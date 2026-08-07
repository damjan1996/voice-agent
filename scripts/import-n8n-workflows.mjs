#!/usr/bin/env node
// =============================================================================
//  import-n8n-workflows.mjs — Workflows nach n8n bringen
// =============================================================================
//  Wiederholt aufrufbar: Ein Workflow, den es schon gibt, wird ersetzt statt
//  ein zweites Mal angelegt. Erkannt wird er am Namen.
//
//  Was das Skript außerdem erledigt:
//
//    * Platzhalter ersetzen. Im Repo stehen __CONTROL_API__ und
//      __VOICE_TOKEN__; die echten Werte kommen aus der .env und landen nur
//      in n8n, nie in Git.
//
//    * Den Fehler-Workflow zuerst importieren, damit die anderen ihn
//      referenzieren können.
//
//    * Nach dem Einschalten NACHSEHEN, ob der Webhook wirklich antwortet.
//      n8n meldet beim Aktivieren zuverlässig 200, lässt den Webhook aber in
//      bestimmten Fällen unregistriert (n8n-io/n8n #16339, #21614, #34038).
//      Wer sich auf die 200 verlässt, hat einen Agent, der nicht abnimmt,
//      und ein Dashboard, das alles grün meldet.
//
//    * Das Register in der Datenbank fortschreiben, damit der WhatsApp-Bot
//      weiß, welche Workflows es gibt und was sie tun.
//
//  Aufruf:
//    node scripts/import-n8n-workflows.mjs
//    node scripts/import-n8n-workflows.mjs --dry-run
//    node scripts/import-n8n-workflows.mjs --nur=10-anruf-start
// =============================================================================

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORDNER = path.join(WURZEL, 'n8n', 'workflows');

const argumente = process.argv.slice(2);
const TROCKEN = argumente.includes('--dry-run');
const NUR = argumente.find((a) => a.startsWith('--nur='))?.slice(6) ?? null;
// Nur das Register in der Datenbank auffrischen, ohne Workflows anzufassen.
// Nützlich, wenn jemand in n8n von Hand etwas umbenannt hat.
const NUR_REGISTER = argumente.includes('--nur-register');

const farbe = process.stdout.isTTY;
const c = (code, s) => (farbe ? `[${code}m${s}[0m` : s);
const gut = (s) => console.log(`  ${c(32, '✓')} ${s}`);
const warn = (s) => console.log(`  ${c(33, '!')} ${s}`);
const info = (s) => console.log(`  ${c(90, '·')} ${c(90, s)}`);

function abbruch(m) { console.error(`\n${c(31, 'Abbruch:')} ${m}\n`); process.exit(1); }

// -----------------------------------------------------------------------------
//  Register — was jeder Workflow ist und ob er geschaltet werden darf
// -----------------------------------------------------------------------------
//  Diese Beschreibungen liest später der WhatsApp-Bot vor. Sie sind für
//  Menschen geschrieben, nicht für Maschinen.

const REGISTER = {
  '10-anruf-start': {
    slug: 'anruf-start',
    beschreibung: 'Nimmt den Anruf an: liest den Betriebsmodus, erkennt bekannte Anrufer und legt die Begrüßung fest.',
    webhook: 'voice/init',
    aktiv: true,
    kritisch: true,      // Ohne ihn nimmt niemand ab.
    schaltbar: false,
  },
  '20-verfuegbarkeit': {
    slug: 'verfuegbarkeit',
    beschreibung: 'Rechnet freie Gesprächsfenster aus Kalender und Sprechzeiten aus.',
    webhook: 'voice/verfuegbarkeit',
    aktiv: true,
    kritisch: false,
    schaltbar: true,     // Ohne ihn sagt der Agent, er komme nicht an den Kalender.
  },
  '30-termin-buchen': {
    slug: 'termin-buchen',
    beschreibung: 'Trägt zugesagte Termine in Datenbank und Google-Kalender ein.',
    webhook: 'voice/termin',
    aktiv: true,
    kritisch: false,
    schaltbar: true,
  },
  '40-notiz': {
    slug: 'notiz',
    beschreibung: 'Hält fest, worum es im Anruf ging, und meldet es per WhatsApp.',
    webhook: 'voice/notiz',
    aktiv: true,
    kritisch: true,      // Ohne ihn verschwinden Anrufe spurlos.
    schaltbar: false,
  },
  '50-nachbereitung': {
    slug: 'nachbereitung',
    beschreibung: 'Verarbeitet Abschrift und Auswertung nach dem Auflegen; fasst notfalls mit Claude Haiku nach.',
    webhook: 'voice/postcall',
    aktiv: true,
    kritisch: false,
    schaltbar: true,
  },
  '90-fehlerbehandlung': {
    slug: 'fehlerbehandlung',
    beschreibung: 'Meldet Ausfälle der anderen Workflows per WhatsApp.',
    webhook: null,
    aktiv: false,        // Fehler-Workflows laufen ohne eigenen Trigger.
    kritisch: true,
    schaltbar: false,
  },
};

// Reihenfolge: der Fehler-Workflow zuerst, damit die anderen ihn kennen.
const REIHENFOLGE = ['90-fehlerbehandlung', '10-anruf-start', '20-verfuegbarkeit',
                     '30-termin-buchen', '40-notiz', '50-nachbereitung'];

// -----------------------------------------------------------------------------

async function ladeEnv() {
  const datei = path.join(WURZEL, '.env');
  if (!existsSync(datei)) abbruch('.env fehlt. Vorlage kopieren: cp .env.example .env');
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

let BASIS = '';
let SCHLUESSEL = '';

async function n8n(pfad, { method = 'GET', body } = {}) {
  const antwort = await fetch(`${BASIS}/api/v1${pfad}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      'X-N8N-API-KEY': SCHLUESSEL,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const roh = await antwort.text();
  let daten = null;
  try { daten = roh ? JSON.parse(roh) : null; } catch { daten = { raw: roh.slice(0, 500) }; }

  if (!antwort.ok) {
    if (antwort.status === 404 && /text\/html/.test(antwort.headers.get('content-type') ?? '')) {
      abbruch(
        'Die n8n Public API antwortet nicht (404 als HTML — die Route ist gar nicht\n' +
        '  eingehängt). Das heißt fast immer: N8N_PUBLIC_API_DISABLED steht auf true.\n' +
        '  In docker-compose.yml auf "false" setzen und "docker compose up -d n8n".',
      );
    }
    throw new Error(`${method} ${pfad} → ${antwort.status}: ${daten?.message ?? roh.slice(0, 300)}`);
  }
  return daten;
}

/**
 * Legt die Zugangsdaten an, mit denen die Webhooks sich absichern.
 *
 * Ohne Authentifizierung am Webhook nimmt n8n jede Anfrage aus dem Internet
 * an, startet den Workflow und lässt ihn erst beim Aufruf der Control-API
 * mit 401 scheitern. Jede dieser Anfragen erzeugt dann eine gescheiterte
 * Ausführung samt gespeicherter Nutzlast und löst den Fehler-Workflow aus —
 * der wiederum eine WhatsApp-Meldung schreibt. Ein einzelner Angreifer
 * könnte damit die Warteschlange fluten und die Platte vollschreiben.
 *
 * Mit Header-Auth lehnt n8n unbefugte Anfragen direkt mit 403 ab: kein
 * Workflow, keine Ausführung, keine Meldung.
 */
async function credentialSicherstellen({ merkname, anzeige, kopfName, wert, zweck }) {
  // Die Public API kann Zugangsdaten anlegen, aber nicht auflisten. Ein
  // zweiter Lauf würde also ein Duplikat erzeugen — deshalb wird die ID
  // gemerkt und wiederverwendet.
  const merkdatei = path.join(WURZEL, 'n8n', merkname);
  if (existsSync(merkdatei)) {
    const id = (await readFile(merkdatei, 'utf8')).trim();
    if (id) { info(`${anzeige} vorhanden (${id})`); return id; }
  }

  if (!wert) {
    warn(`${anzeige}: kein Wert in der .env — übersprungen.`);
    warn(`  ${zweck}`);
    return null;
  }

  if (TROCKEN) { info(`würde ${anzeige} anlegen`); return null; }

  try {
    const neu = await n8n('/credentials', {
      method: 'POST',
      body: { name: anzeige, type: 'httpHeaderAuth', data: { name: kopfName, value: wert } },
    });
    await writeFile(merkdatei, `${neu.id}\n`, 'utf8');
    gut(`${anzeige} angelegt (${neu.id})`);
    return neu.id;
  } catch (err) {
    warn(`${anzeige} nicht angelegt: ${err.message}`);
    warn(`  ${zweck}`);
    return null;
  }
}

async function zugangsdatenSicherstellen(env) {
  const webhook = await credentialSicherstellen({
    merkname: '.credential-id',
    anzeige: 'Voice-Agent Webhook-Token',
    kopfName: 'X-Voice-Token',
    wert: env.VOICE_WEBHOOK_TOKEN,
    zweck: 'Ohne sie bleiben die Webhooks unauthentifiziert — im n8n-Editor nachtragen.',
  });

  const anthropic = await credentialSicherstellen({
    merkname: '.anthropic-cred-id',
    anzeige: 'Anthropic (Voice-Agent)',
    kopfName: 'x-api-key',
    wert: env.ANTHROPIC_API_KEY,
    zweck: 'Ohne sie kann die Nachbereitung Gespräche nicht zusammenfassen.',
  });

  // Die Google-Zugangsdaten legt scripts/google-kalender.mjs an — dort, wo
  // auch der Schlüssel geprüft wird. Hier wird die ID nur nachgeschlagen.
  const merk = path.join(WURZEL, 'n8n', '.google-cred-id');
  let google = null;
  if (existsSync(merk)) {
    google = (await readFile(merk, 'utf8')).trim() || null;
    if (google) info(`Google-Kalender-Zugang vorhanden (${google})`);
  } else {
    warn('Kein Google-Kalender-Zugang — der Agent kann keine Termine vergeben.');
    warn('  Einrichten: node scripts/google-kalender.mjs');
  }

  return { webhook, anthropic, google };
}

/**
 * Hängt die Zugangsdaten an die Nodes, die sie brauchen.
 *
 *   Webhook-Nodes  bekommen Header-Auth, damit n8n unbefugte Anfragen mit 403
 *                  abweist, statt den Workflow zu starten.
 *   Anthropic-Node bekommt den API-Schlüssel. Fehlt er, scheitert die
 *                  Nachbereitung still — der Anruf steht in der Datenbank,
 *                  aber ohne Zusammenfassung.
 */
function zugangsdatenAnhaengen(workflow, { webhook, anthropic, google }) {
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.webhook' && webhook) {
      node.parameters = { ...node.parameters, authentication: 'headerAuth' };
      node.credentials = {
        ...node.credentials,
        httpHeaderAuth: { id: webhook, name: 'Voice-Agent Webhook-Token' },
      };
    }

    if (anthropic && node.parameters?.url?.includes('api.anthropic.com')) {
      node.credentials = {
        ...node.credentials,
        httpHeaderAuth: { id: anthropic, name: 'Anthropic (Voice-Agent)' },
      };
    }

    if (google && node.parameters?.url?.includes('googleapis.com')) {
      const typ = node.parameters.nodeCredentialType;
      node.credentials = {
        ...node.credentials,
        [typ]: {
          id: google,
          name: typ === 'googleApi' ? 'Google Kalender (Dienstkonto)' : 'Google Kalender (OAuth2)',
        },
      };
    }
  }
  return workflow;
}

/** Ersetzt die Platzhalter im gesamten Workflow-JSON. */
function platzhalterErsetzen(text, env, fehlerWorkflowId) {
  const ersatz = {
    __CONTROL_API__: env.CONTROL_API_INTERN_URL || 'http://control-api:3010',
    __VOICE_TOKEN__: env.VOICE_WEBHOOK_TOKEN ?? '',
    __KALENDER_IDS__: env.GOOGLE_KALENDER_IDS || env.GOOGLE_KALENDER_PRIMAER || '',
    __KALENDER_PRIMAER__: env.GOOGLE_KALENDER_PRIMAER || '',
    __VORLAUF_STUNDEN__: env.TERMIN_VORLAUF_STUNDEN || '3',
    // Dienstkonto läuft headless und läuft nie ab; OAuth2 kann dafür
    // Kalendereinladungen an Anrufer verschicken. Siehe docs/03-einrichtung.md.
    __GOOGLE_CRED_TYPE__: (env.GOOGLE_AUTH_METHODE || 'dienstkonto') === 'oauth2'
      ? 'googleCalendarOAuth2Api'
      : 'googleApi',
    voiceagent90fehler: fehlerWorkflowId ?? '',
  };

  let ergebnis = text;
  for (const [platzhalter, wert] of Object.entries(ersatz)) {
    if (!ergebnis.includes(platzhalter)) continue;
    if (!wert) {
      warn(`${platzhalter} ist leer — der betroffene Node wird nicht funktionieren.`);
    }
    // JSON-sicher: der Wert steht in einer Zeichenkette, also müssen
    // Anführungszeichen und Backslashes maskiert werden.
    const sicher = JSON.stringify(String(wert)).slice(1, -1);
    ergebnis = ergebnis.split(platzhalter).join(sicher);
  }
  return ergebnis;
}

/**
 * Beim Import darf nur mitgeschickt werden, was n8n auch annimmt.
 * id, active, tags, versionId, meta und createdAt führen zu 400 —
 * teils mit wenig hilfreichen Meldungen wie "request/body must NOT have
 * additional properties".
 */
function fuerImport(workflow) {
  return {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings ?? { executionOrder: 'v1' },
  };
}

/**
 * Antwortet der Production-Webhook wirklich?
 *
 * Zwei Fragen in einer: Kennt n8n die Route überhaupt (das ist der bekannte
 * Registrierungsfehler), und ist sie von außen erreichbar (DNS, nginx,
 * Zertifikat)? Beides getrennt zu melden spart Sucherei — "antwortet nicht"
 * schickt einen sonst in die falsche Richtung.
 */
async function webhookPruefen(basisUrl, pfad) {
  if (!pfad || !basisUrl) return { geprueft: false };
  try {
    const antwort = await fetch(`${basisUrl.replace(/\/$/, '')}/webhook/${pfad}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' },
      // Absichtlich ohne gültigen Token: es geht nur darum, ob n8n die Route
      // kennt. Eine 401 aus der Control-API ist ein voller Erfolg — der Weg
      // steht, nur die Anmeldung fehlt.
      body: JSON.stringify({ __probe: true }),
    });
    return { geprueft: true, status: antwort.status, registriert: antwort.status !== 404 };
  } catch (err) {
    return { geprueft: true, unerreichbar: true, fehler: err.message };
  }
}

// -----------------------------------------------------------------------------

async function main() {
  const env = await ladeEnv();
  BASIS = (env.N8N_INTERN_URL || 'http://127.0.0.1:5679').replace(/\/$/, '');
  SCHLUESSEL = env.N8N_API_KEY ?? '';

  if (!SCHLUESSEL) {
    abbruch(
      'N8N_API_KEY fehlt.\n' +
      `  In n8n anlegen: ${env.N8N_BASE_URL || 'https://' + (env.N8N_DOMAIN ?? 'n8n')} → Settings → n8n API → Create API key\n` +
      '  Dann in die .env eintragen.',
    );
  }

  console.log(c(1, '\nVoice-Agent — Workflows nach n8n importieren'));
  console.log(c(90, `  Ziel: ${BASIS}`));
  if (TROCKEN) console.log(c(33, '  Probelauf — es wird nichts verändert.'));
  console.log('');

  const dateien = (await readdir(ORDNER)).filter((f) => f.endsWith('.json'));
  const vorhanden = await n8n('/workflows?limit=250');
  const nachName = new Map((vorhanden?.data ?? []).map((w) => [w.name, w]));

  const credentials = NUR_REGISTER ? {} : await zugangsdatenSicherstellen(env);
  if (!NUR_REGISTER) console.log('');

  // Die ID des Fehler-Workflows aus dem Bestand vorbelegen. Wird nur eine
  // Teilmenge importiert (--nur=20), wird der Fehler-Workflow übersprungen
  // und fehlerWorkflowId bliebe null — der Platzhalter würde durch einen
  // Leerstring ersetzt und der importierte Workflow verlöre seine
  // Fehler-Verknüpfung. Ausfälle blieben dann still.
  const fehlerName = REGISTER['90-fehlerbehandlung'].name
    ?? '90 · Fehlerbehandlung';
  let fehlerWorkflowId = (vorhanden?.data ?? [])
    .find((w) => w.name.startsWith('90 ·'))?.id ?? null;

  const ergebnisse = [];

  for (const basis of (NUR_REGISTER ? [] : REIHENFOLGE)) {
    const datei = dateien.find((f) => f.startsWith(basis));
    if (!datei) { warn(`${basis}.json nicht gefunden — übersprungen`); continue; }
    if (NUR && !basis.includes(NUR)) { info(`${basis} übersprungen (--nur)`); continue; }

    const eintrag = REGISTER[basis];
    const rohText = await readFile(path.join(ORDNER, datei), 'utf8');
    const workflow = zugangsdatenAnhaengen(
      JSON.parse(platzhalterErsetzen(rohText, env, fehlerWorkflowId)),
      credentials,
    );
    const alt = nachName.get(workflow.name);

    if (TROCKEN) {
      info(`${workflow.name} würde ${alt ? 'aktualisiert' : 'angelegt'}`);
      ergebnisse.push({ ...eintrag, name: workflow.name, id: alt?.id ?? null });
      continue;
    }

    let id;
    if (alt) {
      await n8n(`/workflows/${alt.id}`, { method: 'PUT', body: fuerImport(workflow) });
      id = alt.id;
      gut(`${workflow.name} aktualisiert (${id})`);
    } else {
      const neu = await n8n('/workflows', { method: 'POST', body: fuerImport(workflow) });
      id = neu.id;
      gut(`${workflow.name} angelegt (${id})`);
    }

    if (basis === '90-fehlerbehandlung') fehlerWorkflowId = id;

    // Schalten. Ein Workflow, der schon im richtigen Zustand ist, wird in
    // Ruhe gelassen — jedes Aus/Ein ist eine Gelegenheit für den
    // Registrierungsfehler oben.
    const istAktiv = Boolean(alt?.active);
    if (eintrag.aktiv && !istAktiv) {
      await n8n(`/workflows/${id}/activate`, { method: 'POST' });
      info('eingeschaltet');
    } else if (!eintrag.aktiv && istAktiv) {
      await n8n(`/workflows/${id}/deactivate`, { method: 'POST' });
      info('ausgeschaltet');
    }

    ergebnisse.push({ ...eintrag, name: workflow.name, id });
  }

  // Im Nur-Register-Lauf kommen die IDs aus dem Bestand statt aus dem Import.
  if (NUR_REGISTER) {
    for (const [basis, eintrag] of Object.entries(REGISTER)) {
      const nr = basis.slice(0, 2);
      const live = (vorhanden?.data ?? []).find((w) => w.name.startsWith(`${nr} ·`));
      if (!live) { warn(`${eintrag.slug} liegt nicht in n8n — übersprungen`); continue; }
      ergebnisse.push({ ...eintrag, name: live.name, id: live.id, aktiv: live.active });
    }
    info(`${ergebnisse.length} Workflows im Bestand gefunden`);
  }

  // --- Nachsehen, ob die Webhooks wirklich stehen ----------------------------

  if (!TROCKEN && !NUR_REGISTER) {
    console.log(`\n${c(1, '▸')} ${c(1, 'Webhooks nachprüfen')}`);
    // Erst lokal: kennt n8n die Route? Das ist die Frage, die der bekannte
    // Registrierungsfehler betrifft, und sie hängt nicht an DNS.
    let nichtRegistriert = 0;
    for (const e of ergebnisse.filter((x) => x.webhook && x.aktiv)) {
      const p = await webhookPruefen(BASIS, e.webhook);
      if (p.registriert) {
        gut(`${e.webhook} — in n8n registriert (HTTP ${p.status})`);
      } else {
        nichtRegistriert++;
        warn(`${e.webhook} — NICHT registriert ${p.fehler ? `(${p.fehler})` : `(HTTP ${p.status})`}`);
      }
    }

    if (nichtRegistriert) {
      console.log('');
      warn('n8n hat das Einschalten bestätigt, aber Webhooks nicht registriert.');
      warn('Das ist ein bekannter Fehler in n8n. Hilft fast immer:');
      warn('  docker compose restart n8n && sleep 30 && make import');
    }

    // Dann von außen: kommt ElevenLabs überhaupt an? Getrennt gemeldet, weil
    // hier ganz andere Ursachen in Frage kommen — DNS, nginx, Zertifikat.
    const oeffentlich = env.N8N_BASE_URL || (env.N8N_DOMAIN ? `https://${env.N8N_DOMAIN}` : null);
    if (oeffentlich) {
      console.log('');
      const p = await webhookPruefen(oeffentlich, 'voice/init');
      if (p.unerreichbar) {
        warn(`Von außen nicht erreichbar: ${oeffentlich} (${p.fehler})`);
        info('Solange das so ist, kann ElevenLabs den Agent nicht aufrufen. Zu prüfen:');
        info(`  1. DNS: A-Record für ${env.N8N_DOMAIN ?? '<Domain>'} auf diesen Server`);
        info('  2. nginx: deploy/nginx/voice-agent.conf eingespielt und neu geladen?');
        info(`  3. Zertifikat: sudo certbot --nginx -d ${env.N8N_DOMAIN ?? '<Domain>'}`);
      } else {
        gut(`Von außen erreichbar: ${oeffentlich} (HTTP ${p.status})`);
      }
    }
  }

  // --- Register in der Datenbank fortschreiben -------------------------------

  console.log(`\n${c(1, '▸')} ${c(1, 'Register für den WhatsApp-Bot')}`);
  const control = env.CONTROL_API_URL || `http://127.0.0.1:${env.CONTROL_API_PORT || 3010}`;

  if (!env.CONTROL_API_TOKEN) {
    warn('CONTROL_API_TOKEN fehlt — Register nicht aktualisiert.');
  } else if (TROCKEN) {
    info(`${ergebnisse.length} Einträge würden geschrieben`);
  } else {
    try {
      const antwort = await fetch(`${control}/v1/workflows/register`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${env.CONTROL_API_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Akteur': 'import-skript',
        },
        body: JSON.stringify({ workflows: ergebnisse }),
      });
      if (antwort.ok) gut(`${ergebnisse.length} Workflows registriert`);
      else warn(`Register nicht aktualisiert: HTTP ${antwort.status}`);
    } catch (err) {
      warn(`Control-API nicht erreichbar: ${err.message}`);
      info('Nachholen mit: make register');
    }
  }

  console.log(`\n${c(1, 'Fertig.')} Zustand ansehen: ${c(90, 'make status')}\n`);
}

main().catch((err) => abbruch(err.stack ?? err.message));
