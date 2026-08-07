# Architektur

## Der Weg eines Anrufs

```
   Anrufer
      │  wählt +49 151 … (Damjans Nummer)
      │  25 s ohne Antwort → bedingte Rufumleitung im Netz
      ▼
   +49 221 …  Zweitnummer bei sipgate oder Twilio
      │  SIP-Trunk
      ▼
┌─────────────────────────────────────────────────────────────┐
│  ElevenLabs Agent  „Vorzimmer Damjan Savić"                 │
│    Sprache: Scribe (rein) · Flash v2.5 (raus) · ulaw 8000   │
│    Denken:  gemini-2.5-flash  (oder claude-haiku-4-5)       │
│    Wissen:  zwei Dokumente über Damjan                      │
└───┬────────────────────────────┬────────────────────────────┘
    │ während es klingelt        │ während des Gesprächs
    │                            │
    ▼                            ▼
 /webhook/voice/init      /webhook/voice/{verfuegbarkeit,termin,notiz}
    │                            │
    │   ┌────────────────────────┘
    ▼   ▼
┌─────────────────────┐        ┌──────────────────────────┐
│  n8n   Port 5679    │───────▶│  Control-API  Port 3010  │
│  6 Workflows        │        │  Modus · Anrufe · Kontakte│
└──────────┬──────────┘        └────────────┬─────────────┘
           │                                │
           ▼                                ▼
   Google Kalender              ┌────────────────────────┐
   Anthropic (Nachbereitung)    │  Postgres  Port 5435   │
                                │  Schema „voice"        │
                                └────────────┬───────────┘
                                             │ voice.outbox
                                             ▼
                                   ┌───────────────────┐
                                   │  WhatsApp-Bot     │
                                   │  holt alle 15 s   │
                                   └───────────────────┘
                                             ▲
                                             │ /agent, /anrufe, /flows
                                          Damjan
```

## Wer wofür zuständig ist

**ElevenLabs** führt das Gespräch. Zuhören, Antworten, Werkzeuge aufrufen,
durchstellen. Nichts davon liegt bei uns — wir liefern nur Prompt, Wissen und
die Werkzeuge.

**n8n** orchestriert alles, was mehr als einen Schritt braucht: Kalender
abfragen und freie Fenster rechnen, Termin in zwei Systeme eintragen,
Gespräche nachbereiten. Das ist auch die Ebene, auf der Damjan später etwas
dazuhängt, ohne Code anzufassen.

**Control-API** hält den Zustand. Betriebsmodus, Anrufe, Nachrichten,
Kontakte, Termine. Sie ist das einzige Programm, das das Datenbankschema
kennt — n8n und der Bot sprechen ausschließlich mit ihr.

**Postgres** speichert. Eigene Datenbank, eigenes Schema, getrennt von
allem anderen auf dem Server.

**Der WhatsApp-Bot** ist die Fernbedienung. Er kennt weder ElevenLabs noch
n8n noch die Datenbank — er stellt Fragen an die Control-API und liest die
Antworten vor.

## Drei Entscheidungen, die den Aufbau erklären

### Der Ein-Aus-Schalter ist eine Datenbankzeile, kein Workflow-Schalter

Naheliegend wäre, den n8n-Workflow zu deaktivieren. Das ist eine Falle:

Ein deaktivierter n8n-Workflow beantwortet seinen Production-Webhook mit
**HTTP 404**. Der Anrufer landet dann nicht bei einer Ansage, sondern in
einem Fehler — bei Twilio hört er „An application error has occurred" und es
legt auf.

Schlimmer: **ElevenLabs schaltet einen Webhook nach zehn Fehlversuchen in
Folge selbsttätig ab.** Aus einer halben Stunde Wartung würde ein dauerhafter
Ausfall, den niemand bemerkt, bis sich jemand über die tote Leitung
beschwert.

Und obendrauf ein bekannter n8n-Fehler: Nach dem Wiedereinschalten meldet die
API `200` und `active: true`, während der Webhook unregistriert bleibt
(n8n-io/n8n #16339, #21614, #34038). Ein Schalter, der scheinbar
funktioniert, ist schlechter als gar keiner. Deshalb prüft
`import-n8n-workflows.mjs` nach jedem Einschalten aktiv nach.

Also: Der Modus steht in `voice.agent_state`, jeder Anruf liest ihn. Es geht
immer jemand ran — die Frage ist nur, was er tut.

### Der Anrufannahme-Webhook hat einen Ausweichweg

Genau ein Aufruf entscheidet, ob überhaupt jemand abnimmt. Deshalb steht in
der nginx-Konfiguration:

```nginx
location = /webhook/voice/init {
    proxy_pass http://voice_n8n;
    proxy_intercept_errors on;
    error_page 404 500 502 503 504 = @init_ausweich;
}
location @init_ausweich {
    proxy_pass http://voice_control/intern/init;
}
```

Antwortet n8n nicht, übernimmt die Control-API. Sie liefert dieselbe Antwort,
nur ohne die Anreicherung aus dem Workflow. ElevenLabs sieht nie einen
Fehler, und der Zähler für die automatische Abschaltung bleibt bei null.

Zusätzlich hat der Workflow selbst einen Notbetrieb: Antwortet die
Control-API nicht, baut der Code-Node eine vollständige, gültige Antwort aus
dem Nichts. Der Agent nimmt dann an und notiert — ohne Kalender, ohne
Durchstellen.

Drei Ebenen für einen Aufruf klingt nach viel. Es ist der eine Aufruf, bei
dem Ausfall bedeutet: Das Telefon klingelt ins Leere.

### n8n spricht nicht direkt mit der Datenbank

Naheliegend wäre der Postgres-Node. Dagegen sprachen drei Dinge:

- Das Schema wäre an zwei Stellen bekannt — in SQL-Strings innerhalb von
  Workflow-JSON und im Code der Control-API. Eine Migration müsste beide
  treffen.
- Workflow-JSON mit eingebettetem SQL ist schlecht lesbar und schlecht zu
  überprüfen.
- Zugangsdaten müssten in n8n liegen und wären beim Verschieben zwischen
  Instanzen jedes Mal neu einzurichten.

Stattdessen: HTTP-Aufrufe mit sprechenden Pfaden. Die Workflows sind kurz
genug, dass man sie auf einem Bildschirm überblickt, und das Schema hat genau
einen Eigentümer.

## Warum eine eigene n8n-Instanz

Auf Port 5678 läuft bereits n8n für das Hörakustik-Projekt. Diese Instanz
bekommt eine eigene auf 5679:

- Diese hier braucht die Public API zum Importieren und Schalten. Dort ist
  sie mit Absicht aus.
- Ein Neustart wegen des privaten Agents darf keine Kundendemo abwürgen.
- Getrennte Verschlüsselungsschlüssel, getrennte Datenhaltung, getrennte
  Sicherungen.

## Datenhaltung

Alles im Schema `voice`. Die wichtigsten Tabellen:

| Tabelle | Inhalt |
|---|---|
| `agent_state` | Genau eine Zeile: der Betriebsmodus |
| `calls` | Ein Eintrag je Gespräch, inklusive Abschrift |
| `messages` | Was auszurichten ist — die Arbeitsliste |
| `bookings` | Vereinbarte Termine, mit eindeutigem Index gegen Doppelbuchung |
| `contacts` | Bekannte Anrufer, VIP- und Sperrkennzeichen |
| `availability_rules` | Wann Termine angeboten werden dürfen |
| `outbox` | Warteschlange für WhatsApp-Meldungen |
| `n8n_workflows` | Register, das der Bot vorliest |
| `audit_log` | Jede Umschaltung, mit Urheber |

Zwei Funktionen tragen Logik, die sonst überall dupliziert würde:
`voice.effective_mode()` berücksichtigt abgelaufene Befristungen, und
`voice.melde()` hält nachts alles zurück, was nicht Dringlichkeit 5 hat.

## Verwendete Modelle

| Aufgabe | Modell | Warum |
|---|---|---|
| Gespräch | `gemini-2.5-flash` | ElevenLabs-Standard, schnellste Antwort, ≈ 0,0014 $/Min |
| Gespräch, Alternative | `claude-haiku-4-5` | urteilt beim Durchstellen sorgfältiger, ≈ 0,0098 $/Min |
| Nachbereitung | `claude-haiku-4-5` | Sorgfalt vor Tempo — es hört niemand mehr zu |

Beide sind bei ElevenLabs **nativ** wählbar; ein Custom-LLM-Umweg ist nicht
nötig. Die vollständige Liste mit Minutenpreisen liegt in
`elevenlabs/llm-preise.json`.
