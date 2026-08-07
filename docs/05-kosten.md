# Kosten

Alle Beträge Stand August 2026, ohne Mehrwertsteuer.

## Je Gesprächsminute

Drei Posten, die sich addieren. Sie werden getrennt abgerechnet — die
ElevenLabs-Minute enthält weder das Sprachmodell noch die Telefonie.

| Posten | Betrag/Min | Anmerkung |
|---|---|---|
| ElevenLabs Agents | **0,08 $** | Zusatzminuten über dem Tarifkontingent |
| Sprachmodell `gemini-2.5-flash` | **0,0014 $** | Vorgabe |
| Sprachmodell `claude-haiku-4-5` | 0,0098 $ | Alternative, urteilt sorgfältiger |
| Telefonie sipgate | ab **0,015 €** | deutsches Festnetz |
| Telefonie Twilio | 0,01 $ | eingehend Deutschland |

**Ein dreiminütiger Anruf ≈ 0,28 $** mit Gemini Flash, ≈ 0,30 $ mit Haiku.

Der Unterschied zwischen den Modellen fällt in der Gesamtrechnung kaum ins
Gewicht: Die ElevenLabs-Minuten machen rund 85 % aus. Wer beim Modell spart,
spart an der falschen Stelle.

## Monatlich

Grundgebühren, unabhängig von der Nutzung:

| Posten | Betrag |
|---|---|
| ElevenLabs *Starter* | 6 $ — 75 Gesprächsminuten inklusive |
| ElevenLabs *Creator* | 22 $ — 275 Minuten |
| sipgate Trunking 2 | 11,84 € |
| Twilio Ortsnetznummer | 1,35 $ |
| Twilio Mobilnummer | 30,00 $ — lohnt nie, siehe unten |
| Server | 0 € — läuft auf vorhandener Hardware |

## Drei Szenarien

Angenommen drei Minuten je Anruf, `gemini-2.5-flash`, sipgate.

### Wenig — 3 Anrufe am Tag

90 Anrufe, 270 Minuten im Monat.

```
ElevenLabs Creator (275 Min inkl.)      22,00 $
Sprachmodell                             0,38 $
sipgate Trunking 2                      11,84 €
─────────────────────────────────────────────────
                                    rund  35 $/Monat
```

### Mittel — 10 Anrufe am Tag

300 Anrufe, 900 Minuten.

```
ElevenLabs Creator                      22,00 $
  + 625 Zusatzminuten × 0,08 $          50,00 $
Sprachmodell                             1,26 $
sipgate Trunking 2                      11,84 €
─────────────────────────────────────────────────
                                    rund  86 $/Monat
```

Ab hier lohnt der Blick auf *Pro* (99 $, 1 238 Minuten): Bei 900 Minuten
kostet Creator plus Zusatzminuten 72 $, Pro deckt sie zum Festpreis von 99 $
ab und lässt Luft nach oben. Der Umstieg rechnet sich ab etwa 1 100 Minuten.

### Viel — 25 Anrufe am Tag

750 Anrufe, 2 250 Minuten.

```
ElevenLabs Pro (1 238 Min inkl.)        99,00 $
  + 1 012 Zusatzminuten × 0,08 $        80,96 $
Sprachmodell                             3,15 $
sipgate Trunking 10                     19,95 €
─────────────────────────────────────────────────
                                   rund  205 $/Monat
```

Bei diesem Volumen wäre *Scale* (299 $, 3 738 Minuten) günstiger.

## Was die Rechnung verändert

**Abgerechnet wird Verbindungsdauer, nicht Sprechzeit.** Vom Verbinden bis
zum Auflegen. Eine lange Warteschleife kostet mit.

**Stille ist billiger.** Pausen über zehn Sekunden werden mit 95 % Rabatt
berechnet.

**Burst-Pricing ist standardmäßig an** und rechnet Anrufe über dem
Parallelitätslimit zum **doppelten** Minutenpreis. Für ein Vorzimmer mit ein
bis zwei gleichzeitigen Anrufen ist das reines Risiko ohne Nutzen — deshalb
steht in `agent.config.json`:

```json
"call_limits": {
  "agent_concurrency_limit": 3,
  "daily_limit": 100,
  "bursting_enabled": false
}
```

`daily_limit: 100` ist die Reißleine. Sollte etwas Anrufe im Kreis erzeugen,
ist bei hundert Schluss statt bei der Kreditkartengrenze.

**Die Rufumleitung selbst kostet dich etwas.** Der weitergeleitete Teil wird
berechnet wie ein Anruf von deinem Handy zur Zweitnummer — bei einer
deutschen Ortsnetznummer in einer Allnet-Flat üblicherweise nichts.

**Im Ausland wird doppelt berechnet:** hin zum letzten bekannten
Aufenthaltsort und zurück nach Deutschland, bis zu 1,59 €/Minute. Vor
Auslandsreisen `##002#`.

## Warum keine Twilio-Mobilnummer

30 $/Monat statt 1,35 $ für eine Ortsnetznummer — bei identischer Funktion.
Anrufer wählen ohnehin nur deine echte Handynummer; welche Art Nummer
dahinter als Umleitungsziel liegt, sieht niemand. Die Mobilnummer kostet das
Zweiundzwanzigfache für nichts.

## Der freie Tarif reicht nicht

15 Gesprächsminuten im Monat und **keine Telefonnummern**. Er taugt zum
Ausprobieren des Agents im Browser, nicht zum Telefonieren. `make pruefen`
weist darauf hin, wenn das Konto darauf steht.
