# Telefonie — der Agent auf deiner eigenen Nummer

Die Frage, an der das ganze Projekt hängt, und die einzige, bei der die
ehrliche Antwort erst mal enttäuscht.

## Die kurze Antwort

**Wörtlich geht es nicht. Praktisch schon.**

Der Agent kann nicht *auf* deiner Mobilnummer sitzen. Er bekommt eine
Zweitnummer, und dein Handy leitet Anrufe bedingt dorthin um.

Für den Anrufer ist das nicht unterscheidbar: Er wählt weiterhin nur deine
Nummer. Klingelt es fünfundzwanzig Sekunden ohne Antwort, ist dein Handy aus
oder besetzt, geht der Agent ran. Genau das, was eine Mailbox auch tut — nur
dass hier jemand zurückspricht.

## Warum es wörtlich nicht geht

Deutsche **Mobilnummern lassen sich nicht** zu einem VoIP-Anbieter
**portieren**. Twilio schreibt es so in seine Portierungsrichtlinien für
Deutschland: *„Mobile number porting is not supported."* Portierbar sind nur
geografische Nummern (Ortsnetzvorwahlen) und 0800er.

Es gibt keinen Weg drumherum. Ein Agent, der Anrufe an deiner Nummer
annimmt, müsste diese Nummer terminieren — und das darf nur dein
Mobilfunkanbieter.

## Wie es stattdessen läuft

```
  Anrufer wählt +49 151 …            ← deine Nummer, unverändert
        │
        ├── du gehst ran              ← Normalfall, nichts passiert
        │
        └── 25 s ohne Antwort / aus / besetzt
              │
              ▼  bedingte Rufumleitung, im Netz des Anbieters
        +49 221 …                     ← Zweitnummer des Agents
              │
              ▼  SIP-Trunk oder Twilio
        ElevenLabs-Agent
              │
              ├── klärt das Anliegen
              ├── schaut in den Kalender
              ├── nimmt eine Nachricht auf
              └── stellt bei Dringlichkeit an +49 151 … durch
```

Die Umleitung passiert **im Netz deines Anbieters**, nicht auf dem Gerät.
Das ist der entscheidende Punkt für den nächsten Abschnitt.

## Sieht der Agent, wer anruft?

Meistens ja — verlassen sollte man sich nicht blind darauf.

Bei netzbasierter Umleitung trägt der weitergeleitete Anruf die Nummer des
**ursprünglichen** Anrufers; deine eigene wandert in einen separaten Header
(SIP-Diversion). Das ist der Normalfall und ausdrücklich zulässig
(§ 120 Abs. 2 TKG).

Drei Fälle, in denen es trotzdem schiefgeht:

1. **Umleitung im Gerät statt im Netz.** Eine Fritz!Box oder TK-Anlage, die
   weiterleitet, sendet *ihre* Nummer. Beim Handy ist der GSM-Code
   automatisch die netzbasierte Variante — hier also kein Problem.

2. **Internationale Strecken.** Läuft der Anruf über ausländische
   Transitwege, ersetzen manche Carrier die Nummer. Das ist das stärkste
   Argument für einen **deutschen** Anbieter statt Twilio.

3. **Unterdrückte Rufnummer.** Kommt als `anonymous` an. Der Agent behandelt
   das sauber: unbekannter Anrufer, keine Kontaktzuordnung, kein Absturz.

> **Vor dem Produktivgang mit echten Testanrufen prüfen** — einmal vom
> Mobiltelefon, einmal vom Festnetz. `voiceagent anrufe` zeigt, welche Nummer
> angekommen ist.

## Welcher Anbieter?

### sipgate trunking — empfohlen

Deutscher Anbieter, deutsche Rechnung, Freischaltung in Stunden statt Tagen,
30 Tage Test mit fünf kostenlosen Nummern. Danach ab 11,84 €/Monat.

Der Weg ist kurz: Origination-URI beim Anbieter auf
`sip:sip.rtc.elevenlabs.io:5060;transport=tcp`, Digest-Auth einschalten,
fertig. Kein Umweg über die USA, keine Regulierungsprüfung.

*Einschränkung:* Warme Übergabe (der Agent sagt dir vorab, wer dran ist) und
`post_dial_digits` gibt es nur bei Twilio. Für ein privates Vorzimmer ist das
verzichtbar.

### Twilio — nur mit Gewerbe

Twilio verkauft in Deutschland **keine Nummern an Privatpersonen**. Wörtlich
aus den Regulatory Guidelines: *„German local numbers are not available to
individuals."* Es braucht Handelsregisterauszug, Gewerbeanmeldung oder eine
Steuernummer-Mitteilung, und bei Ortsnetznummern muss die hinterlegte Adresse
im Vorwahlgebiet liegen. Prüfung: ein bis drei Werktage.

Wenn das erfüllt ist, spricht einiges dafür: warme Übergabe, `blind`-Transfer
mit erhaltener Anrufer-Nummer, und alles in einer Oberfläche.

Preise: Ortsnetznummer 1,35 $/Monat, Mobilnummer 30 $/Monat. **Nimm die
Ortsnetznummer** — funktional identisch, denn Anrufer wählen ohnehin nur
deine Handynummer.

> **Nicht vergessen:** `TWILIO_REGION_ID=ie1` und `TWILIO_EDGE=frankfurt`.
> Ohne das routet Twilio auch deutsche Nummern über die USA. Das verletzt
> nicht nur die Datenresidenz, es lässt auch Weiterleitungen im laufenden
> Gespräch fehlschlagen, weil ElevenLabs dann gegen die falsche Region
> spricht.

### Telnyx

Erlaubt im Gegensatz zu Twilio auch Privatpersonen (Ausweis plus
Adressnachweis, nicht älter als drei Monate). Aktivierung etwa 72 Stunden.
Von ElevenLabs offiziell als Trunk-Anbieter dokumentiert.

## Rufumleitung einrichten

Im Wählfeld eingeben, grüne Taste drücken. Funktioniert netzübergreifend bei
Telekom, Vodafone, O2 und 1&1.

```
**004*+49XXXXXXXXX**25#     alle drei Fälle auf einmal, 25 Sekunden
```

Oder einzeln:

| Code | Wann |
|---|---|
| `**61*+49XXXXXXXXX**25#` | keine Antwort nach 25 Sekunden |
| `**62*+49XXXXXXXXX#` | nicht erreichbar (aus, Flugmodus, kein Netz) |
| `**67*+49XXXXXXXXX#` | besetzt |

Der Timer bei `**61*` akzeptiert nur 5, 10, 15, 20, 25 oder 30 Sekunden.
Dreißig ist das Maximum — länger klingeln lassen geht netzseitig nicht.

**`**21*` nicht verwenden.** Das ist die unbedingte Umleitung: Dein Handy
klingelt dann überhaupt nicht mehr. Das ist kein Anrufbeantworter, das ist
eine Vollumleitung.

Prüfen: `*#61#` · `*#62#` · `*#67#`
Zurücknehmen: `##002#`

### Zwei Dinge, die überraschen

**Deine Mailbox ist danach aus.** Sie hängt technisch an exakt denselben
Codes, nur mit der Mailbox-Nummer als Ziel. Beides gleichzeitig geht nicht.
Nach `##002#` musst du sie in der Carrier-App wieder einschalten.

**Der weitergeleitete Teil kostet dich etwas.** Für den Umleitungsvorgang
gilt, was ein Anruf von deinem Handy zu dieser Nummer kosten würde — bei
einer deutschen Ortsnetznummer in einer Allnet-Flat üblicherweise nichts.
Anders im Ausland: Dort wird doppelt berechnet (hin zum letzten bekannten
Aufenthaltsort und zurück nach Deutschland), bis zu 1,59 €/Minute. **Vor
Auslandsreisen die Umleitung abschalten.** O2 untersagt außerdem das Setzen
von GSM-Codes während des Roamings — also vorher in Deutschland erledigen.

### Wenn der Code nicht angenommen wird

Moderne VoLTE-Netze verschlucken MMI-Codes gelegentlich. Bei
„Verbindungsproblem oder ungültiger MMI-Code":

- Im Netzmodus kurz auf 3G/2G wechseln, Code eingeben, zurückstellen
- oder die Rufumleitung in der App des Anbieters setzen
- Bei Prepaid (etwa Vodafone CallYa) ist die Umleitung auf beliebige Nummern
  oft gesperrt und muss erst freigeschaltet werden

## Durchstellen an dein Handy

Drei Verfahren, eines pro Zeile:

| Verfahren | Geht mit | Was du auf dem Display siehst |
|---|---|---|
| `conference` *(Vorgabe)* | Twilio + SIP | die Agent-Nummer |
| `blind` | nur Twilio | die Nummer des echten Anrufers |
| `sip_refer` | nur SIP | je nach Trunk |

Die Vorgabe `conference` hat einen unterschätzten Vorteil: Du siehst am
Display sofort, dass der Agent durchstellt, und kannst dich darauf
einstellen, statt einen Fremden zu erwarten. Umstellbar über `TRANSFER_TYPE`
in der `.env`.

## Was ein Anruf kostet

Drei Posten, die sich addieren:

| Posten | Betrag |
|---|---|
| ElevenLabs Agents | 0,08 $ je Gesprächsminute (Zusatzminuten über dem Tarif) |
| Sprachmodell | `gemini-2.5-flash` ≈ 0,0014 $/Min · `claude-haiku-4-5` ≈ 0,0098 $/Min |
| Telefonie | Twilio 0,01 $/Min eingehend · sipgate ab 1,5 ct/Min |

Ein dreiminütiges Gespräch kostet also grob **0,28 $** mit Gemini Flash.
Bei zehn Anrufen am Tag sind das rund 85 $ im Monat — dominiert von den
ElevenLabs-Minuten, nicht vom Sprachmodell.

> **Der kostenlose ElevenLabs-Tarif reicht nicht.** Er hat 15 Gesprächsminuten
> im Monat und erlaubt **keine Telefonnummern**. Zum Telefonieren braucht es
> mindestens *Starter* (6 $/Monat, 75 Minuten). `make pruefen` weist darauf hin.

Ein Detail, das die Rechnung schönt: Stillephasen über zehn Sekunden werden
mit 95 % Rabatt berechnet.

Und eines, das sie verhagelt: **Burst-Pricing ist bei ElevenLabs
standardmäßig an** und rechnet Überschussanrufe zum doppelten Minutenpreis.
Für ein Vorzimmer mit ein bis zwei parallelen Anrufen ist das reines
Kostenrisiko ohne Nutzen — deshalb steht es in `agent.config.json` auf
`false`.
