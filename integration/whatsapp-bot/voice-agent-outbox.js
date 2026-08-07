// =============================================================================
//  voice-agent-outbox.js — Meldungen des Agents nach WhatsApp bringen
// =============================================================================
//  Der Voice-Agent legt ab, was Damjan wissen muss; dieser Abholer schickt es
//  raus. Der Umweg über eine Warteschlange statt eines direkten Aufrufs hat
//  einen einfachen Grund: WhatsApp hängt an einer Browsersitzung, die sich
//  abmelden, neu starten oder einen QR-Code verlangen kann. Ein laufender
//  Anruf darf davon nichts merken.
//
//  Einbau in bot.js:
//
//      const outbox = require('./lib/voice-agent-outbox');
//      client.on('ready', () => outbox.starten(client));
//
//  Anhalten (etwa beim Herunterfahren): outbox.anhalten()
// =============================================================================

'use strict';

// Bei JEDEM Zugriff aus der Umgebung lesen, nicht einmal beim Laden.
//
// bot.js liest seine .env erst nach den require-Aufrufen ein. Wer die Werte
// beim Laden des Moduls festhält, bekommt leere Strings und der Abholer
// bleibt still aus — mit einer Meldung, die aussieht, als fehlte die
// Konfiguration. Genau das ist beim ersten Einbau passiert.
const cfg = () => ({
  basis: process.env.VOICEAGENT_API_URL || 'http://127.0.0.1:3010',
  token: process.env.VOICEAGENT_API_TOKEN || '',
  ziel: process.env.VOICEAGENT_OWNER_JID || '',
  takt: Number(process.env.VOICEAGENT_POLL_MS || 15_000),
});

let laeuft = null;
let holtGerade = false;
let stilleFehler = 0;

function log(text) { console.log(`[voice-outbox] ${text}`); }

async function ruf(pfad, optionen = {}) {
  const { basis, token } = cfg();
  const antwort = await fetch(`${basis}${pfad}`, {
    ...optionen,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(optionen.body ? { 'Content-Type': 'application/json' } : {}),
      ...optionen.headers,
    },
  });
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
  return antwort.json();
}

/**
 * Empfänger bestimmen.
 *
 * whatsapp-web.js will eine JID ("4915112345678@c.us"). In der Datenbank
 * steht eine Telefonnummer in E.164. Die Umrechnung ist simpel, aber sie
 * muss passieren — eine Nummer mit Pluszeichen wird stillschweigend nicht
 * zugestellt.
 */
function alsJid(nummer) {
  const ziel = cfg().ziel;
  if (!nummer) return ziel || null;
  const s = String(nummer).trim();
  if (s.includes('@')) return s;
  const ziffern = s.replace(/\D/g, '');
  return ziffern ? `${ziffern}@c.us` : (ziel || null);
}

async function einmalHolen(client) {
  // Überlappende Läufe vermeiden: ein langsamer WhatsApp-Versand darf nicht
  // dazu führen, dass der nächste Takt dieselben Meldungen noch einmal holt.
  if (holtGerade) return;
  holtGerade = true;

  try {
    const { meldungen } = await ruf('/v1/ausgang?anzahl=10');
    stilleFehler = 0;
    if (!meldungen?.length) return;

    for (const m of meldungen) {
      const ziel = alsJid(m.empfaenger);

      if (!ziel) {
        log(`Meldung ${m.id} hat kein Ziel — VOICEAGENT_OWNER_JID setzen.`);
        await ruf(`/v1/ausgang/${m.id}/fehler`, {
          method: 'POST', body: JSON.stringify({ grund: 'kein Empfänger konfiguriert' }),
        }).catch(() => {});
        continue;
      }

      try {
        await client.sendMessage(ziel, m.text);
        // Erst jetzt gilt sie als zugestellt. Bis zu dieser Bestätigung steht
        // sie auf "in_zustellung" und käme nach fünf Minuten von selbst
        // zurück in die Schlange — etwa wenn dieser Prozess mitten in der
        // Schleife stirbt.
        await ruf(`/v1/ausgang/${m.id}/gesendet`, { method: 'POST' });
        log(`Meldung ${m.id} an ${ziel} (${m.anlass}, Dringlichkeit ${m.dringlichkeit})`);
      } catch (err) {
        // Zurück in die Schlange. Die Datenbank staffelt die Abstände, hält
        // die Nachtruhe ein und gibt nach fünf Versuchen auf.
        log(`Meldung ${m.id} nicht zugestellt: ${err.message}`);
        await ruf(`/v1/ausgang/${m.id}/fehler`, {
          method: 'POST', body: JSON.stringify({ grund: String(err.message).slice(0, 400) }),
        }).catch(() => {});
      }
    }
  } catch (err) {
    // Der Voice-Agent kann aus sein — das ist kein Grund, das Bot-Log
    // vollzuschreiben. Erst nach acht erfolglosen Takten (zwei Minuten)
    // eine Zeile, danach wieder Ruhe.
    stilleFehler++;
    if (stilleFehler === 8) {
      log(`Seit ${Math.round((cfg().takt * 8) / 1000)} s nicht erreichbar: ${err.message}`);
    }
  } finally {
    holtGerade = false;
  }
}

function starten(client) {
  if (laeuft) return;
  const { token, takt, ziel } = cfg();

  if (!token) {
    log('VOICEAGENT_API_TOKEN fehlt — Abholer bleibt aus. Siehe EINBAU.md.');
    return;
  }
  if (!ziel) {
    log('VOICEAGENT_OWNER_JID fehlt — es gäbe keinen Empfänger. Abholer bleibt aus.');
    return;
  }

  log(`gestartet, Takt ${takt / 1000} s, Empfänger ${ziel}`);
  laeuft = setInterval(() => einmalHolen(client), takt);
  // Nicht den Prozess am Leben halten, nur weil ein Timer läuft.
  if (laeuft.unref) laeuft.unref();
  einmalHolen(client);
}

function anhalten() {
  if (!laeuft) return;
  clearInterval(laeuft);
  laeuft = null;
  log('angehalten');
}

module.exports = { starten, anhalten, einmalHolen };
