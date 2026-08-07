// =============================================================================
//  Interne Schnittstelle — für n8n und als Ausfallsicherung
// =============================================================================
//  Zwei Nutzer, ein Vertrag:
//
//    * n8n ruft diese Endpunkte während eines Anrufs auf. Die Workflows
//      bleiben dadurch schlank — sie orchestrieren (Kalender, WhatsApp,
//      Zusammenfassung), statt SQL zu enthalten. Das Schema kennt genau ein
//      Programm, und das ist dieses hier.
//
//    * nginx leitet /webhook/voice/init hierher um, wenn n8n nicht antwortet.
//      Deshalb liefert /init die vollständige ElevenLabs-Antwort und nicht
//      bloß Rohdaten: Fällt n8n aus, geht der Anruf trotzdem durch, nur ohne
//      Kalenderanreicherung.
//
//  Das ist wichtiger, als es klingt: ElevenLabs schaltet einen Webhook nach
//  zehn Fehlversuchen in Folge selbsttätig ab. Ohne Ausweichweg würde eine
//  halbe Stunde n8n-Ausfall den Agent dauerhaft lahmlegen.
//
//  Authentifizierung: Header X-Voice-Token, derselbe Wert, den die
//  ElevenLabs-Tools mitschicken.
// =============================================================================

import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { query, tx, audit } from './db.js';
import * as modus from './modus.js';
import { berlinJetzt, formatiere, ZEITZONE } from './zeit.js';

export const intern = express.Router();

const TOKEN = process.env.VOICE_WEBHOOK_TOKEN || '';

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

intern.use((req, res, next) => {
  // Der Post-Call-Webhook kommt direkt von ElevenLabs und trägt keinen
  // eigenen Token — er weist sich über die HMAC-Signatur aus.
  if (req.path === '/postcall') return next();

  const vorgelegt = req.get('X-Voice-Token') || '';
  const a = Buffer.from(vorgelegt);
  const b = Buffer.from(TOKEN);
  if (!TOKEN || a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ fehler: 'Nicht angemeldet' });
  }
  next();
});

// --- Hilfsmittel -------------------------------------------------------------

/** +49 151 234 → +49151234. Gibt null zurück, wenn nichts Brauchbares übrig bleibt. */
function normalisiereNummer(roh) {
  if (!roh) return null;
  const s = String(roh).trim();
  // Unterdrückte Nummern kommen je nach Strecke unterschiedlich an.
  if (/^(anonymous|unknown|restricted|private|\+?266696687)$/i.test(s)) return null;
  const ziffern = s.replace(/[^\d+]/g, '');
  if (ziffern.length < 6) return null;
  return ziffern.startsWith('+') ? ziffern : `+${ziffern.replace(/^00/, '')}`;
}

const TAGESZEIT = (stunde) => (stunde < 11 ? 'Guten Morgen' : stunde < 18 ? 'Guten Tag' : 'Guten Abend');

/**
 * Bereitet den Statushinweis zum Vorlesen auf.
 *
 * Damjan tippt ihn per WhatsApp, meist als Fragment in der ersten Person:
 * "bin in einem Workshop". Wörtlich hinter einen Satz in der dritten Person
 * gehängt ergibt das "Er ist nicht störbar. bin in einem Workshop." — was
 * am Telefon merkwürdig klingt. Deshalb wird der Hinweis als eigener Satz
 * behandelt: erster Buchstabe groß, am Ende ein Punkt.
 *
 * Die Person lässt sich nicht automatisch drehen, ohne zu raten. Die
 * Formulierung bleibt also seine Sache — die Doku sagt das auch so.
 */
function alsSatz(hinweis) {
  const s = String(hinweis ?? '').trim();
  if (!s) return '';
  const gross = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(gross) ? gross : `${gross}.`;
}

/** Die Begrüßung je Modus — das Erste, was der Anrufer hört. */
function ersterSatz({ modus: m, name, hinweis, stunde }) {
  const gruss = TAGESZEIT(stunde);
  const anrede = name ? `, ${name}` : '';
  const grund = alsSatz(hinweis);

  if (m === 'aus') {
    // Steht ein Hinweis, ersetzt er die allgemeine Auskunft, statt sie zu
    // doppeln. Zwei Sätze, die dasselbe sagen, klingen nach Automat.
    const lage = grund || 'Er ist im Moment nicht erreichbar.';
    return `${gruss}${anrede}, hier ist der Assistent von Damjan Savić. ${lage} ` +
      `Ich nehme Ihr Anliegen gern auf und gebe es weiter — worum geht es?`;
  }

  if (m === 'nur_notiz') {
    const lage = grund || 'Er ist gerade in einem Termin und nicht störbar.';
    return `${gruss}${anrede}, hier ist der Assistent von Damjan Savić. ${lage} ` +
      `Ich notiere Ihr Anliegen — worum geht es denn?`;
  }

  return name
    ? `${gruss}, ${name}! Hier ist der Assistent von Damjan Savić. ` +
      `Er kann gerade nicht selbst rangehen — worum geht es?`
    : `${gruss}, hier ist der Assistent von Damjan Savić. ` +
      `Er kann gerade nicht selbst ans Telefon — worum geht es denn?`;
}

// =============================================================================
//  /init — was der Agent über diesen Anruf wissen muss
// =============================================================================
//  ElevenLabs ruft das während des Klingelns auf, der Anrufer hört solange
//  das Freizeichen. Alles hier muss deshalb schnell und ohne externe
//  Abhängigkeiten laufen — eine Kalenderabfrage gehört NICHT hierher.
//
//  Die Antwort muss ALLE im Agent definierten dynamischen Variablen
//  enthalten. Fehlt eine, bricht ElevenLabs den Anruf ab.

intern.post('/init', asyncH(async (req, res) => {
  const nummer = normalisiereNummer(req.body?.caller_id);
  const jetzt = berlinJetzt();

  let z;
  try {
    z = await modus.lies();
  } catch (err) {
    // Selbst ohne Datenbank muss der Anruf angenommen werden. Der
    // Notbetrieb nimmt an und notiert, mehr nicht.
    console.error('[init] Modus nicht lesbar:', err.message);
    z = { modus: 'nur_notiz', hinweis: null, durchstellen_moeglich: false };
  }

  // Kontakt nachschlagen. Scheitert das, bleibt der Anrufer eben unbekannt.
  let kontakt = null;
  if (nummer) {
    try {
      const { rows } = await query(
        `SELECT id, name, company, relation, notes, vip, blocked
           FROM voice.contacts WHERE number = $1`, [nummer]);
      kontakt = rows[0] ?? null;
    } catch (err) {
      console.error('[init] Kontaktsuche fehlgeschlagen:', err.message);
    }
  }

  // Ein gesperrter Anrufer bekommt denselben Ablauf wie im Modus "aus" —
  // höflich, kurz, ohne Kalender und ohne Durchstellen. Auflegen ohne ein
  // Wort wäre wirkungsvoller, hinterlässt aber jemanden, der es gleich
  // nochmal versucht.
  const gesperrt = Boolean(kontakt?.blocked);
  const wirkModus = gesperrt ? 'aus' : z.modus;

  // VIP darf auch dann durchgestellt werden, wenn allgemein nur notiert wird.
  // Der Systemprompt kennt diese Ausnahme ausdrücklich — er richtet sich nach
  // durchstellen_moeglich, nicht allein nach dem Modus.
  //
  // Die Tagesobergrenze gilt aber auch hier: Sie ist der Schutz gegen einen
  // hartnäckigen Anrufer, und ausgerechnet ein hinterlegter Kontakt weiß, dass
  // er durchkommt. Ohne diese Prüfung wäre die VIP-Kennzeichnung ein
  // Freifahrtschein.
  const unterGrenze = z.durchstellen_heute < z.durchstellen_limit;
  const vipAusnahme = Boolean(kontakt?.vip) && z.modus === 'nur_notiz'
    && z.durchstellen_erlaubt && unterGrenze;

  const durchstellen = !gesperrt && (z.durchstellen_moeglich || vipAusnahme);

  // Den Anruf sofort vermerken. Die conversation_id kennen wir hier noch
  // nicht — sie kommt erst mit dem ersten Werkzeugaufruf. Deshalb wird die
  // Zeile beim Werkzeugaufruf per UPSERT vervollständigt.
  let callId = null;
  if (req.body?.call_sid) {
    try {
      const { rows } = await query(`
        INSERT INTO voice.calls (conversation_id, agent_id, caller_number, caller_name,
                                 contact_id, mode_at_call, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'laufend')
        ON CONFLICT (conversation_id) DO UPDATE SET
          caller_number = COALESCE(voice.calls.caller_number, EXCLUDED.caller_number),
          caller_name   = COALESCE(voice.calls.caller_name,   EXCLUDED.caller_name)
        RETURNING id`,
        [`sid:${req.body.call_sid}`, req.body.agent_id ?? null, nummer,
         kontakt?.name ?? null, kontakt?.id ?? null, wirkModus]);
      callId = rows[0]?.id ?? null;
    } catch (err) {
      console.error('[init] Anruf nicht vorgemerkt:', err.message);
    }
  }

  if (kontakt) {
    query(`UPDATE voice.contacts SET last_call_at = now(), call_count = call_count + 1 WHERE id = $1`,
      [kontakt.id]).catch(() => {});
  }

  // Leerstring, nie null: Die dynamischen Variablen gehen so an ElevenLabs,
  // und dort ist ein null ein fehlender Wert — der Anruf bricht dann mit
  // "missing required dynamic variables" ab. Ausgerechnet bei gesperrten
  // Anrufern, wo bisher null gesetzt wurde.
  const hinweis = gesperrt ? '' : (z.hinweis || '');

  // Bei einem gesperrten Anrufer bleibt der hinterlegte Name innen.
  // Kontaktnamen sind Damjans private Notiz — wer jemanden als "Nerviger
  // Anrufer" oder "SEO-Spam" einträgt, will nicht, dass der Agent die Person
  // genau so begrüßt. Dasselbe gilt für die Notiz zum Kontakt.
  const nameFuerAgent = gesperrt ? null : (kontakt?.name ?? null);

  res.json({
    type: 'conversation_initiation_client_data',
    dynamic_variables: {
      modus: wirkModus,
      anrufer_name: nameFuerAgent ?? 'unbekannt',
      anrufer_bekannt: !gesperrt && kontakt ? 'ja' : 'nein',
      anrufer_notiz: gesperrt
        ? 'nichts hinterlegt'
        : ([kontakt?.relation, kontakt?.company, kontakt?.notes]
            .filter(Boolean).join(' · ') || 'nichts hinterlegt'),
      status_hinweis: hinweis,
      durchstellen_moeglich: durchstellen ? 'ja' : 'nein',
      heute: new Intl.DateTimeFormat('de-DE', {
        timeZone: ZEITZONE, weekday: 'long', day: 'numeric', month: 'long',
      }).format(new Date()),
      uhrzeit: `${String(jetzt.stunde).padStart(2, '0')}:${String(jetzt.minute).padStart(2, '0')}`,
    },
    conversation_config_override: {
      agent: {
        first_message: ersterSatz({
          modus: wirkModus, name: nameFuerAgent, hinweis, stunde: jetzt.stunde,
        }),
      },
    },
    // Nicht Teil des ElevenLabs-Vertrags, aber n8n reicht es an die
    // Folgeschritte weiter und es hilft beim Nachvollziehen im Log.
    _intern: { call_id: callId, kontakt_id: kontakt?.id ?? null, gesperrt },
  });
}));

// =============================================================================
//  Terminfindung — die Hälfte, die nicht Google ist
// =============================================================================
//  Liefert Sprechzeiten, Sperrzeiten und schon vergebene Slots. n8n verschneidet
//  das mit den belegten Zeiten aus dem Google-Kalender und rechnet daraus die
//  freien Fenster. Diese Trennung ist Absicht: Google-Zugangsdaten liegen in
//  n8n, wo sie hingehören, und die Regeln liegen in der Datenbank, wo man sie
//  ändern kann, ohne einen Workflow anzufassen.

intern.get('/terminregeln', asyncH(async (req, res) => {
  const tage = Math.min(Math.max(Number.parseInt(req.query.tage, 10) || 10, 1), 30);
  const ab = req.query.ab ? new Date(req.query.ab) : new Date(Date.now() + 3_600_000);
  if (Number.isNaN(ab.getTime())) return res.status(400).json({ fehler: 'ab ist kein gültiges Datum' });

  const bis = new Date(ab.getTime() + tage * 86_400_000);

  const [regeln, sperren, belegt] = await Promise.all([
    query(`SELECT weekday, start_time::text, end_time::text, slot_minutes, label
             FROM voice.availability_rules WHERE active ORDER BY weekday, start_time`),
    query(`SELECT starts_at, ends_at, reason FROM voice.blackouts
            WHERE ends_at > $1 AND starts_at < $2 ORDER BY starts_at`, [ab, bis]),
    query(`SELECT starts_at, ends_at FROM voice.bookings
            WHERE status IN ('vorgemerkt','bestaetigt') AND ends_at > $1 AND starts_at < $2`, [ab, bis]),
  ]);

  res.json({
    zeitzone: ZEITZONE,
    von: ab.toISOString(),
    bis: bis.toISOString(),
    sprechzeiten: regeln.rows,
    sperrzeiten: sperren.rows,
    schon_vergeben: belegt.rows,
    // Etwas Luft, damit der Agent keinen Termin in zehn Minuten verspricht.
    vorlauf_stunden: Number(process.env.TERMIN_VORLAUF_STUNDEN || 3),
  });
}));

// =============================================================================
//  Termin vormerken
// =============================================================================
//  Der eindeutige Index auf belegte Startzeiten entscheidet, wer zuerst da
//  war. Zwei gleichzeitige Anrufer auf denselben Slot können also nicht
//  beide gewinnen — der zweite bekommt eine klare Absage statt einer
//  Doppelbuchung, die erst am Terminvormittag auffällt.

intern.post('/termin', asyncH(async (req, res) => {
  const { start, dauer_minuten, name, thema } = req.body ?? {};
  if (!start || !name || !thema) {
    return res.status(400).json({ ok: false, fehler: 'start, name und thema sind Pflicht' });
  }

  const beginn = new Date(start);
  if (Number.isNaN(beginn.getTime())) {
    return res.status(400).json({ ok: false, fehler: `"${start}" ist kein gültiger Zeitpunkt` });
  }
  if (beginn <= new Date()) {
    return res.status(400).json({ ok: false, fehler: 'Der Termin liegt in der Vergangenheit' });
  }

  const dauer = Math.min(Math.max(Number(dauer_minuten) || 30, 15), 120);
  const ende = new Date(beginn.getTime() + dauer * 60_000);

  try {
    const { rows } = await query(`
      INSERT INTO voice.bookings
        (conversation_id, caller_name, caller_number, caller_email, topic, starts_at, ends_at,
         call_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,
              (SELECT id FROM voice.calls WHERE conversation_id = $1))
      RETURNING id, starts_at, ends_at`,
      [req.body.conversation_id ?? null, String(name).trim(),
       normalisiereNummer(req.body.telefon ?? req.body.anrufer_nummer),
       req.body.email ?? null, String(thema).trim(), beginn, ende]);

    const t = rows[0];
    await query(`SELECT voice.melde($1,$2,$3,$4)`, [
      `📅 *Neuer Termin*\n${formatiere(t.starts_at)}\n${name}: ${thema}`,
      'termin', 3, null,
    ]);

    res.json({
      ok: true,
      buchung_id: t.id,
      start: t.starts_at,
      bestaetigung: `Eingetragen: ${formatiere(t.starts_at)}.`,
    });
  } catch (err) {
    // 23505 = eindeutiger Index (gleiche Startzeit),
    // 23P01 = Ausschluss-Constraint (überlappender Zeitraum).
    // Beide bedeuten dasselbe für den Anrufer: der Platz ist weg.
    if (err.code === '23505' || err.code === '23P01') {
      return res.status(409).json({
        ok: false,
        grund: 'belegt',
        // Wortlaut für den Agent — er soll das vorlesen können, ohne zu
        // improvisieren.
        bestaetigung: 'Der Zeitpunkt ist inzwischen belegt. Ich suche einen anderen.',
      });
    }
    throw err;
  }
}));

intern.post('/termin/:id/kalender', asyncH(async (req, res) => {
  const eventId = req.body?.event_id ?? null;

  // "bestaetigt" heißt: steht im Kalender. Ohne Kalendereintrag bleibt die
  // Buchung "vorgemerkt" — der Slot ist gesperrt und Damjan sieht sie unter
  // /termine, aber die Kennzeichnung lügt nicht. Sonst hielte man einen
  // Termin für gesichert, den kein Kalender kennt.
  const { rows } = await query(`
    UPDATE voice.bookings
       SET calendar_event_id = $2,
           calendar_link     = $3,
           status = CASE WHEN $2::text IS NOT NULL THEN 'bestaetigt'::voice.booking_status
                         ELSE status END
     WHERE id = $1
    RETURNING id, status`,
    [Number.parseInt(req.params.id, 10), eventId, req.body?.link ?? null]);

  if (!rows.length) return res.status(404).json({ ok: false, fehler: 'Buchung nicht gefunden' });

  if (!eventId) {
    await query(`SELECT voice.melde($1,$2,$3)`, [
      `⚠️ *Termin ohne Kalendereintrag*\nBuchung #${rows[0].id} ist vorgemerkt, aber nicht im ` +
      `Google-Kalender gelandet. Der Slot ist gesperrt — bitte von Hand eintragen.`,
      'termin', 4,
    ]);
  }

  res.json({ ok: true, status: rows[0].status });
}));

// =============================================================================
//  Notiz aus dem Gespräch
// =============================================================================

intern.post('/notiz', asyncH(async (req, res) => {
  const b = req.body ?? {};
  const thema = String(b.thema ?? '').trim();
  const zusammenfassung = String(b.zusammenfassung ?? '').trim();
  if (!thema || !zusammenfassung) {
    return res.status(400).json({ ok: false, fehler: 'thema und zusammenfassung sind Pflicht' });
  }

  const dringlichkeit = Math.min(Math.max(Number(b.dringlichkeit) || 3, 1), 5);
  const ergebnis = ['nachricht', 'termin', 'durchgestellt', 'abgewimmelt', 'rueckruf', 'unklar']
    .includes(b.ergebnis) ? b.ergebnis : 'unklar';
  const nummer = normalisiereNummer(b.anrufer_nummer);
  const name = String(b.name ?? '').trim() || null;

  const { callId, nachrichtId, neu } = await tx(async (client) => {
    // Der Anruf ist unter "sid:…" vorgemerkt, sobald der Vorab-Webhook lief.
    // Jetzt kommt zum ersten Mal die conversation_id dazu. Beide Schlüssel
    // zusammenzuführen geht nur hier — deshalb erst versuchen zu ergänzen,
    // dann als neue Zeile anlegen.
    // Der zweite Zweig ist der Rückfall, wenn die conversation_id noch nicht
    // zugeordnet ist: Dann wird der laufende Anruf derselben Nummer gesucht.
    //
    // "$2 IS NOT NULL" ist dabei entscheidend. Ohne die Bedingung wird aus
    // "caller_number IS NOT DISTINCT FROM NULL" ein Treffer auf JEDEN anderen
    // Anruf mit unterdrückter Nummer der letzten halben Stunde — die Notiz
    // des zweiten anonymen Anrufers landete dann auf dem Datensatz des
    // ersten. Zwei Werbeanrufe hintereinander reichen dafür.
    const vorhanden = await client.query(
      `SELECT id FROM voice.calls
        WHERE conversation_id = $1
           OR ($2::text IS NOT NULL AND status = 'laufend' AND caller_number = $2
               AND started_at > now() - interval '30 minutes')
        ORDER BY started_at DESC LIMIT 1`,
      [b.conversation_id ?? null, nummer]);

    let id = vorhanden.rows[0]?.id;

    // "durchgestellt" wird hier ausgerechnet und als eigener Parameter
    // übergeben. Denselben Platzhalter einmal als Enum (outcome = $8) und
    // einmal im Textvergleich zu benutzen, lässt Postgres den Typ nicht
    // eindeutig bestimmen — es antwortet mit "inconsistent types deduced".
    const durchgestellt = ergebnis === 'durchgestellt';

    if (id) {
      await client.query(`
        UPDATE voice.calls
           SET conversation_id = COALESCE($2, conversation_id),
               caller_name = COALESCE($3, caller_name),
               caller_number = COALESCE(caller_number, $4),
               company = COALESCE($5, company),
               topic = $6, urgency = $7, outcome = $8,
               callback_number = COALESCE($9, callback_number),
               callback_email = COALESCE($10, callback_email),
               transferred = (transferred OR $11)
         WHERE id = $1`,
        [id, b.conversation_id ?? null, name, nummer, b.firma ?? null,
         thema, dringlichkeit, ergebnis,
         normalisiereNummer(b.rueckrufnummer), b.email ?? null, durchgestellt]);
    } else {
      const neu = await client.query(`
        INSERT INTO voice.calls (conversation_id, caller_number, caller_name, company,
                                 topic, urgency, outcome, status, callback_number, callback_email,
                                 transferred)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'laufend',$8,$9,$10)
        RETURNING id`,
        [b.conversation_id ?? `notiz:${Date.now()}`, nummer, name, b.firma ?? null,
         thema, dringlichkeit, ergebnis,
         normalisiereNummer(b.rueckrufnummer), b.email ?? null, durchgestellt]);
      id = neu.rows[0].id;
    }

    // Werbung wird protokolliert, aber nicht als Aufgabe geführt. Sonst
    // wächst die Nachrichtenliste mit Dingen, die niemand je abhakt.
    let nid = null;
    let neu = false;

    if (ergebnis !== 'abgewimmelt') {
      // Ruft der Agent notiz_anlegen zweimal für dasselbe Gespräch auf — etwa
      // weil er nach einem Zeitüberlauf wiederholt —, wird die vorhandene
      // Nachricht überschrieben statt eine zweite angelegt. Sonst stünde
      // derselbe Anruf doppelt in der Liste und Damjan bekäme zwei
      // WhatsApp-Meldungen.
      const bestand = b.conversation_id
        ? await client.query(
            `SELECT id FROM voice.messages WHERE conversation_id = $1 AND handled = FALSE LIMIT 1`,
            [b.conversation_id])
        : { rows: [] };

      if (bestand.rows.length) {
        nid = bestand.rows[0].id;
        await client.query(`
          UPDATE voice.messages
             SET caller_name = COALESCE($2, caller_name),
                 caller_number = COALESCE($3, caller_number),
                 subject = $4, body = $5, urgency = $6, callback_requested = $7
           WHERE id = $1`,
          [nid, name, normalisiereNummer(b.rueckrufnummer) ?? nummer,
           thema, zusammenfassung, dringlichkeit, Boolean(b.rueckruf_erwuenscht)]);
      } else {
        const n = await client.query(`
          INSERT INTO voice.messages
            (call_id, conversation_id, caller_name, caller_number, subject, body,
             urgency, callback_requested)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [id, b.conversation_id ?? null, name, normalisiereNummer(b.rueckrufnummer) ?? nummer,
           thema, zusammenfassung, dringlichkeit, Boolean(b.rueckruf_erwuenscht)]);
        nid = n.rows[0].id;
        neu = true;
      }
    }

    return { callId: id, nachrichtId: nid, neu };
  });

  // Werbung meldet der Agent nicht weiter — dafür ist er ja da.
  // Und nur bei einer NEUEN Nachricht: Ein wiederholter Aufruf hat oben
  // die vorhandene aktualisiert, eine zweite Meldung wäre nur Lärm.
  if (ergebnis !== 'abgewimmelt' && neu) {
    const symbol = dringlichkeit >= 4 ? '🔴' : dringlichkeit <= 2 ? '⚪' : '🟠';
    const wer = name || nummer || 'Unbekannt';

    // Die Nummer für den Rückruf: was der Anrufer genannt hat, sonst die,
    // von der er anruft. Früher hing die ganze Zeile an der Anrufernummer —
    // bei unterdrückter Rufnummer stand dann "Rückruf erbeten" ohne Nummer,
    // obwohl der Agent extra danach gefragt hatte. Genau im einzigen Fall,
    // in dem die Angabe unverzichtbar ist, fehlte sie.
    const rueckrufnummer = normalisiereNummer(b.rueckrufnummer) ?? nummer;
    const rueckruf = b.rueckruf_erwuenscht
      ? `\n↩️ Rückruf erbeten${rueckrufnummer ? ` — ${rueckrufnummer}` : ' (keine Nummer hinterlassen)'}`
      : '';
    await query(`SELECT voice.melde($1,$2,$3,$4)`, [
      `${symbol} *Anruf von ${wer}*\n_${thema}_\n\n${zusammenfassung}${rueckruf}` +
      (nachrichtId ? `\n\n\`/erledigt ${nachrichtId}\`` : ''),
      'anruf', dringlichkeit, callId,
    ]);
  }

  res.json({
    ok: true,
    // Der Agent liest das nicht vor, aber es taucht im Werkzeugergebnis auf.
    bestaetigung: 'Notiert.',
  });
}));

// =============================================================================
//  Nachbereitung
// =============================================================================

intern.post('/anruf/abschluss', asyncH(async (req, res) => {
  const b = req.body ?? {};
  if (!b.conversation_id) return res.status(400).json({ fehler: 'conversation_id fehlt' });

  const { rows } = await query(`
    UPDATE voice.calls
       SET status = 'beendet',
           ended_at = COALESCE(ended_at, now()),
           duration_seconds = COALESCE($2, duration_seconds),
           summary = COALESCE($3, summary),
           transcript = COALESCE($4::jsonb, transcript),
           analysis = COALESCE($5::jsonb, analysis),
           cost_credits = COALESCE($6, cost_credits),
           raw_payload = COALESCE($7::jsonb, raw_payload)
     WHERE conversation_id = $1
     RETURNING id, caller_name, caller_number, topic, urgency, outcome`,
    [b.conversation_id, b.dauer_sekunden ?? null, b.zusammenfassung ?? null,
     b.transkript ? JSON.stringify(b.transkript) : null,
     b.analyse ? JSON.stringify(b.analyse) : null,
     b.kosten ?? null, b.roh ? JSON.stringify(b.roh) : null]);

  if (!rows.length) {
    // Kein passender Anruf — kommt vor, wenn der Agent notiz_anlegen nie
    // erreicht hat, etwa weil der Anrufer sofort aufgelegt hat. Dann ist der
    // Post-Call-Lauf die einzige Spur, und die soll nicht verloren gehen.
    const { rows: neu } = await query(`
      INSERT INTO voice.calls (conversation_id, caller_number, status, ended_at,
                               duration_seconds, summary, transcript, analysis, raw_payload,
                               outcome)
      VALUES ($1,$2,'beendet',now(),$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,'unklar')
      ON CONFLICT (conversation_id) DO NOTHING
      RETURNING id`,
      [b.conversation_id, normalisiereNummer(b.anrufer_nummer), b.dauer_sekunden ?? null,
       b.zusammenfassung ?? null,
       b.transkript ? JSON.stringify(b.transkript) : null,
       b.analyse ? JSON.stringify(b.analyse) : null,
       b.roh ? JSON.stringify(b.roh) : null]);

    return res.json({ ok: true, angelegt: Boolean(neu.length), nachgetragen: true });
  }

  res.json({ ok: true, call_id: rows[0].id, anruf: rows[0] });
}));

// =============================================================================
//  Post-Call — Signatur prüfen und wegschreiben
// =============================================================================
//  ElevenLabs signiert mit HMAC-SHA256 über "{zeitstempel}.{roher Body}".
//  Die Prüfung gehört hierher und nicht in n8n, aus zwei Gründen: Das
//  Geheimnis liegt dann an genau einer Stelle (der .env dieses Dienstes),
//  und der rohe Body überlebt den Weg — n8n-Nodes reichen Bodys geparst
//  weiter, womit jede Signatur rechnerisch nicht mehr passt.

const WEBHOOK_GEHEIMNIS = process.env.ELEVENLABS_WEBHOOK_SECRET || '';

/** Prüft die Signatur. Gibt eine Begründung zurück, wenn sie nicht stimmt. */
function signaturPruefen(roh, kopfzeile) {
  if (!WEBHOOK_GEHEIMNIS) return 'ELEVENLABS_WEBHOOK_SECRET ist nicht gesetzt';
  if (!kopfzeile) return 'Signatur fehlt';

  // Format: t=1739537297,v0=<hex>
  const teile = Object.fromEntries(
    String(kopfzeile).split(',').map((s) => {
      const i = s.indexOf('=');
      return i < 0 ? [s.trim(), ''] : [s.slice(0, i).trim(), s.slice(i + 1).trim()];
    }),
  );

  const zeitstempel = Number(teile.t);
  const vorgelegt = teile.v0;
  if (!Number.isFinite(zeitstempel) || !vorgelegt) return 'Signatur unlesbar';

  // Ein alter, abgefangener Aufruf soll sich nicht beliebig oft
  // wiederverwenden lassen. 30 Minuten sind großzügig genug für die
  // Wiederholungen, die ElevenLabs bei Zustellfehlern selbst unternimmt.
  const alter = Math.abs(Date.now() / 1000 - zeitstempel);
  if (alter > 1800) return `Zeitstempel ist ${Math.round(alter / 60)} Minuten alt`;

  const erwartet = createHmac('sha256', WEBHOOK_GEHEIMNIS)
    .update(`${zeitstempel}.${roh}`)
    .digest('hex');

  const a = Buffer.from(erwartet);
  const b = Buffer.from(vorgelegt);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'Signatur stimmt nicht';

  return null;
}

intern.post('/postcall', asyncH(async (req, res) => {
  const roh = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
  const grund = signaturPruefen(roh, req.get('ElevenLabs-Signature') || req.get('elevenlabs-signature'));

  if (grund) {
    console.warn(`[postcall] abgewiesen: ${grund}`);
    return res.status(401).json({ ok: false, fehler: grund });
  }

  let nutzlast;
  try { nutzlast = JSON.parse(roh); } catch { return res.status(400).json({ ok: false, fehler: 'Kein gültiges JSON' }); }

  const typ = nutzlast.type;
  const d = nutzlast.data ?? {};

  // Es gibt drei Ereignisarten. Nur die Abschrift trägt Inhalte; die
  // anderen beiden werden protokolliert und abgehakt.
  if (typ === 'call_initiation_failure') {
    await query(`SELECT voice.melde($1,$2,$3)`, [
      `⚠️ *Anruf nicht zustande gekommen*\n${d.reason ?? 'kein Grund genannt'}` +
      (d.caller_id ? `\nAnrufer: ${d.caller_id}` : ''),
      'fehler', 4,
    ]);
    return res.json({ ok: true, art: typ });
  }

  if (typ !== 'post_call_transcription') {
    return res.json({ ok: true, art: typ, beachtet: false });
  }

  const gespraechId = d.conversation_id;
  if (!gespraechId) return res.status(400).json({ ok: false, fehler: 'conversation_id fehlt' });

  // Die Abschrift als lesbarer Text — das ist, was gleich zusammengefasst wird.
  const abschrift = (d.transcript ?? [])
    .filter((t) => t.message)
    .map((t) => `${t.role === 'agent' ? 'Assistent' : 'Anrufer'}: ${t.message}`)
    .join('\n');

  const nummer = normalisiereNummer(
    d.metadata?.phone_call?.external_number ?? d.conversation_initiation_client_data?.dynamic_variables?.system__caller_id,
  );

  // Wurde durchgestellt?
  //
  // Das lässt sich nur hier feststellen. Der Agent ruft transfer_to_number
  // auf und ist damit aus dem Gespräch — notiz_anlegen kommt danach nicht
  // mehr, also blieb calls.transferred bisher immer false. Damit stand
  // transfers_today() dauerhaft auf 0 und die Tagesobergrenze für
  // Weiterleitungen griff nie. Ein hartnäckiger Anrufer konnte zehnmal
  // durchgestellt werden, obwohl fünf das Maximum sein sollten.
  //
  // Das Transkript ist die einzige verlässliche Spur. Gezählt wird jeder
  // Aufruf, auch ein fehlgeschlagener — bei einer Schutzgrenze ist die
  // vorsichtige Richtung die richtige.
  const durchgestellt = (d.transcript ?? []).some((t) =>
    (t.tool_calls ?? []).some((tc) => (tc.tool_name ?? tc.name) === 'transfer_to_number'),
  );

  // Der Werkzeugaufruf notiz_anlegen hat die Zeile meist schon angelegt,
  // aber unter der conversation_id. Der Vorab-Webhook kannte nur die
  // call_sid. Beide zusammenführen, bevor geschrieben wird.
  const sid = d.metadata?.phone_call?.call_sid;
  if (sid) {
    await query(`
      UPDATE voice.calls SET conversation_id = $1
       WHERE conversation_id = $2
         AND NOT EXISTS (SELECT 1 FROM voice.calls WHERE conversation_id = $1)`,
      [gespraechId, `sid:${sid}`]).catch(() => {});
  }

  const { rows } = await query(`
    INSERT INTO voice.calls (conversation_id, agent_id, caller_number, status, ended_at,
                             duration_seconds, transcript, analysis, cost_credits, raw_payload,
                             transferred, outcome)
    VALUES ($1,$2,$3,'beendet', now(), $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9,
            CASE WHEN $9 THEN 'durchgestellt'::voice.call_outcome ELSE NULL END)
    ON CONFLICT (conversation_id) DO UPDATE SET
      status           = 'beendet',
      ended_at         = COALESCE(voice.calls.ended_at, now()),
      duration_seconds = COALESCE(EXCLUDED.duration_seconds, voice.calls.duration_seconds),
      caller_number    = COALESCE(voice.calls.caller_number, EXCLUDED.caller_number),
      transcript       = COALESCE(EXCLUDED.transcript, voice.calls.transcript),
      analysis         = COALESCE(EXCLUDED.analysis, voice.calls.analysis),
      cost_credits     = COALESCE(EXCLUDED.cost_credits, voice.calls.cost_credits),
      raw_payload      = COALESCE(EXCLUDED.raw_payload, voice.calls.raw_payload),
      -- Nur setzen, nie zurücknehmen: Hat notiz_anlegen es schon vermerkt,
      -- bleibt es dabei, auch wenn das Transkript den Aufruf nicht zeigt.
      transferred      = (voice.calls.transferred OR EXCLUDED.transferred),
      outcome          = COALESCE(voice.calls.outcome, EXCLUDED.outcome)
    RETURNING id, caller_name, caller_number, topic, urgency, outcome, summary, transferred`,
    [gespraechId, d.agent_id ?? null, nummer,
     d.metadata?.call_duration_secs ?? null,
     d.transcript ? JSON.stringify(d.transcript) : null,
     d.analysis ? JSON.stringify(d.analysis) : null,
     d.metadata?.cost ?? null,
     JSON.stringify({ metadata: d.metadata ?? null, analysis: d.analysis ?? null }),
     durchgestellt]);

  const anruf = rows[0];
  await audit('elevenlabs', 'call.postcall',
    { conversation_id: gespraechId, call_id: anruf.id, durchgestellt });

  // n8n bekommt zurück, was es zum Zusammenfassen braucht. Ob überhaupt
  // zusammengefasst werden muss, entscheidet der Workflow: hat der Agent
  // schon notiert und war es Werbung, lohnt der LLM-Aufruf nicht.
  res.json({
    ok: true,
    art: typ,
    call_id: anruf.id,
    conversation_id: gespraechId,
    hat_notiz: Boolean(anruf.topic),
    durchgestellt: anruf.transferred,
    ergebnis: anruf.outcome,
    dringlichkeit: anruf.urgency,
    anrufer: anruf.caller_name ?? anruf.caller_number ?? 'unbekannt',
    dauer_sekunden: d.metadata?.call_duration_secs ?? null,
    abschrift,
    auswertung: d.analysis?.data_collection_results ?? null,
  });
}));

// =============================================================================
//  Meldung einreihen — für Workflows, die selbst etwas ausrichten wollen
// =============================================================================

intern.post('/melden', asyncH(async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ fehler: 'text fehlt' });

  const { rows } = await query(`SELECT voice.melde($1,$2,$3,$4,$5) AS id`, [
    text.slice(0, 3500),
    String(req.body?.anlass ?? 'system').slice(0, 40),
    Math.min(Math.max(Number(req.body?.dringlichkeit) || 3, 1), 5),
    req.body?.call_id ?? null,
    req.body?.empfaenger ?? null,
  ]);
  res.json({ ok: true, id: rows[0].id });
}));

export default intern;
