# Einbau in den bestehenden WhatsApp-Bot

Der Bot unter `/home/damjan/WhatsAppBot` bekommt drei Dinge: die Befehle,
den Abholer für Meldungen und das Wissen, dass es den Voice-Agent überhaupt
gibt.

Nichts davon verändert bestehende Logik — es kommt nur etwas dazu. Wer es
rückgängig machen will, entfernt die eingefügten Zeilen und die zwei
Dateien.

---

## 1. Dateien kopieren

```bash
cp ~/voice-agent/integration/whatsapp-bot/voice-agent-commands.js ~/WhatsAppBot/lib/
cp ~/voice-agent/integration/whatsapp-bot/voice-agent-outbox.js   ~/WhatsAppBot/lib/
```

## 2. Konfiguration ergänzen

An `~/WhatsAppBot/.env` anhängen. Die Werte stehen in `~/voice-agent/.env`.

```bash
cat >> ~/WhatsAppBot/.env <<'EOF'

# --- Voice-Agent -------------------------------------------------------------
VOICEAGENT_API_URL=http://127.0.0.1:3010
VOICEAGENT_API_TOKEN=<CONTROL_API_TOKEN aus ~/voice-agent/.env>
# Damjans WhatsApp-JID: Nummer ohne Plus, dann @c.us
VOICEAGENT_OWNER_JID=4915164025960@c.us
VOICEAGENT_POLL_MS=15000
EOF
```

> Die JID oben ist die Nummer, auf der der **Bot** läuft. Eintragen muss man
> hier die Nummer, die die Meldungen **empfangen** soll — also Damjans
> eigenes Handy. Ein Bot, der sich selbst schreibt, meldet gar nichts.

## 3. Befehle einhängen

In `~/WhatsAppBot/lib/whatsapp-commands.js`:

**a) Oben zu den Imports:**

```js
const voiceAgent = require('./voice-agent-commands');
```

**b) In `handleCommand`, direkt nach `const cmd = normalizeCommand(parts[0]);`
und VOR der Zeile `if (!ALL_COMMANDS.has(cmd)) return null;`:**

```js
  // Voice-Agent: eigene Befehlsgruppe, eigene Rechteprüfung.
  if (voiceAgent.istVoiceBefehl(text)) {
    return voiceAgent.handleVoiceCommand(text, { senderJid, isOwner });
  }
```

Die Reihenfolge ist wichtig — `ALL_COMMANDS` kennt die neuen Befehle nicht
und würde sie sonst als „unbekannt" verwerfen.

**c) Optional, damit `/help` sie mit aufzählt** — in `formatHelp` ans Ende
der zusammengebauten Zeichenkette:

```js
  + voiceAgent.hilfeZeilen()
```

## 4. Abholer starten

In `~/WhatsAppBot/bot.js`, bei den Imports:

```js
const voiceOutbox = require('./lib/voice-agent-outbox');
```

Und dort, wo der WhatsApp-Client `ready` meldet:

```js
client.on('ready', () => {
  // … bestehender Code …
  voiceOutbox.starten(client);
});
```

Gibt es schon einen `ready`-Handler, kommt die Zeile einfach hinein.

## 5. Wissen einspielen

Damit der Bot auch auf „ist der Anrufbeantworter an?" antwortet und nicht nur
auf `/agent`, kommt `VOICE-AGENT.md` in seine Wissensbasis:

```bash
cd ~/WhatsAppBot
node -e '
const fs = require("fs");
const db = require("./lib/db");
const inhalt = fs.readFileSync(
  process.env.HOME + "/voice-agent/integration/whatsapp-bot/VOICE-AGENT.md", "utf8");

db.query(`
  INSERT INTO slackbot.knowledge_base
    (source_type, source_path, title, project_tag, content, summary, metadata)
  VALUES ($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT (source_path) DO UPDATE SET
    content = EXCLUDED.content, summary = EXCLUDED.summary`,
  ["doc", "voice-agent/VOICE-AGENT.md", "Voice-Agent (Telefon-Vorzimmer)",
   "VOICEAGENT", inhalt,
   "Telefon-Vorzimmer: nimmt umgeleitete Anrufe an, kennt den Kalender, "
   + "notiert Anliegen, stellt bei Dringlichkeit durch. Steuerung per /agent. "
   + "Modi: aktiv, nur_notiz, aus. Sechs n8n-Workflows auf Port 5679.",
   JSON.stringify({ quelle: "voice-agent", stand: new Date().toISOString() })])
  .then(() => { console.log("eingespielt"); process.exit(0); })
  .catch((e) => { console.error(e.message); process.exit(1); });
'
```

Meldet das einen Fehler wegen `ON CONFLICT`, hat die Tabelle keinen
eindeutigen Index auf `source_path`. Dann vorher aufräumen:

```sql
DELETE FROM slackbot.knowledge_base WHERE source_path = 'voice-agent/VOICE-AGENT.md';
```

…und den Befehl ohne die `ON CONFLICT`-Zeile wiederholen.

## 6. Neu starten und prüfen

```bash
pm2 restart whatsappbot 2>/dev/null || (cd ~/WhatsAppBot && pkill -f bot.js && node bot.js &)
```

Läuft `bot.js` ohne pm2 — was auf diesem Server der Fall ist — im
gewohnten Verfahren neu starten.

Dann per WhatsApp an den Bot:

```
/agent
```

Erwartete Antwort: der Zustandsbericht mit Modus, offenen Nachrichten und
letzten Anrufen.

Kommt „⚠️ Der Voice-Agent ist nicht erreichbar", läuft die Control-API nicht:

```bash
cd ~/voice-agent && make status
```

---

## Was danach anders ist

- Neun neue Befehle, alle nur für den Owner.
- Alle 15 Sekunden eine HTTP-Anfrage an `127.0.0.1:3010`. Ist der
  Voice-Agent aus, protokolliert der Abholer das genau einmal alle zwei
  Minuten und schweigt sonst.
- Der Bot beantwortet Fragen zum Telefon-Vorzimmer aus seiner Wissensbasis.

Bestehende Befehle, Sessions und die Obsidian-Anbindung bleiben unberührt.
