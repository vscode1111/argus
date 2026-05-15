import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { postMessage } from '../vscode';
import type { ArgusSettings } from '../types';

const DEFAULTS: ArgusSettings = {
  verboseTools: false,
  showTimer: true,
  showOutput: false,
  showLogs: true,
  showLogTime: true,
  showLogType: true,
  soundOnComplete: true,
  notifyOnComplete: true,
  watchdogEnabled: true,
  watchdogTimeout: 120,
  watchdogAutoRetries: 3,
  watchdogRetryDelay: 5,
  watchdogDelayFactor: 2,
};

interface SettingsContextValue extends ArgusSettings {
  update: (patch: Partial<ArgusSettings>) => void;
  setVerboseTools: (v: boolean) => void;
  setShowTimer: (v: boolean) => void;
  setShowOutput: (v: boolean) => void;
  setShowLogs: (v: boolean) => void;
  setShowLogTime: (v: boolean) => void;
  setShowLogType: (v: boolean) => void;
  setSoundOnComplete: (v: boolean) => void;
  setNotifyOnComplete: (v: boolean) => void;
  setWatchdogEnabled: (v: boolean) => void;
  setWatchdogTimeout: (v: number) => void;
  setWatchdogAutoRetries: (v: number) => void;
  setWatchdogRetryDelay: (v: number) => void;
  setWatchdogDelayFactor: (v: number) => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  ...DEFAULTS,
  update: () => {},
  setVerboseTools: () => {},
  setShowTimer: () => {},
  setShowOutput: () => {},
  setShowLogs: () => {},
  setShowLogTime: () => {},
  setShowLogType: () => {},
  setSoundOnComplete: () => {},
  setNotifyOnComplete: () => {},
  setWatchdogEnabled: () => {},
  setWatchdogTimeout: () => {},
  setWatchdogAutoRetries: () => {},
  setWatchdogRetryDelay: () => {},
  setWatchdogDelayFactor: () => {},
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<ArgusSettings>(DEFAULTS);

  useEffect(() => {
    postMessage({ type: 'getSettings' });
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.data?.type === 'settings' && event.data.settings) {
        setSettings(prev => ({ ...prev, ...event.data.settings }));
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const update = useCallback((patch: Partial<ArgusSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      postMessage({ type: 'updateSettings', settings: patch });
      return next;
    });
  }, []);

  const setVerboseTools = useCallback((v: boolean) => update({ verboseTools: v }), [update]);
  const setShowTimer = useCallback((v: boolean) => update({ showTimer: v }), [update]);
  const setShowOutput = useCallback((v: boolean) => update({ showOutput: v }), [update]);
  const setShowLogs = useCallback((v: boolean) => update({ showLogs: v }), [update]);
  const setShowLogTime = useCallback((v: boolean) => update({ showLogTime: v }), [update]);
  const setShowLogType = useCallback((v: boolean) => update({ showLogType: v }), [update]);
  const setSoundOnComplete = useCallback((v: boolean) => update({ soundOnComplete: v }), [update]);
  const setWatchdogEnabled = useCallback((v: boolean) => update({ watchdogEnabled: v }), [update]);
  const setWatchdogTimeout = useCallback((v: number) => update({ watchdogTimeout: v }), [update]);
  const setWatchdogAutoRetries = useCallback((v: number) => update({ watchdogAutoRetries: v }), [update]);
  const setWatchdogRetryDelay = useCallback((v: number) => update({ watchdogRetryDelay: v }), [update]);
  const setWatchdogDelayFactor = useCallback((v: number) => update({ watchdogDelayFactor: v }), [update]);

  const setNotifyOnComplete = useCallback((v: boolean) => {
    update({ notifyOnComplete: v });
    if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, [update]);

  return (
    <SettingsContext.Provider value={{
      ...settings,
      update,
      setVerboseTools, setShowTimer, setShowOutput, setShowLogs,
      setShowLogTime, setShowLogType, setSoundOnComplete, setNotifyOnComplete,
      setWatchdogEnabled, setWatchdogTimeout, setWatchdogAutoRetries, setWatchdogRetryDelay, setWatchdogDelayFactor,
    }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
