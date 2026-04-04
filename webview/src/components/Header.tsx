import React, { useState } from 'react';
import { postMessage } from '../vscode';
import { SettingsModal } from './SettingsModal';

export function Header() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div id="header">
      <span className="title">Argus</span>
      <div className="header-actions">
        <button
          className="btn-icon"
          title="Settings"
          aria-label="Settings"
          onClick={() => setSettingsOpen(v => !v)}
        >
          ⚙
        </button>
        <button
          id="btn-new-session"
          title="New session"
          onClick={() => postMessage({ type: 'newSession' })}
        >
          +
        </button>
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
