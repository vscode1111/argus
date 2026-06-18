import React, { useState, useEffect, useRef } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useDraggable } from '../hooks/useDraggable';
import { useSettings } from '../contexts/SettingsContext';
import { postMessage } from '../vscode';
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

interface Props {
  onClose: () => void;
  workspacePath: string;
  version: string;
}

type Tab = 'general' | 'watchdog' | 'info';

export function SettingsModal({ onClose, workspacePath, version }: Props) {
  const { verboseTools, showTimer, showOutput, showLogs, soundOnComplete, notifyOnComplete, watchdogEnabled, watchdogTimeout, watchdogAutoRetries, watchdogRetryDelay, watchdogDelayFactor, setVerboseTools, setShowTimer, setShowOutput, setShowLogs, setSoundOnComplete, setNotifyOnComplete, setWatchdogEnabled, setWatchdogTimeout, setWatchdogAutoRetries, setWatchdogRetryDelay, setWatchdogDelayFactor } = useSettings();
  useEffect(() => { postMessage({ type: 'getSettings' }); }, []);
  const [tab, setTabState] = useState<Tab>(() => (localStorage.getItem('argus.settingsTab') as Tab) || 'general');
  const setTab = (t: Tab) => { setTabState(t); localStorage.setItem('argus.settingsTab', t); };
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
  const drag = useDraggable(modalRef);

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
            {notifyOnComplete && hasNotificationAPI && notifPerm === 'default' && (
              <div className={styles.settingRow} style={{ paddingTop: 0 }}>
                <button className={styles.grantBtn} onClick={handleGrantNotifications}>
                  Grant permission
                </button>
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
      </div>
    </>
  );
}
