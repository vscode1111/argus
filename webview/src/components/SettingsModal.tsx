import React, { useState, useEffect, useRef } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useDialogGeometry } from '../hooks/useDialogGeometry';
import { clearDialogState } from '../utils/dialogState';
import { useSettings } from '../contexts/SettingsContext';
import { postMessage, isVsCode } from '../vscode';
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

// A random port in 1024-65535 that isn't a well-known/popular one.
function randomPort(): number {
  let p: number;
  do { p = 1024 + Math.floor(Math.random() * (65535 - 1024 + 1)); } while (POPULAR_PORTS.has(p));
  return p;
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

interface Props {
  onClose: () => void;
  workspacePath: string;
  version: string;
}

type Tab = 'general' | 'watchdog' | 'network' | 'info';

export function SettingsModal({ onClose, workspacePath, version }: Props) {
  const { verboseTools, showTimer, showOutput, showLogs, soundOnComplete, notifyOnComplete, watchdogEnabled, watchdogTimeout, watchdogAutoRetries, watchdogRetryDelay, watchdogDelayFactor, allowNetworkAccess, allowedOrigins, setVerboseTools, setShowTimer, setShowOutput, setShowLogs, setSoundOnComplete, setNotifyOnComplete, setWatchdogEnabled, setWatchdogTimeout, setWatchdogAutoRetries, setWatchdogRetryDelay, setWatchdogDelayFactor, setAllowNetworkAccess, setAllowedOrigins, daemonPort, setDaemonPort, daemonIdleMs, setDaemonIdleMs } = useSettings();
  const [activeClients, setActiveClients] = useState<number | null>(null);
  const [serverPort, setServerPort] = useState<number | null>(null);
  const [restarting, setRestarting] = useState(false);
  // Set when the daemon restarts onto a different port and this (browser) tab can't
  // follow it (it is same-origin to the old port) - surfaces a clickable new URL.
  const [movedUrl, setMovedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    postMessage({ type: 'getSettings' });
    postMessage({ type: 'getClientCount' });
    postMessage({ type: 'getServerInfo' });
    // The server also pushes clientCount whenever a connection opens or closes,
    // so this stays live while the modal is open.
    const onMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg && msg.type === 'clientCount' && typeof msg.count === 'number') {
        setActiveClients(msg.count);
      } else if (msg && msg.type === 'serverInfo' && typeof msg.port === 'number') {
        // A fresh connection (incl. after a restart) reports the live port; clear the
        // restart spinner and any "moved" notice once we're talking to the new daemon.
        setServerPort(msg.port);
        setRestarting(false);
        setMovedUrl(null);
      } else if (msg && msg.type === 'daemonRestarting' && typeof msg.port === 'number') {
        setServerPort(msg.port);
        setRestarting(false);
        if (!isVsCode && typeof location !== 'undefined' && String(msg.port) !== location.port) {
          setMovedUrl(msg.url); // this tab can't follow a port change - show the new URL
        }
      } else if (msg && msg.type === 'ws_status' && msg.connected) {
        // After any (re)connect - including the new daemon after a restart - refresh
        // the live port and client count so the address rows reflect the new daemon.
        postMessage({ type: 'getServerInfo' });
        postMessage({ type: 'getClientCount' });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // The Daemon port field configures the *next-restart* port, but on open it should
  // reflect the port the daemon is actually running on (the configured value can be
  // stale - e.g. set then never applied). When the live port arrives via serverInfo,
  // sync the field to it so it shows the real port; randomize/Apply still move it.
  useEffect(() => {
    if (serverPort != null && serverPort !== daemonPort) setDaemonPort(serverPort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverPort]);

  function openExternal(url: string): void {
    postMessage({ type: 'openUrl', url });
    if (!isVsCode && typeof window !== 'undefined') window.open(url, '_blank');
  }
  function copyText(text: string): void {
    try { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* */ }
  }
  function handleRestart(): void {
    setRestarting(true);
    postMessage({ type: 'restartDaemon' });
    // Safety net: drop the spinner if nothing comes back (e.g. dev server no-op).
    setTimeout(() => setRestarting(false), 8000);
  }
  const httpUrl = serverPort ? `http://localhost:${serverPort}` : '';
  const wsUrl = serverPort ? `ws://localhost:${serverPort}/agent` : '';
  const [tab, setTabState] = useState<Tab>(() => (localStorage.getItem('argus.settingsTab') as Tab) || 'general');
  const setTab = (t: Tab) => { setTabState(t); localStorage.setItem('argus.settingsTab', t); };
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

  useEscapeKey(onClose);

  const modalRef = useRef<HTMLDivElement>(null);
  const drag = useDialogGeometry(modalRef, { persistKey: 'settings' });

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
                ? <span className={[styles.clientCountValue, styles.addrLink].join(' ')} data-testid="ws-address" role="button" tabIndex={0} title="Click to copy" onClick={() => copyText(wsUrl)}>{copied ? 'Copied!' : wsUrl}</span>
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
                  onClick={(e) => { e.preventDefault(); setDaemonPort(randomPort()); }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
                    <circle cx="16" cy="16" r="1.4" fill="currentColor" stroke="none" />
                    <circle cx="8" cy="16" r="1.4" fill="currentColor" stroke="none" />
                    <circle cx="16" cy="8" r="1.4" fill="currentColor" stroke="none" />
                  </svg>
                </button>
                <NumberInput id="input-daemon-port" value={daemonPort} onChange={setDaemonPort} min={1} />
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
                <span className={styles.infoLabel}>Version</span>
                <span className={styles.infoValue}>{version}</span>
              </div>
            )}
            <div className={styles.infoRow}>
              <span className={styles.infoLabel}>Path</span>
              <span className={styles.infoValue}>{workspacePath || '(no workspace)'}</span>
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
    </>
  );
}
