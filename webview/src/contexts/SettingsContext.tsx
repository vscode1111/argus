import React, { createContext, useContext, useState } from 'react';

interface SettingsContextValue {
  verboseTools: boolean;
  showTimer: boolean;
  showOutput: boolean;
  showLogs: boolean;
  setVerboseTools: (v: boolean) => void;
  setShowTimer: (v: boolean) => void;
  setShowOutput: (v: boolean) => void;
  setShowLogs: (v: boolean) => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  verboseTools: false,
  showTimer: true,
  showOutput: true,
  showLogs: false,
  setVerboseTools: () => {},
  setShowTimer: () => {},
  setShowOutput: () => {},
  setShowLogs: () => {},
});

function readBool(key: string, defaultVal: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? defaultVal : stored === 'true';
  } catch {
    return defaultVal;
  }
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [verboseTools, setVerboseToolsState] = useState(() => readBool('argus.verboseTools', false));
  const [showTimer, setShowTimerState] = useState(() => readBool('argus.showTimer', true));
  const [showOutput, setShowOutputState] = useState(() => readBool('argus.showOutput', true));
  const [showLogs, setShowLogsState] = useState(() => readBool('argus.showLogs', false));

  function setVerboseTools(v: boolean) {
    setVerboseToolsState(v);
    try { localStorage.setItem('argus.verboseTools', String(v)); } catch {}
  }

  function setShowTimer(v: boolean) {
    setShowTimerState(v);
    try { localStorage.setItem('argus.showTimer', String(v)); } catch {}
  }

  function setShowOutput(v: boolean) {
    setShowOutputState(v);
    try { localStorage.setItem('argus.showOutput', String(v)); } catch {}
  }

  function setShowLogs(v: boolean) {
    setShowLogsState(v);
    try { localStorage.setItem('argus.showLogs', String(v)); } catch {}
  }

  return (
    <SettingsContext.Provider value={{ verboseTools, showTimer, showOutput, showLogs, setVerboseTools, setShowTimer, setShowOutput, setShowLogs }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
