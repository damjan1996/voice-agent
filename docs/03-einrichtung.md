# Einrichtung

Geführt: `make einrichten`. Diese Seite ist die ausführliche Fassung
derselben Schritte, plus die beiden Stellen, an denen man ohne Erklärung
hängenbleibt (Google-Kalender und Rufnummer).

## Voraussetzungen

- Docker mit Compose, Node ≥ 20
- Eine Domain, die auf den Server zeigt — Vorgabe `voice.damjan-savic.com`
- Ein ElevenLabs-Konto mit **mindestens Starter-Tarif**
  (der freie erlaubt keine Telefonnummern)
- Ein Google-Konto mit dem Kalender, um den es geht

## 1 · Konfiguration

```bash
cp .env.example .env
chmod 600 .env
make schluessel      # vier Geheimnisse, in die .env übernehmen
```

Dann von Hand eintragen:

| Variable | Woher |
|---|---|
| `OWNER_PHONE` | Deine Handynummer in E.164, z. B. `+4915164025960` |
| `ELEVENLABS_API_KEY` | elevenlabs.io → Profil → API Keys |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `N8N_DOMAIN` | Deine Domain |

> `N8N_ENCRYPTION_KEY` **nie wieder ändern.** Er verschlüsselt alle in n8n
> hinterlegten Zugangsdaten. Wird er getauscht, ist der Google-Zugang weg.

## 2 · Container

```bash
make hoch
```

Startet Postgres (5435), n8n (5679) und die Control-API (3010). Alle drei
hören nur auf `127.0.0.1`. Die Migrationen laufen beim ersten Start
automatisch.

## 3 · n8n

Die Oberfläche ist absichtlich nicht öffentlich. Zugriff per SSH-Tunnel:

```bash
ssh -L 5679:127.0.0.1:5679 damjan@<server>
```

Dann `http://127.0.0.1:5679` im Browser:

1. Eigentümerkonto anlegen
2. **Settings → n8n API → Create API key**
3. Schlüssel als `N8N_API_KEY` in die `.env`

## 4 · Agent bei ElevenLabs

```bash
make agent
```

Legt an bzw. aktualisiert: Workspace-Secret, zwei Wissensdokumente, drei
Server-Werkzeuge, Post-Call-Webhook, Vorab-Webhook, die Stimme und den Agent.
Wiederholt aufrufbar — nach jeder Prompt-Änderung erneut laufen lassen.

Zwei Werte gibt der Lauf aus, die in die `.env` müssen:

```
ELEVENLABS_AGENT_ID=agent_…
ELEVENLABS_WEBHOOK_SECRET=wsec_…      ← nur jetzt sichtbar
```

Danach `docker compose up -d control-api`, damit die Control-API das
Geheimnis kennt.

> Geht das Geheimnis verloren, ist der Webhook wertlos — es lässt sich nicht
> nachträglich auslesen. `make agent` erkennt das: Fehlt die Variable in der
> `.env`, wird der Webhook gelöscht und neu angelegt.

## 5 · Workflows

```bash
make import
```

Bringt die sechs Workflows nach n8n, ersetzt die Platzhalter aus der `.env`,
schaltet ein und **prüft nach**, ob die Webhooks wirklich registriert sind.
Diese Prüfung ist kein Zierrat — n8n meldet gelegentlich Erfolg, ohne die
Route einzuhängen.

## 6 · Google-Kalender

Hier gibt es zwei Wege mit einem echten Zielkonflikt.

### Weg A · OAuth2 (empfohlen)

Kann Teilnehmer zu Terminen einladen. Braucht einmal einen Klick im Browser.

1. [Google Cloud Console](https://console.cloud.google.com) → Projekt anlegen
2. **APIs & Services → Library → Google Calendar API** aktivieren
3. **Credentials → Create Credentials → OAuth client ID → Web application**
4. Als *Authorized redirect URI* eintragen, was n8n im Credential-Dialog
   anzeigt (`https://<domain>/rest/oauth2-credential/callback`)
5. **OAuth consent screen → PUBLISH APP**

> Schritt 5 ist der wichtigste. Bleibt der Zustimmungsbildschirm auf
> „Testing", widerruft Google das Refresh-Token nach **genau 7 Tagen**. Der
> Kalender funktioniert dann eine Woche und stirbt still. Die Warnung
> „Google hasn't verified this app" beim Verbinden ist unerheblich —
> „Advanced → Go to app" anklicken.

6. In n8n: **Credentials → New → Google Calendar OAuth2 API**, Client ID und
   Secret eintragen, verbinden
7. Das Credential in den Nodes „Google: belegte Zeiten" (Workflow 20) und
   „Google: Termin anlegen" (Workflow 30) auswählen

### Weg B · Dienstkonto (headless)

Keine Klicks, kein Token, das abläuft. Kann dafür **keine Teilnehmer
einladen** — Google lehnt das für Dienstkonten ohne Domain-Wide Delegation
ab, und die gibt es bei privaten Konten nicht.

1. Cloud Console → **Service Account** anlegen, JSON-Schlüssel laden
2. Google Calendar API aktivieren
3. Im Google Kalender: Einstellungen des Kalenders → **„Für bestimmte
   Personen freigeben"** → die `…@….iam.gserviceaccount.com`-Adresse
   hinzufügen, Rolle **„Termine ändern"**
4. In n8n: **Credentials → New → Google Service Account API**, JSON
   einfügen, *„Set up for use in HTTP Request node"* aktivieren, Scope
   `https://www.googleapis.com/auth/calendar`
5. In beiden Google-Nodes `nodeCredentialType` von
   `googleCalendarOAuth2Api` auf `googleApi` umstellen

> Das Dienstkonto bekommt keine Einladungsmail und kann nichts bestätigen —
> es braucht auch nichts zu bestätigen, die Freigabe wirkt sofort. Aber:
> `calendarList` bleibt für das Dienstkonto **leer**. Die Kalender-ID muss
> deshalb fest in der `.env` stehen.

### In beiden Fällen

```bash
GOOGLE_KALENDER_PRIMAER=info@damjan-savic.com
GOOGLE_KALENDER_IDS=info@damjan-savic.com,arbeit@firma.de
```

`GOOGLE_KALENDER_IDS` sind alle Kalender, die für „belegt" zählen.
`GOOGLE_KALENDER_PRIMAER` ist der, in den eingetragen wird.

> **Nie `primary` eintragen.** Bei einem Dienstkonto zeigt das auf dessen
> eigenen, leeren Kalender. Die Abfrage meldet dann fröhlich „alles frei",
> und der Agent bucht mitten in bestehende Termine. `make pruefen` schlägt
> darauf an.

Nach jeder Änderung: `make import`.

## 7 · nginx und Zertifikat

```bash
sudo cp deploy/nginx/voice-agent.conf /etc/nginx/sites-available/voice-agent
sudo ln -s /etc/nginx/sites-available/voice-agent /etc/nginx/sites-enabled/
sudo certbot --nginx -d voice.damjan-savic.com
sudo nginx -t && sudo systemctl reload nginx
```

Nach außen erreichbar ist danach nur `/webhook/voice/…`. Alles andere
antwortet mit 404.

Die Konfiguration enthält einen Ausweichweg: Antwortet n8n auf die
Anrufannahme nicht, übernimmt die Control-API direkt. Warum das nötig ist,
steht in [01-architektur.md](01-architektur.md).

## 8 · Rufnummer

```bash
node scripts/telefonnummer.mjs --hilfe      # erklärt beide Wege
node scripts/telefonnummer.mjs              # verbindet sie
```

Ausführlich in [02-telefonie.md](02-telefonie.md). Kurzfassung: sipgate
trunking nehmen, Origination-URI auf `sip:sip.rtc.elevenlabs.io:5060;transport=tcp`,
Digest-Auth an, CLI-Passthrough an.

Zum Schluss die Rufumleitung auf dem Handy:

```
**004*+49<Zweitnummer>**25#
```

## 9 · WhatsApp-Bot

Siehe [../integration/whatsapp-bot/EINBAU.md](../integration/whatsapp-bot/EINBAU.md).
Zwei Dateien kopieren, fünf Zeilen einfügen, Wissensdokument einspielen.

## 10 · Prüfen

```bash
make pruefen        # Konfiguration, Ports, Fremdsysteme
make test-anruf     # simulierter Anruf durch die ganze Kette
```

`make test-anruf` geht denselben Weg wie ein echter Anruf — Vorab-Webhook,
Kalenderabfrage, Notiz — ohne Gesprächsminuten zu verbrauchen. Kommt danach
eine WhatsApp-Meldung an, steht alles.

Zum Schluss einmal wirklich anrufen: von einem anderen Telefon aus, nicht
abnehmen, warten. Dann `voiceagent anrufe` — und prüfen, ob dort die richtige
Anrufernummer steht und nicht deine eigene.
