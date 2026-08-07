# Voice-Agent

Ein Telefon-Vorzimmer. Es nimmt Anrufe entgegen, die dein Handy nicht
beantwortet, klärt worum es geht, kennt deinen Kalender, nimmt Nachrichten
auf — und stellt durch, wenn es wirklich dringend ist.

Gesteuert wird es per WhatsApp.

```
Du:    /agent aus bis 16 uhr | Er ist bis 16 Uhr in einem Workshop

Agent: 🔴 aus — Nimmt an, sagt kurz Bescheid, nimmt eine Nachricht auf.
       ⏱ bis Fr., 07.08.2026, 16:00 Uhr, danach aktiv
       💬 Ansage: „Er ist bis 16 Uhr in einem Workshop."

       … zwei Anrufe später …

Agent: 🟠 Anruf von Anna Weber · 3 Min.
       Erstgespräch Automatisierung Angebotserstellung

       Frau Weber von der Nordlicht GmbH möchte die Angebotserstellung
       automatisieren. Termin vereinbart: Mittwoch, 12. August, 10 Uhr.

       /erledigt 4
```

## Was es kann

- **Anrufe annehmen**, die per bedingter Rufumleitung ankommen — nach 25
  Sekunden ohne Antwort, bei besetzt oder ausgeschaltetem Handy
- **Bekannte Anrufer erkennen** und beim Namen begrüßen
- **Termine vergeben** aus dem echten Google-Kalender, mit Sprechzeiten und
  Sperrzeiten
- **Durchstellen**, wenn es zeitkritisch ist — und sonst eben nicht
- **Werbeanrufe abfangen**, ohne dass dein Telefon dafür klingelt
- **Nachbereiten**: Abschrift, Zusammenfassung, WhatsApp-Meldung

## Drei Betriebsmodi

„Aus" heißt hier nicht, dass niemand rangeht. Die Rufumleitung im
Mobilfunknetz lässt sich nicht per Software abschalten — es geht immer
jemand ran. Die Frage ist nur, was er tut.

| Modus | Verhalten |
|---|---|
| 🟢 `aktiv` | Klärt das Anliegen, schlägt Termine vor, stellt bei Dringlichkeit durch |
| 🟡 `nur_notiz` | Nimmt an und notiert. Stellt unter keinen Umständen durch. Für Meetings |
| 🔴 `aus` | Kurze Ansage, Nachricht aufnehmen, Schluss. Kein Kalender |

Jeder Modus lässt sich befristen: `/agent notiz bis 16 uhr` fällt danach von
selbst auf `aktiv` zurück.

## Kann der Agent unter meiner eigenen Nummer laufen?

Wörtlich nicht — praktisch ja.

Deutsche Mobilnummern lassen sich nicht zu einem VoIP-Anbieter portieren.
Der Agent bekommt deshalb eine Zweitnummer, und dein Handy leitet bedingt
dorthin um. Für den Anrufer ist das nicht unterscheidbar: Er wählt weiterhin
nur deine Nummer.

Die ganze Geschichte samt GSM-Codes, Anbietervergleich und Fallstricken steht
in **[docs/02-telefonie.md](docs/02-telefonie.md)**.

## Aufbau

```
Anrufer → Zweitnummer → ElevenLabs-Agent → n8n → Control-API → Postgres
                                                       ↓
                                              WhatsApp-Bot → Damjan
```

- **ElevenLabs Agents** führt das Gespräch. LLM: `gemini-2.5-flash`, wahlweise
  `claude-haiku-4-5` — beide nativ, kein Custom-LLM nötig
- **n8n** (eigene Instanz, Port 5679) orchestriert Kalender, Buchung,
  Nachbereitung
- **Control-API** (Port 3010) hält Modus, Anrufe, Kontakte
- **Postgres** (Port 5435), Schema `voice`

Details und die Begründung der Entwurfsentscheidungen:
**[docs/01-architektur.md](docs/01-architektur.md)**

## Einrichten

```bash
git clone git@github.com:damjan1996/voice-agent.git ~/voice-agent
cd ~/voice-agent
make einrichten        # führt Schritt für Schritt durch
```

Oder von Hand:

```bash
cp .env.example .env
make schluessel        # Geheimnisse erzeugen, in die .env eintragen
make hoch              # Container starten
                       # n8n-Konto anlegen, API-Key in die .env
make agent             # Agent bei ElevenLabs anlegen
make import            # Workflows nach n8n
make pruefen           # Konfiguration durchgehen
make test-anruf        # Probelauf ohne zu telefonieren
```

Dann noch:

1. **nginx und Zertifikat** — `deploy/nginx/voice-agent.conf`
2. **Rufnummer verbinden** — `node scripts/telefonnummer.mjs --hilfe`
3. **WhatsApp-Bot anbinden** — `integration/whatsapp-bot/EINBAU.md`

Ausführlich: **[docs/03-einrichtung.md](docs/03-einrichtung.md)**

## Bedienung

Per WhatsApp oder per `voiceagent` auf der Kommandozeile. Das CLI deckt alles
ab bis auf `kontakt` und `sperre` — die gibt es nur über WhatsApp.

| Befehl | Wirkung |
|---|---|
| `/agent` | Modus, offene Nachrichten, letzte Anrufe, Termine |
| `/agent an` · `notiz` · `aus` | Modus umstellen |
| `/agent aus bis 16 uhr` | Befristet |
| `/agent notiz bis 15 uhr \| Er ist im Workshop` | Mit Ansage für den Anrufer |
| `/anrufe [n]` | Letzte Anrufe |
| `/nachrichten` · `/erledigt <nr>` | Arbeitsliste |
| `/termine` | Vereinbarte Termine |
| `/kontakt +49… Name [vip\|gesperrt]` | Anrufer benennen |
| `/sperre morgen bis freitag` | Keine Termine in diesem Zeitraum |
| `/flows` | n8n-Workflows und ihr Zustand |

## Betrieb

```bash
make status      # was läuft, in welchem Modus
make pruefen     # Konfiguration und Erreichbarkeit
make logs        # dienst=n8n für einen einzelnen
make sichern     # Datenbanksicherung
```

Störungssuche: **[docs/04-betrieb.md](docs/04-betrieb.md)**

## Kosten

Drei Posten je Gesprächsminute: ElevenLabs 0,08 $, Sprachmodell 0,0014 $
(Gemini Flash), Telefonie ab 0,01 $. Ein dreiminütiges Gespräch kostet
also rund **0,28 $**.

> Der kostenlose ElevenLabs-Tarif erlaubt **keine Telefonnummern** und hat 15
> Minuten im Monat. Zum Telefonieren braucht es mindestens *Starter*
> (6 $/Monat). `make pruefen` weist darauf hin.

Rechnung: **[docs/05-kosten.md](docs/05-kosten.md)**

## Verzeichnisse

```
control-api/       Zustand: Modus, Anrufe, Kontakte (Node, Express)
db/migrations/     Schema
n8n/workflows/     Sechs Workflows als JSON
elevenlabs/        Agent-Konfiguration, Prompt, Wissensbasis, Werkzeuge
integration/       Drop-in-Module für den bestehenden WhatsApp-Bot
scripts/           Einrichtung, Import, Prüfung, Probelauf
deploy/nginx/      Vhost mit Ausweichweg für die Anrufannahme
docs/              Architektur, Telefonie, Einrichtung, Betrieb, Kosten
```

## Lizenz

Privates Projekt. Alle Rechte vorbehalten.
