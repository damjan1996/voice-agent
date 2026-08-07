// =============================================================================
//  Datenbankzugriff
// =============================================================================
//  Ein Pool für den ganzen Prozess. Alle Abfragen laufen über query() bzw.
//  tx() — nirgends wird ein Client von Hand geholt, damit keiner vergessen
//  werden kann.
// =============================================================================

import pg from 'pg';

const { Pool, types } = pg;

// node-postgres liefert BIGINT als String, weil nicht jeder Wert in eine
// JavaScript-Zahl passt. Unsere IDs und Zählwerte tun das; als String würden
// sie im JSON als "42" statt 42 landen und die Bot-Ausgabe unnötig verwirren.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Jede Sitzung schaut zuerst ins Schema "voice".
  options: '-c search_path=voice,public',
});

// Ein Verbindungsfehler auf einer im Pool ruhenden Verbindung wirft sonst
// unbehandelt und reißt den Prozess mit.
pool.on('error', (err) => {
  console.error('[db] Fehler auf ruhender Verbindung:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Führt fn in einer Transaktion aus und gibt deren Rückgabewert zurück. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Schreibt einen Eintrag ins Änderungsprotokoll. Wirft nie. */
export async function audit(actor, action, detail = {}) {
  try {
    await query(
      'INSERT INTO voice.audit_log (actor, action, detail) VALUES ($1, $2, $3)',
      [actor, action, JSON.stringify(detail)],
    );
  } catch (err) {
    console.error(`[audit] ${action} nicht protokolliert:`, err.message);
  }
}

export async function close() {
  await pool.end();
}
