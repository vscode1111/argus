import React, { useState, useEffect, useRef } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useDialogGeometry } from '../hooks/useDialogGeometry';
import { clearDialogState } from '../utils/dialogState';
import { useSettings } from '../contexts/SettingsContext';
import { postMessage, isVsCode } from '../vscode';
import { plural } from '../utils/text';
import { CliProcessesModal } from './CliProcessesModal';
import styles from './SettingsModal.module.css';

interface ToggleProps {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function Toggle({ id, checked, onChange }: ToggleProps) {
  return (
    <span className={styles.toggle}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span className={styles.toggleTrack} aria-hidden="true" />
    </span>
  );
}

interface NumberInputProps {
  id: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
  disabled?: boolean;
}

// Common service / dev ports to avoid when picking a random daemon port.
const POPULAR_PORTS = new Set([
  21, 22, 23, 25, 53, 80, 110, 143, 443, 587, 993, 995,
  1433, 1521, 3000, 3001, 3017, 3018, 3306, 3389, 4200, 5000, 5173, 5432,
  5672, 6379, 8000, 8080, 8081, 8443, 8888, 9000, 9090, 9200, 9229, 11211, 27017,
]);

// A random port in 10000-49151 that isn't a well-known/popular one.
// Upper bound is below the Windows ephemeral range (49152+) so the port won't
// be grabbed by VS Code's internal IPC or other OS-allocated sockets.
function randomPort(): number {
  let p: number;
  do { p = 10000 + Math.floor(Math.random() * (49151 - 10000 + 1)); } while (POPULAR_PORTS.has(p));
  return p;
}

// Numeric dot-segment compare (a < b => negative, a > b => positive). A plain
// string compare gets "0.0.9" > "0.0.10" wrong, which flips which side actually
// looks stale.
function compareVersions(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const an = Number(as[i] ?? 0);
    const bn = Number(bs[i] ?? 0);
    if (an !== bn) return an - bn;
  }
  return 0;
}

function NumberInput({ id, value, onChange, min = 1, step, disabled }: NumberInputProps) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  return (
    <input
      id={id}
      type="number"
      className={styles.numberInput}
      min={min}
      step={step}
      disabled={disabled}
      value={text}
      onChange={e => {
        setText(e.target.value);
        const parsed = step ? parseFloat(e.target.value) : parseInt(e.target.value);
        if (!isNaN(parsed)) onChange(Math.max(min, parsed));
      }}
      onBlur={() => {
        const parsed = step ? parseFloat(text) : parseInt(text);
        const final = isNaN(parsed) || parsed < min ? min : parsed;
        onChange(final);
        setText(String(final));
      }}
    />
  );
}

interface TextInputProps {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

function TextInput({ id, value, onChange, placeholder, disabled }: TextInputProps) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const commit = () => { if (text !== value) onChange(text); };
  return (
    <input
      id={id}
      type="text"
      className={styles.textInput}
      placeholder={placeholder}
      disabled={disabled}
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
    />
  );
}

interface CopyableValueProps {
  value: string;
  copied: boolean;
  onCopy: () => void;
  className: string;
  testId: string;
}

// A click-to-copy value that keeps its width while showing the "Copied!" feedback.
// Swapping the text outright collapsed the modal (it is content-sized, so a long
// transcript path defines its width) and it snapped back a second later. The value
// stays in the layout and is only made invisible, with the label drawn over it.
function CopyableValue({ value, copied, onCopy, className, testId }: CopyableValueProps) {
  return (
    <span
      className={[className, styles.copyable].join(' ')}
      data-testid={testId}
      role="button"
      tabIndex={0}
      title="Click to copy"
      onClick={onCopy}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCopy(); } }}
    >
      <span className={copied ? styles.copyHidden : undefined}>{value}</span>
      {copied && <span className={styles.copiedBadge}>Copied!</span>}
    </span>
  );
}

interface Props {
  onClose: () => void;
  workspacePath: string;
  version: string;
}

type Tab = 'general' | 'watchdog' | 'network' | 'info';

export function SettingsModal({ onClose, workspacePath, version }: Props) {
  const { verboseTools, showTimer, showOutput, showLogs, soundOnComplete, notifyOnComplete, watchdogEnabled, watchdogTimeout, watchdogAutoRetries, watchdogRetryDelay, watchdogDelayFactor, cliIdleTimeoutSec, allowNetworkAccess, allowedOrigins, setVerboseTools, setShowTimer, setShowOutput, setShowLogs, setSoundOnComplete, setNotifyOnComplete, setWatchdogEnabled, setWatchdogTimeout, setWatchdogAutoRetries, setWatchdogRetryDelay, setWatchdogDelayFactor, setCliIdleTimeoutSec, setAllowNetworkAccess, setAllowedOrigins, daemonPort, setDaemonPort, daemonIdleMs, setDaemonIdleMs } = useSettings();
  const [activeClients, setActiveClients] = useState<number | null>(null);
  const [serverPort, setServerPort] = useState<number | null>(null);
  const [cliLaunchCount, setCliLaunchCount] = useState<number | null>(null);
  // Claude CLIs alive on the machine right now - a different scope from cliLaunchCount,
  // which counts only what THIS server spawned. Shown next to it because the two
  // disagreeing (0 launches, 10 running) reads as a broken counter otherwise.
  const [liveProcesses, setLiveProcesses] = useState<number | null>(null);
  // How many of those are still this server's. Without it the launch tally reads as a
  // broken counter the moment its processes exit ("2 launched, so where are they?").
  const [ownedProcesses, setOwnedProcesses] = useState<number | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  // Set when the daemon restarts onto a different port and this (browser) tab can't
  // follow it (it is same-origin to the old port) - surfaces a clickable new URL.
  const [movedUrl, setMovedUrl] = useState<string | null>(null);
  // Which value was just copied, so the "Copied!" feedback shows on that row only
  // (several rows are copyable now, and a shared boolean lit all of them at once).
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // "Stop all Claude CLI processes": armed by a first click, fired by a second
  // within killArmTimer's window - this kills processes machine-wide (see
  // killAllClaude in cli.ts), so it needs more friction than a single click.
  const [killArmed, setKillArmed] = useState(false);
  const [killing, setKilling] = useState(false);
  const [killResult, setKillResult] = useState<{ count: number; error?: string } | null>(null);
  const killArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "Stop daemon": same arm/confirm friction as the kill button - it takes the server
  // this panel is talking to offline (every other panel included), so a stray click
  // must not be enough. `stopResult` is true when the daemon really stopped, false
  // when the server answered that it isn't a daemon (dev server).
  const [stopArmed, setStopArmed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopResult, setStopResult] = useState<boolean | null>(null);
  const stopArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The process list opens on top of this modal (both are portals), so Settings must
  // not also close on the Escape that dismisses it.
  const [showProcesses, setShowProcesses] = useState(false);
  useEffect(() => () => {
    if (killArmTimer.current) clearTimeout(killArmTimer.current);
    if (stopArmTimer.current) clearTimeout(stopArmTimer.current);
  }, []);
  useEffect(() => {
    postMessage({ type: 'getSettings' });
    postMessage({ type: 'getClientCount' });
    postMessage({ type: 'getServerInfo' });
    postMessage({ type: 'listCliProcesses' });
    // The server also pushes clientCount whenever a connection opens or closes,
    // so this stays live while the modal is open.
    const onMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg && msg.type === 'clientCount' && typeof msg.count === 'number') {
        setActiveClients(msg.count);
      } else if (msg && msg.type === 'cliProcessList' && Array.isArray(msg.processes)) {
        // Also arrives on every poll while the process modal is open, so the row and the
        // list it opens can never show two different totals.
        setLiveProcesses(msg.error ? null : msg.processes.length);
        setOwnedProcesses(msg.error ? null : msg.processes.filter((p: { ours?: boolean }) => p.ours).length);
      } else if (msg && msg.type === 'serverInfo' && typeof msg.port === 'number') {
        // A fresh connection (incl. after a restart) reports the live port; clear the
        // restart spinner and any "moved" notice once we're talking to the new daemon.
        setServerPort(msg.port);
        setRestarting(false);
        setMovedUrl(null);
        if (typeof msg.cliLaunchCount === 'number') setCliLaunchCount(msg.cliLaunchCount);
        setServerVersion(typeof msg.serverVersion === 'string' ? msg.serverVersion : null);
        setSessionId(typeof msg.sessionId === 'string' ? msg.sessionId : null);
        setSessionPath(typeof msg.sessionPath === 'string' ? msg.sessionPath : null);
      } else if (msg && msg.type === 'daemonRestarting' && typeof msg.port === 'number') {
        setServerPort(msg.port);
        setRestarting(false);
        if (!isVsCode && typeof location !== 'undefined' && String(msg.port) !== location.port) {
          setMovedUrl(msg.url); // this tab can't follow a port change - show the new URL
        }
      } else if (msg && msg.type === 'daemonStopping') {
        // Broadcast by the daemon just before it exits; sent with stopped:false by a
        // server that has no process to stop (dev server).
        setStopping(false);
        setStopResult(msg.stopped !== false);
      } else if (msg && msg.type === 'ws_status' && msg.connected) {
        // After any (re)connect - including the new daemon after a restart - refresh
        // the live port and client count so the address rows reflect the new daemon.
        postMessage({ type: 'getServerInfo' });
        postMessage({ type: 'getClientCount' });
      } else if (msg && msg.type === 'killAllClaudeResult' && typeof msg.count === 'number') {
        setKilling(false);
        setKillResult({ count: msg.count, error: typeof msg.error === 'string' ? msg.error : undefined });
        // A kill can respawn this panel's own CLI process count (or end its session),
        // so refresh the Info tab snapshot instead of leaving it at whatever it showed
        // before the click.
        postMessage({ type: 'getServerInfo' });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Local display state for the daemon port input. Seeded from the live server port
  // so the field shows what the daemon is actually running on - but updating this
  // does NOT write to argus.json (only the NumberInput onChange does via setDaemonPort).
  const [localDaemonPort, setLocalDaemonPort] = useState(daemonPort);
  useEffect(() => {
    if (serverPort != null) setLocalDaemonPort(serverPort);
  }, [serverPort]);

  function openExternal(url: string): void {
    postMessage({ type: 'openUrl', url });
    if (!isVsCode && typeof window !== 'undefined') window.open(url, '_blank');
  }
  function copyText(text: string, key: string): void {
    try { navigator.clipboard?.writeText(text); setCopiedKey(key); setTimeout(() => setCopiedKey(null), 1200); } catch { /* */ }
  }
  // Only a genuine disagreement counts: either side can be unknown (the browser dev
  // host passes no version, and an old daemon sends no serverVersion at all). Which
  // side is actually behind matters - "(stale)" belongs on the older build, and a
  // plain inequality check can't tell "0.0.79 vs 0.0.80" from "0.0.80 vs 0.0.79".
  const versionCompare = version && serverVersion && version !== serverVersion
    ? compareVersions(serverVersion, version)
    : 0;
  const serverIsStale = versionCompare < 0;
  const clientIsStale = versionCompare > 0;
  // A daemon older than the serverInfo.serverVersion field sends nothing at all, so
  // silence here is itself proof of skew - the one case this row exists to catch.
  const serverUnknown = !!version && !!serverPort && !serverVersion;
  function handleRestart(): void {
    setRestarting(true);
    postMessage({ type: 'restartDaemon' });
    // Safety net: drop the spinner if nothing comes back (e.g. dev server no-op).
    setTimeout(() => setRestarting(false), 8000);
  }
  function handleKillAll(): void {
    if (killing) return;
    if (!killArmed) {
      setKillArmed(true);
      setKillResult(null);
      if (killArmTimer.current) clearTimeout(killArmTimer.current);
      killArmTimer.current = setTimeout(() => setKillArmed(false), 4000);
      return;
    }
    if (killArmTimer.current) { clearTimeout(killArmTimer.current); killArmTimer.current = null; }
    setKillArmed(false);
    setKilling(true);
    postMessage({ type: 'killAllClaude' });
  }
  function handleStopDaemon(): void {
    if (stopping) return;
    if (!stopArmed) {
      setStopArmed(true);
      setStopResult(null);
      if (stopArmTimer.current) clearTimeout(stopArmTimer.current);
      stopArmTimer.current = setTimeout(() => setStopArmed(false), 4000);
      return;
    }
    if (stopArmTimer.current) { clearTimeout(stopArmTimer.current); stopArmTimer.current = null; }
    setStopArmed(false);
    setStopping(true);
    postMessage({ type: 'stopDaemon' });
    // Safety net: a daemon too old to know this message never answers.
    setTimeout(() => setStopping(false), 8000);
  }
  const httpUrl = serverPort ? `http://localhost:${serverPort}` : '';
  const wsUrl = serverPort ? `ws://localhost:${serverPort}/agent` : '';
  const [tab, setTabState] = useState<Tab>(() => (localStorage.getItem('argus.settingsTab') as Tab) || 'general');
  const setTab = (t: Tab) => {
    setTabState(t);
    localStorage.setItem('argus.settingsTab', t);
    if (t === 'info') { postMessage({ type: 'getServerInfo' }); postMessage({ type: 'listCliProcesses' }); }
  };
  const [layoutCleared, setLayoutCleared] = useState(false);
  const hasDevHarness = !!document.getElementById('dev-harness');
  const hasNotificationAPI = typeof Notification !== 'undefined';
  const [notifPerm, setNotifPerm] = useState(() => hasNotificationAPI ? Notification.permission : 'unavailable');

  function handleGrantNotifications() {
    if (!hasNotificationAPI) return;
    Notification.requestPermission().then(p => {
      setNotifPerm(p);
      if (p === 'granted') {
        new Notification('Argus', { body: 'Notifications enabled!' });
      }
    });
  }

  useEscapeKey(() => { if (!showProcesses) onClose(); });

  const modalRef = useRef<HTMLDivElement>(null);
  const drag = useDialogGeometry(modalRef, { persistKey: 'settings', defaultWidth: 340 });

  // Forget every dialog's remembered position/size/tab (and the Settings tab),
  // then snap this modal back to its default geometry so the reset is visible.
  function handleClearLayout() {
    clearDialogState();
    localStorage.removeItem('argus.settingsTab');
    drag.reset();
    setLayoutCleared(true);
    setTimeout(() => setLayoutCleared(false), 1500);
  }

  return (
    <>
      <div className={styles.overlay} onClick={onClose} aria-hidden="true" />
      <div
        className={styles.dropdown}
        role="dialog"
        aria-label="Settings"
        ref={modalRef}
        style={drag.style}
      >
        <div className={styles.dragHandle} onPointerDown={drag.onPointerDown} />
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close settings" title="Close">&times;</button>
        <div className={styles.scroll}>
        <div className={styles.tabBar}>
          <button className={[styles.tab, tab === 'general' ? styles.tabActive : ''].filter(Boolean).join(' ')} onClick={() => setTab('general')}>General</button>
          <button className={[styles.tab, tab === 'watchdog' ? styles.tabActive : ''].filter(Boolean).join(' ')} onClick={() => setTab('watchdog')}>Watchdog</button>
          <button className={[styles.tab, tab === 'network' ? styles.tabActive : ''].filter(Boolean).join(' ')} onClick={() => setTab('network')}>Network</button>
          <button className={[styles.tab, tab === 'info' ? styles.tabActive : ''].filter(Boolean).join(' ')} onClick={() => setTab('info')}>Info</button>
        </div>
        {tab === 'general' && (
          <div className={styles.tabContent}>
            <label className={styles.settingRow} htmlFor="toggle-verbose">
              <span className={styles.settingLabel} title="Show full tool call details in messages">Verbose tools</span>
              <Toggle id="toggle-verbose" checked={verboseTools} onChange={setVerboseTools} />
            </label>
            <label className={styles.settingRow} htmlFor="toggle-timer">
              <span className={styles.settingLabel} title="Display response time and finish timestamp">Show timer</span>
              <Toggle id="toggle-timer" checked={showTimer} onChange={setShowTimer} />
            </label>
            <label className={styles.settingRow} htmlFor="toggle-output">
              <span className={styles.settingLabel} title="Show CLI stdout in the log panel">Show output</span>
              <Toggle id="toggle-output" checked={showOutput} onChange={setShowOutput} />
            </label>
            <label className={styles.settingRow} htmlFor="toggle-logs">
              <span className={styles.settingLabel} title="Show the log panel below messages">Show logs</span>
              <Toggle id="toggle-logs" checked={showLogs} onChange={setShowLogs} />
            </label>
            <label className={styles.settingRow} htmlFor="toggle-sound">
              <span className={styles.settingLabel} title="Play a sound when a response finishes">Sound on complete</span>
              <Toggle id="toggle-sound" checked={soundOnComplete} onChange={setSoundOnComplete} />
            </label>
            <label className={styles.settingRow} htmlFor="toggle-notify">
              <span className={styles.settingLabel} title="Show a browser notification when a response finishes">Notify on complete</span>
              <Toggle id="toggle-notify" checked={notifyOnComplete} onChange={setNotifyOnComplete} />
            </label>
            {notifyOnComplete && !isVsCode && (
              <div className={styles.settingRow} style={{ paddingTop: 0 }}>
                {!hasNotificationAPI ? (
                  <span className={styles.notifHint}>Notifications are not supported in this window.</span>
                ) : notifPerm === 'granted' ? (
                  <span className={styles.notifHintOk}>Browser notifications are allowed.</span>
                ) : notifPerm === 'denied' ? (
                  <span className={styles.notifHint}>
                    Blocked in the browser.<br />
                    Allow notifications for this site<br />
                    in your browser settings, then reload.
                  </span>
                ) : (
                  <button className={styles.grantBtn} onClick={handleGrantNotifications}>
                    Grant permission
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {tab === 'watchdog' && (
          <div className={styles.tabContent}>
            <label className={styles.settingRow} htmlFor="toggle-watchdog">
              <span className={styles.settingLabel} title="Monitor CLI process for stalls and auto-recover">Enabled</span>
              <Toggle id="toggle-watchdog" checked={watchdogEnabled} onChange={setWatchdogEnabled} />
            </label>
            <label className={[styles.settingRow, !watchdogEnabled ? styles.settingDisabled : ''].filter(Boolean).join(' ')} htmlFor="input-watchdog">
              <span className={styles.settingLabel} title="Seconds of no CLI output before a retry is triggered">Timeout (s)</span>
              <NumberInput id="input-watchdog" value={watchdogTimeout} onChange={setWatchdogTimeout} min={1} disabled={!watchdogEnabled} />
            </label>
            <label className={[styles.settingRow, !watchdogEnabled ? styles.settingDisabled : ''].filter(Boolean).join(' ')} htmlFor="input-retries">
              <span className={styles.settingLabel} title="Max consecutive retries before giving up">Auto retries</span>
              <NumberInput id="input-retries" value={watchdogAutoRetries} onChange={setWatchdogAutoRetries} min={0} disabled={!watchdogEnabled} />
            </label>
            <label className={[styles.settingRow, !watchdogEnabled ? styles.settingDisabled : ''].filter(Boolean).join(' ')} htmlFor="input-retry-delay">
              <span className={styles.settingLabel} title="Initial wait before the first retry">Base delay (s)</span>
              <NumberInput id="input-retry-delay" value={watchdogRetryDelay} onChange={setWatchdogRetryDelay} min={1} disabled={!watchdogEnabled} />
            </label>
            <label className={[styles.settingRow, !watchdogEnabled ? styles.settingDisabled : ''].filter(Boolean).join(' ')} htmlFor="input-delay-factor">
              <span className={styles.settingLabel} title="Multiplier applied each retry: delay = base * factor^attempt. Set to 1 for fixed delay">Delay factor</span>
              <NumberInput id="input-delay-factor" value={watchdogDelayFactor} onChange={setWatchdogDelayFactor} min={1} step={0.5} disabled={!watchdogEnabled} />
            </label>
            <label className={styles.settingRow} htmlFor="input-cli-idle">
              <span className={styles.settingLabel} title="Terminate a CLI process this server owns once its session has been idle this long, to reclaim its memory (each one holds ~250MB). 0 disables it. A process that is mid-turn is never touched, and the conversation survives - the next message respawns the CLI with --resume.">
                Idle CLI timeout (s)
                <span className={styles.infoScope}>this server only · 0 = off</span>
              </span>
              <NumberInput id="input-cli-idle" value={cliIdleTimeoutSec} onChange={setCliIdleTimeoutSec} min={0} />
            </label>
          </div>
        )}
        {tab === 'network' && (
          <div className={styles.tabContent}>
            <label className={styles.settingRow} htmlFor="toggle-network">
              <span className={styles.settingLabel} title="Allow devices other than this machine (LAN/tunnel) to connect. When off, only localhost can connect. Turning this off from a remote device will disconnect it.">Network access</span>
              <Toggle id="toggle-network" checked={allowNetworkAccess} onChange={setAllowNetworkAccess} />
            </label>
            <div className={[styles.settingColumn, !allowNetworkAccess ? styles.settingDisabled : ''].filter(Boolean).join(' ')}>
              <label className={styles.settingLabel} htmlFor="input-origins" title="Extra hosts (IPs or hostnames) allowed to connect, comma-separated. Private-LAN ranges are already allowed when network access is on.">Allowed origins</label>
              <TextInput id="input-origins" value={allowedOrigins} onChange={setAllowedOrigins} placeholder="203.0.113.1, dev.example.com" disabled={!allowNetworkAccess} />
              <span className={styles.fieldHint}>
                Comma-separated hosts.<br />
                Used for tunnels or reverse proxies<br />
                that aren't on the local LAN.
              </span>
            </div>
            <div className={styles.clientCount} title="HTTP endpoint this server is listening on - click to open in a browser">
              <span className={styles.settingLabel}>HTTP address</span>
              {httpUrl
                ? <span className={[styles.clientCountValue, styles.addrLink].join(' ')} data-testid="http-address" role="link" tabIndex={0} title="Open in browser" onClick={() => openExternal(httpUrl + '/')}>{httpUrl}</span>
                : <span className={styles.clientCountValue} data-testid="http-address">-</span>}
            </div>
            <div className={styles.clientCount} title="WebSocket endpoint clients connect to (shares the HTTP port) - click to copy">
              <span className={styles.settingLabel}>WebSocket address</span>
              {wsUrl
                ? <CopyableValue value={wsUrl} copied={copiedKey === 'ws'} onCopy={() => copyText(wsUrl, 'ws')} className={[styles.clientCountValue, styles.addrLink].join(' ')} testId="ws-address" />
                : <span className={styles.clientCountValue} data-testid="ws-address">-</span>}
            </div>
            <div className={styles.clientCount} title="WebSocket clients currently connected to this server (this window counts as one)">
              <span className={styles.settingLabel}>Active connections</span>
              <span className={styles.clientCountValue} data-testid="active-connections">{activeClients ?? '-'}</span>
            </div>
            <label className={styles.settingRow} htmlFor="input-daemon-port">
              <span className={styles.settingLabel} title="Fixed port the always-on daemon listens on (default 3017). The extension and the browser UI read the actual port from the discovery file, so they adapt automatically. Applies to the daemon after a restart (yarn daemon:stop).">Daemon port</span>
              <span className={styles.portControls}>
                <button
                  type="button"
                  className={styles.randomBtn}
                  aria-label="Randomize port"
                  title="Pick a random port (avoids common ports)"
                  onClick={(e) => { e.preventDefault(); const p = randomPort(); setLocalDaemonPort(p); setDaemonPort(p); }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
                    <circle cx="16" cy="16" r="1.4" fill="currentColor" stroke="none" />
                    <circle cx="8" cy="16" r="1.4" fill="currentColor" stroke="none" />
                    <circle cx="16" cy="8" r="1.4" fill="currentColor" stroke="none" />
                  </svg>
                </button>
                <NumberInput id="input-daemon-port" value={localDaemonPort} onChange={(v) => { setLocalDaemonPort(v); setDaemonPort(v); }} min={1} />
              </span>
            </label>
            <label className={styles.settingRow} htmlFor="input-daemon-idle">
              <span className={styles.settingLabel} title="The always-on daemon self-exits after this many minutes with zero connected clients. Applies to the daemon after a restart (yarn daemon:stop).">Daemon idle timeout (min)</span>
              <NumberInput id="input-daemon-idle" value={Math.round(daemonIdleMs / 60000)} onChange={(m) => setDaemonIdleMs(Math.max(1, m) * 60000)} min={1} />
            </label>
            <div className={styles.settingColumn}>
              <span className={styles.fieldHint}>Daemon port and idle timeout. Apply after a daemon restart.</span>
              <button
                className={styles.restartBtn}
                onClick={handleRestart}
                disabled={restarting}
                title="Restart the daemon to apply the port / idle timeout. This disconnects all connected clients and ends any running turn."
              >
                {restarting ? 'Restarting daemon...' : 'Apply (restart daemon)'}
              </button>
              {movedUrl && (
                <span className={styles.fieldHint}>
                  Daemon moved to a new port. Reconnect at{' '}
                  <span className={styles.addrLink} role="link" tabIndex={0} onClick={() => openExternal(movedUrl)}>{movedUrl}</span>
                </span>
              )}
            </div>
          </div>
        )}
        {tab === 'info' && (
          <div className={styles.tabContent}>
            {version && (
              <div className={styles.infoRow}>
                <span className={styles.infoLabel} title="Version of this extension/UI build">Client</span>
                <span
                  className={[styles.infoValue, clientIsStale ? styles.infoValueWarn : ''].filter(Boolean).join(' ')}
                  data-testid="client-version"
                  title={clientIsStale ? `This build is ${version}, the serving daemon is newer (${serverVersion}) - update/reload this install` : undefined}
                >
                  {clientIsStale ? `${version} (stale)` : version}
                </span>
              </div>
            )}
            <div className={styles.infoRow}>
              <span className={styles.infoLabel} title="Version of the daemon serving this panel. The daemon is a separate install found through a machine-global discovery file, so an older one left running elsewhere can serve a newer UI - which then silently misses features.">Server</span>
              <span
                className={[styles.infoValue, serverIsStale || serverUnknown ? styles.infoValueWarn : ''].filter(Boolean).join(' ')}
                data-testid="server-version"
                title={
                  serverIsStale ? `Serving daemon is ${serverVersion}, this build is ${version} - restart the daemon`
                    : serverUnknown ? `The serving daemon is too old to report its version (this build is ${version}) - restart the daemon`
                      : undefined
                }
              >
                {serverVersion ? (serverIsStale ? `${serverVersion} (stale)` : serverVersion) : serverUnknown ? 'unknown (stale)' : '-'}
              </span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoLabel}>Path</span>
              {workspacePath
                ? <CopyableValue value={workspacePath} copied={copiedKey === 'workspace'} onCopy={() => copyText(workspacePath, 'workspace')} className={[styles.infoValue, styles.addrLink].join(' ')} testId="workspace-path" />
                : <span className={styles.infoValue} data-testid="workspace-path">(no workspace)</span>}
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoLabel} title="How many times THIS server has started a Claude CLI since it booted - a running tally of events, not of live processes, so it only goes up (except when 'Stop all Claude CLI processes' resets it). A server that has run no turns shows 0 even while other CLIs run on the machine.">CLI launches<span className={styles.infoScope} data-testid="cli-launches-scope">
                {ownedProcesses == null ? 'this server, total' : `this server, total · ${ownedProcesses} still alive`}
              </span></span>
              <span
                className={[styles.infoValue, styles.addrLink].join(' ')}
                data-testid="cli-launches"
                role="button"
                tabIndex={0}
                title="Show every Claude CLI process running on the server's machine, with its PID, age, CPU and memory"
                onClick={() => setShowProcesses(true)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowProcesses(true); } }}
              >
                {cliLaunchCount ?? '-'}
              </span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoLabel} title="How many Claude CLIs are alive on the server's machine right now, whoever started them - a live count that rises and falls, unlike the launch tally above. This is the set the process list shows and the set 'Stop all Claude CLI processes' would kill.">CLI processes<span className={styles.infoScope}>whole machine, now</span></span>
              <span
                className={[styles.infoValue, styles.addrLink].join(' ')}
                data-testid="cli-processes-count"
                role="button"
                tabIndex={0}
                title="Show every Claude CLI process running on the server's machine, with its PID, age, CPU and memory"
                onClick={() => setShowProcesses(true)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowProcesses(true); } }}
              >
                {liveProcesses ?? '-'}
              </span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoLabel} title="Id of the conversation this panel is in. Empty until the CLI reports one (a new chat has none until its first turn).">Session</span>
              {sessionId
                ? <CopyableValue value={sessionId} copied={copiedKey === 'session'} onCopy={() => copyText(sessionId, 'session')} className={[styles.infoValue, styles.addrLink].join(' ')} testId="session-id" />
                : <span className={styles.infoValue} data-testid="session-id">(no session yet)</span>}
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoLabel} title="Transcript file the CLI stores this conversation in">Transcript</span>
              {sessionPath
                ? <CopyableValue value={sessionPath} copied={copiedKey === 'path'} onCopy={() => copyText(sessionPath, 'path')} className={[styles.infoValue, styles.addrLink].join(' ')} testId="session-path" />
                : <span className={styles.infoValue} data-testid="session-path">-</span>}
            </div>
            <div className={styles.settingColumn}>
              <span className={styles.fieldHint}>
                Force-stops every Claude Code CLI process on this machine (all workspaces and terminals) - not just this panel's session.
              </span>
              <button
                className={[styles.dangerBtn, killArmed ? styles.dangerBtnArmed : ''].filter(Boolean).join(' ')}
                onClick={handleKillAll}
                disabled={killing}
                data-testid="kill-all-claude"
                title="Force-terminates every Claude Code CLI process on this machine"
              >
                {killing ? 'Stopping...' : killArmed ? 'Click again to confirm' : 'Stop all Claude CLI processes'}
              </button>
              {killResult && (
                <span className={killResult.error ? styles.fieldHintError : styles.fieldHint} data-testid="kill-all-claude-result">
                  {killResult.error
                    ? `Failed to stop processes: ${killResult.error}`
                    : killResult.count === 0
                      ? 'No Claude CLI processes were running.'
                      : `Stopped ${plural(killResult.count, 'process', 'processes')}.`}
                </span>
              )}
              <span className={styles.fieldHint}>
                Shuts down the Argus daemon serving this panel, the same as running yarn daemon:stop. Every panel on it disconnects and any running turn ends.
              </span>
              <button
                className={[styles.dangerBtn, stopArmed ? styles.dangerBtnArmed : ''].filter(Boolean).join(' ')}
                onClick={handleStopDaemon}
                disabled={stopping}
                data-testid="stop-daemon"
                title="Stops the daemon process serving this panel"
              >
                {stopping ? 'Stopping...' : stopArmed ? 'Click again to confirm' : 'Stop daemon'}
              </button>
              {stopResult !== null && (
                <span className={styles.fieldHint} data-testid="stop-daemon-result">
                  {stopResult
                    ? 'Daemon stopped. Reconnect to start it again.'
                    : 'This server is not a daemon - nothing to stop.'}
                </span>
              )}
            </div>
          </div>
        )}
        </div>
        {hasDevHarness && (
          <button
            className={styles.devCorner}
            onClick={() => window.dispatchEvent(new Event('devharness-toggle'))}
            aria-label="Toggle debug panel"
            title="Toggle debug panel"
          >
            dev
          </button>
        )}
        <button
          className={styles.resetCorner}
          onClick={handleClearLayout}
          aria-label="Reset dialog layout"
          title="Forget the saved position, size, and tab of all dialogs"
        >
          {layoutCleared ? 'Layout reset' : 'Reset layout'}
        </button>
      </div>
      {showProcesses && <CliProcessesModal onClose={() => setShowProcesses(false)} />}
    </>
  );
}
