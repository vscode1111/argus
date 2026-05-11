import React, { useState } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useSettings } from '../contexts/SettingsContext';
import { InfoModal } from './InfoModal';
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

interface Props {
  onClose: () => void;
  workspacePath: string;
  version: string;
}

export function SettingsModal({ onClose, workspacePath, version }: Props) {
  const { verboseTools, showTimer, showOutput, showLogs, soundOnComplete, notifyOnComplete, watchdogTimeout, setVerboseTools, setShowTimer, setShowOutput, setShowLogs, setSoundOnComplete, setNotifyOnComplete, setWatchdogTimeout } = useSettings();
  const [infoOpen, setInfoOpen] = useState(false);
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

  return (
    <>
      <div className={styles.overlay} onClick={onClose} aria-hidden="true" />
      <div className={styles.dropdown} role="dialog" aria-label="Settings">
        <label className={styles.settingRow} htmlFor="toggle-verbose">
          <span className={styles.settingLabel}>Verbose tools</span>
          <Toggle id="toggle-verbose" checked={verboseTools} onChange={setVerboseTools} />
        </label>
        <label className={styles.settingRow} htmlFor="toggle-timer">
          <span className={styles.settingLabel}>Show timer</span>
          <Toggle id="toggle-timer" checked={showTimer} onChange={setShowTimer} />
        </label>
        <label className={styles.settingRow} htmlFor="toggle-output">
          <span className={styles.settingLabel}>Show output</span>
          <Toggle id="toggle-output" checked={showOutput} onChange={setShowOutput} />
        </label>
        <label className={styles.settingRow} htmlFor="toggle-logs">
          <span className={styles.settingLabel}>Show logs</span>
          <Toggle id="toggle-logs" checked={showLogs} onChange={setShowLogs} />
        </label>
        <label className={styles.settingRow} htmlFor="toggle-sound">
          <span className={styles.settingLabel}>Sound on complete</span>
          <Toggle id="toggle-sound" checked={soundOnComplete} onChange={setSoundOnComplete} />
        </label>
        <label className={styles.settingRow} htmlFor="toggle-notify">
          <span className={styles.settingLabel}>Notify on complete</span>
          <Toggle id="toggle-notify" checked={notifyOnComplete} onChange={setNotifyOnComplete} />
        </label>
        {notifyOnComplete && hasNotificationAPI && notifPerm !== 'granted' && (
          <div className={styles.settingRow} style={{ paddingTop: 0 }}>
            {notifPerm === 'default' && (
              <button className={styles.grantBtn} onClick={handleGrantNotifications}>
                Grant permission
              </button>
            )}
            {notifPerm === 'denied' && (
              <span className={styles.permDenied}>Blocked in browser settings</span>
            )}
          </div>
        )}
        <label className={styles.settingRow} htmlFor="input-watchdog">
          <span className={styles.settingLabel}>Watchdog timeout</span>
          <input
            id="input-watchdog"
            type="number"
            className={styles.numberInput}
            min={10}
            max={600}
            value={watchdogTimeout}
            onChange={e => {
              const v = Math.max(10, Math.min(600, parseInt(e.target.value) || 120));
              setWatchdogTimeout(v);
            }}
          />
          <span className={styles.settingUnit}>s</span>
        </label>
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
          className={styles.infoCorner}
          onClick={() => setInfoOpen(true)}
          aria-label="Workspace info"
          title="Workspace info"
        >
          info
        </button>
      </div>
      {infoOpen && <InfoModal workspacePath={workspacePath} version={version} onClose={() => setInfoOpen(false)} />}
    </>
  );
}
