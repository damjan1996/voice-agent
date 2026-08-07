-- =============================================================================
--  001_schema.sql — Grundschema des Voice-Agents
-- =============================================================================
--  Alles liegt im Schema "voice". Der Rest der Datenbank bleibt unberührt,
--  damit dieselbe Postgres-Instanz später weitere Dienste tragen kann.
--
--  ALLE Migrationen in diesem Verzeichnis sind wiederholt ausführbar und
--  laufen immer vollständig durch — es gibt bewusst keine Versionstabelle.
--  Der Preis: Jede Anweisung muss ein IF NOT EXISTS oder ein Äquivalent
--  tragen. Der Gewinn: Es gibt keinen Zustand, der zwischen Buchführung und
--  Wirklichkeit auseinanderlaufen kann, und ein halb durchgelaufener Satz
--  lässt sich einfach wiederholen.
--
--  Der Kern ist die Tabelle agent_state: genau eine Zeile, die den Betriebs-
--  modus hält. Sie ist der Schalter, den WhatsApp umlegt und den jeder
--  eingehende Anruf zuerst liest. Bewusst eine Tabelle und keine n8n-
--  Workflow-Aktivierung — ein deaktivierter n8n-Workflow beantwortet seinen
--  Production-Webhook nicht mehr, der Anruf liefe dann ins Leere statt in
--  eine geordnete Ansage.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS voice;
SET search_path TO voice, public;

-- -----------------------------------------------------------------------------
--  Aufzählungstypen anlegen, falls sie fehlen
-- -----------------------------------------------------------------------------
--  CREATE TYPE kennt kein IF NOT EXISTS. Ohne diesen Umweg bricht jeder
--  zweite Lauf von "make migrate" gleich in der ersten Anweisung ab — und
--  genau das ist der Lauf, den man beim Aktualisieren macht.

CREATE OR REPLACE FUNCTION voice.typ_anlegen(p_name TEXT, p_werte TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = p_name AND n.nspname = 'voice'
    ) THEN
        EXECUTE format('CREATE TYPE voice.%I AS ENUM (%s)', p_name, p_werte);
    END IF;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
--  Betriebsmodus
-- -----------------------------------------------------------------------------
--  aktiv       Agent nimmt an, klärt das Anliegen, darf bei Dringlichkeit
--              durchstellen und Termine vorschlagen.
--  nur_notiz   Agent nimmt an und notiert, stellt aber nie durch.
--              Der Modus für Meetings und Urlaub.
--  aus         Agent nimmt an, spielt eine kurze Ansage, nimmt eine Nachricht
--              auf und legt auf. Kein Kalender, keine Weiterleitung.
--              "Aus" heißt bewusst nicht "keiner geht ran" — die Rufumleitung
--              im Mobilfunknetz lässt sich nicht per API abschalten, also
--              muss auch der Aus-Zustand einen definierten Anruf-Ausgang haben.

SELECT voice.typ_anlegen('agent_mode', $$'aktiv', 'nur_notiz', 'aus'$$);

CREATE TABLE IF NOT EXISTS voice.agent_state (
    id                  SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    mode                voice.agent_mode NOT NULL DEFAULT 'aktiv',

    -- Bis wann der Modus gilt. NULL = unbefristet. Läuft die Zeit ab, fällt
    -- der Agent auf fallback_mode zurück. So kann man per WhatsApp
    -- "aus bis 16 Uhr" sagen, ohne das Zurückschalten zu vergessen.
    mode_until          TIMESTAMPTZ,
    fallback_mode       voice.agent_mode NOT NULL DEFAULT 'aktiv',

    -- Frei formulierter Grund, den der Agent dem Anrufer nennen darf,
    -- z.B. "bis 16 Uhr in einem Workshop". Wird wörtlich vorgelesen,
    -- also nichts hineinschreiben, was Fremde nicht hören sollen.
    status_note         TEXT,

    -- Darf der Agent durchstellen? Zusätzlicher Riegel unabhängig vom Modus.
    transfer_allowed    BOOLEAN      NOT NULL DEFAULT TRUE,

    -- Obergrenze für Weiterleitungen pro Tag. Schützt davor, dass ein
    -- hartnäckiger Anrufer den Agent als Klingelautomat missbraucht.
    transfer_daily_cap  SMALLINT     NOT NULL DEFAULT 5,

    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by          TEXT
);

INSERT INTO voice.agent_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
--  Anrufe
-- -----------------------------------------------------------------------------
--  Eine Zeile je Gespräch. Beim Anrufbeginn angelegt (Status "laufend"),
--  vom Post-Call-Webhook vervollständigt. Zwei Schreiber auf derselben Zeile,
--  deshalb ist conversation_id eindeutig und alle Updates laufen als UPSERT.

SELECT voice.typ_anlegen('call_status', $$'laufend', 'beendet', 'fehlgeschlagen', 'abgebrochen'$$);
SELECT voice.typ_anlegen('call_outcome', $$'nachricht', 'termin', 'durchgestellt', 'abgewimmelt', 'rueckruf', 'unklar'$$);

CREATE TABLE IF NOT EXISTS voice.calls (
    id                  BIGSERIAL    PRIMARY KEY,
    conversation_id     TEXT         NOT NULL UNIQUE,
    agent_id            TEXT,

    caller_number       TEXT,        -- E.164, soweit übermittelt
    caller_name         TEXT,        -- aus contacts oder vom Anrufer genannt
    contact_id          BIGINT,      -- FK weiter unten, nachdem contacts existiert
    direction           TEXT         NOT NULL DEFAULT 'inbound',

    mode_at_call        voice.agent_mode,
    status              voice.call_status NOT NULL DEFAULT 'laufend',
    outcome             voice.call_outcome,

    started_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    ended_at            TIMESTAMPTZ,
    duration_seconds    INTEGER,

    -- Vom Agent erfasst
    topic               TEXT,        -- worum es ging, ein Satz
    urgency             SMALLINT     CHECK (urgency BETWEEN 1 AND 5),
    company             TEXT,
    callback_number     TEXT,
    callback_email      TEXT,

    summary             TEXT,        -- Zusammenfassung aus dem Post-Call-Lauf
    transcript          JSONB,       -- vollständiges Transkript
    analysis            JSONB,       -- Auswertungsfelder von ElevenLabs
    cost_credits        INTEGER,

    transferred         BOOLEAN      NOT NULL DEFAULT FALSE,

    raw_payload         JSONB,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calls_started_idx  ON voice.calls (started_at DESC);
CREATE INDEX IF NOT EXISTS calls_caller_idx   ON voice.calls (caller_number);
CREATE INDEX IF NOT EXISTS calls_status_idx   ON voice.calls (status) WHERE status = 'laufend';

-- -----------------------------------------------------------------------------
--  Kontakte
-- -----------------------------------------------------------------------------
--  Wer hier steht, wird vom Agent beim Namen begrüßt. vip = darf auch im
--  Modus "nur_notiz" durchgestellt werden; blocked = wird höflich abgewiesen.

CREATE TABLE IF NOT EXISTS voice.contacts (
    id                  BIGSERIAL    PRIMARY KEY,
    number              TEXT         NOT NULL UNIQUE,   -- E.164
    name                TEXT         NOT NULL,
    company             TEXT,
    relation            TEXT,        -- "Kunde", "Familie", "Netzwerk"
    notes               TEXT,        -- was der Agent über sie wissen soll
    vip                 BOOLEAN      NOT NULL DEFAULT FALSE,
    blocked             BOOLEAN      NOT NULL DEFAULT FALSE,
    last_call_at        TIMESTAMPTZ,
    call_count          INTEGER      NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE voice.calls
    DROP CONSTRAINT IF EXISTS calls_contact_fk;
ALTER TABLE voice.calls
    ADD CONSTRAINT calls_contact_fk
    FOREIGN KEY (contact_id) REFERENCES voice.contacts (id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
--  Nachrichten
-- -----------------------------------------------------------------------------
--  Was der Agent ausrichten soll. Getrennt von calls, weil ein Gespräch
--  mehrere Anliegen enthalten kann und weil offene Nachrichten eine eigene
--  Arbeitsliste sind.

CREATE TABLE IF NOT EXISTS voice.messages (
    id                  BIGSERIAL    PRIMARY KEY,
    call_id             BIGINT       REFERENCES voice.calls (id) ON DELETE CASCADE,
    conversation_id     TEXT,
    caller_name         TEXT,
    caller_number       TEXT,
    subject             TEXT         NOT NULL,
    body                TEXT         NOT NULL,
    urgency             SMALLINT     NOT NULL DEFAULT 3 CHECK (urgency BETWEEN 1 AND 5),
    callback_requested  BOOLEAN      NOT NULL DEFAULT FALSE,
    callback_by         TIMESTAMPTZ,
    handled             BOOLEAN      NOT NULL DEFAULT FALSE,
    handled_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_open_idx ON voice.messages (created_at DESC) WHERE handled = FALSE;

-- -----------------------------------------------------------------------------
--  Terminanfragen
-- -----------------------------------------------------------------------------
--  Der Agent legt Termine als "vorgemerkt" an. Ob daraus ein Kalendereintrag
--  wird, entscheidet der Workflow — und bei Bedarf Damjan per WhatsApp.

SELECT voice.typ_anlegen('booking_status', $$'vorgemerkt', 'bestaetigt', 'abgelehnt', 'abgesagt'$$);

CREATE TABLE IF NOT EXISTS voice.bookings (
    id                  BIGSERIAL    PRIMARY KEY,
    call_id             BIGINT       REFERENCES voice.calls (id) ON DELETE SET NULL,
    conversation_id     TEXT,
    caller_name         TEXT         NOT NULL,
    caller_number       TEXT,
    caller_email        TEXT,
    topic               TEXT         NOT NULL,
    starts_at           TIMESTAMPTZ  NOT NULL,
    ends_at             TIMESTAMPTZ  NOT NULL,
    status              voice.booking_status NOT NULL DEFAULT 'vorgemerkt',
    calendar_event_id   TEXT,
    calendar_link       TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT bookings_zeitraum CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS bookings_start_idx ON voice.bookings (starts_at);

-- Zwei Vormerkungen auf denselben Slot sind ein Fehler, kein Zufall.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_slot_unique
    ON voice.bookings (starts_at)
    WHERE status IN ('vorgemerkt', 'bestaetigt');

-- -----------------------------------------------------------------------------
--  Sprechzeiten
-- -----------------------------------------------------------------------------
--  Wann der Agent überhaupt Termine anbieten darf. Der Kalender sagt, wann
--  Damjan frei ist; diese Tabelle sagt, wann "frei" auch "buchbar" heißt.
--  weekday: 0 = Sonntag … 6 = Samstag (wie EXTRACT(DOW)).

CREATE TABLE IF NOT EXISTS voice.availability_rules (
    id                  BIGSERIAL    PRIMARY KEY,
    weekday             SMALLINT     NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    start_time          TIME         NOT NULL,
    end_time            TIME         NOT NULL,
    slot_minutes        SMALLINT     NOT NULL DEFAULT 30,
    label               TEXT,
    active              BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT availability_zeitraum CHECK (end_time > start_time)
);

-- Werktags 10–12 und 14–17 Uhr, halbstündige Slots.
INSERT INTO voice.availability_rules (weekday, start_time, end_time, slot_minutes, label)
SELECT d, s, e, 30, l
FROM (VALUES
    (1,'10:00'::time,'12:00'::time,'Vormittag'),
    (1,'14:00','17:00','Nachmittag'),
    (2,'10:00','12:00','Vormittag'),
    (2,'14:00','17:00','Nachmittag'),
    (3,'10:00','12:00','Vormittag'),
    (3,'14:00','17:00','Nachmittag'),
    (4,'10:00','12:00','Vormittag'),
    (4,'14:00','17:00','Nachmittag'),
    (5,'10:00','12:00','Vormittag'),
    (5,'14:00','16:00','Nachmittag')
) AS v(d, s, e, l)
WHERE NOT EXISTS (SELECT 1 FROM voice.availability_rules);

-- -----------------------------------------------------------------------------
--  Sperrzeiten
-- -----------------------------------------------------------------------------
--  Einmalige Blocker, die nicht im Google-Kalender stehen sollen.

CREATE TABLE IF NOT EXISTS voice.blackouts (
    id                  BIGSERIAL    PRIMARY KEY,
    starts_at           TIMESTAMPTZ  NOT NULL,
    ends_at             TIMESTAMPTZ  NOT NULL,
    reason              TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT blackouts_zeitraum CHECK (ends_at > starts_at)
);

-- -----------------------------------------------------------------------------
--  n8n-Workflow-Register
-- -----------------------------------------------------------------------------
--  Damit der WhatsApp-Bot weiß, welche Workflows es gibt, ohne dass jemand
--  das in seinem Quelltext pflegt. Die Steuerbefehle lesen diese Tabelle;
--  scripts/import-n8n-workflows.mjs schreibt sie beim Import.

CREATE TABLE IF NOT EXISTS voice.n8n_workflows (
    slug                TEXT         PRIMARY KEY,   -- "call-init"
    n8n_id              TEXT,                       -- ID in n8n, nach Import
    name                TEXT         NOT NULL,
    description         TEXT         NOT NULL,      -- wird dem Bot vorgelesen
    webhook_path        TEXT,
    toggleable          BOOLEAN      NOT NULL DEFAULT FALSE, -- darf per WhatsApp an/aus?
    critical            BOOLEAN      NOT NULL DEFAULT FALSE, -- niemals abschalten
    active              BOOLEAN      NOT NULL DEFAULT FALSE, -- letzter bekannter Stand
    last_seen_at        TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
--  Änderungsprotokoll
-- -----------------------------------------------------------------------------
--  Jede Umschaltung wird festgehalten. Wenn ein Anruf verloren geht, ist die
--  erste Frage immer: in welchem Modus war der Agent zu dem Zeitpunkt?

CREATE TABLE IF NOT EXISTS voice.audit_log (
    id                  BIGSERIAL    PRIMARY KEY,
    at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    actor               TEXT         NOT NULL,      -- "whatsapp:4915…", "cli", "system"
    action              TEXT         NOT NULL,      -- "mode.set", "workflow.activate"
    detail              JSONB
);

CREATE INDEX IF NOT EXISTS audit_at_idx ON voice.audit_log (at DESC);

-- -----------------------------------------------------------------------------
--  updated_at automatisch mitführen
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION voice.touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['agent_state','calls','contacts','bookings','n8n_workflows']
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS touch_%1$s ON voice.%1$s;
             CREATE TRIGGER touch_%1$s BEFORE UPDATE ON voice.%1$s
             FOR EACH ROW EXECUTE FUNCTION voice.touch_updated_at();', t);
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
--  Der wirksame Modus
-- -----------------------------------------------------------------------------
--  Berücksichtigt eine abgelaufene Befristung, ohne dass jemand aufräumen
--  muss. Jeder Leser nimmt diese Funktion, nie agent_state.mode direkt.

CREATE OR REPLACE FUNCTION voice.effective_mode()
RETURNS voice.agent_mode AS $$
    SELECT CASE
             WHEN mode_until IS NOT NULL AND mode_until <= now() THEN fallback_mode
             ELSE mode
           END
    FROM voice.agent_state WHERE id = 1;
$$ LANGUAGE sql STABLE;

-- Wie viele Weiterleitungen es heute schon gab — gegen transfer_daily_cap.
CREATE OR REPLACE FUNCTION voice.transfers_today()
RETURNS INTEGER AS $$
    SELECT COUNT(*)::int
    FROM voice.calls
    WHERE transferred
      AND started_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Berlin')
                        AT TIME ZONE 'Europe/Berlin';
$$ LANGUAGE sql STABLE;
