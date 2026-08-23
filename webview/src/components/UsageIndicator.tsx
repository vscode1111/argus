import React from 'react';
import { type RateLimitInfo, sortWindows, usagePercent, usageTier, windowLabel, formatReset } from '../utils/usage';
import styles from './UsageIndicator.module.css';

// Three stacked mini bars in the header: the same windows the Account & Usage modal
// shows as full bars (session, weekly, model-scoped weekly), always visible so the
// limits do not need a modal to check. Data is pushed by the daemon's central poller,
// never fetched here - see src/backend/usagePoller.ts.
//
// This is also the header's only way into the Account & Usage modal (it replaced a
// separate button that did nothing more than open it). So with no windows to draw -
// before the first poll lands, or while the usage API is rate-limiting - it falls back
// to that button's icon instead of rendering nothing: three dead grey lines would look
// broken, but a vanishing control would take the entry point away exactly when the
// user wants to open the panel and hit refresh.
const MAX_BARS = 3;

const TIER_CLASS = {
  base: '',
  medium: styles.fillMedium,
  high: styles.fillHigh,
} as const;

interface Props {
  windows: RateLimitInfo[];
  /** Why there are no windows, when the server said (e.g. "rate limited (HTTP 429)"). */
  error?: string;
  onClick: () => void;
}

export function UsageIndicator({ windows, error, onClick }: Props) {
  if (windows.length === 0) {
    // Say why the bars are missing. Without this the fallback is indistinguishable
    // from "the feature is not there", which is exactly how it was first reported.
    const why = error ? `Usage data unavailable: ${error}` : 'Usage data not loaded yet';
    return (
      <button
        className={[styles.indicator, styles.iconOnly].join(' ')}
        title={`${why}\n\nOpen Account & usage`}
        aria-label="Account & usage"
        onClick={onClick}
        data-testid="usage-indicator"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      </button>
    );
  }

  const shown = sortWindows(windows).slice(0, MAX_BARS);
  const lines = shown.map(rl => {
    const pct = usagePercent(rl.utilization);
    return `${windowLabel(rl)}: ${pct}%${rl.resetsAt ? ` · ${formatReset(rl.resetsAt)}` : ''}`;
  });

  return (
    <button
      className={styles.indicator}
      title={`${lines.join('\n')}\n\nOpen Account & usage`}
      aria-label={`Usage limits. ${lines.join('. ')}`}
      onClick={onClick}
      data-testid="usage-indicator"
    >
      {shown.map(rl => {
        const pct = usagePercent(rl.utilization);
        return (
          <span
            key={rl.rateLimitType}
            className={styles.track}
            data-window={rl.rateLimitType}
            data-percent={pct}
          >
            <span
              className={[styles.fill, TIER_CLASS[usageTier(pct)]].filter(Boolean).join(' ')}
              style={{ width: `${pct}%` }}
            />
          </span>
        );
      })}
    </button>
  );
}
