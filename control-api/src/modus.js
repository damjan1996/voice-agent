// =============================================================================
//  Betriebsmodus
// =============================================================================
//  Der Modus ist die einzige Stelle, an der entschieden wird, wie sich der
//  Agent am Telefon verhält. Er wird per WhatsApp gesetzt und bei jedem
//  eingehenden Anruf gelesen.
// =============================================================================

import { query, audit } from './db.js';
import { zeitpunktAus, formatiere } from './zeit.js';

export const MODI = ['aktiv', 'nur_notiz', 'aus'];

// Was jemand tatsächlich tippt, wenn er einen Modus meint. Der Bot reicht
// den Rohtext durch; die Übersetzung gehört hierher und nicht in den Bot,
// damit CLI, WhatsApp und HTTP dieselbe Sprache verstehen.
const SCHREIBWEISEN = {
  aktiv: 'aktiv', an: 'aktiv', ein: 'aktiv', on: 'aktiv', start: 'aktiv',
  aktivieren: 'aktiv', normal: 'aktiv',

  nur_notiz: 'nur_notiz', notiz: 'nur_notiz', 'nur-notiz': 'nur_notiz',
  stumm: 'nur_notiz', ruhe: 'nur_notiz', meeting: 'nur_notiz',
  dnd: 'nur_notiz', nichtstoeren: 'nur_notiz', 'nicht-stören': 'nur_notiz',

  aus: 'aus', off: 'aus', stop: 'aus', deaktivieren: 'aus', urlaub: 'aus',
};

export function modusAus(text) {
  if (!text) return null;
  const s = String(text).trim().toLowerCase().replace(/\s+/g, '-');
  return SCHREIBWEISEN[s] ?? SCHREIBWEISEN[s.replace(/-/g, '_')] ?? null;
}

export const BESCHREIBUNG = {
  aktiv: 'Nimmt an, klärt das Anliegen, schlägt Termine vor und stellt bei Dringlichkeit durch.',
  nur_notiz: 'Nimmt an und notiert das Anliegen — stellt aber nicht durch. Für Meetings.',
  aus: 'Nimmt an, sagt kurz Bescheid, nimmt eine Nachricht auf. Kein Kalender, keine Weiterleitung.',
};

/** Der gespeicherte Zustand plus dem, was daraus gerade tatsächlich gilt. */
export async function lies() {
  const { rows } = await query(`
    SELECT s.mode              AS gesetzter_modus,
           voice.effective_mode() AS modus,
           s.mode_until        AS gilt_bis,
           s.fallback_mode     AS danach,
           s.status_note       AS hinweis,
           s.transfer_allowed  AS durchstellen_erlaubt,
           s.transfer_daily_cap AS durchstellen_limit,
           voice.transfers_today() AS durchstellen_heute,
           s.updated_at        AS geaendert_am,
           s.updated_by        AS geaendert_von
    FROM voice.agent_state s WHERE s.id = 1
  `);

  const z = rows[0];
  if (!z) throw new Error('agent_state ist leer — Migration 001 nicht gelaufen?');

  return {
    ...z,
    abgelaufen: z.gesetzter_modus !== z.modus,
    beschreibung: BESCHREIBUNG[z.modus],
    durchstellen_moeglich:
      z.modus === 'aktiv' &&
      z.durchstellen_erlaubt &&
      z.durchstellen_heute < z.durchstellen_limit,
  };
}

/**
 * Setzt den Modus.
 *
 * @param {object} p
 * @param {string} p.modus           Zielmodus, schon normalisiert.
 * @param {string} [p.bis]           Zeitangabe wie "16 uhr" oder "2h".
 * @param {string} [p.danach]        Modus nach Ablauf. Vorgabe: 'aktiv'.
 * @param {string} [p.hinweis]       Wird dem Anrufer vorgelesen — sparsam nutzen.
 * @param {string} p.akteur          Wer schaltet ("whatsapp:4915…", "cli").
 */
export async function setze({ modus, bis, danach, hinweis, akteur = 'unbekannt' }) {
  if (!MODI.includes(modus)) {
    throw Object.assign(new Error(`Unbekannter Modus "${modus}"`), { code: 'BAD_MODE' });
  }

  let giltBis = null;
  if (bis) {
    giltBis = zeitpunktAus(bis);
    if (!giltBis) {
      throw Object.assign(
        new Error(`Zeitangabe "${bis}" nicht verstanden. Beispiele: "16 uhr", "2h", "morgen", "freitag".`),
        { code: 'BAD_TIME' },
      );
    }
    if (giltBis <= new Date()) {
      throw Object.assign(new Error('Der Zeitpunkt liegt in der Vergangenheit.'), { code: 'BAD_TIME' });
    }
  }

  const rueckfall = danach ? modusAus(danach) : 'aktiv';
  if (!rueckfall) {
    throw Object.assign(new Error(`Unbekannter Folgemodus "${danach}"`), { code: 'BAD_MODE' });
  }

  const { rows } = await query(`
    UPDATE voice.agent_state
       SET mode          = $1,
           mode_until    = $2,
           fallback_mode = $3,
           -- Ein nicht mitgeschickter Hinweis löscht den alten. Ein alter
           -- Hinweis wie "bin bis 14 Uhr im Termin" wäre am nächsten Tag
           -- schlicht falsch, und falsch ist schlimmer als leer.
           status_note   = $4,
           updated_by    = $5
     WHERE id = 1
    RETURNING mode, mode_until
  `, [modus, giltBis, rueckfall, hinweis?.trim() || null, akteur]);

  await audit(akteur, 'mode.set', {
    modus, gilt_bis: giltBis?.toISOString() ?? null, danach: rueckfall, hinweis: hinweis ?? null,
  });

  return { ...rows[0], gilt_bis_lesbar: giltBis ? formatiere(giltBis) : null };
}

/** Einzeiler für WhatsApp. */
export function alsText(z) {
  const teile = [];
  const symbol = { aktiv: '🟢', nur_notiz: '🟡', aus: '🔴' }[z.modus];
  teile.push(`${symbol} *${z.modus.replace('_', ' ')}* — ${z.beschreibung}`);

  if (z.gilt_bis && !z.abgelaufen) {
    teile.push(`⏱ bis ${formatiere(z.gilt_bis)}, danach *${z.danach.replace('_', ' ')}*`);
  } else if (z.abgelaufen) {
    teile.push(`⏱ Befristung abgelaufen — es gilt der Rückfall *${z.modus.replace('_', ' ')}*`);
  }

  if (z.hinweis) teile.push(`💬 Ansage: „${z.hinweis}“`);

  if (z.modus === 'aktiv') {
    teile.push(z.durchstellen_moeglich
      ? `📞 Durchstellen möglich (heute ${z.durchstellen_heute}/${z.durchstellen_limit})`
      : `📞 Durchstellen gesperrt (heute ${z.durchstellen_heute}/${z.durchstellen_limit})`);
  }

  return teile.join('\n');
}
