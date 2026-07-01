import React, { useState, useRef, useEffect } from 'react';
import { postMessage } from '../vscode';
import { getDialogState, patchDialogState } from '../utils/dialogState';
import { Modal } from './shared/Modal';
import { RefreshButton } from './shared/RefreshButton';
import { useWebviewMessage } from '../hooks/useWebviewMessage';
import styles from './AccountUsageModal.module.css';
import shell from './shared/centeredModal.module.css';

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

interface ModelEntry {
  id: string;
  displayName: string;
  description?: string;
}

const MODEL_DESCRIPTIONS: Record<string, string> = {
  'claude-opus-4-8':           'Best for everyday, complex tasks',
  'claude-opus-4-7':           'Best for everyday, complex tasks',
  'claude-sonnet-4-6':         'Efficient for routine tasks',
  'claude-sonnet-4-5':         'Efficient for routine tasks',
  'claude-haiku-4-5':          'Fastest for quick answers',
  'claude-haiku-4-5-20251001': 'Fastest for quick answers',
  'claude-fable-5':            'Creative and expressive',
};

const FALLBACK_MODELS: ModelEntry[] = [
  { id: 'claude-haiku-4-5',  displayName: 'Claude Haiku 4.5',  description: 'Fastest for quick answers'        },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', description: 'Efficient for routine tasks'      },
  { id: 'claude-opus-4-8',   displayName: 'Claude Opus 4.8',   description: 'Best for everyday, complex tasks' },
];

function makeDefaultEntry(runtimeModel: string): ModelEntry {
  return {
    id: '',
    displayName: 'Default (CLI)',
    description: runtimeModel ? `Currently ${runtimeModel}` : 'Defers to the Claude CLI default',
  };
}

type Tab = 'usage' | 'models';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

interface Props {
  onClose: () => void;
  currentModel?: string;
  currentEffort?: string;
  thinkingEnabled?: boolean;
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

export function AccountUsageModal({ onClose, currentModel = '', currentEffort = 'high', thinkingEnabled = true }: Props) {
  const [tab, setTabState] = useState<Tab>(() => (getDialogState('accountUsage')?.tab as Tab) || 'usage');
  const setTab = (t: Tab) => { setTabState(t); patchDialogState('accountUsage', { tab: t }); };
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [rateLimits, setRateLimits] = useState<RateLimitInfo[]>([]);
  const [usageError, setUsageError] = useState<string | undefined>(undefined);
  // Account and usage load independently: the server sends the account first
  // (fast) with `usagePending: true`, then usage. The account renders right away
  // while only the usage section stays in a loading state.
  const [accountLoading, setAccountLoading] = useState(true);
  const [usageLoading, setUsageLoading] = useState(true);

  // Models tab state
  const [fetchedModels, setFetchedModels] = useState<ModelEntry[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [runtimeDefaultModel, setRuntimeDefaultModel] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const modelsLoadedRef = useRef(false);

  // If the restored tab is "models", trigger the lazy fetch on mount.
  useEffect(() => {
    if (tab === 'models' && !modelsLoadedRef.current) {
      modelsLoadedRef.current = true;
      setModelsLoading(true);
      postMessage({ type: 'getModels' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useWebviewMessage(
    (e: MessageEvent) => {
      if (e.data?.type === 'accountUsage') {
        const d = e.data;
        setAccount(d.account ?? null);
        setAccountLoading(false);
        if (d.usagePending) return; // account-only phase; usage still loading
        setRateLimits(Array.isArray(d.rateLimits) ? d.rateLimits : []);
        setUsageError(typeof d.usageError === 'string' ? d.usageError : undefined);
        setUsageLoading(false);
      } else if (e.data?.type === 'modelList') {
        const raw: ModelEntry[] = (e.data.models ?? []).map((m: { id: string; displayName: string }) => ({
          id: m.id,
          displayName: m.displayName,
          description: MODEL_DESCRIPTIONS[m.id],
        }));
        setFetchedModels(raw.length > 0 ? raw : null);
        setModelsError(raw.length === 0 && e.data.error ? String(e.data.error) : null);
        setModelsLoading(false);
        if (typeof e.data.runtimeDefaultModel === 'string' && e.data.runtimeDefaultModel) {
          setRuntimeDefaultModel(e.data.runtimeDefaultModel);
        }
      }
    },
    () => postMessage({ type: 'getAccountUsage' }),
  );

  // Manual refresh: force a fresh fetch, bypassing the server's 60s usage cache.
  function refresh() {
    if (usageLoading) return;
    setUsageLoading(true);
    setUsageError(undefined);
    postMessage({ type: 'getAccountUsage', force: true });
  }

  function openModelsTab() {
    setTab('models');
    if (!modelsLoadedRef.current) {
      modelsLoadedRef.current = true;
      setModelsLoading(true);
      postMessage({ type: 'getModels' });
    }
  }

  function pickModel(id: string) {
    postMessage({ type: 'switchModel', model: id });
  }

  const sortedLimits = [...rateLimits].sort(
    (a, b) => rateLimitOrder(a.rateLimitType) - rateLimitOrder(b.rateLimitType)
  );

  const allModels = [
    makeDefaultEntry(runtimeDefaultModel),
    ...(fetchedModels ?? FALLBACK_MODELS),
  ];
  const modelSearchLower = modelSearch.toLowerCase();
  const displayModels = modelSearchLower
    ? allModels.filter(m =>
        m.displayName.toLowerCase().includes(modelSearchLower) ||
        m.id.toLowerCase().includes(modelSearchLower)
      )
    : allModels;

  return (
    <Modal title="Account" ariaLabel="Account" onClose={onClose} width={380} persistKey="accountUsage">
      <div className={shell.tabs}>
        <button
          className={[shell.tab, tab === 'usage' ? shell.tabActive : ''].filter(Boolean).join(' ')}
          onClick={() => setTab('usage')}
        >Account & Usage</button>
        <button
          className={[shell.tab, tab === 'models' ? shell.tabActive : ''].filter(Boolean).join(' ')}
          onClick={openModelsTab}
        >Models</button>
      </div>

      {tab === 'usage' && (
        <>
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
                  <RefreshButton spinning={usageLoading} onClick={refresh} label="Refresh usage" title="Refresh usage data" size={13} />
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
        </>
      )}

      {tab === 'models' && (
        <>
          <div className={shell.searchRow}>
            <input
              className={shell.search}
              type="text"
              value={modelSearch}
              onChange={e => setModelSearch(e.target.value)}
              placeholder="Search models..."
              aria-label="Search models"
              autoFocus
            />
          </div>
          <div className={styles.body}>
            {modelsLoading && <div className={styles.placeholder}>Loading models...</div>}
            {!modelsLoading && modelsError && <div className={styles.placeholder}>{modelsError}</div>}
            {!modelsLoading && displayModels.map(m => {
              const isActive = m.id === currentModel;
              return (
                <div
                  key={m.id || '__default__'}
                  className={[styles.modelRow, isActive ? styles.modelRowActive : ''].filter(Boolean).join(' ')}
                  onClick={() => pickModel(m.id)}
                  title={m.description}
                >
                  <span className={styles.modelCheck}>{isActive ? '✓' : ''}</span>
                  <div className={styles.modelInfo}>
                    <span className={styles.modelName}>{m.displayName}</span>
                    {m.description && <span className={styles.modelDesc}>{m.description}</span>}
                  </div>
                </div>
              );
            })}
            {!modelsLoading && displayModels.length === 0 && (
              <div className={styles.placeholder}>No models match "{modelSearch}"</div>
            )}
          </div>
          <div className={styles.optionsSection}>
            <div className={styles.optionRow}>
              <span className={styles.optionLabel}>Effort ({currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1)})</span>
              <div className={styles.effortDots}>
                {EFFORT_LEVELS.map(level => (
                  <span
                    key={level}
                    title={level.charAt(0).toUpperCase() + level.slice(1)}
                    className={[styles.effortDot, level === (EFFORT_LEVELS.includes(currentEffort as EffortLevel) ? currentEffort : 'high') ? styles.effortDotActive : ''].filter(Boolean).join(' ')}
                    onClick={() => postMessage({ type: 'switchEffort', effort: level })}
                  />
                ))}
              </div>
            </div>
            <div className={styles.optionRow} onClick={() => postMessage({ type: 'switchThinking', thinking: !thinkingEnabled })} style={{ cursor: 'pointer' }}>
              <span className={styles.optionLabel}>Thinking</span>
              <div className={[styles.toggleTrack, thinkingEnabled ? styles.toggleTrackOn : ''].filter(Boolean).join(' ')}>
                <div className={[styles.toggleThumb, thinkingEnabled ? styles.toggleThumbOn : ''].filter(Boolean).join(' ')} />
              </div>
            </div>
          </div>
        </>
      )}
    </Modal>
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
