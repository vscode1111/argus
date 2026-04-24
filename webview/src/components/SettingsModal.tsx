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
  const { verboseTools, showTimer, showOutput, showLogs, soundOnComplete, notifyOnComplete, setVerboseTools, setShowTimer, setShowOutput, setShowLogs, setSoundOnComplete, setNotifyOnComplete } = useSettings();
  const [infoOpen, setInfoOpen] = useState(false);
  const devHarnessEl = document.getElementById('dev-harness');

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
        {devHarnessEl && (
          <button
            className={styles.devCorner}
            onClick={() => {
              const show = devHarnessEl.style.display === 'none';
              devHarnessEl.style.display = show ? '' : 'none';
              document.body.classList.toggle('dev-harness-visible', show);
              try { localStorage.setItem('argus.showDevHarness', String(show)); } catch {}
            }}
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
