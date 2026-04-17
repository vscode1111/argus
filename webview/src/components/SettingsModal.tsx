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
}

export function SettingsModal({ onClose, workspacePath }: Props) {
  const { verboseTools, showTimer, showOutput, showLogs, soundOnComplete, setVerboseTools, setShowTimer, setShowOutput, setShowLogs, setSoundOnComplete } = useSettings();
  const [infoOpen, setInfoOpen] = useState(false);

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
        <button
          className={styles.infoCorner}
          onClick={() => setInfoOpen(true)}
          aria-label="Workspace info"
          title="Workspace info"
        >
          ℹ
        </button>
      </div>
      {infoOpen && <InfoModal workspacePath={workspacePath} onClose={() => setInfoOpen(false)} />}
    </>
  );
}
