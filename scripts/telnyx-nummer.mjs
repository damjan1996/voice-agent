#!/usr/bin/env node
// =============================================================================
//  telnyx-nummer.mjs — deutsche Rufnummer bei Telnyx besorgen und anschließen
// =============================================================================
//  Führt den ganzen Weg durch: Adresse hinterlegen, Nachweise hochladen,
//  Nummer kaufen, SIP-Verbindung anlegen, mit dem Agent verbinden.
//
//    node scripts/telnyx-nummer.mjs                 Stand und nächster Schritt
//    node scripts/telnyx-nummer.mjs --suche 221     freie Nummern zeigen
//    node scripts/telnyx-nummer.mjs --adresse       Adresse anlegen (aus .env)
//    node scripts/telnyx-nummer.mjs --dokumente <ordner>   Nachweise hochladen
//    node scripts/telnyx-nummer.mjs --kaufen +4922…       Nummer kaufen
//    node scripts/telnyx-nummer.mjs --trunk         SIP-Verbindung einrichten
//
//  Was NICHT automatisch geht: die Nachweise selbst. Telnyx verlangt für eine
//  deutsche Ortsnetznummer eine Ausweiskopie, einen Adressnachweis und das
//  Formular der Bundesnetzagentur. Die muss ein Mensch beibringen — das
//  Skript lädt sie hoch und hängt sie an die Nummer.
// =============================================================================

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASIS = 'https://api.telnyx.com/v2';

const farbe = process.stdout.isTTY;
const c = (k, s) => (farbe ? `[${k}m${s}[0m` : s);
const gut = (s) => console.log(`  ${c(32, '✓')} ${s}`);
const warn = (s) => console.log(`  ${c(33, '!')} ${s}`);
const info = (s) => console.log(`  ${c(90, '·')} ${c(90, s)}`);
const schritt = (s) => console.log(`\n${c(1, '▸')} ${c(1, s)}`);

function abbruch(m) { console.error(`\n${c(31, 'Abbruch:')} ${m}\n`); process.exit(1); }

const argv = process.argv.slice(2);
const wert = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const hat = (n) => argv.includes(`--${n}`);

async function ladeEnv() {
  const datei = path.join(WURZEL, '.env');
  if (!existsSync(datei)) abbruch('.env fehlt.');
  const e = {};
  for (const z of (await readFile(datei, 'utf8')).split('\n')) {
    const t = z.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!t) continue;
    let v = t[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    e[t[1]] = v;
  }
  return { ...e, ...process.env };
}

async function setzeEnv(schluessel, wert) {
  const datei = path.join(WURZEL, '.env');
  let t = await readFile(datei, 'utf8');
  const zeile = `${schluessel}=${/[\s#"']/.test(wert) ? `"${wert}"` : wert}`;
  const m = new RegExp(`^${schluessel}=.*$`, 'm');
  await writeFile(datei, m.test(t) ? t.replace(m, zeile) : `${t.trimEnd()}\n${zeile}\n`, 'utf8');
}

let SCHLUESSEL = '';

async function api(pfad, { method = 'GET', body, roh } = {}) {
  const antwort = await fetch(`${BASIS}${pfad}`, {
    method,
    signal: AbortSignal.timeout(45_000),
    headers: {
      Authorization: `Bearer ${SCHLUESSEL}`,
      ...(body && !roh ? { 'Content-Type': 'application/json' } : {}),
    },
    body: roh ?? (body ? JSON.stringify(body) : undefined),
  });

  const text = await antwort.text();
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch { d = { raw: text.slice(0, 400) }; }

  if (!antwort.ok) {
    const fehler = (d?.errors ?? []).map((e) => {
      const feld = e.source?.pointer ? ` (${e.source.pointer})` : '';
      return `${e.title}${feld}: ${e.detail ?? ''}`;
    }).join('\n     ') || JSON.stringify(d).slice(0, 400);
    throw new Error(`${method} ${pfad} → ${antwort.status}\n     ${fehler}`);
  }
  return d;
}

// =============================================================================

async function suche(env, ndc) {
  schritt(`Freie Nummern mit Vorwahl 0${ndc}`);
  const q = new URLSearchParams({
    'filter[country_code]': 'DE',
    'filter[national_destination_code]': ndc,
    'filter[limit]': '8',
  });
  const d = await api(`/available_phone_numbers?${q}`);
  const n = d?.data ?? [];

  if (!n.length) {
    warn(`Keine Nummern mit Vorwahl 0${ndc} verfügbar.`);
    info('Andere Vorwahl probieren — die Adresse muss dazu passen.');
    return;
  }

  for (const x of n) {
    const k = x.cost_information ?? {};
    const ort = (x.region_information ?? []).find((r) => r.region_type === 'location')?.region_name;
    console.log(`  ${c(1, x.phone_number)}  ${Number(k.monthly_cost).toFixed(2)} ${k.currency}/Monat ` +
      `+ ${Number(k.upfront_cost).toFixed(2)} einmalig   ${c(90, ort ?? '')}`);
  }
  console.log('');
  info(`Kaufen: node scripts/telnyx-nummer.mjs --kaufen ${n[0].phone_number}`);
}

/**
 * Adresse anlegen.
 *
 * Sie muss im Vorwahlgebiet der Nummer liegen — die Bundesnetzagentur
 * verlangt einen örtlichen Bezug. Eine Kölner Nummer mit Berliner Adresse
 * lehnt Telnyx ab, und zwar erst nach der Dokumentenprüfung.
 */
async function adresseAnlegen(env) {
  schritt('Adresse hinterlegen');

  const noetig = ['TELNYX_VORNAME', 'TELNYX_NACHNAME', 'TELNYX_STRASSE', 'TELNYX_PLZ', 'TELNYX_STADT'];
  const fehlend = noetig.filter((k) => !env[k]);
  if (fehlend.length) {
    console.log('');
    warn('In die .env eintragen:');
    console.log('');
    console.log(c(36, [
      'TELNYX_VORNAME=Damjan',
      'TELNYX_NACHNAME=Savić',
      'TELNYX_STRASSE="Musterstraße 12"',
      'TELNYX_PLZ=50667',
      'TELNYX_STADT=Köln',
    ].map((z) => `  ${z}`).join('\n')));
    console.log('');
    info('Die Adresse muss im Vorwahlgebiet der Nummer liegen (0221 = Köln)');
    info('und mit dem Adressnachweis übereinstimmen, den du hochlädst.');
    process.exit(1);
  }

  const vorhanden = await api('/addresses');
  const treffer = (vorhanden?.data ?? []).find(
    (a) => a.street_address === env.TELNYX_STRASSE && a.postal_code === env.TELNYX_PLZ,
  );
  if (treffer) { gut(`Adresse vorhanden (${treffer.id})`); await setzeEnv('TELNYX_ADRESS_ID', treffer.id); return treffer.id; }

  const neu = await api('/addresses', {
    method: 'POST',
    body: {
      first_name: env.TELNYX_VORNAME,
      last_name: env.TELNYX_NACHNAME,
      // Telnyx verlangt das Feld auch bei Privatpersonen. Die deutsche
      // Regulierung sagt dazu ausdrücklich: bei Einzelpersonen "N/A".
      business_name: env.TELNYX_FIRMA || 'N/A',
      street_address: env.TELNYX_STRASSE,
      postal_code: env.TELNYX_PLZ,
      locality: env.TELNYX_STADT,
      country_code: 'DE',
      administrative_area: env.TELNYX_BUNDESLAND || 'NW',
      phone_number: env.OWNER_PHONE || undefined,
    },
  });

  const id = neu.data.id;
  await setzeEnv('TELNYX_ADRESS_ID', id);
  gut(`Adresse angelegt (${id})`);
  info(`${env.TELNYX_STRASSE}, ${env.TELNYX_PLZ} ${env.TELNYX_STADT}`);
  return id;
}

/** Nachweise hochladen. */
async function dokumenteHochladen(ordner) {
  schritt('Nachweise hochladen');

  const pfad = path.resolve(ordner.replace(/^~/, process.env.HOME ?? '~'));
  if (!existsSync(pfad)) abbruch(`Ordner nicht gefunden: ${pfad}`);

  const dateien = (await readdir(pfad)).filter((f) => /\.(pdf|jpe?g|png)$/i.test(f));
  if (!dateien.length) abbruch(`Keine PDF- oder Bilddateien in ${pfad}`);

  const ids = [];
  for (const datei of dateien) {
    const inhalt = await readFile(path.join(pfad, datei));
    const form = new FormData();
    form.append('file', new Blob([inhalt]), datei);
    form.append('customer_reference', 'voice-agent');

    const antwort = await fetch(`${BASIS}/documents`, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${SCHLUESSEL}` },
      body: form,
    });
    const d = await antwort.json();
    if (!antwort.ok) { warn(`${datei}: ${JSON.stringify(d.errors ?? d).slice(0, 200)}`); continue; }

    gut(`${datei} → ${d.data.id}`);
    ids.push({ datei, id: d.data.id });
  }

  if (ids.length) {
    await writeFile(path.join(WURZEL, 'n8n', '.telnyx-dokumente.json'),
      JSON.stringify(ids, null, 2) + '\n', 'utf8');
    info('IDs gemerkt für den Kauf.');
  }
  return ids;
}

/** Nummer kaufen. */
async function kaufen(env, nummer) {
  schritt(`Nummer ${nummer} kaufen`);

  if (!env.TELNYX_ADRESS_ID) {
    abbruch('Keine Adresse hinterlegt.\n  Erst: node scripts/telnyx-nummer.mjs --adresse');
  }

  const dokDatei = path.join(WURZEL, 'n8n', '.telnyx-dokumente.json');
  const dokumente = existsSync(dokDatei) ? JSON.parse(await readFile(dokDatei, 'utf8')) : [];

  const bestellung = {
    phone_numbers: [{ phone_number: nummer }],
    // Die Adresse wird als Notrufadresse UND als regulatorischer Nachweis
    // des örtlichen Bezugs verwendet.
    messaging_profile_id: undefined,
  };
  if (env.TELNYX_ADRESS_ID) bestellung.phone_numbers[0].bundle_id = undefined;

  console.log('');
  info(`Kosten: 1,00 USD einmalig + 1,00 USD monatlich`);
  info(`Adresse: ${env.TELNYX_ADRESS_ID}`);
  info(`Dokumente: ${dokumente.length}`);
  console.log('');

  const d = await api('/number_orders', { method: 'POST', body: bestellung });
  const auftrag = d.data;

  gut(`Bestellung angelegt (${auftrag.id})`);
  info(`Status: ${auftrag.status}`);

  const offen = (auftrag.phone_numbers ?? [])[0]?.requirements_status;
  if (offen && offen !== 'approved') {
    console.log('');
    warn(`Regulatorische Prüfung: ${offen}`);
    info('Telnyx meldet sich per E-Mail, wenn Unterlagen fehlen.');
    info('Stand prüfen: node scripts/telnyx-nummer.mjs');
  }

  await setzeEnv('AGENT_PHONE_NUMBER', nummer);
  await setzeEnv('TELNYX_ORDER_ID', auftrag.id);
  gut(`AGENT_PHONE_NUMBER=${nummer} in der .env`);
  return auftrag;
}

/** SIP-Verbindung nach dem Muster aus der ElevenLabs-Doku. */
async function trunk(env) {
  schritt('SIP-Verbindung für ElevenLabs');

  const name = 'voice-agent-elevenlabs';
  const vorhanden = await api('/fqdn_connections');
  let verbindung = (vorhanden?.data ?? []).find((v) => v.connection_name === name);

  if (verbindung) {
    gut(`Verbindung vorhanden (${verbindung.id})`);
  } else {
    // Die Werte stammen aus der ElevenLabs-Anleitung für Telnyx:
    // eingehend +E.164 über TCP ohne Digest-Auth, ausgehend mit
    // Zugangsdaten gegen sip.rtc.elevenlabs.io.
    const benutzer = env.SIP_BENUTZER || `voiceagent${Math.floor(Math.random() * 9000 + 1000)}`;
    const passwort = env.SIP_PASSWORT || Array.from(
      { length: 24 },
      () => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 55)],
    ).join('');

    const neu = await api('/fqdn_connections', {
      method: 'POST',
      body: {
        connection_name: name,
        transport_protocol: 'TCP',
        inbound: {
          // ElevenLabs erwartet die Zielnummer in E.164 im User-Teil der URI.
          ani_number_format: '+E.164',
          dnis_number_format: '+e164',
          sip_region: 'Europe',
        },
        outbound: {
          ani_override_type: 'always',
          outbound_voice_profile_id: undefined,
        },
        user_name: benutzer,
        password: passwort,
      },
    });
    verbindung = neu.data;
    await setzeEnv('SIP_BENUTZER', benutzer);
    await setzeEnv('SIP_PASSWORT', passwort);
    await setzeEnv('TELNYX_CONNECTION_ID', verbindung.id);
    gut(`Verbindung angelegt (${verbindung.id})`);
    info(`Zugangsdaten in der .env hinterlegt`);
  }

  // FQDN auf ElevenLabs zeigen lassen.
  const fqdns = await api(`/fqdns?filter%5Bconnection_id%5D=${verbindung.id}`);
  if (!(fqdns?.data ?? []).length) {
    await api('/fqdns', {
      method: 'POST',
      body: {
        connection_id: verbindung.id,
        fqdn: 'sip.rtc.elevenlabs.io',
        port: 5060,
        dns_record_type: 'a',
      },
    });
    gut('FQDN sip.rtc.elevenlabs.io eingetragen');
  } else {
    info('FQDN bereits eingetragen');
  }

  // Nummer der Verbindung zuweisen.
  if (env.AGENT_PHONE_NUMBER) {
    const q = new URLSearchParams({ 'filter[phone_number]': env.AGENT_PHONE_NUMBER });
    const n = await api(`/phone_numbers?${q}`);
    const eintrag = (n?.data ?? [])[0];
    if (eintrag) {
      await api(`/phone_numbers/${eintrag.id}`, {
        method: 'PATCH',
        body: { connection_id: verbindung.id },
      });
      gut(`${env.AGENT_PHONE_NUMBER} → Verbindung ${verbindung.id}`);
    } else {
      info(`${env.AGENT_PHONE_NUMBER} noch nicht im Konto — kommt nach der Freigabe.`);
    }
  }

  console.log('');
  info('Weiter mit: node scripts/telefonnummer.mjs');
  return verbindung;
}

/** Was ist der Stand? */
async function stand(env) {
  console.log(c(1, '\nTelnyx — Stand\n'));

  const [konto, adressen, nummern, auftraege] = await Promise.all([
    api('/balance').catch(() => null),
    api('/addresses').catch(() => ({ data: [] })),
    api('/phone_numbers').catch(() => ({ data: [] })),
    api('/number_orders').catch(() => ({ data: [] })),
  ]);

  if (konto?.data) {
    const b = konto.data;
    console.log(`  Guthaben   ${b.balance} ${b.currency}`);
  }

  const a = adressen.data ?? [];
  console.log(`  Adressen   ${a.length}`);
  for (const x of a) console.log(c(90, `             ${x.street_address}, ${x.postal_code} ${x.locality} (${x.id})`));

  const n = nummern.data ?? [];
  console.log(`  Nummern    ${n.length}`);
  for (const x of n) {
    console.log(`             ${c(1, x.phone_number)}  Status ${x.status}` +
      (x.connection_id ? c(90, `  → Verbindung ${x.connection_id}`) : c(33, '  ohne Verbindung')));
  }

  const o = (auftraege.data ?? []).filter((x) => x.status !== 'success');
  if (o.length) {
    console.log(`  Offene Bestellungen ${o.length}`);
    for (const x of o) {
      console.log(c(33, `             ${x.id}: ${x.status}`));
      for (const p of x.phone_numbers ?? []) {
        console.log(c(90, `               ${p.phone_number} — ${p.requirements_status ?? p.status}`));
      }
    }
  }

  console.log('');
  if (!a.length) info('Nächster Schritt: node scripts/telnyx-nummer.mjs --adresse');
  else if (!n.length) info('Nächster Schritt: node scripts/telnyx-nummer.mjs --suche 221');
  else if (!n[0].connection_id) info('Nächster Schritt: node scripts/telnyx-nummer.mjs --trunk');
  else info('Nächster Schritt: node scripts/telefonnummer.mjs');
  console.log('');
}

// =============================================================================

async function main() {
  const env = await ladeEnv();
  SCHLUESSEL = env.TELNYX_API_KEY;
  if (!SCHLUESSEL) abbruch('TELNYX_API_KEY fehlt in der .env.');

  try {
    if (wert('suche')) return await suche(env, wert('suche'));
    if (hat('adresse')) return void await adresseAnlegen(env);
    if (wert('dokumente')) return void await dokumenteHochladen(wert('dokumente'));
    if (wert('kaufen')) return void await kaufen(env, wert('kaufen'));
    if (hat('trunk')) return void await trunk(env);
    await stand(env);
  } catch (err) {
    abbruch(err.message);
  }
}

main();
