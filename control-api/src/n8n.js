// =============================================================================
//  n8n Public API
// =============================================================================
//  Nur so viel Client, wie die Control-API braucht: Workflows auflisten und
//  schalten. Alles Weitere (Import, Anlegen) macht scripts/import-n8n-workflows.mjs.
//
//  Wichtig zum Verständnis der Betriebsart: Das Ein- und Ausschalten des
//  Voice-Agents läuft NICHT über diese Funktionen, sondern über den Modus in
//  der Datenbank. Ein deaktivierter n8n-Workflow beantwortet seinen
//  Production-Webhook nicht mehr — ein Anruf liefe dann in einen Fehler statt
//  in eine Ansage. Diese Funktionen sind für die Workflows gedacht, deren
//  Ausfall harmlos ist (Tageszusammenfassung, Nachfassen).
// =============================================================================

const BASIS = process.env.N8N_BASE_URL || 'http://n8n:5678';
const SCHLUESSEL = process.env.N8N_API_KEY || '';

export const n8nKonfiguriert = () => Boolean(SCHLUESSEL);

async function ruf(pfad, optionen = {}) {
  if (!SCHLUESSEL) {
    throw Object.assign(new Error('N8N_API_KEY ist nicht gesetzt'), { code: 'N8N_UNCONFIGURED' });
  }

  const abbruch = AbortSignal.timeout(optionen.timeoutMs ?? 10_000);
  const antwort = await fetch(`${BASIS}/api/v1${pfad}`, {
    ...optionen,
    signal: abbruch,
    headers: {
      'X-N8N-API-KEY': SCHLUESSEL,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...optionen.headers,
    },
  });

  const roh = await antwort.text();
  let daten = null;
  try { daten = roh ? JSON.parse(roh) : null; } catch { daten = { raw: roh }; }

  if (!antwort.ok) {
    const meldung = daten?.message || daten?.raw || antwort.statusText;
    throw Object.assign(new Error(`n8n ${antwort.status}: ${meldung}`), {
      code: 'N8N_HTTP', status: antwort.status, body: daten,
    });
  }
  return daten;
}

/** Alle Workflows mit ihrem aktuellen Aktivzustand. */
export async function listeWorkflows() {
  const seiten = [];
  let cursor;
  // Die API blättert. Bei einer Handvoll Workflows ist das akademisch,
  // aber eine stillschweigend abgeschnittene Liste wäre ein hässlicher Bug.
  do {
    const q = new URLSearchParams({ limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const seite = await ruf(`/workflows?${q}`);
    seiten.push(...(seite?.data ?? []));
    cursor = seite?.nextCursor || null;
  } while (cursor);

  return seiten.map((w) => ({
    id: w.id,
    name: w.name,
    active: Boolean(w.active),
    updatedAt: w.updatedAt,
  }));
}

export async function aktiviere(id) {
  return ruf(`/workflows/${encodeURIComponent(id)}/activate`, { method: 'POST' });
}

export async function deaktiviere(id) {
  return ruf(`/workflows/${encodeURIComponent(id)}/deactivate`, { method: 'POST' });
}

/** Erreichbarkeit prüfen, ohne bei fehlendem Schlüssel zu werfen. */
export async function pruefe() {
  if (!SCHLUESSEL) return { ok: false, grund: 'kein API-Key hinterlegt' };
  try {
    await ruf('/workflows?limit=1', { timeoutMs: 5_000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, grund: err.message };
  }
}
