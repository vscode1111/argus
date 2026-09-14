import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Remote-access credentials.
 *
 * Only peers that are NOT on this machine ever meet this: loopback and the VS Code
 * webview are exempt, so the extension panel and local dev are untouched. The decision
 * is made on the peer's address (see isLocalAddress in clients.ts), never on the Origin
 * header - Origin is supplied by the client, and a request that simply omits it used to
 * be treated as local from anywhere (measured; see
 * !notes/tasks/remote-access-auth/scripts/probe-origin-gate.js).
 *
 * The credential lives in its own file rather than in argus.json, because that config is
 * written by `updateSettings`, a bulk merge filtered only by the DEFAULT_CONFIG
 * allowlist - a password must not be reachable by the same path that writes a checkbox.
 * Mode 600, matching daemonInfo.ts.
 */
export interface AuthRecord {
  user: string;
  /** Hex, 16 random bytes. */
  salt: string;
  /** Hex scrypt output over (password, salt). The plaintext is never stored. */
  hash: string;
  updatedAt: number;
}

/**
 * Where the credential lives, resolved **per call** rather than captured at import.
 *
 * `config.ts` pins its path at import time and every spec that needs another one has to
 * pay for it with a child process; worse, a module that happens to be loaded before the
 * override is set silently keeps the default - which here is the user's real credential.
 * That is not a hypothetical: it failed exactly that way in the suite, where the spec
 * read the developer's own `argus-auth.json`, found a record and refused to overwrite it.
 * Resolving on each call costs an env lookup and removes the whole class of problem.
 */
export function authFilePath(): string {
  return process.env.ARGUS_AUTH_FILE
    || path.join(os.homedir(), '.claude', 'argus-auth.json');
}

const SCRYPT_KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 8;

// Failed logins before an address is locked out, and the first lockout. Each further
// failure doubles the wait, capped - enough to make guessing over a LAN pointless
// without permanently locking out someone who fat-fingered their own password.
const MAX_FAILURES = 5;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

/**
 * Read the stored credential, or undefined when none is configured.
 *
 * Deliberately re-read from disk every time rather than cached: a password change has to
 * take effect on the very next request, and a stale cache here would keep letting an
 * old session's re-check succeed. The file is a few hundred bytes and only remote
 * requests reach it.
 */
export function readAuth(): AuthRecord | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(authFilePath(), 'utf8')) as Partial<AuthRecord>;
    if (!raw || typeof raw.hash !== 'string' || typeof raw.salt !== 'string' || !raw.hash || !raw.salt) return undefined;
    return { user: String(raw.user ?? ''), salt: raw.salt, hash: raw.hash, updatedAt: Number(raw.updatedAt) || 0 };
  } catch {
    return undefined;
  }
}

export function hasPassword(): boolean {
  return readAuth() !== undefined;
}

export interface SetPasswordResult {
  ok: boolean;
  error?: string;
}

/**
 * Set or replace the credential. When one already exists the current password is
 * required: a hijacked session must not be able to lock the owner out, and this is the
 * cheapest way to make that true.
 */
export function setPassword(user: string, password: string, currentPassword?: string): SetPasswordResult {
  const existing = readAuth();
  if (existing && !verifyPassword(existing.user, currentPassword ?? '')) {
    return { ok: false, error: 'current password is wrong' };
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  const salt = randomBytes(16).toString('hex');
  const record: AuthRecord = {
    user: String(user ?? '').slice(0, 64),
    salt,
    hash: hashPassword(password, salt),
    updatedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(authFilePath()), { recursive: true });
  fs.writeFileSync(authFilePath(), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  // Every existing session was issued against the old password.
  dropAllSessions();
  return { ok: true };
}

/** Remove the credential, which (by design) leaves remote access refused, not open. */
export function clearPassword(currentPassword: string): SetPasswordResult {
  const existing = readAuth();
  if (!existing) return { ok: true };
  if (!verifyPassword(existing.user, currentPassword)) return { ok: false, error: 'current password is wrong' };
  try { fs.unlinkSync(authFilePath()); } catch { /* already gone */ }
  dropAllSessions();
  return { ok: true };
}

/**
 * Constant-time credential check. Returns false when nothing is configured, so a server
 * with no password refuses every remote client rather than accepting any of them.
 */
export function verifyPassword(user: string, password: string): boolean {
  const record = readAuth();
  if (!record) return false;
  if (typeof password !== 'string' || password.length === 0) return false;
  // The user field is a label, not a secret; an empty configured user accepts anything.
  if (record.user && String(user ?? '') !== record.user) return false;
  const expected = Buffer.from(record.hash, 'hex');
  const actual = Buffer.from(hashPassword(password, record.salt), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

interface Session {
  createdAt: number;
  /** Address the token was issued to, for the log line and the client list. */
  address: string;
}

// In memory only: a daemon restart (or its idle exit) ends every session and each device
// logs in again. Chosen deliberately over a persisted secret on disk.
const sessions = new Map<string, Session>();

export function createSession(address: string): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now(), address });
  return token;
}

export function isValidSession(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.length > 0 && sessions.has(token);
}

export function dropSession(token: string): void {
  sessions.delete(token);
}

export function dropAllSessions(): number {
  const n = sessions.size;
  sessions.clear();
  return n;
}

export function sessionCount(): number {
  return sessions.size;
}

interface Attempts {
  fails: number;
  /** Unix ms until which this address is locked out; 0 when it is not. */
  until: number;
}
const attempts = new Map<string, Attempts>();

export interface RateLimitState {
  allowed: boolean;
  retryAfterMs: number;
}

export function checkRateLimit(address: string, now: number = Date.now()): RateLimitState {
  const rec = attempts.get(address);
  if (!rec || rec.until <= now) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: rec.until - now };
}

export function noteLoginFailure(address: string, now: number = Date.now()): Attempts {
  const rec = attempts.get(address) ?? { fails: 0, until: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILURES) {
    const over = rec.fails - MAX_FAILURES;
    rec.until = now + Math.min(BASE_LOCKOUT_MS * Math.pow(2, over), MAX_LOCKOUT_MS);
  }
  attempts.set(address, rec);
  return rec;
}

export function noteLoginSuccess(address: string): void {
  attempts.delete(address);
}

export { MAX_FAILURES };

/** Test seam: the session map and the failure counters are module state. */
export function resetAuthState(): void {
  sessions.clear();
  attempts.clear();
}
