export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return m + 'm ' + rs + 's';
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// Compact relative age, e.g. "now", "5m", "3h 12m", "2d 4h".
export function relativeTime(updatedAt: number): string {
  const diff = Date.now() - updatedAt;
  if (diff < 60_000) return 'now';
  const totalMin = Math.floor(diff / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const min = totalMin % 60;
    return min ? `${totalHr}h ${min}m` : `${totalHr}h`;
  }
  const days = Math.floor(totalHr / 24);
  const hr = totalHr % 24;
  return hr ? `${days}d ${hr}h` : `${days}d`;
}
