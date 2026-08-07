// =============================================================================
//  ElevenLabs Agents Platform
// =============================================================================
//  Die Control-API liest hier nur — ob der Agent existiert, welche Nummer auf
//  ihm liegt, wie viele Gespräche es gab. Verändert wird die Agent-Definition
//  ausschließlich durch scripts/provision-elevenlabs.mjs, damit es genau eine
//  Stelle gibt, an der die Wahrheit über den Agent steht.
//
//  Das An- und Ausschalten läuft NICHT über diesen Weg. Würde man dem Agent
//  die Telefonnummer entziehen, wäre der Anrufer mit einem Freizeichen ins
//  Leere allein — der Modus in der Datenbank sorgt stattdessen dafür, dass
//  immer jemand abnimmt und etwas Sinnvolles sagt.
// =============================================================================

const BASIS = 'https://api.elevenlabs.io/v1';
const SCHLUESSEL = process.env.ELEVENLABS_API_KEY || '';

export const elevenlabsKonfiguriert = () => Boolean(SCHLUESSEL);

async function ruf(pfad, optionen = {}) {
  if (!SCHLUESSEL) {
    throw Object.assign(new Error('ELEVENLABS_API_KEY ist nicht gesetzt'), { code: 'EL_UNCONFIGURED' });
  }

  const antwort = await fetch(`${BASIS}${pfad}`, {
    ...optionen,
    signal: AbortSignal.timeout(optionen.timeoutMs ?? 15_000),
    headers: {
      'xi-api-key': SCHLUESSEL,
      'Content-Type': 'application/json',
      ...optionen.headers,
    },
  });

  const roh = await antwort.text();
  let daten = null;
  try { daten = roh ? JSON.parse(roh) : null; } catch { daten = { raw: roh }; }

  if (!antwort.ok) {
    const meldung = daten?.detail?.message || daten?.detail || daten?.raw || antwort.statusText;
    throw Object.assign(new Error(`ElevenLabs ${antwort.status}: ${meldung}`), {
      code: 'EL_HTTP', status: antwort.status, body: daten,
    });
  }
  return daten;
}

export async function holeAgent(agentId) {
  return ruf(`/convai/agents/${encodeURIComponent(agentId)}`);
}

export async function listeAgenten() {
  const d = await ruf('/convai/agents?page_size=30');
  return d?.agents ?? [];
}

export async function listeTelefonnummern() {
  const d = await ruf('/convai/phone-numbers');
  return Array.isArray(d) ? d : (d?.phone_numbers ?? []);
}

export async function listeGespraeche({ agentId, limit = 10 } = {}) {
  const q = new URLSearchParams({ page_size: String(limit) });
  if (agentId) q.set('agent_id', agentId);
  const d = await ruf(`/convai/conversations?${q}`);
  return d?.conversations ?? [];
}

/** Verbleibendes Guthaben und Tarif — für "/agent status". */
export async function holeKontingent() {
  const d = await ruf('/user/subscription', { timeoutMs: 10_000 });
  return {
    tarif: d?.tier ?? 'unbekannt',
    verbraucht: d?.character_count ?? null,
    limit: d?.character_limit ?? null,
    zuruecksetzung: d?.next_character_count_reset_unix
      ? new Date(d.next_character_count_reset_unix * 1000).toISOString()
      : null,
  };
}

/**
 * Sammelt den sichtbaren Zustand bei ElevenLabs, ohne bei Teilausfällen
 * die ganze Statusabfrage zu kippen. Jede Teilauskunft darf einzeln fehlen.
 */
export async function zustand(agentId) {
  if (!SCHLUESSEL) return { ok: false, grund: 'kein API-Key hinterlegt' };

  const [agent, nummern, kontingent] = await Promise.allSettled([
    agentId ? holeAgent(agentId) : Promise.resolve(null),
    listeTelefonnummern(),
    holeKontingent(),
  ]);

  const wert = (r) => (r.status === 'fulfilled' ? r.value : null);
  const fehler = [agent, nummern, kontingent]
    .filter((r) => r.status === 'rejected')
    .map((r) => r.reason?.message);

  const a = wert(agent);
  const n = wert(nummern) ?? [];

  return {
    ok: fehler.length === 0,
    fehler: fehler.length ? fehler : undefined,
    agent: a ? {
      id: a.agent_id,
      name: a.name,
      llm: a.conversation_config?.agent?.prompt?.llm ?? null,
      sprache: a.conversation_config?.agent?.language ?? null,
      stimme: a.conversation_config?.tts?.voice_id ?? null,
    } : null,
    telefonnummern: n.map((x) => ({
      id: x.phone_number_id,
      nummer: x.phone_number,
      label: x.label,
      anbieter: x.provider,
      zugewiesenerAgent: x.assigned_agent?.agent_id ?? null,
    })),
    kontingent: wert(kontingent),
  };
}
