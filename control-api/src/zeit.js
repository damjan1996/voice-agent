// =============================================================================
//  Zeitangaben aus WhatsApp-Nachrichten
// =============================================================================
//  "/agent aus bis 16 uhr" soll funktionieren, ohne dass jemand ein
//  ISO-Datum tippt. Diese Datei übersetzt die Handvoll Formulierungen, die
//  man im Alltag wirklich benutzt, in einen Zeitpunkt.
//
//  Absichtlich klein gehalten: erkannt wird, was eindeutig ist. Alles andere
//  gibt null zurück, und der Aufrufer sagt dann, was er verstanden hätte.
//  Ein falsch geratenes "bis morgen" wäre schlimmer als eine Rückfrage —
//  es bedeutet verpasste Anrufe.
// =============================================================================

export const ZEITZONE = 'Europe/Berlin';

/**
 * Aktueller Zeitpunkt, zerlegt in Berliner Wanduhr-Bestandteile.
 * Der Umweg über Intl ist nötig, weil der Container zwar auf Europe/Berlin
 * steht, das aber niemand garantiert.
 */
export function berlinJetzt(now = new Date()) {
  const teile = new Intl.DateTimeFormat('de-DE', {
    timeZone: ZEITZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const p = Object.fromEntries(teile.filter((t) => t.type !== 'literal').map((t) => [t.type, t.value]));
  return {
    jahr: Number(p.year),
    monat: Number(p.month),
    tag: Number(p.day),
    // Intl liefert für Mitternacht je nach Node-Version "24" statt "00".
    stunde: Number(p.hour) % 24,
    minute: Number(p.minute),
    sekunde: Number(p.second),
  };
}

/**
 * Baut aus Berliner Wanduhrzeit einen echten Zeitpunkt.
 *
 * Der Versatz zwischen UTC und Berlin ist nicht konstant (Sommerzeit), also
 * wird er für den gesuchten Tag bestimmt statt fest angenommen. Zweimal,
 * weil der Versatz selbst vom Ergebnis abhängen kann — nämlich genau in den
 * beiden Umstellungsnächten.
 */
export function berlinZeitpunkt({ jahr, monat, tag, stunde = 0, minute = 0 }) {
  let ts = Date.UTC(jahr, monat - 1, tag, stunde, minute, 0);
  for (let i = 0; i < 2; i++) {
    const versatz = versatzMinuten(new Date(ts));
    const korrigiert = Date.UTC(jahr, monat - 1, tag, stunde, minute, 0) - versatz * 60_000;
    if (korrigiert === ts) break;
    ts = korrigiert;
  }
  return new Date(ts);
}

/**
 * Verschiebt ein Kalenderdatum um n Tage.
 *
 * Bewusst über Date.UTC statt über Millisekunden: Ein Berliner Tag hat in
 * den beiden Umstellungsnächten 23 bzw. 25 Stunden. Wer 86 400 000 ms
 * addiert, landet dann eine Stunde daneben — und weil hier von 23:59
 * gerechnet wird, kippt diese Stunde über Mitternacht in den falschen Tag.
 * "/agent aus bis morgen" am 28. März hätte den Agent einen Tag zu lang
 * abgeschaltet.
 *
 * UTC kennt keine Sommerzeit, deshalb ist die Rechnung dort exakt; Monats-
 * und Jahreswechsel erledigt Date.UTC von selbst.
 */
function tagePlus({ jahr, monat, tag }, n) {
  const d = new Date(Date.UTC(jahr, monat - 1, tag + n));
  return { jahr: d.getUTCFullYear(), monat: d.getUTCMonth() + 1, tag: d.getUTCDate() };
}

/** Wochentag eines Kalenderdatums. 0 = Sonntag. */
function wochentagVon({ jahr, monat, tag }) {
  return new Date(Date.UTC(jahr, monat - 1, tag)).getUTCDay();
}

// Liefert den Zonenversatz als Text, z.B. "GMT+02:00". Der Formatierer wird
// einmal gebaut und wiederverwendet — er ist teuer, und diese Funktion läuft
// bei jeder Terminberechnung mehrfach.
const VERSATZ_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: ZEITZONE,
  timeZoneName: 'longOffset',
});

/**
 * Versatz der Zeitzone gegenüber UTC in Minuten, für diesen Zeitpunkt.
 *
 * Der naheliegende Weg — dasselbe Datum einmal als Berlin und einmal als UTC
 * formatieren und die Differenz nehmen — hat einen Haken: Beide Strings
 * werden von new Date() in der Zeitzone des SERVERS geparst. Steht die auf
 * Europe/Berlin, fällt eine der beiden Wanduhrzeiten in der Nacht der
 * Vorstellung in die Stunde, die es nicht gibt (02:00–03:00). Das Ergebnis
 * ist dann um eine Stunde daneben, und zwar genau dort, wo es darauf ankommt.
 *
 * Intl kennt den Versatz direkt. Kein Parsen, keine Server-Zeitzone.
 */
function versatzMinuten(datum) {
  const teil = VERSATZ_FORMAT.formatToParts(datum).find((t) => t.type === 'timeZoneName');
  const treffer = /GMT([+-])(\d{2}):(\d{2})/.exec(teil?.value ?? '');
  if (!treffer) return 0; // "GMT" ohne Versatz bedeutet UTC.
  const [, vorzeichen, stunden, minuten] = treffer;
  const betrag = Number(stunden) * 60 + Number(minuten);
  return vorzeichen === '-' ? -betrag : betrag;
}

/**
 * Übersetzt eine Zeitangabe in einen Zeitpunkt.
 *
 * Verstanden werden:
 *   "16 uhr", "16:30", "bis 9"          → heute zu dieser Uhrzeit,
 *                                          morgen, falls schon vorbei
 *   "2h", "90m", "30min", "1.5h"        → Dauer ab jetzt
 *   "heute"                             → heute 23:59
 *   "morgen"                            → morgen 23:59
 *   "montag" … "sonntag"                → nächster solcher Tag, 23:59
 *   "2026-08-09T14:00:00+02:00"         → wie angegeben
 *
 * @returns {Date|null} null, wenn die Angabe nicht eindeutig ist.
 */
export function zeitpunktAus(eingabe, jetzt = new Date()) {
  if (!eingabe) return null;
  const text = String(eingabe).trim().toLowerCase().replace(/^bis\s+/, '').trim();
  if (!text) return null;

  const heute = berlinJetzt(jetzt);

  // --- Dauer: 2h, 90m, 45min, 1,5h ------------------------------------------
  const dauer = text.match(/^(\d+(?:[.,]\d+)?)\s*(h|std|stunden?|m|min|minuten?)$/);
  if (dauer) {
    const menge = Number(dauer[1].replace(',', '.'));
    if (!Number.isFinite(menge) || menge <= 0) return null;
    // Alle Stundenformen fangen mit h oder s an (h, std, stunde, stunden),
    // alle Minutenformen mit m. Der frühere Test auf startsWith('std') ging
    // bei "stunden" ins Leere — daraus wurden dann drei Minuten statt drei
    // Stunden, und der Agent schaltete viel zu früh zurück.
    const proEinheit = /^[hs]/.test(dauer[2]) ? 3_600_000 : 60_000;
    return new Date(jetzt.getTime() + menge * proEinheit);
  }

  // --- Uhrzeit: 16 uhr, 16:30, 16.30, 9 -------------------------------------
  const uhrzeit = text.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr)?$/);
  if (uhrzeit) {
    const stunde = Number(uhrzeit[1]);
    const minute = Number(uhrzeit[2] ?? 0);
    if (stunde > 23 || minute > 59) return null;
    // Eine bereits vergangene Uhrzeit meint den nächsten Tag.
    const tagDavon = berlinZeitpunkt({ ...heute, stunde, minute }) <= jetzt
      ? tagePlus(heute, 1)
      : heute;
    return berlinZeitpunkt({ ...tagDavon, stunde, minute });
  }

  // --- Tagesbezug -----------------------------------------------------------
  //  Immer erst das Kalenderdatum bestimmen, dann daraus den Zeitpunkt.
  //  Nie umgekehrt — siehe tagePlus().
  const tagesEnde = (versatz) => berlinZeitpunkt({ ...tagePlus(heute, versatz), stunde: 23, minute: 59 });

  if (text === 'heute' || text === 'heute abend') return tagesEnde(0);
  if (text === 'morgen') return tagesEnde(1);
  if (text === 'übermorgen' || text === 'uebermorgen') return tagesEnde(2);

  // --- Wochentag ------------------------------------------------------------
  const TAGE = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
  const wochentag = TAGE.indexOf(text);
  if (wochentag >= 0) {
    // Den Wochentag aus dem Berliner Kalenderdatum ableiten, nicht aus
    // getDay() eines Zeitpunkts — das läse die Zeitzone des Servers.
    const heutigerIndex = wochentagVon(heute);
    // Immer der KOMMENDE Tag dieses Namens, nie heute.
    const abstand = ((wochentag - heutigerIndex + 7) % 7) || 7;
    return tagesEnde(abstand);
  }

  // --- ISO ------------------------------------------------------------------
  //  new Date(text), nicht new Date(eingabe): Geprüft wird der bereinigte
  //  Text, also der ohne führendes "bis". Gäbe man die Rohfassung weiter,
  //  scheiterte ausgerechnet die dokumentierte Schreibweise
  //  "bis 2026-08-09T14:00:00+02:00" an einem Invalid Date.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/** "Do, 07.08.2026, 16:30 Uhr" — für Ausgaben an den Menschen. */
export function formatiere(datum) {
  if (!datum) return '—';
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: ZEITZONE,
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(datum)) + ' Uhr';
}

/** "in 2 Std. 15 Min." bzw. "vor 5 Min." */
export function relativ(datum, jetzt = new Date()) {
  if (!datum) return '—';
  const diff = new Date(datum).getTime() - jetzt.getTime();
  const min = Math.round(Math.abs(diff) / 60_000);
  const text = min < 60
    ? `${min} Min.`
    : `${Math.floor(min / 60)} Std. ${min % 60} Min.`;
  return diff >= 0 ? `in ${text}` : `vor ${text}`;
}
