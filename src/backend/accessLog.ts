import * as fs from 'fs';
import * as path from 'path';
import type { IncomingMessage } from 'http';
import { CONFIG_PATH } from './config';
import { normalizeAddress } from './clients';

/**
 * Audit log of every remote attempt to enter Argus, successful or not.
 *
 * Only peers that are not on this machine are recorded (the same line the auth gate
 * draws), so local panels and dev traffic never fill it. Stored in SQLite so it can be
 * queried from a database tool. Secrets are never written: no password, no session
 * token, no nonce - only the username the client typed, which is a label.
 *
 * Logging must never break the request it describes, so every write swallows its own
 * failure.
 */
export type AccessEvent =
  | 'login_ok'          // POST /login accepted, token issued
  | 'login_failed'      // wrong user or password
  | 'login_locked'      // refused by the per-address rate limit
  | 'login_unconfigured'// no password set, remote access is refused
  | 'login_bad_request' // malformed body, wrong content type or oversized
  | 'nonce_refused'     // GET /nonce without a valid session
  | 'ws_refused'        // WebSocket upgrade without a valid session
  | 'ws_open'           // authenticated remote WebSocket connected
  | 'ws_close';         // that connection ended

type SqlValue = string | number | null;
interface DatabaseSync {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): { run(...values: SqlValue[]): unknown };
}
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => DatabaseSync };

const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

let database: DatabaseSync | undefined;
let disabled = false;

export function accessLogPath(): string {
  // Next to the active config, like session-stats: a test server running on an e2e
  // config then writes beside that config and never into the user's real log.
  return process.env.ARGUS_ACCESS_LOG_DB || path.join(path.dirname(CONFIG_PATH), 'remote-access.sqlite');
}

function getDatabase(): DatabaseSync | undefined {
  if (database || disabled) return database;
  try {
    const file = accessLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        at_iso TEXT NOT NULL,
        event TEXT NOT NULL,
        address TEXT NOT NULL,
        user TEXT,
        user_agent TEXT,
        origin TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS access_log_at_idx ON access_log(at);
      CREATE INDEX IF NOT EXISTS access_log_address_idx ON access_log(address, at);
    `);
    db.prepare('DELETE FROM access_log WHERE at < ?').run(Date.now() - RETENTION_MS);
    database = db;
  } catch (err) {
    // A broken log file must not take remote access down with it; say so once.
    disabled = true;
    console.log(`[argus-server] remote access log unavailable: ${(err as Error).message}`);
  }
  return database;
}

export interface AccessEntry {
  event: AccessEvent;
  req: IncomingMessage;
  user?: string;
  detail?: string;
}

export function logAccess({ event, req, user, detail }: AccessEntry): void {
  try {
    const db = getDatabase();
    if (!db) return;
    const now = Date.now();
    const header = (name: string) => {
      const v = req.headers[name];
      return (Array.isArray(v) ? v[0] : v ?? '').slice(0, 300) || null;
    };
    db.prepare(`INSERT INTO access_log (at, at_iso, event, address, user, user_agent, origin, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      now,
      new Date(now).toISOString(),
      event,
      normalizeAddress(req.socket.remoteAddress ?? ''),
      user === undefined ? null : String(user).slice(0, 64),
      header('user-agent'),
      header('origin'),
      detail === undefined ? null : detail.slice(0, 500),
    );
  } catch { /* never fail the request because of its audit line */ }
}

/** Test hook: close the handle so a spec can point the next write at another file. */
export function closeAccessLog(): void {
  try { database?.close(); } catch { /* already closed */ }
  database = undefined;
  disabled = false;
}
