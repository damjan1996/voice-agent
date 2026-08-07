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

```bash
node scripts/google-kalender.mjs
```

Zeigt die vier Schritte, die in der Google Cloud Console zu klicken sind.
Danach:

```bash
node scripts/google-kalender.mjs ~/voice-agent-xxxxx.json
```

Das Skript prüft zuerst mit einer echten Abfrage, ob der Kalender antwortet,
und richtet erst dann ein: Zugangsdaten in n8n, `.env`, Workflows. Schlägt die
Prüfung fehl, bleibt alles unverändert und es sagt, welcher Schritt fehlt.

### Warum ein Dienstkonto und nicht OAuth2

Zwei Gründe, der erste ist praktisch zwingend:

**OAuth2 braucht eine erreichbare Domain.** Der Rückleit-URI lautet
`https://<domain>/rest/oauth2-credential/callback`. Solange DNS und
Zertifikat fehlen, lässt sich die Verbindung gar nicht erst herstellen.

**Und OAuth2 verfällt.** Steht der Zustimmungsbildschirm auf „Testing",
widerruft Google das Refresh-Token nach **genau sieben Tagen**. Der Kalender
funktioniert dann eine Woche und stirbt still — der Agent sagt ab da bei
jedem Terminwunsch, er komme nicht an den Kalender. Wer OAuth2 will, muss den
Bildschirm auf *In Production* veröffentlichen.

Das Dienstkonto hat dafür eine echte Einschränkung: **Es kann keine
Kalendereinladungen an Anrufer verschicken.** Google verbietet das ohne
Domain-Weite Delegation, die es bei privaten Konten nicht gibt. Die
Kontaktdaten des Anrufers stehen deshalb in der Terminbeschreibung, und die
Bestätigung geht per WhatsApp an dich statt per Einladung an ihn.

Für ein Vorzimmer ist das der bessere Handel: Ein Zugang, der nie abläuft und
keinen Browser braucht, gegen eine Einladung, die ohnehin niemand erwartet,
wenn er gerade telefoniert hat.

### Auf OAuth2 wechseln

Sobald die Domain steht und du Einladungen verschicken willst:

1. In der Cloud Console eine *OAuth client ID* (Web application) anlegen,
   Rückleit-URI aus dem n8n-Credential-Dialog eintragen
2. **OAuth consent screen → PUBLISH APP** — sonst die sieben Tage
3. In n8n: *Credentials → New → Google Calendar OAuth2 API*, verbinden
4. In der `.env`: `GOOGLE_AUTH_METHODE=oauth2`
5. Die ID der neuen Credential nach `n8n/.google-cred-id`
6. `node scripts/import-n8n-workflows.mjs`

Die Workflows stellen sich dann von selbst um — der Credential-Typ ist ein
Platzhalter, der beim Import aus `GOOGLE_AUTH_METHODE` gesetzt wird.

### Welche Kalender

```bash
GOOGLE_KALENDER_PRIMAER=damjandak@gmail.com          # hier wird eingetragen
GOOGLE_KALENDER_IDS=damjandak@gmail.com,arbeit@…     # das zählt als belegt
```

> **Nie `primary` eintragen.** Bei einem Dienstkonto zeigt das auf dessen
> eigenen, leeren Kalender. Die Abfrage meldete dann „alles frei", und der
> Agent bucht mitten in bestehende Termine. `make pruefen` schlägt darauf an.

Prüfen, wann immer etwas unklar ist:

```bash
node scripts/google-kalender.mjs --pruefen
```

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
