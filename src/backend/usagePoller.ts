import { fetchUsage, type RateLimitInfo } from './accountUsage';
import { broadcastToAllChannels } from './channel';

// Central usage-limit poller.
//
// The usage windows are machine-global (one account, one set of limits), so exactly
// one poller runs - in the daemon - and pushes each result to every connected client,
// however many panels are open. A per-client fetch would multiply requests against an
// endpoint that rate-limits hard (HTTP 429) while producing the same three numbers.
//
// Polling is activity-gated, because the windows only move while somebody is spending
// tokens: activity opens a one-hour window during which we refresh once a minute, and
// an hour with no activity pauses the timer entirely until the next turn (or an
// explicit refresh) reopens it.

export const USAGE_POLL_INTERVAL_MS = 60_000;
export const USAGE_ACTIVE_WINDOW_MS = 60 * 60_000;
/**
 * Floor between two calls to the usage API from this process, whatever asks. Clients
 * cannot fetch usage themselves - they ask the server to refresh, and a request that
 * arrives inside this window is answered from the snapshot instead of hitting the API.
 * So N panels opening the modal and hammering its refresh button cost at most one
 * request a minute in total, which is the same budget the poller already spends.
 */
export const USAGE_MIN_REFRESH_MS = USAGE_POLL_INTERVAL_MS;

export interface UsageSnapshot {
  windows: RateLimitInfo[];
  /** Unix ms of the last successful fetch; 0 when nothing has landed yet. */
  fetchedAt: number;
  /** Why `windows` is empty, when the last attempt failed (e.g. "rate limited (HTTP 429)"). */
  error?: string;
}

/**
 * Whether polling should still be running, as a pure function of the last activity
 * stamp. `lastActivityAt` of 0 means "nothing has happened yet", which is not the
 * same as a stale stamp: it never starts the timer in the first place.
 */
export function usagePollActive(lastActivityAt: number, now: number): boolean {
  if (lastActivityAt <= 0) return false;
  return now - lastActivityAt < USAGE_ACTIVE_WINDOW_MS;
}

/**
 * Whether an explicit refresh may call the API, as a pure function of the last *attempt*.
 * Attempts, not successes: while the API is rate-limiting, every failed try must still
 * push the next one out, or a user clicking refresh at a 429 would retry per click and
 * deepen the very rate limit they are waiting out.
 */
export function usageRefreshDue(lastAttemptAt: number, now: number): boolean {
  return now - lastAttemptAt >= USAGE_MIN_REFRESH_MS;
}

let timer: ReturnType<typeof setInterval> | null = null;
let enabled = false;
let lastActivityAt = 0;
let lastAttemptAt = 0;
let inFlight: Promise<UsageSnapshot> | null = null;
let snapshot: UsageSnapshot = { windows: [], fetchedAt: 0 };
let lastBroadcast = '';
let logFn: (msg: string) => void = () => {};

/** Last usage windows this process fetched. Empty until the first successful poll. */
export function getUsageSnapshot(): UsageSnapshot {
  return snapshot;
}

/**
 * Enable polling for this process. Called by the daemon only - the dev server and the
 * extension host stay passive and answer `getUsageLimits` with a one-shot cached fetch.
 * `ARGUS_USAGE_POLL=0` disables it (e2e daemons must not hit the live API on a timer).
 */
export function startUsagePoller(log?: (msg: string) => void): void {
  if (process.env.ARGUS_USAGE_POLL === '0') return;
  if (enabled) return;
  enabled = true;
  if (log) logFn = log;
  // A daemon only starts because a panel asked for it, so the launch is itself
  // activity: fetch now and open the first hour window.
  noteUsageActivity();
}

/**
 * Record user activity (a turn starting, an explicit usage refresh). Resumes polling
 * when it was paused, with an immediate fetch so the indicator reflects the new turn
 * rather than waiting out the first interval.
 */
export function noteUsageActivity(): void {
  lastActivityAt = Date.now();
  if (!enabled || timer) return;
  timer = setInterval(tick, USAGE_POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  void poll();
}

function pause(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function tick(): void {
  if (!usagePollActive(lastActivityAt, Date.now())) {
    pause();
    logFn('usage poller paused (no activity for an hour)');
    return;
  }
  void poll();
}

/**
 * Adopt freshly fetched windows as the current snapshot and push them to every client.
 * The single door into the snapshot, so the header indicator and the Account & Usage
 * modal can never end up showing different numbers side by side.
 */
export function publishUsageWindows(windows: RateLimitInfo[]): void {
  if (windows.length === 0) return;
  snapshot = { windows, fetchedAt: Date.now() };
  // Only the numbers matter to a client, so an unchanged set sends nothing - most polls
  // during a quiet hour return percentages identical to the previous one.
  const key = JSON.stringify(windows);
  if (key === lastBroadcast) return;
  lastBroadcast = key;
  broadcastToAllChannels(JSON.stringify({ type: 'usageLimits', windows: snapshot.windows, fetchedAt: snapshot.fetchedAt }));
}

/**
 * The one place this process calls the usage API. Coalesces concurrent callers onto a
 * single request, publishes the result to every client, and keeps the previous snapshot
 * when the fetch fails.
 */
function runFetch(): Promise<UsageSnapshot> {
  if (inFlight) return inFlight;
  lastAttemptAt = Date.now();
  inFlight = (async () => {
    try {
      const res = await fetchUsage(true);
      if (res.windows.length === 0) {
        // Keep the last good snapshot: a 429 or an expired token is transient, and a
        // blank indicator is worse than a slightly old one. Record the reason so a
        // client with nothing to show can say why.
        logFn(`usage refresh failed: ${res.error ?? 'no windows returned'}`);
        snapshot = { ...snapshot, error: res.error };
        return snapshot;
      }
      publishUsageWindows(res.windows);
      return snapshot;
    } catch (e) {
      const error = (e as Error).message ?? String(e);
      logFn(`usage refresh error: ${error}`);
      snapshot = { ...snapshot, error };
      return snapshot;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * A client asked for fresh usage (opening the Account & Usage modal, or its refresh
 * button). Clients never call the API themselves: this either answers from the snapshot,
 * joins a request already in flight, or spends the one request this process is allowed
 * per `USAGE_MIN_REFRESH_MS` - and whatever it fetches is broadcast to every client, so
 * one person's refresh updates everyone's indicator.
 */
export function requestUsageRefresh(): Promise<UsageSnapshot> {
  if (inFlight) return inFlight;
  if (!usageRefreshDue(lastAttemptAt, Date.now())) return Promise.resolve(snapshot);
  return runFetch();
}

async function poll(): Promise<void> {
  await runFetch();
}
