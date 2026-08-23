import React, { useState, useRef, useEffect } from 'react';
import { postMessage } from '../vscode';
import { getDialogState, patchDialogState } from '../utils/dialogState';
import { Modal } from './shared/Modal';
import { RefreshButton } from './shared/RefreshButton';
import { useWebviewMessage } from '../hooks/useWebviewMessage';
import { type ModelEntry, FALLBACK_MODELS, makeDefaultEntry, sameModel, toModelEntry } from '../utils/model';
import { type RateLimitInfo, formatReset, sortWindows, usagePercent, usageTier, windowLabel } from '../utils/usage';
import styles from './AccountUsageModal.module.css';
import shell from './shared/centeredModal.module.css';

interface AccountInfo {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

interface InsightRow {
  name: string;
  pct: number; // 0-100
}

interface BehaviorStat {
  key: string;
  pct: number; // 0-100
  count: number;
}

interface InsightsReport {
  totalCost: number;
  requestCount: number;
  sessionCount: number;
  behaviors: BehaviorStat[];
  skills: InsightRow[];
  agents: InsightRow[];
  plugins: InsightRow[];
  mcpServers: InsightRow[];
}

interface UsageInsights {
  day: InsightsReport;
  week: InsightsReport;
}

type InsightsRange = 'day' | 'week';

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

// "What's contributing to your limits usage?" behavior insights: official copy,
// keyed by the behavior keys the server reports (sorted by cost there). Unknown
// future keys are skipped rather than rendered without wording.
const BEHAVIOR_META: Record<string, { headline: (pct: number) => string; body: string }> = {
  cache_miss: {
    headline: (pct) => `${pct}% of your usage hit a >100k-token cache miss`,
    body: 'Uncached input is expensive, and often happens when sending a message to a session that has gone idle. /compact before stepping away keeps the cold-start small.',
  },
  long_context: {
    headline: (pct) => `${pct}% of your usage was at >150k context`,
    body: 'Longer sessions are more expensive even when cached. /compact mid-task, /clear when switching to new tasks.',
  },
  subagent_heavy: {
    headline: (pct) => `${pct}% of your usage came from subagent-heavy sessions`,
    body: 'Each subagent runs its own requests. Be deliberate about spawning them — and consider configuring a cheaper model for simpler subagents.',
  },
  high_parallel: {
    headline: (pct) => `${pct}% of your usage was while 4+ sessions ran in parallel`,
    body: "All sessions share one limit. If you don't need them all at once, queueing uses it more evenly.",
  },
  cron: {
    headline: (pct) => `${pct}% of your usage came from sessions active for 8+ hours`,
    body: 'These are often background/loop sessions. Continuous usage can add up quickly so make sure it is intentional.',
  },
};

// Matches the official panel: behaviors under 10% are noise and hidden, tables
// show the top 8 rows.
const MIN_BEHAVIOR_PCT = 10;
const TABLE_ROW_CAP = 8;

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

  // Local usage insights ("What's contributing to your limits usage?"): both
  // ranges arrive in one reply, the Day/Week toggle switches client-side.
  const [insights, setInsights] = useState<UsageInsights | null>(null);
  const [insightsError, setInsightsError] = useState<string | undefined>(undefined);
  const [insightsLoading, setInsightsLoading] = useState(true);
  const [insightsRange, setInsightsRange] = useState<InsightsRange>('day');

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
      } else if (e.data?.type === 'usageLimits' && Array.isArray(e.data.windows) && e.data.windows.length > 0) {
        // The server pushes these when its shared snapshot changes (the poller, or
        // another panel's refresh). Adopt them so an open modal cannot sit on numbers
        // older than the header indicator behind it. Empty pushes are ignored: this is
        // a sync, not a load, and it must not blank bars we already have.
        setRateLimits(e.data.windows as RateLimitInfo[]);
        setUsageError(undefined);
        setUsageLoading(false);
      } else if (e.data?.type === 'usageInsights') {
        const d = e.data;
        const hasReports = d.day && d.week;
        setInsights(hasReports ? { day: d.day, week: d.week } : null);
        setInsightsError(typeof d.error === 'string' ? d.error : undefined);
        setInsightsLoading(false);
      } else if (e.data?.type === 'modelList') {
        const raw: ModelEntry[] = (e.data.models ?? []).map(toModelEntry);
        setFetchedModels(raw.length > 0 ? raw : null);
        setModelsError(raw.length === 0 && e.data.error ? String(e.data.error) : null);
        setModelsLoading(false);
        if (typeof e.data.runtimeDefaultModel === 'string' && e.data.runtimeDefaultModel) {
          setRuntimeDefaultModel(e.data.runtimeDefaultModel);
        }
      }
    },
    () => {
      postMessage({ type: 'getAccountUsage' });
      postMessage({ type: 'getUsageInsights' });
    },
  );

  // Manual refresh: force a fresh fetch, bypassing the server's 60s usage cache.
  function refresh() {
    if (usageLoading) return;
    setUsageLoading(true);
    setUsageError(undefined);
    postMessage({ type: 'getAccountUsage', force: true });
    setInsightsLoading(true);
    setInsightsError(undefined);
    postMessage({ type: 'getUsageInsights', force: true });
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

  const sortedLimits = sortWindows(rateLimits);

  const report = insights ? insights[insightsRange] : null;
  const hasAttribution = !!report &&
    (report.skills.length > 0 || report.agents.length > 0 || report.plugins.length > 0 || report.mcpServers.length > 0);

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
                  const percent = usagePercent(rl.utilization);
                  const tier = usageTier(percent);
                  const barClass = [
                    styles.progressBar,
                    tier === 'high' ? styles.progressHigh : tier === 'medium' ? styles.progressMedium : '',
                  ].filter(Boolean).join(' ');
                  return (
                    <div key={rl.rateLimitType} className={styles.usageRow}>
                      <div className={styles.usageHeader}>
                        <span className={styles.usageName}>{windowLabel(rl)}</span>
                        <span className={styles.usagePercent}>{percent}%</span>
                      </div>
                      <div className={styles.progressTrack}>
                        <div className={barClass} style={{ width: `${percent}%` }} />
                      </div>
                      {rl.resetsAt && <div className={styles.resetLabel}>{formatReset(rl.resetsAt)}</div>}
                    </div>
                  );
                })}

                <div className={styles.insightsHeader}>What's contributing to your limits usage?</div>
                {insightsLoading && !report && <div className={styles.usageHint}>Analyzing local sessions...</div>}
                {!insightsLoading && !report && (
                  <div className={styles.usageHint}>
                    {insightsError ? `Usage insights are unavailable: ${insightsError}.` : 'Usage insights are unavailable right now.'}
                  </div>
                )}
                {/* Toggle and disclaimers only accompany actual data - while loading
                    or after a failure they are scaffolding around nothing. */}
                {report && (
                  <>
                    <div className={styles.rangeTabs} role="tablist" aria-label="Insights range">
                      {(['day', 'week'] as const).map(range => (
                        <button
                          key={range}
                          role="tab"
                          aria-selected={insightsRange === range}
                          className={[styles.rangeTab, insightsRange === range ? styles.rangeTabActive : ''].filter(Boolean).join(' ')}
                          onClick={() => setInsightsRange(range)}
                        >{range === 'day' ? 'Day' : 'Week'}</button>
                      ))}
                    </div>
                    <div className={styles.insightsNote}>
                      Approximate, based on local sessions on this machine — does not include other devices or claude.ai
                    </div>
                    <div className={styles.insightsNote}>
                      {insightsRange === 'day' ? 'Last 24h' : 'Last 7d'} · these are independent characteristics of your usage, not a breakdown
                    </div>
                    {report.behaviors
                      .filter(b => b.pct >= MIN_BEHAVIOR_PCT && BEHAVIOR_META[b.key])
                      .map(b => (
                        <div key={b.key} className={styles.behavior}>
                          <div className={styles.behaviorHeadline}>{BEHAVIOR_META[b.key].headline(b.pct)}</div>
                          <div className={styles.behaviorBody}>{BEHAVIOR_META[b.key].body}</div>
                        </div>
                      ))}
                    {hasAttribution ? (
                      <>
                        <InsightTable title="Skills" rows={report.skills} format={n => `/${n}`} />
                        <InsightTable title="Subagents" rows={report.agents} />
                        <InsightTable title="Plugins" rows={report.plugins} />
                        <InsightTable title="MCP servers" rows={report.mcpServers} />
                      </>
                    ) : (
                      <div className={styles.behavior}>
                        <div className={styles.behaviorHeadline}>Skills, subagents, plugins, and MCP servers</div>
                        <div className={styles.behaviorBody}>No attribution data yet · accumulates as you use Claude</div>
                      </div>
                    )}
                  </>
                )}
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
              const isActive = sameModel(m.id, currentModel);
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

function InsightTable({ title, rows, format }: { title: string; rows: InsightRow[]; format?: (name: string) => string }) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, TABLE_ROW_CAP);
  const hidden = rows.length - TABLE_ROW_CAP;
  return (
    <div className={styles.insightTable}>
      <div className={styles.insightTableHeader}>
        <span>{title}</span>
        <span className={styles.insightTablePct}>% of usage</span>
      </div>
      {shown.map(row => {
        const name = format ? format(row.name) : row.name;
        return (
          <div key={row.name} className={styles.insightTableRow}>
            <span className={styles.insightTableName} title={name}>{name}</span>
            <span className={styles.insightTablePct}>{row.pct}%</span>
          </div>
        );
      })}
      {hidden > 0 && <div className={styles.insightTableMore}>… {hidden} more</div>}
    </div>
  );
}
