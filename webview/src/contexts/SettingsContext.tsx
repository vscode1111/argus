import React, { createContext, useContext, useState } from 'react';

interface SettingsContextValue {
  verboseTools: boolean;
  showTimer: boolean;
  setVerboseTools: (v: boolean) => void;
  setShowTimer: (v: boolean) => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  verboseTools: false,
  showTimer: true,
  setVerboseTools: () => {},
  setShowTimer: () => {},
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

  function setVerboseTools(v: boolean) {
    setVerboseToolsState(v);
    try { localStorage.setItem('argus.verboseTools', String(v)); } catch {}
  }

  function setShowTimer(v: boolean) {
    setShowTimerState(v);
    try { localStorage.setItem('argus.showTimer', String(v)); } catch {}
  }

  return (
    <SettingsContext.Provider value={{ verboseTools, showTimer, setVerboseTools, setShowTimer }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
