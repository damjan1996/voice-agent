// =============================================================================
//  voice-agent-commands.js — Befehle für den bestehenden WhatsApp-Bot
// =============================================================================
//  Einbau: siehe EINBAU.md. Das Modul kommt nach ~/WhatsAppBot/lib/ und wird
//  in whatsapp-commands.js mit drei Zeilen eingehängt.
//
//  Absichtlich ohne Abhängigkeiten und ohne Kenntnis der Datenbank: Alles
//  läuft über die Control-API. Der Bot muss weder Postgres noch ElevenLabs
//  noch n8n kennen — er stellt Fragen und liest Antworten vor.
//
//  Die Control-API liefert zu jeder Antwort ein Feld "text", das schon
//  WhatsApp-tauglich formatiert ist. Der Bot reicht es durch. Damit liegt
//  die Darstellung an einer Stelle und ändert sich mit dem Dienst, nicht mit
//  dem Bot.
// =============================================================================

'use strict';

const BASIS = process.env.VOICEAGENT_API_URL || 'http://127.0.0.1:3010';
const TOKEN = process.env.VOICEAGENT_API_TOKEN || '';

const BEFEHLE = new Set([
  '/agent', '/anrufe', '/nachrichten', '/erledigt', '/termine',
  '/flows', '/workflows', '/kontakt', '/sperre',
]);

/** Erkennt, ob eine Nachricht an dieses Modul geht. */
function istVoiceBefehl(text) {
  if (!text || typeof text !== 'string') return false;
  const erstes = text.trim().split(/\s+/)[0].toLowerCase();
  return BEFEHLE.has(erstes) || BEFEHLE.has('/' + erstes);
}

// -----------------------------------------------------------------------------

async function ruf(pfad, { method = 'GET', body, akteur } = {}) {
  if (!TOKEN) {
    return { _fehler: 'VOICEAGENT_API_TOKEN ist im Bot nicht gesetzt. Siehe EINBAU.md.' };
  }

  try {
    const antwort = await fetch(`${BASIS}${pfad}`, {
      method,
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Akteur': akteur || 'whatsapp',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const daten = await antwort.json().catch(() => ({}));
    if (!antwort.ok) {
      return { _fehler: daten.text || daten.fehler || `HTTP ${antwort.status}` };
    }
    return daten;
  } catch (err) {
    const grund = err.name === 'TimeoutError'
      ? 'Der Voice-Agent antwortet nicht.'
      : `Der Voice-Agent ist nicht erreichbar (${err.message}).`;
    return { _fehler: `${grund}\n\nAuf dem Server prüfen: \`cd ~/voice-agent && make status\`` };
  }
}

/** Vereinheitlicht: entweder der Text vom Dienst oder die Fehlermeldung. */
const antwortAus = (d, ersatz) => ({ response: d._fehler ? `⚠️ ${d._fehler}` : (d.text || ersatz) });

// -----------------------------------------------------------------------------
//  /agent — Modus zeigen und schalten
// -----------------------------------------------------------------------------

const HILFE_AGENT = [
  '*Telefon-Vorzimmer*',
  '',
  '`/agent`               Zustand anzeigen',
  '`/agent an`            Voller Betrieb, darf durchstellen',
  '`/agent notiz`         Nimmt an und notiert, stellt nicht durch',
  '`/agent aus`           Kurze Ansage, Nachricht aufnehmen',
  '',
  '*Befristet* — danach zurück auf „an":',
  '`/agent notiz bis 16 uhr`',
  '`/agent aus bis morgen`',
  '`/agent notiz 2h`',
  '',
  '*Mit Ansage für den Anrufer:*',
  '`/agent notiz bis 15 uhr | Er ist bis 15 Uhr in einem Workshop`',
  '',
  '_Der Satz wird wörtlich vorgelesen. Zwei Dinge deshalb beachten:_',
  '_in der dritten Person schreiben („Er ist…", nicht „Bin…"),_',
  '_und nichts hineinschreiben, das Fremde nicht hören sollen._',
].join('\n');

async function befehlAgent(teile, akteur) {
  if (!teile.length) {
    return antwortAus(await ruf('/v1/status', { akteur }), 'Kein Zustand verfügbar.');
  }

  const roh = teile.join(' ');
  if (/^(hilfe|help|\?)$/i.test(roh)) return { response: HILFE_AGENT };

  // "notiz bis 16 uhr | bin im Workshop" auseinandernehmen.
  const [linkeSeite, ...hinweisTeile] = roh.split('|');
  const hinweis = hinweisTeile.join('|').trim() || undefined;

  const worte = linkeSeite.trim().split(/\s+/);
  const modus = worte.shift();

  // Alles nach einem optionalen "bis" ist die Zeitangabe.
  let bis;
  if (worte.length) {
    bis = worte[0].toLowerCase() === 'bis' ? worte.slice(1).join(' ') : worte.join(' ');
    bis = bis.trim() || undefined;
  }

  const d = await ruf('/v1/modus', { method: 'POST', akteur, body: { modus, bis, hinweis } });
  return antwortAus(d, 'Umgestellt.');
}

// -----------------------------------------------------------------------------
//  Übrige Befehle
// -----------------------------------------------------------------------------

async function befehlAnrufe(teile, akteur) {
  const anzahl = Math.min(Math.max(parseInt(teile[0], 10) || 5, 1), 30);
  return antwortAus(await ruf(`/v1/anrufe?limit=${anzahl}`, { akteur }), 'Keine Anrufe.');
}

async function befehlNachrichten(teile, akteur) {
  const alle = teile[0] && /^(alle|all)$/i.test(teile[0]);
  return antwortAus(await ruf(`/v1/nachrichten?offen=${alle ? '0' : '1'}`, { akteur }), 'Keine Nachrichten.');
}

async function befehlErledigt(teile, akteur) {
  const id = parseInt(teile[0], 10);
  if (!Number.isFinite(id)) {
    return { response: 'Welche Nachricht? Beispiel: `/erledigt 12`\n\nDie Nummern stehen bei `/nachrichten`.' };
  }
  return antwortAus(await ruf(`/v1/nachrichten/${id}/erledigt`, { method: 'POST', akteur }), 'Abgehakt.');
}

async function befehlTermine(_teile, akteur) {
  return antwortAus(await ruf('/v1/termine', { akteur }), 'Keine Termine.');
}

async function befehlFlows(teile, akteur) {
  if (!teile.length) {
    return antwortAus(await ruf('/v1/workflows', { akteur }), 'Keine Workflows registriert.');
  }

  const [erstes, ...rest] = teile;
  const aktion = /^(an|ein|start|aktivieren)$/i.test(erstes) ? 'aktivieren'
    : /^(aus|stop|deaktivieren)$/i.test(erstes) ? 'deaktivieren' : null;

  if (!aktion) {
    return { response: 'So geht das: `/flows an <name>` oder `/flows aus <name>`\n\n`/flows` zeigt die Namen.' };
  }

  const slug = rest.join('-').toLowerCase();
  if (!slug) return { response: `Welchen Workflow? \`/flows ${erstes} <name>\`` };

  const d = await ruf(`/v1/workflows/${encodeURIComponent(slug)}/${aktion}`, { method: 'POST', akteur });
  return antwortAus(d, 'Geschaltet.');
}

async function befehlKontakt(teile, akteur) {
  if (teile.length < 2) {
    return { response: [
      'So legst du einen Kontakt an — der Agent begrüßt ihn dann beim Namen:',
      '',
      '`/kontakt +4915112345678 Max Mustermann`',
      '`/kontakt +4915112345678 Max Mustermann vip`',
      '`/kontakt +4915112345678 Nervkunde gesperrt`',
      '',
      '`/kontakt` allein zeigt alle hinterlegten Kontakte.',
    ].join('\n') };
  }

  const [nummer, ...rest] = teile;
  const vip = rest.some((w) => /^vip$/i.test(w));
  const gesperrt = rest.some((w) => /^(gesperrt|blocked|block)$/i.test(w));
  const name = rest.filter((w) => !/^(vip|gesperrt|blocked|block)$/i.test(w)).join(' ');

  if (!name) return { response: 'Der Name fehlt. Beispiel: `/kontakt +4915112345678 Max Mustermann`' };

  const d = await ruf('/v1/kontakte', { method: 'POST', akteur, body: { nummer, name, vip, gesperrt } });
  return antwortAus(d, 'Gespeichert.');
}

async function befehlSperre(teile, akteur) {
  const roh = teile.join(' ');
  const treffer = roh.match(/^(.+?)\s+bis\s+(.+?)(?:\s*\|\s*(.+))?$/i);
  if (!treffer) {
    return { response: [
      'Zeitraum sperren, in dem keine Termine vergeben werden:',
      '',
      '`/sperre morgen bis freitag`',
      '`/sperre heute bis 18 uhr | Deep Work`',
    ].join('\n') };
  }

  const d = await ruf('/v1/sperrzeit', {
    method: 'POST', akteur,
    body: { von: treffer[1].trim(), bis: treffer[2].trim(), grund: treffer[3]?.trim() },
  });
  return antwortAus(d, 'Gesperrt.');
}

// -----------------------------------------------------------------------------

/**
 * Führt einen Voice-Agent-Befehl aus.
 *
 * @returns {Promise<{response: string}|null>} null, wenn der Befehl nicht
 *   zu diesem Modul gehört — dann macht der Bot normal weiter.
 */
async function handleVoiceCommand(text, { senderJid, isOwner } = {}) {
  const worte = String(text).trim().split(/\s+/);
  const befehl = worte[0].toLowerCase().replace(/^\/?/, '/');
  if (!BEFEHLE.has(befehl)) return null;

  // Wer den Agent umschaltet, entscheidet, ob Damjans Telefon klingelt.
  // Das ist nichts, was ein beliebiger Chatpartner dürfen sollte.
  if (!isOwner) {
    return { response: 'Diese Befehle sind dem Bot-Owner vorbehalten.' };
  }

  const rest = worte.slice(1);
  const akteur = senderJid ? `whatsapp:${String(senderJid).split('@')[0]}` : 'whatsapp';

  switch (befehl) {
    case '/agent':        return befehlAgent(rest, akteur);
    case '/anrufe':       return befehlAnrufe(rest, akteur);
    case '/nachrichten':  return befehlNachrichten(rest, akteur);
    case '/erledigt':     return befehlErledigt(rest, akteur);
    case '/termine':      return befehlTermine(rest, akteur);
    case '/flows':
    case '/workflows':    return befehlFlows(rest, akteur);
    case '/kontakt':      return befehlKontakt(rest, akteur);
    case '/sperre':       return befehlSperre(rest, akteur);
    default:              return null;
  }
}

/** Zeilen für die `/help`-Ausgabe des Bots. */
function hilfeZeilen() {
  return [
    '',
    '*Telefon-Vorzimmer*',
    '/agent — Zustand · an · notiz · aus [bis <zeit>]',
    '/anrufe [n] — letzte Anrufe',
    '/nachrichten — offene Nachrichten',
    '/erledigt <nr> — Nachricht abhaken',
    '/termine — vereinbarte Termine',
    '/kontakt <nummer> <name> — Anrufer benennen',
    '/sperre <von> bis <bis> — keine Termine',
    '/flows — n8n-Workflows des Agents',
  ].join('\n');
}

module.exports = {
  istVoiceBefehl,
  handleVoiceCommand,
  hilfeZeilen,
  BEFEHLE,
};
