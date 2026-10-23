import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { CONFIG_PATH } from './config';
import type { SessionState } from './sessionState';

type SqlValue = string | number | null;
interface DatabaseSync {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...values: SqlValue[]): unknown;
    get(...values: SqlValue[]): unknown;
    all(...values: SqlValue[]): unknown[];
  };
}
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => DatabaseSync };

export interface RequestStat {
  id: string;
  sessionId: string;
  workspacePath: string;
  providerId: string;
  model: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  outcome: 'success' | 'error' | 'stopped';
}

interface PendingRequest {
  id: string;
  startedAt: number;
  startedMonotonic: number;
  providerId: string;
  model: string;
  workspacePath: string;
  inputTokens: number;
  outputTokens: number;
  hasUsage: boolean;
  seenMessages: Set<string>;
  outcome: RequestStat['outcome'];
}

const pending = new WeakMap<SessionState, PendingRequest>();
const legacyFile = process.env.ARGUS_STATS_FILE || path.join(path.dirname(CONFIG_PATH), 'session-stats.jsonl');
const databaseFile = process.env.ARGUS_STATS_DB || legacyFile.replace(/\.jsonl$/, '') + '.sqlite';
let database: DatabaseSync | undefined;

function getDatabase(): DatabaseSync {
  if (database) return database;
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databaseFile);
  try {
    fs.chmodSync(databaseFile, 0o600);
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS workspaces (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id INTEGER REFERENCES workspaces(id),
        provider_id TEXT,
        task_key TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_workspace_idx ON sessions(workspace_id);
      CREATE INDEX IF NOT EXISTS sessions_task_idx ON sessions(task_key) WHERE task_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL,
        name TEXT NOT NULL,
        UNIQUE(provider_id, name)
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        model_id INTEGER NOT NULL REFERENCES models(id),
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
        input_tokens INTEGER CHECK(input_tokens >= 0),
        output_tokens INTEGER CHECK(output_tokens >= 0),
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'error', 'stopped'))
      );
      CREATE INDEX IF NOT EXISTS requests_session_started_idx ON requests(session_id, started_at_ms);
    `);
    migrateLegacy(db);
    database = db;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function insertRequest(db: DatabaseSync, record: RequestStat): void {
  db.prepare('INSERT OR IGNORE INTO workspaces(path) VALUES (?)').run(record.workspacePath);
  db.prepare(`INSERT INTO sessions(id, workspace_id, provider_id) VALUES (?, (SELECT id FROM workspaces WHERE path = ?), ?)
    ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, provider_id = excluded.provider_id`)
    .run(record.sessionId, record.workspacePath, record.providerId);
  db.prepare('INSERT OR IGNORE INTO models(provider_id, name) VALUES (?, ?)').run(record.providerId, record.model);
  db.prepare(`INSERT OR IGNORE INTO requests
    (id, session_id, model_id, started_at_ms, ended_at_ms, duration_ms, input_tokens, output_tokens, outcome)
    VALUES (?, ?, (SELECT id FROM models WHERE provider_id = ? AND name = ?), ?, ?, ?, ?, ?, ?)`)
    .run(record.id, record.sessionId, record.providerId, record.model, record.startedAt,
      record.endedAt, record.durationMs, record.inputTokens, record.outputTokens, record.outcome);
}

function validRecord(value: unknown): value is RequestStat {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.sessionId === 'string' && !!record.sessionId
    && typeof record.workspacePath === 'string' && typeof record.providerId === 'string'
    && typeof record.model === 'string' && typeof record.startedAt === 'number'
    && typeof record.endedAt === 'number' && typeof record.durationMs === 'number'
    && ['success', 'error', 'stopped'].includes(String(record.outcome))
    && (record.inputTokens === null || typeof record.inputTokens === 'number')
    && (record.outputTokens === null || typeof record.outputTokens === 'number');
}

function migrateLegacy(db: DatabaseSync): void {
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version >= 1) return;
  let content: string;
  try { content = fs.readFileSync(legacyFile, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') content = '';
    else throw error;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const line of content.split('\n')) {
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (validRecord(value)) insertRequest(db, value);
    }
    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function closeStatsDatabase(): void {
  database?.close();
  database = undefined;
}

export function deleteSessionStats(sessionId: string): void {
  getDatabase().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function setSessionTaskKey(sessionId: string, taskKey: string | null): string | null {
  if (!sessionId || sessionId.length > 128) throw new Error('Invalid session ID');
  const normalized = taskKey?.trim().toUpperCase() || null;
  if (normalized && !/^[A-Z][A-Z0-9]*-\d{1,10}$/.test(normalized)) throw new Error('Use an issue key such as SCSOL-29');
  getDatabase().prepare('INSERT INTO sessions(id, task_key) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET task_key = excluded.task_key')
    .run(sessionId, normalized);
  return normalized;
}

export function readSessionTaskKeys(): Record<string, string> {
  const rows = getDatabase().prepare('SELECT id, task_key FROM sessions WHERE task_key IS NOT NULL').all() as Array<{ id: string; task_key: string }>;
  return Object.fromEntries(rows.map(row => [row.id, row.task_key]));
}

export function readSessionTaskKey(sessionId: string): string | null {
  const row = getDatabase().prepare('SELECT task_key FROM sessions WHERE id = ?').get(sessionId) as { task_key: string | null } | undefined;
  return row?.task_key ?? null;
}

// Observe the client-facing stream after retry filtering. A retry has no second user
// message, while a background notification has no user message at all.
export function beginRequest(state: SessionState): void {
  if (pending.has(state)) return;
  pending.set(state, {
    id: randomUUID(), startedAt: Date.now(), startedMonotonic: performance.now(), providerId: state.selection.providerId,
    model: state.selection.model || state.serverDefaultModel, workspacePath: state.workspaceDir,
    inputTokens: 0, outputTokens: 0, hasUsage: false, seenMessages: new Set(), outcome: 'success',
  });
}

export function noteRequestEvent(state: SessionState, event: Record<string, unknown>): void {
  if (event.type === 'message' && (event.message as { role?: string } | undefined)?.role === 'user') {
    beginRequest(state);
    return;
  }
  const request = pending.get(state);
  if (!request) return;
  if (event.type === 'error') request.outcome = 'error';
  if (event.type !== 'done' && event.type !== 'clear') return;
  pending.delete(state);
  const endedAt = Date.now();
  const record: RequestStat = {
    id: request.id, sessionId: state.sessionId || '', workspacePath: request.workspacePath,
    providerId: request.providerId, model: request.model, startedAt: request.startedAt,
    endedAt, durationMs: Math.max(0, Math.round(performance.now() - request.startedMonotonic)),
    inputTokens: request.hasUsage ? request.inputTokens : null,
    outputTokens: request.hasUsage ? request.outputTokens : null,
    outcome: event.type === 'clear' || event.interrupted === true ? 'stopped' : request.outcome,
  };
  if (!record.sessionId) return;
  try {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE');
    try { insertRequest(db, record); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  catch (error) { console.error('[argus-server] Could not save session statistics:', error); }
}

export function noteClaudeUsage(state: SessionState, messageId: string, inputTokens: number, outputTokens: number): void {
  const request = pending.get(state);
  if (!request || request.seenMessages.has(messageId)) return;
  request.seenMessages.add(messageId);
  request.inputTokens += inputTokens;
  request.outputTokens += outputTokens;
  request.hasUsage = true;
}

export function noteCodexUsage(state: SessionState, inputTokens: number, outputTokens: number): void {
  const request = pending.get(state);
  if (!request) return;
  request.inputTokens = Math.max(request.inputTokens, inputTokens);
  request.outputTokens = Math.max(request.outputTokens, outputTokens);
  request.hasUsage = true;
}

export function readRequestStats(sessionId: string): RequestStat[] {
  if (!sessionId) return [];
  return getDatabase().prepare(`SELECT r.id, r.session_id AS sessionId, w.path AS workspacePath,
    s.provider_id AS providerId, m.name AS model, r.started_at_ms AS startedAt,
    r.ended_at_ms AS endedAt, r.duration_ms AS durationMs, r.input_tokens AS inputTokens,
    r.output_tokens AS outputTokens, r.outcome
    FROM requests r JOIN sessions s ON s.id = r.session_id
    JOIN workspaces w ON w.id = s.workspace_id JOIN models m ON m.id = r.model_id
    WHERE r.session_id = ? ORDER BY r.started_at_ms, r.rowid`).all(sessionId) as unknown as RequestStat[];
}
