# Betrieb und Störungssuche

## Der tägliche Blick

```bash
make status      # Container, Erreichbarkeit, Modus, offene Nachrichten
voiceagent       # nur der fachliche Zustand
```

`make status` geht von unten nach oben: erst die Container, dann die
Dienste, dann was fachlich los ist. Wenn etwas nicht stimmt, sagt die erste
rote Zeile meistens schon, wo.

## Die häufigsten Fälle

### Der Agent geht nicht ran

Der Reihe nach:

```bash
make status                                    # Läuft überhaupt alles?
curl -s https://voice.damjan-savic.com/webhook/voice/init -X POST \
     -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}\n'
```

| Antwort | Bedeutung |
|---|---|
| `403` | Alles gut. Der Weg steht — n8n weist den Test nur ab, weil der Token fehlt. |
| `404` | n8n kennt den Webhook nicht. → `make import` |
| `502`/`504` | n8n antwortet nicht. → `docker compose restart n8n` |
| Verbindungsfehler | DNS, nginx oder Zertifikat. |

Steht der Weg, aber es klingelt trotzdem nur: Die Rufumleitung prüfen —
`*#61#` auf dem Handy. Und im ElevenLabs-Dashboard nachsehen, ob die
Telefonnummer noch dem Agent zugewiesen ist.

### n8n meldet „aktiv", der Webhook antwortet trotzdem 404

Bekannter Fehler in n8n: Das Einschalten wird bestätigt, die Route aber nicht
registriert.

```bash
docker compose restart n8n && sleep 30 && make import
```

`make import` prüft nach jedem Lauf nach und meldet, wenn es wieder passiert
ist. Ein „grün" aus der API allein reicht nicht.

### Keine WhatsApp-Meldung nach einem Anruf

Drei Stellen, in dieser Reihenfolge:

```bash
# 1. Steht die Meldung in der Warteschlange?
voiceagent json /v1/status | grep -i offene

docker compose exec postgres psql -U voiceagent -d voiceagent \
  -c "SELECT id, anlass, status, faellig_ab, versuche, letzter_fehler
        FROM voice.outbox ORDER BY id DESC LIMIT 5"

# 2. Holt der Bot ab?
grep voice-outbox ~/WhatsAppBot/bot.log | tail -20

# 3. Ist der Empfänger richtig?
grep VOICEAGENT_OWNER_JID ~/WhatsAppBot/.env
```

Steht die Zeile auf `offen` mit einem `faellig_ab` in der Zukunft, ist das
kein Fehler: Zwischen 22 und 7 Uhr wird alles unterhalb Dringlichkeit 5 bis
zum nächsten Morgen zurückgehalten.

### Der Agent nennt keine Termine

Er sagt dann so etwas wie „Ich komme gerade nicht an den Kalender". Das ist
Absicht — lieber ehrlich als geraten. Ursachen:

```bash
docker compose logs n8n --tail=100 | grep -i -A5 kalender
```

- **Google-Zugangsdaten abgelaufen.** Bei OAuth2 mit Zustimmungsbildschirm im
  Testing-Modus verfällt das Refresh-Token nach **genau 7 Tagen**. Fix: In
  der Google Cloud Console → OAuth consent screen → **PUBLISH APP**. Die
  Warnung „Google hasn't verified this app" ist bei einem einzelnen
  verbundenen Konto ohne Belang.
- **Kalender nicht geteilt.** Beim Dienstkonto: Kalendereinstellungen → „Für
  bestimmte Personen freigeben" → die `…@….iam.gserviceaccount.com`-Adresse
  mit Rolle *Termine ändern*.
- **`GOOGLE_KALENDER_PRIMAER` steht auf `primary`.** Dann zeigt die Abfrage
  auf den leeren Kalender des Dienstkontos. Es scheint alles frei zu sein,
  und der Agent bucht mitten in bestehende Termine. `make pruefen` schlägt
  darauf an.

### Der Agent stellt zu oft (oder zu selten) durch

Zwei Hebel:

1. **Kurzfristig:** `/agent notiz` — dann stellt er gar nicht durch.
2. **Dauerhaft:** In der `.env` `ELEVENLABS_LLM=claude-haiku-4-5`, dann
   `make agent`. Haiku wägt die Frage „ist das wirklich zeitkritisch"
   spürbar sorgfältiger ab als Gemini Flash. Kostet etwa das Siebenfache je
   Minute — bei 0,0098 $ statt 0,0014 $ ist das absolut betrachtet wenig.

Zusätzlich begrenzt `transfer_daily_cap` (Vorgabe 5) die Weiterleitungen pro
Tag:

```sql
UPDATE voice.agent_state SET transfer_daily_cap = 3;
```

### Post-Call-Aufrufe werden abgewiesen

```bash
docker compose logs control-api | grep postcall
```

- `Signatur stimmt nicht` → `ELEVENLABS_WEBHOOK_SECRET` passt nicht zum
  Webhook. Das Geheimnis ist nur beim Anlegen sichtbar; ist es weg, hilft nur
  ein neuer Webhook. `make agent` erkennt das und legt ihn automatisch neu an,
  wenn die Variable in der `.env` fehlt.
- `Zeitstempel ist … Minuten alt` → Uhr des Servers prüfen (`timedatectl`).

### Ein Anrufer nervt

```
/kontakt +4930555123456 Meridian Digital gesperrt
```

Gesperrte Anrufer bekommen unabhängig vom Modus die Kurzansage, keinen
Kalender und kein Durchstellen.

## Sichern und Wiederherstellen

```bash
make sichern                                   # nach backups/
make wiederherstellen datei=backups/….sql.gz
```

Die Sicherung umfasst beide Datenbanken — `voiceagent` (Anrufe, Modus,
Kontakte) und `n8n` (Workflows, Zugangsdaten).

> **`N8N_ENCRYPTION_KEY` gehört mitgesichert**, getrennt von der Datenbank.
> Ohne ihn sind alle in n8n hinterlegten Zugangsdaten nach dem
> Wiederherstellen unbrauchbar, und der Google-Zugang muss neu eingerichtet
> werden.

Sinnvoll als Cronjob:

```cron
0 3 * * * cd /home/damjan/voice-agent && bash scripts/sichern.sh >/dev/null
```

Bewusst `scripts/sichern.sh` statt `make sichern`: Das Skript braucht kein
make, räumt Sicherungen älter als 30 Tage selbst weg und beendet sich mit
einem Fehlercode, wenn der Dump leer bleibt. Damit schickt cron eine Mail,
statt still weiterzumachen — nur `2>&1` darf man nicht anhängen, sonst
verschluckt man genau diese Meldung.

## Aktualisieren

```bash
cd ~/voice-agent && git pull
make neu                # Container neu bauen
make migrate            # Schema nachziehen
make agent              # Prompt und Werkzeuge zu ElevenLabs
make import             # Workflows nach n8n
make pruefen
```

Reihenfolge einhalten: Das Schema muss stehen, bevor die Control-API startet,
und der Agent muss die Werkzeuge kennen, bevor die Workflows sie bedienen.

## Was im Blick bleiben sollte

| Was | Wie | Wie oft |
|---|---|---|
| Guthaben bei ElevenLabs | `voiceagent json /v1/status` | wöchentlich |
| Webhook erreichbar | `make status` | wöchentlich |
| Google-Zugang | erster Terminwunsch im Monat | monatlich |
| Sicherungen vorhanden | `ls -la backups/` | monatlich |
| Zertifikat | `certbot certificates` | vierteljährlich |

Der Fehler-Workflow (`90-fehlerbehandlung`) meldet Ausfälle von selbst per
WhatsApp. Was während eines laufenden Anrufs schiefgeht, kommt mit
Dringlichkeit 5 sofort durch; alles andere wartet bis zum Morgen.

## Nützliche Abfragen

```sql
-- Wer ruft am häufigsten an?
SELECT COALESCE(caller_name, caller_number) AS wer, count(*) AS anrufe
  FROM voice.calls WHERE started_at > now() - interval '30 days'
 GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

-- Wie oft war welcher Ausgang?
SELECT outcome, count(*), round(avg(duration_seconds)) AS schnitt_sek
  FROM voice.calls WHERE started_at > now() - interval '30 days'
 GROUP BY 1 ORDER BY 2 DESC;

-- Wer hat wann umgeschaltet?
SELECT at, actor, action, detail FROM voice.audit_log
 ORDER BY at DESC LIMIT 20;

-- Wie viel Zeit hat der Agent gekostet?
SELECT date_trunc('day', started_at)::date AS tag,
       count(*) AS anrufe,
       round(sum(duration_seconds)/60.0, 1) AS minuten
  FROM voice.calls WHERE started_at > now() - interval '30 days'
 GROUP BY 1 ORDER BY 1 DESC;
```
