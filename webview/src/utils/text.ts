export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? singular + 's')}`;
}

// Compact a line count for badges/labels: 1234 -> "1.2k", 980 -> "980".
export function fmtLineCount(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n);
}
