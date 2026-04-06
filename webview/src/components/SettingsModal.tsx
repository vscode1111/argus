import React, { useEffect, useState } from 'react';
import { useSettings } from '../contexts/SettingsContext';
import { InfoModal } from './InfoModal';

interface ToggleProps {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function Toggle({ id, checked, onChange }: ToggleProps) {
  return (
    <span className="toggle">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true" />
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
      <div className="settings-overlay" onClick={onClose} aria-hidden="true" />
      <div className="settings-dropdown" role="dialog" aria-label="Settings">
        <label className="setting-row" htmlFor="toggle-verbose">
          <span className="setting-label">Verbose tools</span>
          <Toggle id="toggle-verbose" checked={verboseTools} onChange={setVerboseTools} />
        </label>
        <label className="setting-row" htmlFor="toggle-timer">
          <span className="setting-label">Show timer</span>
          <Toggle id="toggle-timer" checked={showTimer} onChange={setShowTimer} />
        </label>
        <label className="setting-row" htmlFor="toggle-output">
          <span className="setting-label">Show output</span>
          <Toggle id="toggle-output" checked={showOutput} onChange={setShowOutput} />
        </label>
        <button
          className="settings-info-corner"
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
