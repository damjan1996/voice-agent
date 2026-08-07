// =============================================================================
//  Control-API — Einstiegspunkt
// =============================================================================
//  Hört nur auf 127.0.0.1 im Docker-Netz. Erreichbar ist der Dienst für den
//  WhatsApp-Bot auf demselben Host und für das CLI. Nach außen geht nichts;
//  nginx reicht diesen Port nicht durch.
// =============================================================================

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { router } from './routes.js';
import { intern } from './intern.js';
import { pool, close } from './db.js';

const app = express();
const PORT = Number(process.env.PORT || 3010);
const TOKEN = process.env.CONTROL_API_TOKEN || '';

if (!TOKEN) {
  console.error('CONTROL_API_TOKEN fehlt — ohne Token startet der Dienst nicht.');
  process.exit(1);
}

app.disable('x-powered-by');

// Der Post-Call-Webhook wird von ElevenLabs signiert — und zwar über den
// ROHEN Text des Bodys. Wer ihn erst zu JSON macht und wieder ausgibt,
// bekommt garantiert eine andere Signatur, weil Reihenfolge und
// Leerzeichen nicht erhalten bleiben. Deshalb muss dieser eine Pfad vor dem
// JSON-Parser stehen; express markiert den Body dann als gelesen und der
// Parser dahinter lässt ihn in Ruhe.
app.use('/intern/postcall', express.raw({ type: '*/*', limit: '8mb' }));

app.use(express.json({ limit: '1mb' }));

// --- Kurzprotokoll -----------------------------------------------------------
//  Eine Zeile je Anfrage. Reicht, um im Zweifel zu sehen, wer wann geschaltet
//  hat; die inhaltliche Spur liegt in voice.audit_log.
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${ms.toFixed(0)} ms)`);
  });
  next();
});

// --- Erreichbarkeit ----------------------------------------------------------
//  Ohne Token, damit Docker den Zustand prüfen kann.
app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, dienst: 'voiceagent-control', zeit: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, fehler: err.message });
  }
});

// --- Zugang ------------------------------------------------------------------

/** Vergleich in konstanter Zeit, damit die Prüfung nichts über den Token verrät. */
function tokenStimmt(vorgelegt) {
  if (!vorgelegt) return false;
  const a = Buffer.from(vorgelegt);
  const b = Buffer.from(TOKEN);
  // timingSafeEqual verlangt gleiche Länge — der Längenvergleich davor ist
  // unkritisch, die Länge des Tokens ist kein Geheimnis.
  return a.length === b.length && timingSafeEqual(a, b);
}

// Eigene Authentifizierung (X-Voice-Token) — siehe intern.js. Getrennt vom
// Control-Token, weil ElevenLabs und n8n andere Rechte brauchen als der Bot:
// Sie dürfen Anrufe schreiben, aber den Betriebsmodus nicht umstellen.
app.use('/intern', intern);

app.use('/v1', (req, res, next) => {
  const kopf = req.get('Authorization') || '';
  const vorgelegt = kopf.startsWith('Bearer ') ? kopf.slice(7) : req.get('X-Control-Token');
  if (!tokenStimmt(vorgelegt)) {
    return res.status(401).json({ fehler: 'Nicht angemeldet' });
  }
  next();
}, router);

// --- Fehler ------------------------------------------------------------------

app.use((req, res) => res.status(404).json({ fehler: `Unbekannter Pfad ${req.method} ${req.path}` }));

app.use((err, _req, res, _next) => {
  console.error('[fehler]', err.stack || err.message);
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({
    fehler: err.message || 'Unerwarteter Fehler',
    text: `⚠️ Die Control-API meldet: ${err.message || 'unerwarteter Fehler'}`,
  });
});

// --- Start und Ende ----------------------------------------------------------

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Control-API hört auf Port ${PORT}`);
});

// Ohne sauberes Herunterfahren wartet "docker compose down" auf den Timeout
// und laufende Anfragen brechen mitten in einer Transaktion ab.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} empfangen — fahre herunter`);
    server.close(async () => {
      await close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

export default app;
