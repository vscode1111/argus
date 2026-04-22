import React, { createContext, useContext, useState } from 'react';

interface SettingsContextValue {
  verboseTools: boolean;
  showTimer: boolean;
  showOutput: boolean;
  showLogs: boolean;
  showLogTime: boolean;
  showLogType: boolean;
  soundOnComplete: boolean;
  notifyOnComplete: boolean;
  setVerboseTools: (v: boolean) => void;
  setShowTimer: (v: boolean) => void;
  setShowOutput: (v: boolean) => void;
  setShowLogs: (v: boolean) => void;
  setShowLogTime: (v: boolean) => void;
  setShowLogType: (v: boolean) => void;
  setSoundOnComplete: (v: boolean) => void;
  setNotifyOnComplete: (v: boolean) => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  verboseTools: false,
  showTimer: true,
  showOutput: false,
  showLogs: true,
  showLogTime: true,
  showLogType: true,
  soundOnComplete: true,
  notifyOnComplete: true,
  setVerboseTools: () => {},
  setShowTimer: () => {},
  setShowOutput: () => {},
  setShowLogs: () => {},
  setShowLogTime: () => {},
  setShowLogType: () => {},
  setSoundOnComplete: () => {},
  setNotifyOnComplete: () => {},
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
  const [showOutput, setShowOutputState] = useState(() => readBool('argus.showOutput', false));
  const [showLogs, setShowLogsState] = useState(() => readBool('argus.showLogs', true));
  const [showLogTime, setShowLogTimeState] = useState(() => readBool('argus.showLogTime', true));
  const [showLogType, setShowLogTypeState] = useState(() => readBool('argus.showLogType', true));
  const [soundOnComplete, setSoundOnCompleteState] = useState(() => readBool('argus.soundOnComplete', true));
  const [notifyOnComplete, setNotifyOnCompleteState] = useState(() => readBool('argus.notifyOnComplete', true));

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

  function setShowLogTime(v: boolean) {
    setShowLogTimeState(v);
    try { localStorage.setItem('argus.showLogTime', String(v)); } catch {}
  }

  function setShowLogType(v: boolean) {
    setShowLogTypeState(v);
    try { localStorage.setItem('argus.showLogType', String(v)); } catch {}
  }

  function setSoundOnComplete(v: boolean) {
    setSoundOnCompleteState(v);
    try { localStorage.setItem('argus.soundOnComplete', String(v)); } catch {}
  }

  function setNotifyOnComplete(v: boolean) {
    setNotifyOnCompleteState(v);
    try { localStorage.setItem('argus.notifyOnComplete', String(v)); } catch {}
    if (v && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  return (
    <SettingsContext.Provider value={{ verboseTools, showTimer, showOutput, showLogs, showLogTime, showLogType, soundOnComplete, notifyOnComplete, setVerboseTools, setShowTimer, setShowOutput, setShowLogs, setShowLogTime, setShowLogType, setSoundOnComplete, setNotifyOnComplete }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
