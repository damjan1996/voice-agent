// =============================================================================
//  Tests für die Zeitlogik
// =============================================================================
//  Hier steckt die meiste Rechnerei und damit das meiste Fehlerpotential.
//  Die Umstellungsnächte haben schon einmal einen Fehler versteckt: "morgen"
//  landete am 28. März auf dem übernächsten Tag, weil 86 400 000 ms addiert
//  wurden statt einen Kalendertag weiterzuzählen. Ein "/agent aus bis morgen"
//  hätte den Agent dann einen ganzen Tag zu lang abgeschaltet.
//
//  Ausführen: npm test   (oder: node --test test/)
// =============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { zeitpunktAus, berlinZeitpunkt, berlinJetzt, formatiere, relativ } from '../src/zeit.js';

/** Berliner Wanduhrzeit als "TT.MM.JJJJ HH:MM" — unabhängig von der Server-Zeitzone. */
const berlin = (d) =>
  d === null || d === undefined
    ? 'null'
    : new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(d).replace(',', '');

// Sommerzeit 2026: Beginn So 29.03., Ende So 25.10.
const SA_VOR_VORSTELLUNG  = new Date('2026-03-28T12:00:00+01:00');
const SA_VOR_RUECKSTELLUNG = new Date('2026-10-24T12:00:00+02:00');
const NORMALER_FREITAG    = new Date('2026-08-07T12:00:00+02:00');

describe('zeitpunktAus — Tagesbezug', () => {
  test('heute ist der heutige Tagesabschluss', () => {
    assert.equal(berlin(zeitpunktAus('heute', NORMALER_FREITAG)), '07.08.2026 23:59');
  });

  test('morgen ist der folgende Kalendertag', () => {
    assert.equal(berlin(zeitpunktAus('morgen', NORMALER_FREITAG)), '08.08.2026 23:59');
  });

  test('übermorgen zählt zwei Kalendertage', () => {
    assert.equal(berlin(zeitpunktAus('übermorgen', NORMALER_FREITAG)), '09.08.2026 23:59');
    assert.equal(berlin(zeitpunktAus('uebermorgen', NORMALER_FREITAG)), '09.08.2026 23:59');
  });

  test('über den Monatswechsel hinweg', () => {
    const letzterAugust = new Date('2026-08-31T12:00:00+02:00');
    assert.equal(berlin(zeitpunktAus('morgen', letzterAugust)), '01.09.2026 23:59');
  });

  test('über den Jahreswechsel hinweg', () => {
    const silvester = new Date('2026-12-31T12:00:00+01:00');
    assert.equal(berlin(zeitpunktAus('morgen', silvester)), '01.01.2027 23:59');
  });
});

describe('zeitpunktAus — Umstellungsnächte', () => {
  // Der Tag der Vorstellung hat nur 23 Stunden. Wer Millisekunden addiert,
  // landet auf 00:59 des ÜBERNÄCHSTEN Tages.
  test('morgen bleibt auch vor der Vorstellung der Folgetag', () => {
    assert.equal(berlin(zeitpunktAus('morgen', SA_VOR_VORSTELLUNG)), '29.03.2026 23:59');
  });

  test('übermorgen bleibt auch vor der Vorstellung korrekt', () => {
    assert.equal(berlin(zeitpunktAus('übermorgen', SA_VOR_VORSTELLUNG)), '30.03.2026 23:59');
  });

  // Der Tag der Rückstellung hat 25 Stunden — hier landet die
  // Millisekundenrechnung eine Stunde zu früh.
  test('morgen bleibt auch vor der Rückstellung der Folgetag', () => {
    assert.equal(berlin(zeitpunktAus('morgen', SA_VOR_RUECKSTELLUNG)), '25.10.2026 23:59');
  });

  test('Wochentag über die Umstellung hinweg', () => {
    // Von Samstag, 28.03. ist der kommende Montag der 30.03.
    assert.equal(berlin(zeitpunktAus('montag', SA_VOR_VORSTELLUNG)), '30.03.2026 23:59');
  });
});

describe('zeitpunktAus — Uhrzeit', () => {
  test('eine noch kommende Uhrzeit meint heute', () => {
    assert.equal(berlin(zeitpunktAus('16 uhr', NORMALER_FREITAG)), '07.08.2026 16:00');
    assert.equal(berlin(zeitpunktAus('16:30', NORMALER_FREITAG)), '07.08.2026 16:30');
    assert.equal(berlin(zeitpunktAus('16.30', NORMALER_FREITAG)), '07.08.2026 16:30');
  });

  test('eine vergangene Uhrzeit meint morgen', () => {
    assert.equal(berlin(zeitpunktAus('9 uhr', NORMALER_FREITAG)), '08.08.2026 09:00');
  });

  test('das führende "bis" wird abgeschnitten', () => {
    assert.equal(berlin(zeitpunktAus('bis 16 uhr', NORMALER_FREITAG)), '07.08.2026 16:00');
  });

  test('unmögliche Uhrzeiten ergeben null', () => {
    assert.equal(zeitpunktAus('25 uhr', NORMALER_FREITAG), null);
    assert.equal(zeitpunktAus('16:99', NORMALER_FREITAG), null);
  });

  test('eine vergangene Uhrzeit am Tag vor der Umstellung', () => {
    // 9 Uhr ist um 12 Uhr vorbei → morgen. Der 29.03. hat nur 23 Stunden.
    assert.equal(berlin(zeitpunktAus('9 uhr', SA_VOR_VORSTELLUNG)), '29.03.2026 09:00');
  });
});

describe('zeitpunktAus — Dauer', () => {
  test('Stunden und Minuten', () => {
    assert.equal(berlin(zeitpunktAus('2h', NORMALER_FREITAG)), '07.08.2026 14:00');
    assert.equal(berlin(zeitpunktAus('90m', NORMALER_FREITAG)), '07.08.2026 13:30');
    assert.equal(berlin(zeitpunktAus('45min', NORMALER_FREITAG)), '07.08.2026 12:45');
    assert.equal(berlin(zeitpunktAus('3 stunden', NORMALER_FREITAG)), '07.08.2026 15:00');
  });

  test('Dezimaltrennzeichen Punkt wie Komma', () => {
    assert.equal(berlin(zeitpunktAus('1.5h', NORMALER_FREITAG)), '07.08.2026 13:30');
    assert.equal(berlin(zeitpunktAus('1,5h', NORMALER_FREITAG)), '07.08.2026 13:30');
  });

  test('eine Dauer über die Umstellung hinweg zählt echte Stunden', () => {
    // 24 Stunden ab Sa 12:00 CET sind So 13:00 CEST — die Uhr springt vor.
    // Das ist bei einer DAUER richtig so, anders als bei einem Kalendertag.
    assert.equal(berlin(zeitpunktAus('24h', SA_VOR_VORSTELLUNG)), '29.03.2026 13:00');
  });

  test('null und negative Dauer ergeben null', () => {
    assert.equal(zeitpunktAus('0h', NORMALER_FREITAG), null);
    assert.equal(zeitpunktAus('-2h', NORMALER_FREITAG), null);
  });
});

describe('zeitpunktAus — Wochentage', () => {
  test('nennt immer den KOMMENDEN Tag dieses Namens', () => {
    // Der 07.08.2026 ist ein Freitag.
    assert.equal(berlin(zeitpunktAus('montag', NORMALER_FREITAG)),    '10.08.2026 23:59');
    assert.equal(berlin(zeitpunktAus('sonntag', NORMALER_FREITAG)),   '09.08.2026 23:59');
    assert.equal(berlin(zeitpunktAus('donnerstag', NORMALER_FREITAG)), '13.08.2026 23:59');
  });

  test('heute genannt meint in einer Woche, nicht jetzt', () => {
    assert.equal(berlin(zeitpunktAus('freitag', NORMALER_FREITAG)), '14.08.2026 23:59');
  });
});

describe('zeitpunktAus — Sonstiges', () => {
  test('ISO-Zeitstempel werden übernommen', () => {
    assert.equal(berlin(zeitpunktAus('2026-08-09T14:00:00+02:00', NORMALER_FREITAG)), '09.08.2026 14:00');
  });

  test('Unverständliches ergibt null statt eines geratenen Werts', () => {
    for (const eingabe of ['', null, undefined, 'irgendwann', 'nächste woche', 'gleich', 'abc']) {
      assert.equal(zeitpunktAus(eingabe, NORMALER_FREITAG), null, `"${eingabe}" hätte null ergeben müssen`);
    }
  });
});

describe('berlinZeitpunkt', () => {
  test('trifft die Wanduhrzeit in beiden Halbjahren', () => {
    assert.equal(berlin(berlinZeitpunkt({ jahr: 2026, monat: 1, tag: 15, stunde: 10, minute: 0 })),
      '15.01.2026 10:00');
    assert.equal(berlin(berlinZeitpunkt({ jahr: 2026, monat: 7, tag: 15, stunde: 10, minute: 0 })),
      '15.07.2026 10:00');
  });

  test('ein Zeitpunkt direkt nach der Vorstellung', () => {
    assert.equal(berlin(berlinZeitpunkt({ jahr: 2026, monat: 3, tag: 29, stunde: 3, minute: 0 })),
      '29.03.2026 03:00');
  });
});

describe('berlinJetzt', () => {
  test('liefert plausible Bestandteile', () => {
    const j = berlinJetzt(NORMALER_FREITAG);
    assert.equal(j.jahr, 2026);
    assert.equal(j.monat, 8);
    assert.equal(j.tag, 7);
    assert.equal(j.stunde, 12);
    assert.ok(j.stunde >= 0 && j.stunde <= 23, 'Stunde muss zwischen 0 und 23 liegen');
  });

  test('Mitternacht ergibt Stunde 0, nicht 24', () => {
    const mitternacht = new Date('2026-08-07T00:00:00+02:00');
    assert.equal(berlinJetzt(mitternacht).stunde, 0);
  });
});

describe('Ausgabe für Menschen', () => {
  test('formatiere nennt Wochentag, Datum und Uhrzeit', () => {
    const s = formatiere(new Date('2026-08-07T16:30:00+02:00'));
    assert.match(s, /07\.08\.2026/);
    assert.match(s, /16:30/);
    assert.match(s, /Uhr$/);
  });

  test('formatiere verträgt null', () => {
    assert.equal(formatiere(null), '—');
  });

  test('relativ unterscheidet Vergangenheit und Zukunft', () => {
    const jetzt = new Date('2026-08-07T12:00:00+02:00');
    assert.match(relativ(new Date('2026-08-07T12:30:00+02:00'), jetzt), /^in 30 Min\./);
    assert.match(relativ(new Date('2026-08-07T11:55:00+02:00'), jetzt), /^vor 5 Min\./);
    assert.match(relativ(new Date('2026-08-07T14:15:00+02:00'), jetzt), /^in 2 Std\. 15 Min\./);
  });
});
