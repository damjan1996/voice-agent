-- =============================================================================
--  002_ausgang.sql — Warteschlange für Meldungen an Damjan
-- =============================================================================
--  Der Voice-Agent muss Damjan erreichen: "Anruf von X, Thema Y, dringend".
--  Der Weg dorthin ist WhatsApp — und WhatsApp hängt an whatsapp-web.js im
--  Bot-Prozess, nicht an einer API, die n8n aufrufen könnte.
--
--  Deshalb diese Tabelle als Übergabepunkt. n8n und die Control-API legen
--  hier ab, der Bot holt ab. Das entkoppelt beide Seiten sauber:
--
--    * Ist der Bot gerade neu gestartet oder hat WhatsApp die Sitzung
--      abgemeldet, geht keine Meldung verloren — sie wartet.
--    * Ein hängendes WhatsApp bremst keinen laufenden Anruf aus.
--    * Was rausging und was nicht, ist nachvollziehbar.
-- =============================================================================

SET search_path TO voice, public;

CREATE TYPE voice.ausgang_status AS ENUM ('offen', 'gesendet', 'fehlgeschlagen', 'verworfen');

CREATE TABLE IF NOT EXISTS voice.outbox (
    id              BIGSERIAL   PRIMARY KEY,

    -- Wohin. Leer = an OWNER_PHONE aus der Konfiguration.
    empfaenger      TEXT,
    kanal           TEXT        NOT NULL DEFAULT 'whatsapp',

    text            TEXT        NOT NULL,

    -- Zur Einordnung im Bot und für die Fehlersuche.
    anlass          TEXT        NOT NULL,   -- 'anruf', 'notiz', 'termin', 'fehler'
    call_id         BIGINT      REFERENCES voice.calls (id) ON DELETE SET NULL,
    dringlichkeit   SMALLINT    NOT NULL DEFAULT 3 CHECK (dringlichkeit BETWEEN 1 AND 5),

    status          voice.ausgang_status NOT NULL DEFAULT 'offen',
    versuche        SMALLINT    NOT NULL DEFAULT 0,
    letzter_fehler  TEXT,

    -- Frühester Sendezeitpunkt. Erlaubt zweierlei: Wiederholung mit Abstand
    -- nach einem Fehlschlag, und Zurückhalten von Unwichtigem zur Nachtzeit.
    faellig_ab      TIMESTAMPTZ NOT NULL DEFAULT now(),

    erstellt_am     TIMESTAMPTZ NOT NULL DEFAULT now(),
    gesendet_am     TIMESTAMPTZ
);

-- Der Abholer fragt genau danach: was ist offen und fällig?
CREATE INDEX IF NOT EXISTS outbox_faellig_idx
    ON voice.outbox (faellig_ab, dringlichkeit DESC)
    WHERE status = 'offen';

-- -----------------------------------------------------------------------------
--  Eine Meldung einreihen
-- -----------------------------------------------------------------------------
--  Als Funktion, damit die Regel "nachts nur Dringendes" an genau einer
--  Stelle steht und nicht in jedem Workflow neu gebaut wird.
--
--  Zwischen 22 und 7 Uhr wird alles unterhalb Dringlichkeit 5 auf den
--  nächsten Morgen um 7 gelegt. Ein Werbeanruf um drei Uhr nachts soll
--  niemanden wecken; ein echter Notfall schon.

CREATE OR REPLACE FUNCTION voice.melde(
    p_text          TEXT,
    p_anlass        TEXT,
    p_dringlichkeit SMALLINT DEFAULT 3,
    p_call_id       BIGINT   DEFAULT NULL,
    p_empfaenger    TEXT     DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
    v_jetzt   TIMESTAMPTZ := now();
    v_stunde  INT;
    v_faellig TIMESTAMPTZ;
    v_id      BIGINT;
BEGIN
    v_stunde := EXTRACT(HOUR FROM v_jetzt AT TIME ZONE 'Europe/Berlin');

    IF p_dringlichkeit >= 5 OR (v_stunde >= 7 AND v_stunde < 22) THEN
        v_faellig := v_jetzt;
    ELSE
        -- Nächster Tag 07:00 Berliner Zeit. Der Umweg über date_trunc auf der
        -- lokalen Zeit und zurück hält die Sommerzeit korrekt.
        v_faellig := ((date_trunc('day', v_jetzt AT TIME ZONE 'Europe/Berlin')
                       + CASE WHEN v_stunde >= 22 THEN interval '1 day' ELSE interval '0' END
                       + interval '7 hours') AT TIME ZONE 'Europe/Berlin');
    END IF;

    INSERT INTO voice.outbox (text, anlass, dringlichkeit, call_id, empfaenger, faellig_ab)
    VALUES (p_text, p_anlass, p_dringlichkeit, p_call_id, p_empfaenger, v_faellig)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
--  Abholen
-- -----------------------------------------------------------------------------
--  FOR UPDATE SKIP LOCKED, damit zwei Abholer sich nicht dieselbe Zeile
--  greifen. Im Normalbetrieb läuft nur einer — aber während eines
--  Bot-Neustarts überlappen sich alter und neuer Prozess kurz.

CREATE OR REPLACE FUNCTION voice.hole_ausgang(p_anzahl INT DEFAULT 10)
RETURNS SETOF voice.outbox AS $$
    UPDATE voice.outbox
       SET status = 'gesendet', versuche = versuche + 1, gesendet_am = now()
     WHERE id IN (
         SELECT id FROM voice.outbox
          WHERE status = 'offen' AND faellig_ab <= now()
          ORDER BY dringlichkeit DESC, id
          LIMIT p_anzahl
          FOR UPDATE SKIP LOCKED
     )
    RETURNING *;
$$ LANGUAGE sql;

-- Konnte der Bot doch nicht senden, geht die Zeile zurück in die Schlange —
-- mit wachsendem Abstand und nach fünf Versuchen endgültig als gescheitert.
CREATE OR REPLACE FUNCTION voice.ausgang_fehlgeschlagen(p_id BIGINT, p_fehler TEXT)
RETURNS VOID AS $$
    UPDATE voice.outbox
       SET status = CASE WHEN versuche >= 5 THEN 'fehlgeschlagen'::voice.ausgang_status
                         ELSE 'offen'::voice.ausgang_status END,
           letzter_fehler = p_fehler,
           gesendet_am = NULL,
           faellig_ab = now() + (interval '1 minute' * power(3, LEAST(versuche, 4)))
     WHERE id = p_id;
$$ LANGUAGE sql;
