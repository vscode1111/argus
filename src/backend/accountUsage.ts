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
  label?: string;          // display label from the API (model-scoped windows, e.g. "Weekly Fable")
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

function parseResetsAt(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

// Parse the newer `limits` array of the usage response. Each entry is
// `{ kind, percent, resets_at, scope? }`; model-scoped weekly windows carry the
// model display name (e.g. "Fable") in scope - this is the only place the API
// exposes them, the legacy top-level keys never gain new families. Unknown kinds
// (overage, promotions) are skipped like the official panel does.
function parseLimitsArray(limits: unknown): RateLimitInfo[] {
  if (!Array.isArray(limits)) return [];
  const out: RateLimitInfo[] = [];
  for (const entry of limits) {
    if (!entry || typeof entry !== 'object') continue;
    const l = entry as Record<string, unknown>;
    const pct = Number(l.percent);
    if (isNaN(pct)) continue;
    const resetsAt = parseResetsAt(l.resets_at);
    if (l.kind === 'session') {
      out.push({ rateLimitType: 'five_hour', utilization: pct / 100, resetsAt });
    } else if (l.kind === 'weekly_all') {
      out.push({ rateLimitType: 'seven_day', utilization: pct / 100, resetsAt });
    } else if (l.kind === 'weekly_scoped') {
      const scope = l.scope as { model?: { display_name?: unknown } } | null | undefined;
      const name = typeof scope?.model?.display_name === 'string' ? scope.model.display_name : '';
      if (!name) continue;
      out.push({
        rateLimitType: `seven_day_${name.toLowerCase().replace(/\W+/g, '_')}`,
        utilization: pct / 100,
        resetsAt,
        label: `Weekly ${name}`,
      });
    }
  }
  return out;
}

// Parse the live `/api/oauth/usage` response: the `limits` array when present
// (it carries model-scoped weekly windows the legacy keys do not), else the
// legacy top-level known-window keys, each
// `{ utilization: <percent 0-100>, resets_at: <ISO string|null> }` or null.
export function parseUsageResponse(data: Record<string, unknown>): RateLimitInfo[] {
  const fromLimits = parseLimitsArray(data.limits);
  if (fromLimits.length > 0) return fromLimits;
  const out: RateLimitInfo[] = [];
  for (const key of KNOWN_USAGE_WINDOWS) {
    const val = data[key];
    if (!val || typeof val !== 'object') continue;
    const w = val as Record<string, unknown>;
    const pct = Number(w.utilization);
    if (isNaN(pct)) continue;
    out.push({ rateLimitType: key, utilization: pct / 100, resetsAt: parseResetsAt(w.resets_at) });
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

export interface ModelInfo {
  id: string;
  displayName: string;
  // Context window in tokens (`max_input_tokens`). The authoritative source: the
  // installed CLI's own registry reports the 200k default for any model newer than
  // the CLI build, so it cannot be trusted for the context-usage percentage.
  contextWindow?: number;
}

export interface ModelsResult {
  models: ModelInfo[];
  error?: string;
}

let modelsCache: { data: ModelInfo[]; ts: number } | null = null;
const MODELS_TTL_MS = 5 * 60_000;

export async function fetchModels(): Promise<ModelsResult> {
  if (modelsCache && Date.now() - modelsCache.ts < MODELS_TTL_MS) return { models: modelsCache.data };
  const token = readOAuthToken();
  if (!token) return { models: [], error: 'not signed in (no OAuth token)' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': OAUTH_BETA,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const reason =
        res.status === 401 ? 'token expired' :
        res.status === 403 ? 'access denied' :
        'request failed';
      return { models: [], error: `${reason} (HTTP ${res.status})` };
    }
    const data = await res.json() as { data?: Array<{ id: string; display_name?: string; max_input_tokens?: number }> };
    const models: ModelInfo[] = (data.data ?? []).map(m => ({
      id: m.id,
      displayName: m.display_name ?? m.id,
      ...(typeof m.max_input_tokens === 'number' && m.max_input_tokens > 0 ? { contextWindow: m.max_input_tokens } : {}),
    }));
    modelsCache = { data: models, ts: Date.now() };
    return { models };
  } catch (e) {
    const error = e instanceof Error && e.name === 'TimeoutError' ? 'request timed out' : 'network error';
    return { models: [], error };
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
