import React, { useEffect, useState } from 'react';
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
  const { verboseTools, showTimer, showOutput, setVerboseTools, setShowTimer, setShowOutput } = useSettings();
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
