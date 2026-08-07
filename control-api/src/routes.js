// =============================================================================
//  HTTP-Oberfläche der Control-API
// =============================================================================
//  Nutzer sind der WhatsApp-Bot, das CLI und gelegentlich ein Mensch mit curl.
//  Alle Antworten sind JSON; die Felder, die der Bot direkt weiterschickt,
//  liegen zusätzlich als fertig formatierter deutscher Text unter "text".
//  So muss der Bot keine Darstellungslogik kennen.
// =============================================================================

import express from 'express';
import { query, audit } from './db.js';
import * as modus from './modus.js';
import * as n8n from './n8n.js';
import * as el from './elevenlabs.js';
import { formatiere, relativ, zeitpunktAus } from './zeit.js';

export const router = express.Router();

// --- Hilfsmittel -------------------------------------------------------------

/** Fängt abgelehnte Promises aus async-Handlern ein. */
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Wer den Aufruf ausgelöst hat — landet im Änderungsprotokoll. */
const akteurVon = (req) =>
  String(req.body?.akteur || req.query?.akteur || req.get('X-Akteur') || 'api').slice(0, 120);

const ganzzahl = (wert, vorgabe, max) => {
  const n = Number.parseInt(wert, 10);
  if (!Number.isFinite(n) || n < 1) return vorgabe;
  return Math.min(n, max);
};

// =============================================================================
//  Zustand
// =============================================================================

router.get('/status', asyncH(async (req, res) => {
  const z = await modus.lies();

  // Die Außenwelt darf hängen, ohne dass die Statusabfrage hängt.
  const [offene, letzte, termine, workflows, elz] = await Promise.all([
    query(`SELECT count(*)::int AS n FROM voice.messages WHERE handled = FALSE`),
    query(`SELECT conversation_id, caller_number, caller_name, topic, outcome,
                  urgency, started_at, duration_seconds, transferred
             FROM voice.calls
            WHERE status <> 'laufend'
            ORDER BY started_at DESC LIMIT 5`),
    query(`SELECT caller_name, topic, starts_at, status
             FROM voice.bookings
            WHERE starts_at > now() AND status IN ('vorgemerkt','bestaetigt')
            ORDER BY starts_at LIMIT 5`),
    workflowUebersicht().catch((e) => ({ fehler: e.message, eintraege: [] })),
    req.query.knapp === '1'
      ? Promise.resolve(null)
      : el.zustand(process.env.ELEVENLABS_AGENT_ID).catch((e) => ({ ok: false, grund: e.message })),
  ]);

  const daten = {
    modus: z,
    offene_nachrichten: offene.rows[0].n,
    letzte_anrufe: letzte.rows,
    naechste_termine: termine.rows,
    workflows,
    elevenlabs: elz,
  };

  res.json({ ...daten, text: statusText(daten) });
}));

function statusText(d) {
  const zeilen = [modus.alsText(d.modus), ''];

  zeilen.push(d.offene_nachrichten > 0
    ? `📬 *${d.offene_nachrichten}* offene Nachricht${d.offene_nachrichten === 1 ? '' : 'en'}`
    : '📭 Keine offenen Nachrichten');

  if (d.naechste_termine.length) {
    zeilen.push('', '*Nächste Termine*');
    for (const t of d.naechste_termine) {
      zeilen.push(`• ${formatiere(t.starts_at)} — ${t.caller_name}: ${t.topic}` +
        (t.status === 'vorgemerkt' ? ' _(vorgemerkt)_' : ''));
    }
  }

  if (d.letzte_anrufe.length) {
    zeilen.push('', '*Letzte Anrufe*');
    for (const a of d.letzte_anrufe) {
      const wer = a.caller_name || a.caller_number || 'unbekannt';
      const wie = a.duration_seconds ? ` ${Math.round(a.duration_seconds / 60)} Min.` : '';
      zeilen.push(`• ${relativ(a.started_at)} — ${wer}: ${a.topic || a.outcome || '—'}${wie}` +
        (a.transferred ? ' ➡️ durchgestellt' : ''));
    }
  }

  const aus = (d.workflows?.eintraege ?? []).filter((w) => !w.aktiv_in_n8n && w.bekannt_in_n8n);
  if (aus.length) {
    zeilen.push('', `⚠️ Nicht aktiv in n8n: ${aus.map((w) => w.slug).join(', ')}`);
  }
  if (d.workflows?.fehler) zeilen.push('', `⚠️ n8n nicht erreichbar: ${d.workflows.fehler}`);
  if (d.elevenlabs && d.elevenlabs.ok === false) {
    zeilen.push(`⚠️ ElevenLabs: ${d.elevenlabs.grund || (d.elevenlabs.fehler ?? []).join('; ')}`);
  }

  return zeilen.join('\n');
}

// =============================================================================
//  Modus schalten
// =============================================================================

router.post('/modus', asyncH(async (req, res) => {
  const roh = req.body?.modus;
  const ziel = modus.modusAus(roh);
  if (!ziel) {
    return res.status(400).json({
      fehler: `Unbekannter Modus "${roh ?? ''}"`,
      text: `Ich kenne die Modi *aktiv*, *nur notiz* und *aus*.\n\n` +
        Object.entries(modus.BESCHREIBUNG).map(([k, v]) => `• *${k.replace('_', ' ')}* — ${v}`).join('\n'),
    });
  }

  try {
    await modus.setze({
      modus: ziel,
      bis: req.body?.bis,
      danach: req.body?.danach,
      hinweis: req.body?.hinweis,
      akteur: akteurVon(req),
    });
  } catch (err) {
    if (err.code === 'BAD_TIME' || err.code === 'BAD_MODE') {
      return res.status(400).json({ fehler: err.message, text: `⚠️ ${err.message}` });
    }
    throw err;
  }

  const z = await modus.lies();
  res.json({ modus: z, text: `Umgestellt.\n\n${modus.alsText(z)}` });
}));

// =============================================================================
//  Anrufe, Nachrichten, Termine
// =============================================================================

router.get('/anrufe', asyncH(async (req, res) => {
  const limit = ganzzahl(req.query.limit, 10, 100);
  const { rows } = await query(`
    SELECT c.conversation_id, c.caller_number, c.caller_name, c.company,
           c.topic, c.urgency, c.outcome, c.status, c.summary,
           c.started_at, c.duration_seconds, c.transferred, c.mode_at_call
      FROM voice.calls c
     ORDER BY c.started_at DESC
     LIMIT $1`, [limit]);

  const text = rows.length
    ? rows.map((a) => {
        const wer = a.caller_name || a.caller_number || 'unbekannt';
        const kopf = `*${wer}* — ${formatiere(a.started_at)}`;
        const inhalt = a.summary || a.topic || '(keine Notiz)';
        const marker = [
          a.transferred ? 'durchgestellt' : null,
          a.urgency >= 4 ? 'dringend' : null,
          a.status === 'laufend' ? 'läuft gerade' : null,
        ].filter(Boolean);
        return `${kopf}\n${inhalt}${marker.length ? `\n_${marker.join(' · ')}_` : ''}`;
      }).join('\n\n')
    : 'Noch keine Anrufe aufgezeichnet.';

  res.json({ anrufe: rows, text });
}));

router.get('/nachrichten', asyncH(async (req, res) => {
  const nurOffen = req.query.offen !== '0';
  const limit = ganzzahl(req.query.limit, 20, 100);
  const { rows } = await query(`
    SELECT id, caller_name, caller_number, subject, body, urgency,
           callback_requested, callback_by, handled, created_at
      FROM voice.messages
     WHERE ($1::bool IS FALSE OR handled = FALSE)
     ORDER BY handled ASC, urgency DESC, created_at DESC
     LIMIT $2`, [nurOffen, limit]);

  const text = rows.length
    ? rows.map((m) => {
        const dringend = m.urgency >= 4 ? '🔴 ' : m.urgency <= 2 ? '⚪ ' : '🟠 ';
        const rueckruf = m.callback_requested
          ? `\n↩️ Rückruf erbeten${m.callback_by ? ` bis ${formatiere(m.callback_by)}` : ''}` +
            (m.caller_number ? ` — ${m.caller_number}` : '')
          : '';
        return `${dringend}*#${m.id} ${m.caller_name || m.caller_number || 'unbekannt'}* ` +
          `(${relativ(m.created_at)})\n_${m.subject}_\n${m.body}${rueckruf}`;
      }).join('\n\n')
    : (nurOffen ? '📭 Keine offenen Nachrichten.' : 'Keine Nachrichten.');

  res.json({ nachrichten: rows, text });
}));

router.post('/nachrichten/:id/erledigt', asyncH(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ fehler: 'Ungültige ID' });

  const { rows } = await query(`
    UPDATE voice.messages SET handled = TRUE, handled_at = now()
     WHERE id = $1 AND handled = FALSE
     RETURNING id, subject`, [id]);

  if (!rows.length) {
    return res.status(404).json({ fehler: 'Nicht gefunden oder schon erledigt',
      text: `Nachricht #${id} gibt es nicht oder sie ist bereits abgehakt.` });
  }
  await audit(akteurVon(req), 'message.handled', { id });
  res.json({ nachricht: rows[0], text: `✅ Nachricht #${id} abgehakt: _${rows[0].subject}_` });
}));

router.get('/termine', asyncH(async (req, res) => {
  const { rows } = await query(`
    SELECT id, caller_name, caller_email, caller_number, topic,
           starts_at, ends_at, status, calendar_link
      FROM voice.bookings
     WHERE ends_at > now() - interval '1 day'
     ORDER BY starts_at
     LIMIT 30`);

  const text = rows.length
    ? rows.map((t) => `• ${formatiere(t.starts_at)} — *${t.caller_name}*: ${t.topic}` +
        (t.status !== 'bestaetigt' ? ` _(${t.status})_` : '')).join('\n')
    : 'Keine anstehenden Termine.';

  res.json({ termine: rows, text });
}));

router.post('/termine/:id/status', asyncH(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const status = String(req.body?.status || '').toLowerCase();
  if (!['bestaetigt', 'abgelehnt', 'abgesagt'].includes(status)) {
    return res.status(400).json({ fehler: 'status muss bestaetigt, abgelehnt oder abgesagt sein' });
  }
  const { rows } = await query(
    `UPDATE voice.bookings SET status = $2 WHERE id = $1 RETURNING id, caller_name, topic, starts_at, status`,
    [id, status]);
  if (!rows.length) return res.status(404).json({ fehler: 'Termin nicht gefunden' });

  await audit(akteurVon(req), 'booking.status', { id, status });
  res.json({ termin: rows[0], text: `Termin #${id} ist jetzt *${status}*.` });
}));

// =============================================================================
//  Sperrzeiten
// =============================================================================

router.post('/sperrzeit', asyncH(async (req, res) => {
  const von = zeitpunktAus(req.body?.von);
  const bis = zeitpunktAus(req.body?.bis);
  if (!von || !bis) {
    return res.status(400).json({ fehler: 'von und bis müssen verständliche Zeitangaben sein',
      text: 'Beispiel: `von: "morgen"`, `bis: "freitag"` — oder ISO-Zeitstempel.' });
  }
  if (bis <= von) return res.status(400).json({ fehler: '"bis" muss nach "von" liegen' });

  const { rows } = await query(
    `INSERT INTO voice.blackouts (starts_at, ends_at, reason) VALUES ($1,$2,$3) RETURNING id`,
    [von, bis, req.body?.grund || null]);

  await audit(akteurVon(req), 'blackout.add', { id: rows[0].id, von, bis });
  res.json({ id: rows[0].id,
    text: `🚫 Keine Termine von ${formatiere(von)} bis ${formatiere(bis)}.` });
}));

// =============================================================================
//  Kontakte
// =============================================================================

router.get('/kontakte', asyncH(async (req, res) => {
  const { rows } = await query(`
    SELECT id, number, name, company, relation, vip, blocked, call_count, last_call_at
      FROM voice.contacts ORDER BY vip DESC, name LIMIT 200`);
  const text = rows.length
    ? rows.map((k) => `${k.blocked ? '⛔' : k.vip ? '⭐' : '•'} *${k.name}*` +
        `${k.company ? ` (${k.company})` : ''} — ${k.number}`).join('\n')
    : 'Noch keine Kontakte hinterlegt.';
  res.json({ kontakte: rows, text });
}));

router.post('/kontakte', asyncH(async (req, res) => {
  const { nummer, name } = req.body ?? {};
  if (!nummer || !name) return res.status(400).json({ fehler: 'nummer und name sind Pflicht' });

  const normalisiert = String(nummer).replace(/[^\d+]/g, '');
  if (!/^\+\d{7,15}$/.test(normalisiert)) {
    return res.status(400).json({ fehler: 'Nummer bitte im Format +4915112345678' });
  }

  const { rows } = await query(`
    INSERT INTO voice.contacts (number, name, company, relation, notes, vip, blocked)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (number) DO UPDATE SET
      name = EXCLUDED.name, company = EXCLUDED.company, relation = EXCLUDED.relation,
      notes = EXCLUDED.notes, vip = EXCLUDED.vip, blocked = EXCLUDED.blocked
    RETURNING id, name, number, vip, blocked`,
    [normalisiert, String(name).trim(), req.body.firma || null, req.body.beziehung || null,
     req.body.notiz || null, Boolean(req.body.vip), Boolean(req.body.gesperrt)]);

  await audit(akteurVon(req), 'contact.upsert', { nummer: normalisiert });
  const k = rows[0];
  res.json({ kontakt: k,
    text: `${k.blocked ? '⛔' : k.vip ? '⭐' : '✅'} *${k.name}* (${k.number}) gespeichert.` });
}));

// =============================================================================
//  n8n-Workflows
// =============================================================================
//  Das Register in der Datenbank ist die Beschreibung, n8n der Ist-Zustand.
//  Die Zusammenführung passiert hier, damit der Bot beides in einem Rutsch
//  bekommt und selbst nichts über n8n wissen muss.

async function workflowUebersicht() {
  const { rows } = await query(`
    SELECT slug, n8n_id, name, description, webhook_path, toggleable, critical, active
      FROM voice.n8n_workflows ORDER BY critical DESC, slug`);

  let live = [];
  let fehler;
  try {
    live = await n8n.listeWorkflows();
  } catch (err) {
    fehler = err.message;
  }

  const nachId = new Map(live.map((w) => [String(w.id), w]));
  const eintraege = rows.map((r) => {
    const l = r.n8n_id ? nachId.get(String(r.n8n_id)) : null;
    return {
      slug: r.slug,
      name: r.name,
      beschreibung: r.description,
      n8n_id: r.n8n_id,
      webhook: r.webhook_path,
      schaltbar: r.toggleable,
      kritisch: r.critical,
      bekannt_in_n8n: Boolean(l),
      aktiv_in_n8n: l ? l.active : null,
    };
  });

  // Was in n8n läuft, aber nicht im Register steht — meist von Hand angelegt.
  const bekannteIds = new Set(rows.map((r) => String(r.n8n_id)));
  const unbekannt = live.filter((w) => !bekannteIds.has(String(w.id)))
    .map((w) => ({ n8n_id: w.id, name: w.name, aktiv_in_n8n: w.active }));

  return { eintraege, unregistriert: unbekannt, fehler };
}

router.get('/workflows', asyncH(async (req, res) => {
  const u = await workflowUebersicht();

  const zeile = (w) => {
    const zustand = !w.bekannt_in_n8n ? '⚪ nicht importiert' : w.aktiv_in_n8n ? '🟢 aktiv' : '🔴 aus';
    const marker = w.kritisch ? ' 🔒' : w.schaltbar ? ' 🎚' : '';
    return `${zustand} *${w.slug}*${marker}\n   ${w.beschreibung}`;
  };

  const teile = ['*n8n-Workflows des Voice-Agents*', '', ...u.eintraege.map(zeile)];
  if (u.unregistriert.length) {
    teile.push('', '_Weitere Workflows in dieser n8n-Instanz:_',
      ...u.unregistriert.map((w) => `• ${w.name} ${w.aktiv_in_n8n ? '🟢' : '🔴'}`));
  }
  teile.push('', '🔒 = darf nicht abgeschaltet werden · 🎚 = per WhatsApp schaltbar',
    '', 'Zum Ein-/Ausschalten des Agents nutze `/agent aus` — das schaltet den *Modus*, nicht die Workflows.');
  if (u.fehler) teile.push('', `⚠️ n8n nicht erreichbar: ${u.fehler}`);

  res.json({ ...u, text: teile.join('\n') });
}));

// Zwei getrennte Routen statt eines Musters im Pfadparameter: die Schreibweise
// :aktion(aktivieren|deaktivieren) gibt es in Express 5 nicht mehr, und ein
// stiller Routing-Ausfall nach einem Upgrade wäre schwer zu finden.
const schalten = asyncH(async (req, res) => {
  const { slug } = req.params;
  const aktion = req.aktion;
  const { rows } = await query(
    `SELECT slug, n8n_id, name, toggleable, critical FROM voice.n8n_workflows WHERE slug = $1`, [slug]);

  const w = rows[0];
  if (!w) return res.status(404).json({ fehler: `Workflow "${slug}" ist nicht registriert` });
  if (!w.n8n_id) {
    return res.status(409).json({ fehler: 'Workflow ist noch nicht nach n8n importiert',
      text: `„${slug}" ist noch nicht importiert. Auf dem Server: \`make import\`` });
  }

  // Ein kritischer Workflow ist die Annahme des Anrufs selbst. Wer den
  // abschaltet, hat keinen stillen Agent, sondern einen kaputten.
  if (w.critical && aktion === 'deaktivieren') {
    return res.status(409).json({
      fehler: 'Kritischer Workflow',
      text: `🔒 „${slug}" trägt die Anrufannahme und lässt sich nicht abschalten.\n\n` +
        `Wenn der Agent schweigen soll: \`/agent aus\`. Der Anruf wird dann trotzdem ` +
        `sauber angenommen — nur ohne Kalender und ohne Durchstellen.`,
    });
  }
  if (!w.toggleable) {
    return res.status(409).json({ fehler: 'Workflow ist nicht zum Schalten freigegeben',
      text: `„${slug}" ist nicht per WhatsApp schaltbar.` });
  }

  try {
    if (aktion === 'aktivieren') await n8n.aktiviere(w.n8n_id);
    else await n8n.deaktiviere(w.n8n_id);
  } catch (err) {
    return res.status(502).json({ fehler: err.message, text: `⚠️ n8n meldet: ${err.message}` });
  }

  const aktiv = aktion === 'aktivieren';
  await query(`UPDATE voice.n8n_workflows SET active = $2, last_seen_at = now() WHERE slug = $1`,
    [slug, aktiv]);
  await audit(akteurVon(req), `workflow.${aktion}`, { slug, n8n_id: w.n8n_id });

  res.json({ slug, aktiv, text: `${aktiv ? '🟢' : '🔴'} Workflow *${slug}* ist jetzt ${aktiv ? 'aktiv' : 'aus'}.` });
});

// Das Import-Skript meldet hier, was es nach n8n gebracht hat. Ohne dieses
// Register wüsste der WhatsApp-Bot nur, DASS es Workflows gibt — nicht, was
// sie tun und welche man gefahrlos abschalten darf.
router.post('/workflows/register', asyncH(async (req, res) => {
  const liste = Array.isArray(req.body?.workflows) ? req.body.workflows : null;
  if (!liste) return res.status(400).json({ fehler: 'workflows muss eine Liste sein' });

  let geschrieben = 0;
  for (const w of liste) {
    if (!w?.slug || !w?.name) continue;
    await query(`
      INSERT INTO voice.n8n_workflows
        (slug, n8n_id, name, description, webhook_path, toggleable, critical, active, last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
      ON CONFLICT (slug) DO UPDATE SET
        n8n_id = EXCLUDED.n8n_id, name = EXCLUDED.name,
        description = EXCLUDED.description, webhook_path = EXCLUDED.webhook_path,
        toggleable = EXCLUDED.toggleable, critical = EXCLUDED.critical,
        active = EXCLUDED.active, last_seen_at = now()`,
      [w.slug, w.id ?? null, w.name, w.beschreibung ?? '', w.webhook ?? null,
       Boolean(w.schaltbar), Boolean(w.kritisch), Boolean(w.aktiv)]);
    geschrieben++;
  }

  await audit(akteurVon(req), 'workflow.register', { anzahl: geschrieben });
  res.json({ ok: true, geschrieben });
}));

router.post('/workflows/:slug/aktivieren',
  (req, _res, next) => { req.aktion = 'aktivieren'; next(); }, schalten);
router.post('/workflows/:slug/deaktivieren',
  (req, _res, next) => { req.aktion = 'deaktivieren'; next(); }, schalten);

// =============================================================================
//  Ausgangs-Warteschlange
// =============================================================================
//  Der WhatsApp-Bot holt hier ab, was der Agent auszurichten hat. Das Abholen
//  markiert die Zeilen sofort als gesendet; klappt das Senden im Bot doch
//  nicht, meldet er das über /fehler zurück und die Zeile geht mit Abstand
//  erneut in die Schlange.

router.get('/ausgang', asyncH(async (req, res) => {
  const anzahl = ganzzahl(req.query.anzahl, 10, 50);
  const { rows } = await query(`SELECT * FROM voice.hole_ausgang($1)`, [anzahl]);
  res.json({ meldungen: rows });
}));

router.post('/ausgang/:id/fehler', asyncH(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ fehler: 'Ungültige ID' });
  await query(`SELECT voice.ausgang_fehlgeschlagen($1, $2)`,
    [id, String(req.body?.grund ?? 'unbekannt').slice(0, 500)]);
  res.json({ ok: true });
}));

// =============================================================================
//  Selbstauskunft
// =============================================================================
//  Damit der WhatsApp-Bot — und jeder Mensch — herausfinden kann, was es hier
//  überhaupt gibt, ohne in den Quelltext zu schauen.

router.get('/faehigkeiten', asyncH(async (req, res) => {
  const u = await workflowUebersicht().catch(() => ({ eintraege: [] }));
  res.json({
    dienst: 'voice-agent',
    beschreibung:
      'Telefon-Vorzimmer von Damjan Savic. Nimmt umgeleitete Anrufe an, klärt das Anliegen, ' +
      'kennt den Kalender, nimmt Nachrichten auf und stellt bei Dringlichkeit durch.',
    modi: modus.BESCHREIBUNG,
    befehle: [
      { befehl: '/agent', wirkung: 'Zeigt Modus, offene Nachrichten, letzte Anrufe und Termine.' },
      { befehl: '/agent an', wirkung: 'Voller Betrieb inklusive Durchstellen.' },
      { befehl: '/agent notiz', wirkung: 'Nimmt an und notiert, stellt aber nicht durch.' },
      { befehl: '/agent aus [bis <zeit>]', wirkung: 'Nur kurze Ansage und Nachricht. Beispiel: /agent aus bis 16 uhr' },
      { befehl: '/anrufe [n]', wirkung: 'Die letzten Anrufe mit Zusammenfassung.' },
      { befehl: '/nachrichten', wirkung: 'Offene Nachrichten aus Anrufen.' },
      { befehl: '/erledigt <nr>', wirkung: 'Hakt eine Nachricht ab.' },
      { befehl: '/termine', wirkung: 'Anstehende Termine, die der Agent vereinbart hat.' },
      { befehl: '/flows', wirkung: 'Die n8n-Workflows dieses Projekts und ihr Zustand.' },
      { befehl: '/kontakt <nummer> <name>', wirkung: 'Anrufer benennen, damit der Agent sie erkennt.' },
    ],
    workflows: u.eintraege,
  });
}));

export default router;
