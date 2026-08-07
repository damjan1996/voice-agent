#!/usr/bin/env node
// =============================================================================
//  google-kalender.mjs — Kalender anbinden
// =============================================================================
//  Führt durch die vier Schritte, die man in der Google Cloud Console selbst
//  klicken muss, und erledigt danach alles Übrige von allein: Zugangsdaten in
//  n8n hinterlegen, .env setzen, Workflows umstellen und mit einer echten
//  Abfrage prüfen, ob der Kalender antwortet.
//
//    node scripts/google-kalender.mjs                Anleitung und Stand
//    node scripts/google-kalender.mjs <schluessel.json>   einrichten
//    node scripts/google-kalender.mjs --pruefen      nur testen
//
//  Warum ein Dienstkonto und nicht OAuth2:
//
//    OAuth2 braucht einen Rückleit-URI, den Google erreichen kann —
//    https://<domain>/rest/oauth2-credential/callback. Solange die Domain
//    nicht aufgelöst wird, lässt sich die Verbindung gar nicht herstellen.
//
//    Und selbst danach: Ein OAuth2-Zugang mit unveröffentlichtem
//    Zustimmungsbildschirm verliert nach genau sieben Tagen seine Gültigkeit.
//    Der Kalender funktioniert dann eine Woche und stirbt still — der Agent
//    sagt ab da bei jedem Terminwunsch, er komme nicht an den Kalender.
//
//    Ein Dienstkonto hat keinen Ablauf und braucht keinen Browser. Der Preis:
//    Es kann keine Kalendereinladungen an Anrufer verschicken (Google
//    verbietet das ohne Domain-Weite Delegation, die es bei privaten Konten
//    nicht gibt). Die Kontaktdaten stehen deshalb in der Terminbeschreibung.
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSign } from 'node:crypto';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const farbe = process.stdout.isTTY;
const c = (k, s) => (farbe ? `[${k}m${s}[0m` : s);
const gut = (s) => console.log(`  ${c(32, '✓')} ${s}`);
const warn = (s) => console.log(`  ${c(33, '!')} ${s}`);
const info = (s) => console.log(`  ${c(90, '·')} ${c(90, s)}`);
const schritt = (s) => console.log(`\n${c(1, '▸')} ${c(1, s)}`);

function abbruch(m) { console.error(`\n${c(31, 'Abbruch:')} ${m}\n`); process.exit(1); }

async function ladeEnv() {
  const datei = path.join(WURZEL, '.env');
  if (!existsSync(datei)) abbruch('.env fehlt.');
  const env = {};
  for (const zeile of (await readFile(datei, 'utf8')).split('\n')) {
    const t = zeile.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!t) continue;
    let v = t[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    env[t[1]] = v;
  }
  return { ...env, ...process.env };
}

/** Setzt einen Wert in der .env, ohne den Rest anzufassen. */
async function setzeEnv(schluessel, wert) {
  const datei = path.join(WURZEL, '.env');
  let t = await readFile(datei, 'utf8');
  const zeile = `${schluessel}=${/[\s#"']/.test(wert) ? `"${wert}"` : wert}`;
  const muster = new RegExp(`^${schluessel}=.*$`, 'm');
  t = muster.test(t) ? t.replace(muster, zeile) : `${t.trimEnd()}\n${zeile}\n`;
  await writeFile(datei, t, 'utf8');
}

// -----------------------------------------------------------------------------
//  Google-Token aus dem Dienstkonto-Schlüssel
// -----------------------------------------------------------------------------
//  Selbst signiert statt über eine Bibliothek: Das Skript soll ohne
//  zusätzliche Abhängigkeit laufen, und ein JWT ist überschaubar.

function base64url(x) {
  return Buffer.from(x).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function holeToken(schluessel, bereiche) {
  const jetzt = Math.floor(Date.now() / 1000);
  const kopf = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const inhalt = base64url(JSON.stringify({
    iss: schluessel.client_email,
    scope: bereiche.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: jetzt,
    exp: jetzt + 3600,
  }));

  const signatur = createSign('RSA-SHA256')
    .update(`${kopf}.${inhalt}`)
    .sign(schluessel.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const antwort = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${kopf}.${inhalt}.${signatur}`,
    }),
  });

  const d = await antwort.json();
  if (!antwort.ok) {
    throw new Error(`Google lehnt den Schlüssel ab: ${d.error_description ?? d.error ?? antwort.status}`);
  }
  return d.access_token;
}

/** Fragt den Kalender ab — der eigentliche Beweis, dass alles steht. */
async function kalenderProbe(schluessel, kalenderId) {
  const token = await holeToken(schluessel, ['https://www.googleapis.com/auth/calendar']);

  const von = new Date();
  const bis = new Date(Date.now() + 7 * 86_400_000);

  const antwort = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: von.toISOString(),
      timeMax: bis.toISOString(),
      timeZone: 'Europe/Berlin',
      items: [{ id: kalenderId }],
    }),
  });

  const d = await antwort.json();
  if (!antwort.ok) throw new Error(`freeBusy: ${d.error?.message ?? antwort.status}`);

  const eintrag = d.calendars?.[kalenderId];
  if (!eintrag) throw new Error(`Kalender "${kalenderId}" kam in der Antwort nicht vor.`);

  // Google meldet fehlende Freigaben NICHT als HTTP-Fehler, sondern still
  // in diesem Feld. Ohne diese Prüfung sähe alles gut aus, während der
  // Agent später jeden Termin für frei hielte.
  if (eintrag.errors?.length) {
    const grund = eintrag.errors.map((e) => e.reason).join(', ');
    throw new Error(
      `Kalender nicht zugänglich (${grund}).\n` +
      `     Der Kalender muss mit ${schluessel.client_email} geteilt sein — ` +
      `Rolle "Termine ändern".`);
  }

  return eintrag.busy ?? [];
}

// -----------------------------------------------------------------------------

const ANLEITUNG = (mail) => `
${c(1, 'Google-Kalender anbinden')}

Vier Schritte in der Google Cloud Console — die muss ich dir überlassen,
sie brauchen deinen Login. Alles danach mache ich.

${c(1, '1. Projekt und Kalender-API')}
   → https://console.cloud.google.com/projectcreate
     Name z.B. "voice-agent", anlegen, oben als aktives Projekt wählen.
   → https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
     ${c(1, 'Aktivieren')} klicken.

${c(1, '2. Dienstkonto anlegen')}
   → https://console.cloud.google.com/iam-admin/serviceaccounts/create
     Name: ${c(36, 'voice-agent')}  →  ${c(1, 'Erstellen und fortfahren')}
     Rollen überspringen (werden hier nicht gebraucht)  →  ${c(1, 'Fertig')}

${c(1, '3. Schlüssel herunterladen')}
   In der Liste auf das eben angelegte Konto klicken
   → Reiter ${c(1, 'Schlüssel')} → ${c(1, 'Schlüssel hinzufügen')} → ${c(1, 'Neuen Schlüssel erstellen')} → ${c(1, 'JSON')}
   Die Datei lädt herunter. Auf den Server bringen, z.B.:

     ${c(36, 'scp ~/Downloads/voice-agent-*.json damjan@<server>:~/')}

${c(1, '4. Kalender freigeben')}  ${c(33, '← der Schritt, den man vergisst')}
   → https://calendar.google.com  (angemeldet als ${c(1, mail)})
   Links bei ${c(1, mail)} auf die drei Punkte → ${c(1, 'Einstellungen und Freigabe')}
   Runter zu ${c(1, '"Für bestimmte Personen oder Gruppen freigeben"')}
   → ${c(1, 'Personen hinzufügen')}
   Dort die E-Mail des Dienstkontos eintragen. Sie steht in der JSON-Datei
   unter "client_email" und sieht so aus:

     ${c(36, 'voice-agent@<projekt>.iam.gserviceaccount.com')}

   Berechtigung: ${c(1, 'Termine ändern')}  ${c(90, '(nicht nur "Verfügbarkeit sehen" —')}
   ${c(90, '   sonst kann der Agent lesen, aber nichts eintragen)')}
   → ${c(1, 'Senden')}. Das Dienstkonto bekommt keine Mail und muss nichts bestätigen.

${c(1, 'Dann hier weiter:')}

   ${c(36, 'node scripts/google-kalender.mjs ~/voice-agent-xxxxx.json')}

Ich lege daraufhin die Zugangsdaten in n8n an, trage den Kalender in die
.env ein, stelle die Workflows um und prüfe mit einer echten Abfrage nach.
`;

// -----------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const env = await ladeEnv();
  const mail = env.GOOGLE_KALENDER_PRIMAER || 'damjandak@gmail.com';

  // --- nur prüfen ------------------------------------------------------------
  if (argv.includes('--pruefen')) {
    schritt('Kalenderzugang prüfen');
    const ablage = path.join(WURZEL, 'google-service-account.json');
    if (!existsSync(ablage)) abbruch('Kein Schlüssel hinterlegt. Erst einrichten — siehe --hilfe.');
    const schluessel = JSON.parse(await readFile(ablage, 'utf8'));
    try {
      const belegt = await kalenderProbe(schluessel, mail);
      gut(`${mail} ist erreichbar`);
      info(`${belegt.length} belegte Zeiträume in den nächsten sieben Tagen`);
    } catch (err) {
      abbruch(err.message);
    }
    return;
  }

  const datei = argv.find((a) => !a.startsWith('--'));

  if (!datei) {
    console.log(ANLEITUNG(mail));
    const ablage = path.join(WURZEL, 'google-service-account.json');
    if (existsSync(ablage)) {
      const s = JSON.parse(await readFile(ablage, 'utf8'));
      schritt('Aktueller Stand');
      gut(`Schlüssel liegt bereits vor: ${s.client_email}`);
      info('Prüfen mit: node scripts/google-kalender.mjs --pruefen');
    }
    return;
  }

  // --- einrichten ------------------------------------------------------------
  const pfad = path.resolve(datei.replace(/^~/, process.env.HOME ?? '~'));
  if (!existsSync(pfad)) abbruch(`Datei nicht gefunden: ${pfad}`);

  const schluessel = JSON.parse(await readFile(pfad, 'utf8'));
  if (schluessel.type !== 'service_account' || !schluessel.private_key || !schluessel.client_email) {
    abbruch('Das ist kein Dienstkonto-Schlüssel.\n  Erwartet wird die JSON-Datei aus Schritt 3 der Anleitung.');
  }

  schritt('Schlüssel');
  gut(`Dienstkonto: ${schluessel.client_email}`);
  info(`Projekt: ${schluessel.project_id}`);

  // --- 1. Zugang prüfen, bevor irgendetwas eingerichtet wird -----------------
  schritt(`Zugriff auf ${mail} prüfen`);
  let belegt;
  try {
    belegt = await kalenderProbe(schluessel, mail);
    gut('Kalender ist zugänglich');
    info(`${belegt.length} belegte Zeiträume in den nächsten sieben Tagen`);
  } catch (err) {
    console.log('');
    warn(err.message);
    console.log('');
    info('Schritt 4 der Anleitung fehlt vermutlich noch:');
    info(`  calendar.google.com → ${mail} → Einstellungen und Freigabe`);
    info(`  → Personen hinzufügen → ${schluessel.client_email}`);
    info('  → Berechtigung "Termine ändern"');
    console.log('');
    info('Danach diesen Befehl einfach nochmal ausführen.');
    process.exit(1);
  }

  // --- 2. Schlüssel ablegen ---------------------------------------------------
  const ablage = path.join(WURZEL, 'google-service-account.json');
  await writeFile(ablage, JSON.stringify(schluessel, null, 2) + '\n', { mode: 0o600 });
  gut(`Schlüssel abgelegt: ${path.relative(WURZEL, ablage)} (nur für dich lesbar, nicht in git)`);

  // --- 3. Zugangsdaten in n8n -------------------------------------------------
  schritt('Zugangsdaten in n8n');
  const merkdatei = path.join(WURZEL, 'n8n', '.google-cred-id');
  let credId = existsSync(merkdatei) ? (await readFile(merkdatei, 'utf8')).trim() : null;

  if (credId) {
    info(`vorhanden (${credId}) — wird wiederverwendet`);
  } else {
    const antwort = await fetch(`${env.N8N_INTERN_URL || 'http://127.0.0.1:5679'}/api/v1/credentials`, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { 'X-N8N-API-KEY': env.N8N_API_KEY ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Google Kalender (Dienstkonto)',
        type: 'googleApi',
        data: {
          email: schluessel.client_email,
          privateKey: schluessel.private_key,
          // Ohne das reicht n8n die Zugangsdaten nicht an den HTTP-Node
          // durch — und genau den nutzen unsere Workflows.
          httpNode: true,
          scopes: 'https://www.googleapis.com/auth/calendar',
        },
      }),
    });
    const d = await antwort.json();
    if (!antwort.ok) abbruch(`n8n lehnt die Zugangsdaten ab: ${d.message ?? antwort.status}`);
    credId = d.id;
    await writeFile(merkdatei, `${credId}\n`, 'utf8');
    gut(`angelegt (${credId})`);
  }

  // --- 4. .env ----------------------------------------------------------------
  schritt('Konfiguration');
  await setzeEnv('GOOGLE_AUTH_METHODE', 'dienstkonto');
  await setzeEnv('GOOGLE_KALENDER_PRIMAER', mail);
  if (!env.GOOGLE_KALENDER_IDS || env.GOOGLE_KALENDER_IDS !== mail) {
    await setzeEnv('GOOGLE_KALENDER_IDS', mail);
  }
  gut(`GOOGLE_KALENDER_PRIMAER=${mail}`);
  gut('GOOGLE_AUTH_METHODE=dienstkonto');

  // --- 5. Fertig ---------------------------------------------------------------
  schritt('Was jetzt noch fehlt');
  info('Workflows mit dem neuen Zugang neu importieren:');
  console.log(`     ${c(36, 'node scripts/import-n8n-workflows.mjs')}`);
  info('Danach ein Probeanruf, der wirklich Termine sucht:');
  console.log(`     ${c(36, 'node scripts/test-anruf.mjs --n8n')}`);
  console.log('');
}

main().catch((err) => abbruch(err.stack ?? err.message));
