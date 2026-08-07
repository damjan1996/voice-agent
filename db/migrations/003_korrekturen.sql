-- =============================================================================
--  003_korrekturen.sql — vier Fehler aus dem ersten Review
-- =============================================================================
--  Alle vier sind bei der Prüfung mit echten Daten aufgefallen, nicht beim
--  Lesen. Sie haben gemeinsam, dass das System sie nicht meldet: Es tut
--  einfach still das Falsche.
-- =============================================================================

SET search_path TO voice, public;

-- -----------------------------------------------------------------------------
--  1. Überlappende Termine
-- -----------------------------------------------------------------------------
--  Der bisherige eindeutige Index lag auf starts_at und fing nur den Fall ab,
--  dass zwei Buchungen exakt zur selben Sekunde beginnen. Ein Termin von
--  10:00 bis 11:00 und einer von 10:30 bis 11:00 gingen beide durch — nachweislich.
--
--  Das ist keine Randerscheinung: Das Sprachmodell ruft termin_buchen mit einer
--  frei gewählten Startzeit auf, und die Dauer schwankt zwischen 15 und 120
--  Minuten. Serverseitig prüfte nichts außer diesem Index.
--
--  EXCLUDE mit tstzrange prüft echte Überschneidung. Die Bereichsgrenzen sind
--  bewusst '[)' — ein Termin von 10:00 bis 11:00 und einer ab 11:00 berühren
--  sich, überlappen aber nicht.

DROP INDEX IF EXISTS voice.bookings_slot_unique;

-- Gibt es schon überlappende Buchungen, scheitert das ALTER TABLE mit einer
-- Meldung, die nur eine der beiden Zeilen nennt und keine ID enthält. Deshalb
-- vorher nachsehen und verständlich sagen, was zu tun ist — sonst steht man
-- beim Aktualisieren vor einem Fehler ohne Handlungsanweisung.
DO $$
DECLARE
    v_anzahl INT;
    v_paar   TEXT;
BEGIN
    SELECT count(*), string_agg(format('#%s (%s) ⇄ #%s (%s)',
             a.id, to_char(a.starts_at, 'DD.MM. HH24:MI'),
             b.id, to_char(b.starts_at, 'DD.MM. HH24:MI')), E'\n  ')
      INTO v_anzahl, v_paar
      FROM voice.bookings a
      JOIN voice.bookings b
        ON a.id < b.id
       AND a.status IN ('vorgemerkt', 'bestaetigt')
       AND b.status IN ('vorgemerkt', 'bestaetigt')
       AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)');

    IF v_anzahl > 0 THEN
        RAISE EXCEPTION E'Es gibt bereits % überlappende Buchung(en):\n  %\n\n'
            'Die Sperre gegen Doppelbuchungen lässt sich erst setzen, wenn die '
            'Überschneidungen aufgelöst sind. Ansehen mit:\n'
            '  SELECT id, caller_name, topic, starts_at, ends_at, status FROM voice.bookings ORDER BY starts_at;\n'
            'Dann die überzählige Buchung absagen:\n'
            '  UPDATE voice.bookings SET status = ''abgesagt'' WHERE id = <id>;',
            v_anzahl, v_paar;
    END IF;
END $$;

ALTER TABLE voice.bookings DROP CONSTRAINT IF EXISTS bookings_kein_ueberlapp;
ALTER TABLE voice.bookings
    ADD CONSTRAINT bookings_kein_ueberlapp
    EXCLUDE USING gist (tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (status IN ('vorgemerkt', 'bestaetigt'));

-- -----------------------------------------------------------------------------
--  2. Tote Spalte
-- -----------------------------------------------------------------------------
--  notified_at wurde nie geschrieben — der Meldeweg läuft vollständig über
--  voice.outbox. Die Spalte blieb dauerhaft NULL, der Teilindex darauf schloss
--  also nichts aus und wurde bei jedem Post-Call-UPDATE trotzdem gepflegt.
--  Schlimmer als die Kosten ist die Irreführung: Wer bei der Fehlersuche
--  "wann die WhatsApp-Meldung rausging" liest und NULL findet, schließt
--  daraus, dass keine rausging.

DROP INDEX IF EXISTS voice.calls_open_idx;
ALTER TABLE voice.calls DROP COLUMN IF EXISTS notified_at;

-- -----------------------------------------------------------------------------
--  3. Zustellung der Warteschlange in zwei Schritten
-- -----------------------------------------------------------------------------
--  hole_ausgang() setzte den Status sofort auf 'gesendet' — bevor überhaupt
--  jemand gesendet hatte. Holt der Bot zehn Meldungen und stirbt nach der
--  dritten (Neustart, Speichermangel, abgemeldete WhatsApp-Sitzung), sind
--  sieben für immer weg. Die Datenbank behauptet, sie seien zugestellt.
--
--  Jetzt: 'in_zustellung' beim Abholen, 'gesendet' erst auf Zuruf des Bots.
--  Was zu lange in 'in_zustellung' hängt, wird wieder freigegeben — damit
--  heilt sich ein abgestürzter Abholer von selbst.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'ausgang_status' AND e.enumlabel = 'in_zustellung'
    ) THEN
        ALTER TYPE voice.ausgang_status ADD VALUE 'in_zustellung' AFTER 'offen';
    END IF;
END $$;

-- Ein neuer Enum-Wert ist erst nach dem Ende der Transaktion benutzbar,
-- deshalb stehen die Funktionen darunter in einer eigenen Anweisung.

CREATE OR REPLACE FUNCTION voice.hole_ausgang(p_anzahl INT DEFAULT 10)
RETURNS SETOF voice.outbox AS $$
    -- Erst aufräumen: Was seit mehr als fünf Minuten in Zustellung hängt,
    -- hat kein Abholer mehr in der Hand.
    --
    -- Freigegebene Zeilen holt erst der NÄCHSTE Aufruf ab — beide Teile
    -- dieser Anweisung sehen denselben Datenstand, das UPDATE unten kennt
    -- die eben freigegebenen Zeilen also noch nicht. Bei einem Abholtakt von
    -- 15 Sekunden ist das die kleinere Verzögerung; die Alternative wäre,
    -- eine Zeile im selben Atemzug freizugeben und wieder zu greifen, was
    -- die Zählung der Versuche verfälschen würde.
    WITH freigabe AS (
        UPDATE voice.outbox
           SET status = 'offen'
         WHERE status = 'in_zustellung'
           AND gesendet_am < now() - interval '5 minutes'
        RETURNING 1
    )
    UPDATE voice.outbox
       SET status = 'in_zustellung',
           versuche = versuche + 1,
           gesendet_am = now()
     WHERE id IN (
         SELECT id FROM voice.outbox
          WHERE status = 'offen' AND faellig_ab <= now()
          ORDER BY dringlichkeit DESC, id
          LIMIT p_anzahl
          FOR UPDATE SKIP LOCKED
     )
    RETURNING *;
$$ LANGUAGE sql;

-- Der Bot bestätigt jede Meldung einzeln, nachdem WhatsApp sie angenommen hat.
CREATE OR REPLACE FUNCTION voice.ausgang_zugestellt(p_id BIGINT)
RETURNS VOID AS $$
    UPDATE voice.outbox
       SET status = 'gesendet', gesendet_am = now()
     WHERE id = p_id AND status = 'in_zustellung';
$$ LANGUAGE sql;

-- -----------------------------------------------------------------------------
--  4. Nachtruhe galt nur beim ersten Versuch
-- -----------------------------------------------------------------------------
--  melde() hält nachts alles unter Dringlichkeit 5 zurück. Der Wiedervorlage-
--  Pfad tat das nicht: Scheiterte ein Werbeanruf-Hinweis um 21:58 mehrfach,
--  lag der nächste Versuch bei 23:19 — und weckte damit genau den, den die
--  Regel schützen soll.

CREATE OR REPLACE FUNCTION voice.ausgang_fehlgeschlagen(p_id BIGINT, p_fehler TEXT)
RETURNS VOID AS $$
DECLARE
    v_zeile   voice.outbox%ROWTYPE;
    v_naechst TIMESTAMPTZ;
    v_stunde  INT;
BEGIN
    SELECT * INTO v_zeile FROM voice.outbox WHERE id = p_id;
    IF NOT FOUND THEN RETURN; END IF;

    -- Abstand wächst mit jedem Versuch: 1, 3, 9, 27, 81 Minuten.
    v_naechst := now() + (interval '1 minute' * power(3, LEAST(v_zeile.versuche, 4)));
    v_stunde  := EXTRACT(HOUR FROM v_naechst AT TIME ZONE 'Europe/Berlin');

    -- Dieselbe Nachtregel wie in melde(), nur auf den Wiedervorlagezeitpunkt.
    IF v_zeile.dringlichkeit < 5 AND (v_stunde >= 22 OR v_stunde < 7) THEN
        v_naechst := ((date_trunc('day', v_naechst AT TIME ZONE 'Europe/Berlin')
                       + CASE WHEN v_stunde >= 22 THEN interval '1 day' ELSE interval '0' END
                       + interval '7 hours') AT TIME ZONE 'Europe/Berlin');
    END IF;

    UPDATE voice.outbox
       SET status = CASE WHEN v_zeile.versuche >= 5 THEN 'fehlgeschlagen'::voice.ausgang_status
                         ELSE 'offen'::voice.ausgang_status END,
           letzter_fehler = p_fehler,
           gesendet_am = NULL,
           faellig_ab = v_naechst
     WHERE id = p_id;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
--  5. Die Tagesobergrenze für Weiterleitungen zählte nie
-- -----------------------------------------------------------------------------
--  transfers_today() liest voice.calls.transferred. Gesetzt wurde die Spalte
--  aber nur, wenn der Agent notiz_anlegen mit ergebnis='durchgestellt'
--  aufruft — und nach einer echten Weiterleitung über transfer_to_number ist
--  das Gespräch für ihn beendet, er ruft nichts mehr auf. Die Zählung stand
--  damit dauerhaft auf 0 und die Obergrenze griff nie.
--
--  Die Control-API setzt transferred jetzt zusätzlich beim Nachbereiten,
--  wenn im Transkript ein Aufruf von transfer_to_number steht (siehe
--  intern.js). Diese Sicht macht sichtbar, worauf sich die Grenze stützt.

CREATE OR REPLACE VIEW voice.weiterleitungen_heute AS
SELECT id, conversation_id, caller_number, caller_name, started_at, outcome
  FROM voice.calls
 WHERE transferred
   AND started_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Berlin')
                     AT TIME ZONE 'Europe/Berlin';

COMMENT ON VIEW voice.weiterleitungen_heute IS
  'Grundlage für transfer_daily_cap. Ist sie leer, obwohl durchgestellt wurde, '
  'erkennt die Nachbereitung den Werkzeugaufruf nicht — siehe intern.js, /postcall.';
