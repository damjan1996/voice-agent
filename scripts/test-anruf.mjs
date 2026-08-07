#!/usr/bin/env node
// =============================================================================
//  test-anruf.mjs — Anruf simulieren, ohne zu telefonieren
// =============================================================================
//  Geht denselben Weg durch, den ElevenLabs bei einem echten Anruf nimmt:
//  Vorab-Webhook, Kalenderabfrage, Notiz. So sieht man, ob die Kette steht,
//  bevor man mit dem eigenen Handy dagegen anruft — und ohne Gesprächsminuten
//  zu verbrauchen.
//
//    node scripts/test-anruf.mjs
//    node scripts/test-anruf.mjs --von +4915112345678
//    node scripts/test-anruf.mjs --lokal      # an der Control-API vorbei an n8n
// =============================================================================

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const farbe = process.stdout.isTTY;
const c = (k, s) => (farbe ? `[${k}m${s}[0m` : s);

const argv = process.argv.slice(2);
const wert = (name, vorgabe) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : vorgabe;
};
const LOKAL = argv.includes('--lokal');
const VON = wert('von', '+4915199988877');

async function env() {
  const datei = path.join(WURZEL, '.env');
  if (!existsSync(datei)) { console.error('.env fehlt'); process.exit(1); }
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

let bestanden = 0;
let durchgefallen = 0;

async function schritt(name, fn) {
  process.stdout.write(`  ${name} … `);
  const start = Date.now();
  try {
    const ergebnis = await fn();
    const ms = Date.now() - start;
    console.log(c(32, 'ok') + c(90, ` (${ms} ms)`));
    bestanden++;
    return ergebnis;
  } catch (err) {
    console.log(c(31, 'FEHLER'));
    console.log(c(90, `      ${err.message.split('\n').join('\n      ')}`));
    durchgefallen++;
    return null;
  }
}

async function post(url, body, kopf = {}) {
  const antwort = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(25_000),
    headers: { 'Content-Type': 'application/json', ...kopf },
    body: JSON.stringify(body),
  });
  const text = await antwort.text();
  let daten;
  try { daten = JSON.parse(text); } catch { daten = { raw: text.slice(0, 400) }; }
  if (!antwort.ok) {
    throw new Error(`HTTP ${antwort.status} — ${JSON.stringify(daten).slice(0, 400)}`);
  }
  return daten;
}

async function main() {
  const e = await env();
  const basis = LOKAL
    ? `${e.CONTROL_API_URL || 'http://127.0.0.1:3010'}/intern`
    : (e.VOICE_WEBHOOK_BASE || '').replace(/\/$/, '');

  if (!basis) { console.error('VOICE_WEBHOOK_BASE fehlt in der .env'); process.exit(1); }

  const kopf = { 'X-Voice-Token': e.VOICE_WEBHOOK_TOKEN ?? '' };
  const gespraech = `test_${Date.now()}`;

  console.log(c(1, '\nAnruf simulieren'));
  console.log(c(90, `  Weg:     ${LOKAL ? 'direkt an die Control-API' : 'über nginx und n8n'}`));
  console.log(c(90, `  Basis:   ${basis}`));
  console.log(c(90, `  Anrufer: ${VON}\n`));

  // --- 1. Es klingelt --------------------------------------------------------
  const init = await schritt('Anruf wird angenommen', async () => {
    const d = await post(`${basis}/init`, {
      caller_id: VON,
      agent_id: e.ELEVENLABS_AGENT_ID ?? 'test',
      called_number: e.AGENT_PHONE_NUMBER ?? '+490000000',
      call_sid: gespraech,
    }, kopf);

    const dv = d.dynamic_variables;
    if (!dv) throw new Error('keine dynamic_variables in der Antwort');

    // Fehlt hier auch nur eine Variable, bricht ElevenLabs den echten Anruf
    // ab. Deshalb wird die Vollständigkeit hart geprüft.
    const noetig = ['modus', 'anrufer_name', 'anrufer_bekannt', 'anrufer_notiz',
                    'status_hinweis', 'durchstellen_moeglich', 'heute', 'uhrzeit'];
    const fehlend = noetig.filter((k) => dv[k] === undefined);
    if (fehlend.length) throw new Error(`Variablen fehlen: ${fehlend.join(', ')}`);

    return d;
  });

  if (init) {
    const dv = init.dynamic_variables;
    console.log(c(90, `      Modus:        ${dv.modus}`));
    console.log(c(90, `      Anrufer:      ${dv.anrufer_name} (bekannt: ${dv.anrufer_bekannt})`));
    console.log(c(90, `      Durchstellen: ${dv.durchstellen_moeglich}`));
    const gruss = init.conversation_config_override?.agent?.first_message;
    if (gruss) console.log(c(90, `      Begrüßung:    „${gruss.slice(0, 100)}…"`));
    console.log('');
  }

  // --- 2. Kalender -----------------------------------------------------------
  if (!LOKAL) {
    const frei = await schritt('Terminvorschläge holen', async () => {
      const d = await post(`${basis}/verfuegbarkeit`, {
        tageszeit: 'egal', dauer_minuten: 30, conversation_id: gespraech,
      }, kopf);
      if (d.ok === false && !d.ansage) throw new Error('weder Vorschläge noch Ansage');
      return d;
    });
    if (frei) {
      console.log(c(90, `      Ansage: „${frei.ansage}"`));
      if (frei.vorschlaege?.length) {
        for (const v of frei.vorschlaege) console.log(c(90, `      • ${v.lesbar}`));
      }
      console.log('');
    }
  } else {
    console.log(c(90, '  Terminvorschläge … übersprungen (--lokal geht an n8n vorbei)\n'));
  }

  // --- 3. Notiz --------------------------------------------------------------
  await schritt('Notiz anlegen', async () => {
    const d = await post(`${basis}/notiz`, {
      conversation_id: gespraech,
      anrufer_nummer: VON,
      name: 'Testanruf',
      thema: 'Probelauf der Anrufkette',
      zusammenfassung: 'Automatischer Testanruf von scripts/test-anruf.mjs. ' +
        'Wenn diese Nachricht per WhatsApp ankommt, steht die gesamte Kette.',
      dringlichkeit: 2,
      ergebnis: 'nachricht',
      rueckruf_erwuenscht: false,
    }, kopf);
    if (!d.ok && d.bestaetigung === undefined) throw new Error(JSON.stringify(d).slice(0, 300));
    return d;
  });

  // --- Ergebnis --------------------------------------------------------------
  console.log('');
  if (durchgefallen === 0) {
    console.log(c(32, `  ${bestanden} Schritte in Ordnung.`));
    console.log(c(90, '  Der Testanruf steht jetzt unter "voiceagent anrufe" und die'));
    console.log(c(90, '  WhatsApp-Meldung sollte binnen 15 Sekunden ankommen.'));
    console.log(c(90, `  Aufräumen: voiceagent nachrichten  →  voiceagent erledigt <nr>`));
  } else {
    console.log(c(31, `  ${durchgefallen} von ${bestanden + durchgefallen} Schritten fehlgeschlagen.`));
    console.log(c(90, '  Weiter mit: make status'));
    process.exitCode = 1;
  }
  console.log('');
}

main().catch((err) => { console.error(c(31, err.stack ?? err.message)); process.exit(1); });
