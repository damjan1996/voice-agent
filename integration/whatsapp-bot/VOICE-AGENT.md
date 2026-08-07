# Voice-Agent — was der WhatsApp-Bot darüber wissen muss

<!--
  Diese Datei wird in die Wissensbasis des Bots eingespielt, damit er auch
  auf freie Formulierungen sinnvoll antwortet — nicht nur auf Slash-Befehle.

  Einspielen: siehe EINBAU.md, Abschnitt 3.
-->

## Was das ist

Unter `/home/damjan/voice-agent` läuft ein Telefon-Vorzimmer. Es nimmt
Anrufe entgegen, die von Damjans Handy dorthin umgeleitet werden, klärt das
Anliegen des Anrufers, kennt seinen Kalender, nimmt Nachrichten auf und
stellt bei Dringlichkeit an ihn durch.

Beteiligt sind drei Dinge:

- **ElevenLabs Agents Platform** — führt das Gespräch (Sprache, Zuhören,
  Antworten). Der Agent heißt „Vorzimmer Damjan Savić".
- **n8n** auf Port 5679 — eigene Instanz, getrennt von der auf 5678
  (die gehört zum Hörakustik-Projekt). Hier liegen die Workflows.
- **Control-API** auf Port 3010 — hält den Betriebsmodus, die Anrufe und die
  Kontakte. Der Bot spricht ausschließlich mit ihr.

## Die drei Betriebsmodi

Das ist der wichtigste Begriff. „Der Agent ist aus" heißt **nicht**, dass
niemand rangeht — die Rufumleitung im Mobilfunknetz lässt sich nicht per
Software abschalten. Es geht immer jemand ran; die Frage ist nur, was er tut.

| Modus | Was passiert |
|---|---|
| `aktiv` | Nimmt an, klärt das Anliegen, schlägt Termine vor, stellt bei Dringlichkeit durch. |
| `nur_notiz` | Nimmt an und notiert. Stellt unter keinen Umständen durch. Für Meetings. |
| `aus` | Kurze Ansage, Nachricht aufnehmen, Schluss. Kein Kalender, keine Weiterleitung. |

Modi lassen sich befristen: `/agent notiz bis 16 uhr` schaltet um und fällt
danach von selbst auf `aktiv` zurück.

## Befehle

| Befehl | Wirkung |
|---|---|
| `/agent` | Zustand: Modus, offene Nachrichten, letzte Anrufe, Termine |
| `/agent an` \| `notiz` \| `aus` | Modus umstellen |
| `/agent aus bis 16 uhr` | Befristet umstellen |
| `/agent notiz bis 15 uhr \| bin im Workshop` | Mit Ansage, die dem Anrufer vorgelesen wird |
| `/anrufe [n]` | Die letzten Anrufe mit Zusammenfassung |
| `/nachrichten` | Offene Nachrichten aus Anrufen |
| `/erledigt <nr>` | Nachricht abhaken |
| `/termine` | Termine, die der Agent vereinbart hat |
| `/kontakt <nummer> <name> [vip\|gesperrt]` | Anrufer benennen |
| `/sperre <von> bis <bis>` | Zeitraum für Terminvergabe sperren |
| `/flows` | Die n8n-Workflows des Agents und ihr Zustand |
| `/flows an\|aus <name>` | Einen Workflow schalten |

## Die n8n-Workflows

Instanz auf Port 5679, öffentlich unter `voice.damjan-savic.com/webhook/…`.

| Slug | Aufgabe | Schaltbar? |
|---|---|---|
| `anruf-start` | Nimmt den Anruf an: Modus lesen, Anrufer erkennen, Begrüßung festlegen | **nein — kritisch** |
| `verfuegbarkeit` | Rechnet freie Gesprächsfenster aus Kalender und Sprechzeiten | ja |
| `termin-buchen` | Trägt zugesagte Termine in Datenbank und Google-Kalender ein | ja |
| `notiz` | Hält fest, worum es ging, und meldet es per WhatsApp | **nein — kritisch** |
| `nachbereitung` | Verarbeitet Abschrift nach dem Auflegen, fasst notfalls mit Claude Haiku nach | ja |
| `fehlerbehandlung` | Meldet Ausfälle der anderen Workflows | **nein — kritisch** |

**Kritische Workflows lassen sich nicht per WhatsApp abschalten.** Das ist
Absicht: Ein deaktivierter n8n-Workflow beantwortet seinen Webhook nicht mehr
(HTTP 404), der Anruf liefe dann in einen Fehler statt in eine Ansage. Und
ElevenLabs schaltet einen Webhook nach zehn Fehlversuchen in Folge von selbst
ab — aus einer kurzen Störung würde ein dauerhafter Ausfall.

**Wer den Agent stillstellen will, nutzt den Modus, nicht die Workflows.**

## Wenn jemand fragt, wie es dem Agent geht

`/agent` beantwortet das. Es zeigt Modus, offene Nachrichten, die letzten
Anrufe, anstehende Termine und meldet, wenn n8n oder ElevenLabs nicht
erreichbar sind.

Auf dem Server tiefer nachsehen:

```
cd /home/damjan/voice-agent
make status          # Zusammenfassung
make pruefen         # Konfiguration und Erreichbarkeit
make logs dienst=n8n # Logs
```

## Häufige Situationen

**„Der Agent stellt zu oft durch."**
Entweder `/agent notiz` für die Zeit der Ruhe, oder in der `.env`
`ELEVENLABS_LLM=claude-haiku-4-5` setzen — das Modell urteilt bei der Frage
„durchstellen oder nicht" sorgfältiger als die Vorgabe `gemini-2.5-flash`.
Danach `make agent`.

**„Ein bestimmter Anrufer nervt."**
`/kontakt +49… Name gesperrt` — der bekommt dann die Kurzansage, unabhängig
vom Modus.

**„Der Agent kennt meinen Kunden nicht."**
`/kontakt +49… Max Mustermann vip` — VIPs werden auch im Modus `nur_notiz`
durchgestellt.

**„Es kam keine WhatsApp-Meldung zum Anruf."**
Die Meldungen laufen über eine Warteschlange in der Datenbank
(`voice.outbox`), die der Bot alle 15 Sekunden abholt. Nachts (22–7 Uhr)
werden nur Meldungen mit Dringlichkeit 5 sofort zugestellt, der Rest wartet
bis 7 Uhr. Steht der Abholer? `grep voice-outbox ~/WhatsAppBot/bot.log`

**„Kann der Agent unter meiner echten Handynummer laufen?"**
Nicht wörtlich. Deutsche Mobilnummern lassen sich nicht zu einem
VoIP-Anbieter portieren. Der Agent hat eine Zweitnummer, und das Handy leitet
bedingt dorthin um (`**61*` bei keiner Antwort, `**62*` bei nicht erreichbar,
`**67*` bei besetzt). Für den Anrufer sieht es aus, als ginge der Agent auf
der eigenen Nummer ran — er wählt ja weiterhin nur diese eine Nummer.
Details: `docs/02-telefonie.md` im Repo.
