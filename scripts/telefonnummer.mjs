#!/usr/bin/env node
// =============================================================================
//  telefonnummer.mjs — Rufnummer mit dem Agent verbinden
// =============================================================================
//  Der letzte Schritt vor dem ersten echten Anruf. Zwei Wege, je nachdem, wo
//  die Nummer herkommt:
//
//    sip_trunk   Deutscher Anbieter (sipgate, Telnyx, easybell, Placetel).
//                Empfohlen. Keine Wartezeit auf eine Regulierungsprüfung,
//                deutsche Rechnung, kürzerer Weg für das Gespräch.
//
//    twilio      Native Anbindung. Nur mit Gewerbe — Twilio verkauft in
//                Deutschland keine Nummern an Privatpersonen. Dafür gibt es
//                warme Übergabe und blind transfer.
//
//  Aufruf:
//    node scripts/telefonnummer.mjs --hilfe
//    node scripts/telefonnummer.mjs            # aus der .env
//    node scripts/telefonnummer.mjs --liste
// =============================================================================

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASIS = 'https://api.elevenlabs.io/v1';

const argv = process.argv.slice(2);
const farbe = process.stdout.isTTY;
const c = (k, s) => (farbe ? `[${k}m${s}[0m` : s);
const gut = (s) => console.log(`  ${c(32, '✓')} ${s}`);
const warn = (s) => console.log(`  ${c(33, '!')} ${s}`);

function abbruch(m) { console.error(`\n${c(31, 'Abbruch:')} ${m}\n`); process.exit(1); }

const HILFE = `
${c(1, 'Rufnummer mit dem Agent verbinden')}

Der Agent kann nicht unter deiner echten Handynummer laufen — deutsche
Mobilnummern lassen sich nicht zu einem VoIP-Anbieter portieren. Er bekommt
eine Zweitnummer, und dein Handy leitet bedingt dorthin um. Für den Anrufer
sieht es aus, als ginge der Agent auf deiner Nummer ran: Er wählt weiterhin
nur diese eine Nummer.

${c(1, 'Weg A — SIP-Trunk (empfohlen für Deutschland)')}

  1. Bei sipgate trunking anmelden (30 Tage Test, danach ab 11,84 €/Monat)
     und eine Ortsnetznummer buchen.

  2. Im sipgate-Portal als Origination-URI eintragen:
       ${c(36, 'sip:sip.rtc.elevenlabs.io:5060;transport=tcp')}
     Digest-Auth aktivieren (Benutzername und Passwort vergeben).
     ${c(90, 'IP-Allowlisting funktioniert hier NICHT — ElevenLabs bedient SIP')}
     ${c(90, 'aus wechselnden Adressen. Digest-Auth ist der vorgesehene Weg.')}

  3. „Rufnummernübermittlung" / CLI-Passthrough aktivieren, damit der Agent
     die Nummer des echten Anrufers sieht und nicht deine.

  4. In die .env:
       TELEFON_ANBIETER=sip_trunk
       AGENT_PHONE_NUMBER=+49...      ${c(90, '(die neue Nummer)')}
       SIP_BENUTZER=...
       SIP_PASSWORT=...
       SIP_ADRESSE=sipgate.de         ${c(90, 'reiner Hostname, OHNE "sip:"')}

  5. Dieses Skript laufen lassen.

${c(1, 'Weg B — Twilio')}

  Setzt eine Gewerbeanmeldung oder einen Handelsregisterauszug voraus; die
  Adresse muss zum Vorwahlgebiet der Nummer passen. Prüfung 1–3 Werktage.
  Eine Ortsnetznummer kostet 1,35 $/Monat, eine Mobilnummer 30 $ — nimm die
  Ortsnetznummer, es gibt keinen funktionalen Unterschied.

  In die .env: TELEFON_ANBIETER=twilio, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  AGENT_PHONE_NUMBER. TWILIO_REGION_ID=ie1 und TWILIO_EDGE=frankfurt nicht
  vergessen — sonst routet Twilio auch deutsche Nummern über die USA, was
  die Datenresidenz verletzt UND das Durchstellen scheitern lässt.

${c(1, 'Danach: Rufumleitung auf dem Handy')}

  Im Wählfeld eingeben und Anrufen drücken:

    ${c(36, '**004*<AGENT_PHONE_NUMBER>**25#')}   alle drei Fälle, 25 s Klingeln

  oder einzeln:
    **61*<nummer>**25#   keine Antwort nach 25 Sekunden
    **62*<nummer>#       nicht erreichbar (aus, Flugmodus, kein Netz)
    **67*<nummer>#       besetzt

  ${c(33, 'Nicht **21* verwenden')} — das leitet ALLES um, dein Handy klingelt nie mehr.

  Rückgängig: ${c(36, '##002#')} — danach die Mailbox in der Carrier-App wieder
  einschalten. Sie hängt an denselben Codes und ist jetzt aus.

  Prüfen: *#61#  ·  *#62#  ·  *#67#
`;

async function env() {
  const datei = path.join(WURZEL, '.env');
  if (!existsSync(datei)) abbruch('.env fehlt');
  const e = {};
  for (const zeile of (await readFile(datei, 'utf8')).split('\n')) {
    const t = zeile.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!t) continue;
    let v = t[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    e[t[1]] = v;
  }
  return { ...e, ...process.env };
}

async function api(schluessel, pfad, { method = 'GET', body } = {}) {
  const antwort = await fetch(`${BASIS}${pfad}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: { 'xi-api-key': schluessel, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const roh = await antwort.text();
  let d = null;
  try { d = roh ? JSON.parse(roh) : null; } catch { d = { raw: roh }; }
  if (!antwort.ok) {
    const m = d?.detail?.message ?? JSON.stringify(d?.detail ?? d).slice(0, 700);
    throw new Error(`${method} ${pfad} → ${antwort.status}\n     ${m}`);
  }
  return d;
}

async function main() {
  if (argv.includes('--hilfe') || argv.includes('-h')) { console.log(HILFE); return; }

  const e = await env();
  const K = e.ELEVENLABS_API_KEY;
  if (!K) abbruch('ELEVENLABS_API_KEY fehlt.');

  if (argv.includes('--liste')) {
    const n = await api(K, '/convai/phone-numbers');
    const liste = Array.isArray(n) ? n : (n?.phone_numbers ?? []);
    console.log(c(1, '\nRufnummern im Konto\n'));
    if (!liste.length) console.log('  keine\n');
    for (const x of liste) {
      console.log(`  ${c(1, x.phone_number)}  ${x.label ?? ''}`);
      console.log(c(90, `    ${x.provider} · ${x.phone_number_id}`));
      console.log(c(90, `    Agent: ${x.assigned_agent?.agent_id ?? 'keiner zugewiesen'}\n`));
    }
    return;
  }

  const nummer = e.AGENT_PHONE_NUMBER;
  const agentId = e.ELEVENLABS_AGENT_ID;
  const anbieter = (e.TELEFON_ANBIETER || 'sip_trunk').toLowerCase();

  if (!nummer) abbruch('AGENT_PHONE_NUMBER fehlt in der .env.\n  Erst eine Nummer besorgen — "--hilfe" erklärt, wie.');
  if (!agentId) abbruch('ELEVENLABS_AGENT_ID fehlt. Zuerst: make agent');

  console.log(c(1, '\nRufnummer verbinden'));
  console.log(c(90, `  Nummer:   ${nummer}`));
  console.log(c(90, `  Anbieter: ${anbieter}`));
  console.log(c(90, `  Agent:    ${agentId}\n`));

  // Schon da? Dann nur die Zuordnung richten.
  const bestand = await api(K, '/convai/phone-numbers');
  const liste = Array.isArray(bestand) ? bestand : (bestand?.phone_numbers ?? []);
  const treffer = liste.find((x) => x.phone_number === nummer);

  if (treffer) {
    if (treffer.assigned_agent?.agent_id === agentId) {
      gut('Nummer ist bereits mit diesem Agent verbunden.');
    } else {
      await api(K, `/convai/phone-numbers/${treffer.phone_number_id}`, {
        method: 'PATCH', body: { agent_id: agentId },
      });
      gut(`Nummer neu zugewiesen (${treffer.phone_number_id})`);
    }
    console.log(`\n  ${c(1, 'In die .env:')}\n  PHONE_NUMBER_ID=${treffer.phone_number_id}\n`);
    return;
  }

  let body;
  if (anbieter === 'twilio') {
    if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN) {
      abbruch('TWILIO_ACCOUNT_SID und TWILIO_AUTH_TOKEN fehlen in der .env.');
    }
    body = {
      provider: 'twilio',
      phone_number: nummer,
      label: 'Vorzimmer Damjan',
      sid: e.TWILIO_ACCOUNT_SID,
      token: e.TWILIO_AUTH_TOKEN,
      agent_id: agentId,
    };
    if (e.TWILIO_REGION_ID && e.TWILIO_EDGE) {
      body.region_config = {
        region_id: e.TWILIO_REGION_ID,
        edge_location: e.TWILIO_EDGE,
        token: e.TWILIO_AUTH_TOKEN,
      };
    } else {
      warn('Ohne TWILIO_REGION_ID und TWILIO_EDGE routet Twilio über die USA.');
      warn('Das verletzt die Datenresidenz und lässt Weiterleitungen scheitern.');
    }
  } else {
    if (!e.SIP_BENUTZER || !e.SIP_PASSWORT || !e.SIP_ADRESSE) {
      abbruch('SIP_BENUTZER, SIP_PASSWORT und SIP_ADRESSE fehlen in der .env.\n  Siehe "--hilfe".');
    }
    if (/^sips?:/i.test(e.SIP_ADRESSE)) {
      abbruch(`SIP_ADRESSE darf kein "sip:" enthalten — nur der Hostname, also z.B. "${e.SIP_ADRESSE.replace(/^sips?:/i, '')}".`);
    }
    body = {
      provider: 'sip_trunk',
      phone_number: nummer,
      label: 'Vorzimmer Damjan',
      agent_id: agentId,
      inbound_trunk_config: {
        media_encryption: 'allowed',
        credentials: { username: e.SIP_BENUTZER, password: e.SIP_PASSWORT },
      },
      outbound_trunk_config: {
        address: e.SIP_ADRESSE,
        transport: e.SIP_TRANSPORT || 'tls',
        media_encryption: 'allowed',
        credentials: { username: e.SIP_BENUTZER, password: e.SIP_PASSWORT },
      },
    };
  }

  const neu = await api(K, '/convai/phone-numbers', { method: 'POST', body });
  gut(`Nummer angelegt und zugewiesen (${neu.phone_number_id})`);

  console.log(`\n  ${c(1, 'In die .env:')}`);
  console.log(`  PHONE_NUMBER_ID=${neu.phone_number_id}\n`);
  console.log(`  ${c(1, 'Letzter Schritt — Rufumleitung auf dem Handy:')}`);
  console.log(`  ${c(36, `**004*${nummer}**25#`)}   ${c(90, 'im Wählfeld eingeben, Anrufen drücken')}\n`);
  console.log(c(90, '  Danach von einem anderen Telefon aus anrufen, nicht abnehmen, und'));
  console.log(c(90, '  prüfen, ob der Agent rangeht: voiceagent anrufe\n'));
}

main().catch((err) => abbruch(err.message));
