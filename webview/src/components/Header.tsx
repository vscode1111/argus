import React, { useState } from 'react';
import { postMessage } from '../vscode';
import { SettingsModal } from './SettingsModal';
import styles from './Header.module.css';

interface Props {
  workspacePath: string;
}

export function Header({ workspacePath }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className={styles.header}>
      <span className={styles.title}>Argus</span>
      <div className={styles.headerActions}>
        <button
          className="btn-icon"
          title="Settings"
          aria-label="Settings"
          onClick={() => setSettingsOpen(v => !v)}
        >
          ⚙
        </button>
        <button
          className={styles.btnNewSession}
          title="New session"
          onClick={() => postMessage({ type: 'newSession' })}
        >
          +
        </button>
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} workspacePath={workspacePath} />}
    </div>
  );
}
