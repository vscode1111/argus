import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { postMessage } from '../vscode';
import styles from './AccountUsageModal.module.css';

interface AccountInfo {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

interface RateLimitInfo {
  rateLimitType: string;
  utilization: number; // 0..1
  resetsAt?: number;   // unix epoch seconds
  status?: string;
}

interface Props {
  onClose: () => void;
}

const PLAN_LABELS: Record<string, string> = {
  max: 'Claude Max',
  pro: 'Claude Pro',
  free: 'Free',
  team: 'Team',
  enterprise: 'Enterprise',
};

const AUTH_LABELS: Record<string, string> = {
  'claude.ai': 'Claude AI',
  'api_key': 'API Key',
};

// Friendly label + display order for known rate-limit windows.
const RATE_LIMIT_META: Record<string, { label: string; order: number }> = {
  five_hour: { label: 'Session (5hr)', order: 0 },
  seven_day: { label: 'Weekly (7 day)', order: 1 },
  seven_day_opus: { label: 'Weekly Opus', order: 2 },
  seven_day_sonnet: { label: 'Weekly Sonnet', order: 3 },
};

function rateLimitLabel(type: string): string {
  if (RATE_LIMIT_META[type]) return RATE_LIMIT_META[type].label;
  // Fallback: prettify the raw type, e.g. "five_hour" -> "Five Hour"
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function rateLimitOrder(type: string): number {
  return RATE_LIMIT_META[type]?.order ?? 100;
}

function formatReset(resetsAt: number): string {
  const diffMs = resetsAt * 1000 - Date.now();
  if (diffMs <= 0) return 'Resets soon';
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `Resets in ${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `Resets in ${diffHr}h`;
  return `Resets in ${Math.floor(diffHr / 24)}d`;
}

export function AccountUsageModal({ onClose }: Props) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [rateLimits, setRateLimits] = useState<RateLimitInfo[]>([]);
  const [usageError, setUsageError] = useState<string | undefined>(undefined);
  // Account and usage load independently: the server sends the account first
  // (fast) with `usagePending: true`, then usage. The account renders right away
  // while only the usage section stays in a loading state.
  const [accountLoading, setAccountLoading] = useState(true);
  const [usageLoading, setUsageLoading] = useState(true);

  useEscapeKey(onClose);

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type !== 'accountUsage') return;
      const d = e.data;
      setAccount(d.account ?? null);
      setAccountLoading(false);
      if (d.usagePending) return; // account-only phase; usage still loading
      setRateLimits(Array.isArray(d.rateLimits) ? d.rateLimits : []);
      setUsageError(typeof d.usageError === 'string' ? d.usageError : undefined);
      setUsageLoading(false);
    }
    window.addEventListener('message', handleMessage);
    postMessage({ type: 'getAccountUsage' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Manual refresh: force a fresh fetch, bypassing the server's 60s usage cache.
  function refresh() {
    if (usageLoading) return;
    setUsageLoading(true);
    setUsageError(undefined);
    postMessage({ type: 'getAccountUsage', force: true });
  }

  const sortedLimits = [...rateLimits].sort(
    (a, b) => rateLimitOrder(a.rateLimitType) - rateLimitOrder(b.rateLimitType)
  );

  return createPortal(
    <>
      <div className={styles.overlay} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal} role="dialog" aria-label="Account & Usage">
        <div className={styles.header}>
          <span className={styles.title}>Account &amp; Usage</span>
          <button className={styles.close} onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className={styles.body}>
          {accountLoading && <div className={styles.placeholder}>Loading...</div>}
          {!accountLoading && account && !account.loggedIn && (
            <div className={styles.placeholder}>Not logged in</div>
          )}
          {!accountLoading && account?.loggedIn && (
            <>
              <div className={styles.sectionTitle}>Account</div>
              {account.authMethod && (
                <Row label="Auth method" value={AUTH_LABELS[account.authMethod] ?? account.authMethod} />
              )}
              {account.email && <Row label="Email" value={account.email} />}
              {account.orgName && <Row label="Organization" value={account.orgName} />}
              {account.subscriptionType && (
                <Row label="Plan" value={PLAN_LABELS[account.subscriptionType] ?? account.subscriptionType} />
              )}

              <div className={styles.usageTitleRow}>
                <span className={styles.sectionTitle}>Usage</span>
                <button
                  className={[styles.refreshBtn, usageLoading ? styles.refreshing : ''].filter(Boolean).join(' ')}
                  onClick={refresh}
                  disabled={usageLoading}
                  aria-label="Refresh usage"
                  title="Refresh usage data"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                </button>
              </div>
              {sortedLimits.length === 0 && (
                <div className={styles.usageHint}>
                  {usageLoading
                    ? 'Loading usage data...'
                    : usageError
                      ? `Usage data is unavailable: ${usageError}.`
                      : 'Usage data is unavailable right now.'}
                </div>
              )}
              {sortedLimits.map(rl => {
                const percent = Math.max(0, Math.min(100, Math.round(rl.utilization * 100)));
                const barClass = [
                  styles.progressBar,
                  percent >= 90 ? styles.progressHigh : percent >= 50 ? styles.progressMedium : '',
                ].filter(Boolean).join(' ');
                return (
                  <div key={rl.rateLimitType} className={styles.usageRow}>
                    <div className={styles.usageHeader}>
                      <span className={styles.usageName}>{rateLimitLabel(rl.rateLimitType)}</span>
                      <span className={styles.usagePercent}>{percent}%</span>
                    </div>
                    <div className={styles.progressTrack}>
                      <div className={barClass} style={{ width: `${percent}%` }} />
                    </div>
                    {rl.resetsAt && <div className={styles.resetLabel}>{formatReset(rl.resetsAt)}</div>}
                  </div>
                );
              })}
            </>
          )}
        </div>
        <div className={styles.footer}>
          <button
            className={styles.footerLink}
            onClick={() => {
              const url = 'https://claude.ai/new#settings/usage';
              postMessage({ type: 'openUrl', url }); // VS Code extension path
              window.open(url, '_blank'); // browser dev path (WS bridge has no openUrl)
            }}
          >
            Manage usage on claude.ai
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  );
}
