import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveClaudeBin, IS_WIN } from './cli';

export interface AccountInfo {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

// One rate-limit window. `utilization` is normalized to a 0..1 fraction and
// `resetsAt` to unix epoch seconds regardless of the source (live API or stream event).
export interface RateLimitInfo {
  rateLimitType: string;   // e.g. 'five_hour', 'seven_day', 'seven_day_sonnet'
  utilization: number;     // 0..1 fraction of the window consumed
  resetsAt?: number;       // unix epoch seconds
  status?: string;         // e.g. 'allowed', 'allowed_warning', 'rejected'
}

// Subscription windows the UI surfaces, mirroring the official Account & Usage panel.
// Other keys in the API response (internal codenames, oauth_apps, etc.) are ignored.
const KNOWN_USAGE_WINDOWS = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']);

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

// Parse a CLI `rate_limit_event` (stream fallback) into a RateLimitInfo, or null if malformed.
// Shape: { type: 'rate_limit_event', rate_limit_info: { rateLimitType, utilization (0..1), resetsAt (unix sec), status } }
export function parseRateLimitEvent(event: Record<string, unknown>): RateLimitInfo | null {
  const info = event.rate_limit_info as Record<string, unknown> | undefined;
  if (!info || typeof info !== 'object') return null;
  const rateLimitType = typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined;
  const utilization = Number(info.utilization);
  if (!rateLimitType || isNaN(utilization)) return null;
  return {
    rateLimitType,
    utilization,
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
    status: typeof info.status === 'string' ? info.status : undefined,
  };
}

// Parse the live `/api/oauth/usage` response. Each known window is
// `{ utilization: <percent 0-100>, resets_at: <ISO string|null> }` or null.
export function parseUsageResponse(data: Record<string, unknown>): RateLimitInfo[] {
  const out: RateLimitInfo[] = [];
  for (const key of KNOWN_USAGE_WINDOWS) {
    const val = data[key];
    if (!val || typeof val !== 'object') continue;
    const w = val as Record<string, unknown>;
    const pct = Number(w.utilization);
    if (isNaN(pct)) continue;
    let resetsAt: number | undefined;
    if (typeof w.resets_at === 'string') {
      const ms = Date.parse(w.resets_at);
      if (!isNaN(ms)) resetsAt = Math.floor(ms / 1000);
    }
    out.push({ rateLimitType: key, utilization: pct / 100, resetsAt });
  }
  return out;
}

// Read Claude Code's OAuth access token. Used only at runtime to call the same
// usage API the CLI uses; never logged or persisted.
function readOAuthToken(): string | null {
  try {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = j?.claudeAiOauth?.accessToken;
    return typeof t === 'string' && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

// Result of a usage fetch. `windows` is empty on failure; `error` then holds a
// short human-readable reason (e.g. "rate limited (HTTP 429)") for the UI.
export interface UsageResult {
  windows: RateLimitInfo[];
  error?: string;
}

// Cache the last good usage result so re-opening the panel does not hammer the
// usage endpoint (which rate-limits aggressively).
let usageCache: { data: RateLimitInfo[]; ts: number } | null = null;
const USAGE_TTL_MS = 60_000;

// Fetch live usage windows from the Anthropic OAuth usage endpoint.
// On failure (missing/expired token, rate limit, offline) returns empty windows
// plus an `error` reason so the caller can fall back and surface the cause.
export async function fetchUsage(force = false): Promise<UsageResult> {
  if (!force && usageCache && Date.now() - usageCache.ts < USAGE_TTL_MS) return { windows: usageCache.data };
  const token = readOAuthToken();
  if (!token) return { windows: [], error: 'not signed in (no OAuth token)' };
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const reason =
        res.status === 429 ? 'rate limited' :
        res.status === 401 ? 'token expired' :
        res.status === 403 ? 'access denied' :
        'request failed';
      return { windows: [], error: `${reason} (HTTP ${res.status})` };
    }
    const data = await res.json() as Record<string, unknown>;
    const parsed = parseUsageResponse(data);
    if (parsed.length > 0) usageCache = { data: parsed, ts: Date.now() };
    return { windows: parsed };
  } catch (e) {
    const error = e instanceof Error && e.name === 'TimeoutError' ? 'request timed out' : 'network error';
    return { windows: [], error };
  }
}

// Read account/subscription details from `claude auth status --json`.
// Resolves to { loggedIn: false } on any error so the UI can show a logged-out state.
export function fetchAccountInfo(): Promise<AccountInfo> {
  return new Promise((resolve) => {
    const bin = resolveClaudeBin();
    execFile(bin, ['auth', 'status', '--json'], { timeout: 10_000, shell: IS_WIN, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ loggedIn: false });
        return;
      }
      try {
        const data = JSON.parse(stdout.trim());
        resolve({
          loggedIn: data.loggedIn ?? false,
          authMethod: data.authMethod,
          email: data.email,
          orgName: data.orgName,
          subscriptionType: data.subscriptionType,
        });
      } catch {
        resolve({ loggedIn: false });
      }
    });
  });
}
