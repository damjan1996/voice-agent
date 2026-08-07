#!/usr/bin/env node
// =============================================================================
//  provision-elevenlabs.mjs — richtet den Agent bei ElevenLabs ein
// =============================================================================
//  Wiederholt aufrufbar. Jeder Schritt prüft erst, ob es die Ressource schon
//  gibt, und aktualisiert sie dann, statt eine zweite anzulegen. Man kann das
//  Skript also nach jeder Prompt-Änderung erneut laufen lassen.
//
//  Reihenfolge, weil jeder Schritt IDs für den nächsten liefert:
//    1. Secret für den Webhook-Token   → wird von den Tools referenziert
//    2. Wissensdokumente               → Damjan-Fakten
//    3. Server-Tools                   → Kalender, Termin, Notiz
//    4. Post-Call-Webhook              → Nachbereitung in n8n
//    5. Vorab-Webhook (Workspace)      → Modus und Anrufer je Anruf
//    6. Agent                          → bindet 1–5 zusammen
//
//  Aufruf:
//    node scripts/provision-elevenlabs.mjs            # anlegen/aktualisieren
//    node scripts/provision-elevenlabs.mjs --dry-run  # nur zeigen, was käme
//    node scripts/provision-elevenlabs.mjs --nur=agent
//
//  Die erzeugten IDs landen in elevenlabs/.provisioned.json und werden beim
//  nächsten Lauf wiederverwendet. Diese Datei gehört NICHT ins Repo.
// =============================================================================

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZUSTANDSDATEI = path.join(WURZEL, 'elevenlabs', '.provisioned.json');
const BASIS = 'https://api.elevenlabs.io/v1';

const argumente = process.argv.slice(2);
const TROCKEN = argumente.includes('--dry-run');
const NUR = argumente.find((a) => a.startsWith('--nur='))?.slice(6)?.split(',') ?? null;

// --- Ausgabe -----------------------------------------------------------------

const farbe = process.stdout.isTTY;
const c = (code, s) => (farbe ? `[${code}m${s}[0m` : s);
const info = (s) => console.log(`  ${s}`);
const schritt = (s) => console.log(`\n${c(1, '▸')} ${c(1, s)}`);
const gut = (s) => console.log(`  ${c(32, '✓')} ${s}`);
const warn = (s) => console.log(`  ${c(33, '!')} ${s}`);
const uebersprungen = (s) => console.log(`  ${c(90, '·')} ${c(90, s)}`);

function abbruch(nachricht) {
  console.error(`\n${c(31, 'Abbruch:')} ${nachricht}\n`);
  process.exit(1);
}

const machen = (name) => !NUR || NUR.includes(name);

// --- .env --------------------------------------------------------------------

async function ladeEnv() {
  const datei = path.join(WURZEL, '.env');
  if (!existsSync(datei)) {
    abbruch('.env fehlt. Vorlage kopieren: cp .env.example .env');
  }

  const env = {};
  const inhalt = await readFile(datei, 'utf8');
  for (const zeile of inhalt.split('\n')) {
    const treffer = zeile.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!treffer) continue;
    let wert = treffer[2].trim();
    // Anführungszeichen entfernen, aber nur wenn sie paarweise außen stehen.
    if (/^".*"$/.test(wert) || /^'.*'$/.test(wert)) wert = wert.slice(1, -1);
    env[treffer[1]] = wert;
  }
  return { ...env, ...process.env };
}

// --- HTTP --------------------------------------------------------------------

let SCHLUESSEL = '';

async function api(pfad, { method = 'GET', body, erlaubt404 = false } = {}) {
  const antwort = await fetch(`${BASIS}${pfad}`, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      'xi-api-key': SCHLUESSEL,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const roh = await antwort.text();
  let daten = null;
  try { daten = roh ? JSON.parse(roh) : null; } catch { daten = { raw: roh }; }

  if (antwort.status === 404 && erlaubt404) return null;

  if (!antwort.ok) {
    const detail = daten?.detail;
    const meldung = typeof detail === 'string' ? detail
      : detail?.message ?? JSON.stringify(detail ?? daten).slice(0, 900);
    throw new Error(`${method} ${pfad} → ${antwort.status}\n     ${meldung}`);
  }
  return daten;
}

// --- Konfiguration aufbereiten -----------------------------------------------

/** Entfernt alle Schlüssel mit führendem Unterstrich — das sind Kommentare. */
function ohneKommentare(wert) {
  if (Array.isArray(wert)) return wert.map(ohneKommentare);
  if (wert && typeof wert === 'object') {
    return Object.fromEntries(
      Object.entries(wert)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, ohneKommentare(v)]),
    );
  }
  return wert;
}

/**
 * Ersetzt ${NAME} in allen Zeichenketten.
 *
 * Ein unbekannter Platzhalter bricht ab, statt "${OWNER_PHONE}" wörtlich an
 * ElevenLabs zu schicken. Der Agent würde sonst versuchen, eine Nummer namens
 * "${OWNER_PHONE}" anzurufen — und das fiele erst beim ersten echten
 * Durchstellversuch auf.
 */
function ersetze(wert, env, pfad = '') {
  if (typeof wert === 'string') {
    return wert.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
      const v = env[name];
      if (v === undefined || v === '') {
        abbruch(`Platzhalter \${${name}} (bei ${pfad || 'Wurzel'}) ist in der .env nicht gesetzt.`);
      }
      return v;
    });
  }
  if (Array.isArray(wert)) return wert.map((v, i) => ersetze(v, env, `${pfad}[${i}]`));
  if (wert && typeof wert === 'object') {
    return Object.fromEntries(
      Object.entries(wert).map(([k, v]) => [k, ersetze(v, env, pfad ? `${pfad}.${k}` : k)]),
    );
  }
  return wert;
}

/** Entfernt den HTML-Kommentarblock am Anfang des Systemprompts. */
function promptAufbereiten(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->\s*/g, '').trim();
}

// --- Zustand -----------------------------------------------------------------

async function ladeZustand() {
  if (!existsSync(ZUSTANDSDATEI)) return {};
  try { return JSON.parse(await readFile(ZUSTANDSDATEI, 'utf8')); } catch { return {}; }
}

async function speichereZustand(zustand) {
  if (TROCKEN) return;
  await writeFile(ZUSTANDSDATEI, JSON.stringify(zustand, null, 2) + '\n', 'utf8');
}

// =============================================================================
//  Schritte
// =============================================================================

/** 1. Secret, das die Tools als X-Voice-Token mitschicken. */
async function secretSicherstellen(env, zustand) {
  schritt('Webhook-Token als Workspace-Secret');
  const name = 'VOICEAGENT_WEBHOOK_TOKEN';

  const vorhanden = await api('/convai/secrets');
  const treffer = (vorhanden?.secrets ?? []).find((s) => s.name === name);

  if (treffer) {
    // Der Wert eines Secrets ist nicht auslesbar. Ob er noch zum .env-Wert
    // passt, kann hier also niemand prüfen — deshalb wird bei jedem Lauf
    // überschrieben. Das ist billig und schließt die Lücke, dass jemand den
    // Token in der .env dreht und sich wundert, warum n8n 401 antwortet.
    if (TROCKEN) { uebersprungen(`würde Secret ${name} aktualisieren`); return treffer.secret_id; }
    await api(`/convai/secrets/${treffer.secret_id}`, {
      method: 'PATCH',
      body: { type: 'update', name, value: env.VOICE_WEBHOOK_TOKEN },
    });
    gut(`Secret ${name} aktualisiert (${treffer.secret_id})`);
    return treffer.secret_id;
  }

  if (TROCKEN) { uebersprungen(`würde Secret ${name} anlegen`); return 'sec_dry_run'; }
  const neu = await api('/convai/secrets', {
    method: 'POST',
    body: { type: 'new', name, value: env.VOICE_WEBHOOK_TOKEN },
  });
  gut(`Secret ${name} angelegt (${neu.secret_id})`);
  return neu.secret_id;
}

/** 2. Wissensdokumente aus elevenlabs/knowledge/. */
async function wissenSicherstellen(zustand) {
  schritt('Wissensbasis');
  const ordner = path.join(WURZEL, 'elevenlabs', 'knowledge');
  const dateien = (await readdir(ordner)).filter((f) => f.endsWith('.md')).sort();

  const vorhanden = await api('/convai/knowledge-base?page_size=100');
  const nachName = new Map((vorhanden?.documents ?? []).map((d) => [d.name, d]));
  const locators = [];

  for (const datei of dateien) {
    const name = `voiceagent-${path.basename(datei, '.md')}`;
    const text = await readFile(path.join(ordner, datei), 'utf8');
    const alt = nachName.get(name);

    if (alt) {
      // Ein Textdokument lässt sich nicht in place ersetzen; alt weg, neu hin.
      // Die Reihenfolge ist Absicht: erst das neue anlegen, dann das alte
      // löschen wäre sauberer, scheitert aber am eindeutigen Namen.
      if (TROCKEN) { uebersprungen(`würde ${name} ersetzen`); locators.push({ type: 'text', name, id: alt.id }); continue; }
      await api(`/convai/knowledge-base/${alt.id}`, { method: 'DELETE', erlaubt404: true });
    }

    if (TROCKEN) { uebersprungen(`würde ${name} anlegen`); locators.push({ type: 'text', name, id: 'kb_dry_run' }); continue; }
    const neu = await api('/convai/knowledge-base/text', { method: 'POST', body: { name, text } });
    gut(`${name} (${neu.id})`);
    locators.push({ type: 'text', name, id: neu.id, usage_mode: 'auto' });
  }

  zustand.knowledge = locators;
  return locators;
}

/** 3. Server-Tools aus elevenlabs/tools/. */
async function toolsSicherstellen(env, secretId, zustand) {
  schritt('Server-Tools');
  const ordner = path.join(WURZEL, 'elevenlabs', 'tools');
  const dateien = (await readdir(ordner)).filter((f) => f.endsWith('.json')).sort();

  const vorhanden = await api('/convai/tools');
  const nachName = new Map(
    (vorhanden?.tools ?? []).map((t) => [t.tool_config?.name ?? t.name, t]),
  );

  const ids = [];
  const umgebung = { ...env, SECRET_ID_WEBHOOK_TOKEN: secretId };

  for (const datei of dateien) {
    const roh = JSON.parse(await readFile(path.join(ordner, datei), 'utf8'));
    const konfig = ersetze(ohneKommentare(roh), umgebung, datei);
    const name = konfig.tool_config.name;
    const alt = nachName.get(name);

    if (TROCKEN) {
      uebersprungen(`würde Tool ${name} ${alt ? 'aktualisieren' : 'anlegen'}`);
      ids.push(alt?.id ?? 'tool_dry_run');
      continue;
    }

    if (alt) {
      const id = alt.id ?? alt.tool_id;
      await api(`/convai/tools/${id}`, { method: 'PATCH', body: konfig });
      gut(`${name} aktualisiert (${id})`);
      ids.push(id);
    } else {
      const neu = await api('/convai/tools', { method: 'POST', body: konfig });
      const id = neu.id ?? neu.tool_id;
      gut(`${name} angelegt (${id})`);
      ids.push(id);
    }
  }

  zustand.tools = ids;
  return ids;
}

/**
 * 4. Post-Call-Webhook (Workspace-Ressource).
 *
 * Zwei Eigenheiten der API, die den Ablauf bestimmen:
 *
 *   * Die Ziel-URL lässt sich per PATCH NICHT ändern — das Feld gibt es dort
 *     nicht. Zeigt der Webhook woanders hin, muss er neu angelegt werden.
 *
 *   * Das HMAC-Geheimnis liefert ausschließlich die Antwort auf das POST,
 *     und zwar genau einmal. Es gibt keinen Weg, es später auszulesen. Wer
 *     es verliert, braucht einen neuen Webhook.
 *
 * Daraus folgt: Fehlt das Geheimnis in der .env, ist der vorhandene Webhook
 * wertlos — die Signaturprüfung könnte nie gelingen. Dann wird er ersetzt.
 */
async function postCallWebhookSicherstellen(env, zustand) {
  schritt('Post-Call-Webhook');
  const name = 'voiceagent-postcall';
  const url = `${env.VOICE_WEBHOOK_BASE}/postcall`;

  const vorhanden = await api('/workspace/webhooks?include_usages=false');
  const treffer = (vorhanden?.webhooks ?? []).find((w) => w.name === name);

  const neuAnlegen = async (grund) => {
    if (grund) info(grund);
    if (TROCKEN) { uebersprungen(`würde Webhook ${name} anlegen`); return 'whk_dry_run'; }

    const neu = await api('/workspace/webhooks', {
      method: 'POST',
      body: { settings: { auth_type: 'hmac', name, webhook_url: url } },
    });
    gut(`${name} angelegt (${neu.webhook_id})`);

    const geheimnis = neu.webhook_secret;
    if (geheimnis) {
      console.log('');
      console.log(c(33, '  ┌─ NUR JETZT SICHTBAR ──────────────────────────────────────┐'));
      console.log(c(33, '  │ HMAC-Geheimnis des Post-Call-Webhooks. In die .env:       │'));
      console.log(c(33, '  └───────────────────────────────────────────────────────────┘'));
      console.log(`  ${c(1, `ELEVENLABS_WEBHOOK_SECRET=${geheimnis}`)}\n`);
      console.log(c(90, '  Danach: docker compose up -d control-api\n'));
    } else {
      warn('Kein Geheimnis in der Antwort. Ohne es werden Post-Call-Aufrufe');
      warn('abgewiesen. Im Dashboard nachsehen: Settings → Webhooks.');
    }
    return neu.webhook_id;
  };

  if (!treffer) return neuAnlegen();

  const zeigtWoandersHin = treffer.webhook_url && treffer.webhook_url !== url;
  const geheimnisFehlt = !env.ELEVENLABS_WEBHOOK_SECRET;

  if (zeigtWoandersHin || geheimnisFehlt) {
    if (!TROCKEN) {
      // Ein verknüpfter Webhook lässt sich nicht löschen ("still in use").
      // Erst die Bindung in den Workspace-Einstellungen lösen.
      await api('/convai/settings', {
        method: 'PATCH',
        body: { webhooks: { post_call_webhook_id: null, events: ['transcript'] } },
      }).catch((err) => warn(`Bindung nicht gelöst: ${err.message}`));

      await api(`/workspace/webhooks/${treffer.webhook_id}`, { method: 'DELETE', erlaubt404: true });
    }
    return neuAnlegen(zeigtWoandersHin
      ? `Alter Webhook zeigte auf ${treffer.webhook_url} — wird ersetzt.`
      : 'ELEVENLABS_WEBHOOK_SECRET fehlt in der .env — Webhook wird neu angelegt.');
  }

  if (TROCKEN) { uebersprungen(`Webhook ${name} ist in Ordnung`); return treffer.webhook_id; }

  // Nur Kosmetik und Zustellverhalten — die URL bleibt, wie sie ist.
  await api(`/workspace/webhooks/${treffer.webhook_id}`, {
    method: 'PATCH',
    body: { name, is_disabled: false, retry_enabled: true },
  });
  gut(`${name} unverändert und aktiv (${treffer.webhook_id})`);
  return treffer.webhook_id;
}

/** 5. Vorab-Webhook workspaceweit eintragen. */
async function vorabWebhookSicherstellen(env, secretId, postCallId) {
  schritt('Vorab-Webhook (Modus und Anrufer je Anruf)');
  const url = `${env.VOICE_WEBHOOK_BASE}/init`;

  if (TROCKEN) { uebersprungen(`würde Vorab-Webhook auf ${url} setzen`); return; }

  await api('/convai/settings', {
    method: 'PATCH',
    body: {
      conversation_initiation_client_data_webhook: {
        url,
        request_headers: { 'X-Voice-Token': { secret_id: secretId } },
      },
      webhooks: {
        post_call_webhook_id: postCallId,
        events: ['transcript', 'call_initiation_failure'],
        transcript_format: 'json',
      },
    },
  });
  gut(`Vorab-Webhook → ${url}`);
  gut('Post-Call-Webhook workspaceweit verknüpft');
}

/**
 * 5b. Die Stimme muss im eigenen Konto liegen.
 *
 * Stimmen aus der öffentlichen Bibliothek sind nicht automatisch verfügbar —
 * das Anlegen des Agents scheitert sonst mit "A voice for the voice_id … was
 * not found", was nicht danach klingt, als fehlte bloß ein Klick.
 * Deshalb wird sie hier bei Bedarf übernommen.
 */
async function stimmeSicherstellen(env) {
  schritt('Stimme');
  const gewuenscht = env.ELEVENLABS_VOICE_ID;

  const eigene = await api('/voices?page_size=100').catch(() => null);
  if ((eigene?.voices ?? []).some((v) => v.voice_id === gewuenscht)) {
    const v = eigene.voices.find((x) => x.voice_id === gewuenscht);
    gut(`„${v.name}" liegt im Konto`);
    return;
  }

  if (TROCKEN) { uebersprungen(`würde Stimme ${gewuenscht} übernehmen`); return; }

  // In der Bibliothek nachsehen. Ohne den Eigentümer geht das Übernehmen nicht.
  const geteilt = await api(`/shared-voices?page_size=100&search=${encodeURIComponent(gewuenscht)}`)
    .catch(() => null);
  let treffer = (geteilt?.voices ?? []).find((v) => v.voice_id === gewuenscht);

  if (!treffer) {
    // Die Suche greift nicht immer auf die ID. Deutsche Stimmen durchgehen.
    const de = await api('/shared-voices?language=de&page_size=100').catch(() => null);
    treffer = (de?.voices ?? []).find((v) => v.voice_id === gewuenscht);
  }

  if (!treffer) {
    warn(`Stimme ${gewuenscht} weder im Konto noch in der Bibliothek gefunden.`);
    warn('ELEVENLABS_VOICE_ID prüfen — das Anlegen des Agents wird sonst scheitern.');
    return;
  }

  if (treffer.free_users_allowed === false) {
    warn(`„${treffer.name}" ist im kostenlosen Tarif gesperrt.`);
    warn('Entweder eine andere Stimme wählen oder den Tarif anheben.');
  }

  await api(`/voices/add/${treffer.public_owner_id}/${gewuenscht}`, {
    method: 'POST',
    body: { new_name: `${treffer.name} — Vorzimmer` },
  });
  gut(`„${treffer.name}" ins Konto übernommen`);
}

/** 6. Der Agent selbst. */
async function agentSicherstellen(env, zustand, { toolIds, wissen }) {
  schritt('Agent');

  const roh = JSON.parse(await readFile(path.join(WURZEL, 'elevenlabs', 'agent.config.json'), 'utf8'));
  const konfig = ersetze(ohneKommentare(roh), env, 'agent.config.json');

  konfig.conversation_config.agent.prompt.prompt = promptAufbereiten(
    await readFile(path.join(WURZEL, 'elevenlabs', 'prompts', 'system-prompt.md'), 'utf8'),
  );
  konfig.conversation_config.agent.prompt.tool_ids = toolIds;
  konfig.conversation_config.agent.prompt.knowledge_base = wissen;

  // Ohne Zielnummer ergibt das Durchstellen-Werkzeug keinen Sinn. Es dann
  // wegzulassen ist ehrlicher, als es mit einem leeren Ziel anzulegen.
  if (!env.OWNER_PHONE) {
    delete konfig.conversation_config.agent.prompt.built_in_tools.transfer_to_number;
    warn('OWNER_PHONE ist nicht gesetzt — Durchstellen ist deaktiviert.');
  }

  const agentId = zustand.agent_id || env.ELEVENLABS_AGENT_ID;

  if (agentId) {
    const bestand = await api(`/convai/agents/${agentId}`, { erlaubt404: true });
    if (bestand) {
      if (TROCKEN) { uebersprungen(`würde Agent ${agentId} aktualisieren`); return agentId; }
      await api(`/convai/agents/${agentId}`, { method: 'PATCH', body: konfig });
      gut(`Agent aktualisiert (${agentId})`);
      return agentId;
    }
    warn(`Agent ${agentId} existiert nicht mehr — es wird ein neuer angelegt.`);
  }

  if (TROCKEN) {
    uebersprungen('würde neuen Agent anlegen');
    console.log(c(90, JSON.stringify(konfig, null, 2).split('\n').slice(0, 40).map((l) => '    ' + l).join('\n')));
    return 'agent_dry_run';
  }

  const neu = await api('/convai/agents/create', { method: 'POST', body: konfig });
  gut(`Agent angelegt (${neu.agent_id})`);
  console.log(`\n  ${c(1, 'In die .env eintragen:')}`);
  console.log(`  ELEVENLABS_AGENT_ID=${neu.agent_id}\n`);
  return neu.agent_id;
}

/** Zum Schluss: was noch von Hand zu tun ist. */
function abschluss(env, zustand) {
  schritt('Was jetzt noch fehlt');

  const offen = [];
  if (!env.ELEVENLABS_WEBHOOK_SECRET) {
    offen.push('ELEVENLABS_WEBHOOK_SECRET in die .env eintragen (oben ausgegeben).');
  }
  if (!env.ELEVENLABS_AGENT_ID && zustand.agent_id) {
    offen.push(`ELEVENLABS_AGENT_ID=${zustand.agent_id} in die .env eintragen.`);
  }
  if (!env.PHONE_NUMBER_ID) {
    offen.push('Telefonnummer anbinden: node scripts/telefonnummer.mjs --hilfe');
  }
  offen.push('Workflows importieren: make import');
  offen.push('Probelauf: make test-anruf');

  if (offen.length) offen.forEach((o) => info(`• ${o}`));
  else gut('Nichts. Der Agent steht.');
}

// =============================================================================

async function main() {
  const env = await ladeEnv();
  SCHLUESSEL = env.ELEVENLABS_API_KEY;
  if (!SCHLUESSEL) abbruch('ELEVENLABS_API_KEY fehlt in der .env.');
  if (!env.VOICE_WEBHOOK_BASE) abbruch('VOICE_WEBHOOK_BASE fehlt in der .env.');
  if (!env.VOICE_WEBHOOK_TOKEN) abbruch('VOICE_WEBHOOK_TOKEN fehlt in der .env.');

  console.log(c(1, '\nVoice-Agent — Einrichtung bei ElevenLabs'));
  console.log(c(90, `  Webhooks unter ${env.VOICE_WEBHOOK_BASE}`));
  if (TROCKEN) console.log(c(33, '  Probelauf — es wird nichts verändert.'));

  const zustand = await ladeZustand();

  try {
    const secretId = machen('secret')
      ? await secretSicherstellen(env, zustand)
      : (zustand.secret_id ?? abbruch('Secret-Schritt übersprungen, aber keine ID gespeichert.'));
    zustand.secret_id = secretId;

    const wissen = machen('wissen') ? await wissenSicherstellen(zustand) : (zustand.knowledge ?? []);
    const toolIds = machen('tools') ? await toolsSicherstellen(env, secretId, zustand) : (zustand.tools ?? []);

    if (machen('webhooks')) {
      zustand.postcall_webhook_id = await postCallWebhookSicherstellen(env, zustand);
      await vorabWebhookSicherstellen(env, secretId, zustand.postcall_webhook_id);
    }

    if (machen('agent')) {
      await stimmeSicherstellen(env);
      zustand.agent_id = await agentSicherstellen(env, zustand, { toolIds, wissen });
    }

    zustand.zuletzt = new Date().toISOString();
    await speichereZustand(zustand);
    abschluss(env, zustand);
    console.log('');
  } catch (fehler) {
    // Was bis hierher geklappt hat, bleibt gespeichert — der nächste Lauf
    // macht dort weiter, statt Tools und Dokumente zu verdoppeln.
    await speichereZustand(zustand);
    abbruch(fehler.message);
  }
}

main();
