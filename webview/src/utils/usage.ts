// Rate-limit window helpers shared by the Account & Usage modal (full bars) and the
// header usage indicator (three compact bars). Both render the same windows, so the
// labels, ordering, percentage rounding and colour tiers must not drift apart.

export interface RateLimitInfo {
  rateLimitType: string;
  utilization: number; // 0..1
  resetsAt?: number;   // unix epoch seconds
  status?: string;
  label?: string;      // server-provided display label (model-scoped windows, e.g. "Weekly Fable")
}

// Friendly label + display order for known rate-limit windows.
const RATE_LIMIT_META: Record<string, { label: string; order: number }> = {
  five_hour: { label: 'Session (5hr)', order: 0 },
  seven_day: { label: 'Weekly (7 day)', order: 1 },
  seven_day_fable: { label: 'Weekly Fable', order: 2 },
  seven_day_opus: { label: 'Weekly Opus', order: 3 },
  seven_day_sonnet: { label: 'Weekly Sonnet', order: 4 },
};

export function rateLimitLabel(type: string): string {
  if (RATE_LIMIT_META[type]) return RATE_LIMIT_META[type].label;
  // Fallback: prettify the raw type, e.g. "five_hour" -> "Five Hour"
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function rateLimitOrder(type: string): number {
  return RATE_LIMIT_META[type]?.order ?? 100;
}

/** The window's display name: the server's own label wins over our local table. */
export function windowLabel(rl: RateLimitInfo): string {
  return rl.label ?? rateLimitLabel(rl.rateLimitType);
}

/** Windows in display order, lowest `order` first. Does not mutate the input. */
export function sortWindows(windows: RateLimitInfo[]): RateLimitInfo[] {
  return [...windows].sort((a, b) => rateLimitOrder(a.rateLimitType) - rateLimitOrder(b.rateLimitType));
}

/** Utilization (0..1) as a whole percent clamped to 0-100. */
export function usagePercent(utilization: number): number {
  return Math.max(0, Math.min(100, Math.round(utilization * 100)));
}

/** Colour tier for a percentage; each component maps it to its own CSS module class. */
export function usageTier(percent: number): 'base' | 'medium' | 'high' {
  if (percent >= 90) return 'high';
  if (percent >= 50) return 'medium';
  return 'base';
}

export function formatReset(resetsAt: number): string {
  const target = resetsAt * 1000;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'Resets soon';

  // Relative countdown (two-unit precision).
  const totalMin = Math.floor(diffMs / 60_000);
  let rel: string;
  if (totalMin < 60) {
    rel = `${totalMin}m`;
  } else {
    const totalHr = Math.floor(totalMin / 60);
    if (totalHr < 24) {
      const m = totalMin % 60;
      rel = m > 0 ? `${totalHr}h ${m}m` : `${totalHr}h`;
    } else {
      const days = Math.floor(totalHr / 24);
      const h = totalHr % 24;
      rel = h > 0 ? `${days}d ${h}h` : `${days}d`;
    }
  }

  // Absolute reset moment, like the official panel (e.g. "Sun 9:00 PM").
  const d = new Date(target);
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `Resets in ${rel} · ${day} ${time}`;
}
