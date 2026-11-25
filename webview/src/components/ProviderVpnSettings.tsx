import React, { useEffect, useRef, useState } from 'react';
import { providerVpnSetting, type ProviderVpnCheck, type ProviderVpnProfile, type VpnProvider } from '../../../src/shared/providerVpn';
import { useSettings } from '../contexts/SettingsContext';
import { postMessage } from '../vscode';
import styles from './SettingsModal.module.css';

function ProviderRoute({ provider, label, profiles }: { provider: VpnProvider; label: string; profiles: ProviderVpnProfile[] }) {
  const settings = useSettings();
  const key = providerVpnSetting[provider];
  const storedMode = settings[key];
  const mode = typeof storedMode === 'string' ? storedMode : 'unavailable';
  const modeAvailable = mode === 'normal' || profiles.some(profile => profile.id === mode);
  const [result, setResult] = useState<ProviderVpnCheck>();
  const [checking, setChecking] = useState(false);
  const request = useRef<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.data?.type !== 'providerVpnCheck' || !request.current || event.data.requestId !== request.current) return;
      request.current = undefined;
      clearTimeout(timer.current);
      setChecking(false);
      setResult(event.data.result);
    }
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      clearTimeout(timer.current);
    };
  }, []);

  function check() {
    request.current = crypto.randomUUID?.() ?? String(Math.random());
    setChecking(true);
    setTimedOut(false);
    setResult(undefined);
    postMessage({ type: 'checkProviderVpn', provider, requestId: request.current });
    timer.current = setTimeout(() => {
      request.current = undefined;
      setChecking(false);
      setTimedOut(true);
    }, 15_000);
  }

  return (
    <div className={styles.settingColumn}>
      <label className={styles.settingLabel} htmlFor={key}>{label}</label>
      <div className={styles.routeControls}>
        <select className={styles.routeSelect} id={key} value={mode} onChange={event => {
          const selected = event.currentTarget.value;
          if (selected === 'normal' || profiles.some(profile => profile.id === selected)) settings.update({ [key]: selected });
          setResult(undefined);
          setTimedOut(false);
        }}>
          <option value="normal">Normal route</option>
          {!modeAvailable && <option value={mode} disabled>Selected route unavailable</option>}
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
        </select>
        <button className={styles.restartBtn} type="button" aria-label={`Check ${label} route`} onClick={check} disabled={checking}>Check</button>
      </div>
      <div role="status">
        {checking && 'Checking route…'}
        {timedOut && 'No reply from the Argus server.'}
        {result?.mode === mode && (
          <>
            <div>{result.exitIp ? `Observed exit IP ${result.exitIp}` : 'Exit IP unavailable'}</div>
            {result.error && <div>{result.error}</div>}
            <div>{result.apiStatus ? `Provider endpoint responded (HTTP ${result.apiStatus})` : result.apiError}</div>
            <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString()}</time>
          </>
        )}
      </div>
    </div>
  );
}

export function ProviderVpnSettings() {
  const [profiles, setProfiles] = useState<ProviderVpnProfile[]>([]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.data?.type === 'providerVpnProfiles' && Array.isArray(event.data.profiles)) setProfiles(event.data.profiles);
    }
    window.addEventListener('message', receive);
    postMessage({ type: 'getProviderVpnProfiles' });
    return () => window.removeEventListener('message', receive);
  }, []);

  return (
    <div className={styles.tabContent}>
      <ProviderRoute provider="claude" label="Claude Code" profiles={profiles} />
      <ProviderRoute provider="codex" label="Codex" profiles={profiles} />
      <div className={styles.settingColumn}>
        <span className={styles.fieldHint}>Route changes apply to the next turn. Protected routes require server-side network isolation.</span>
      </div>
    </div>
  );
}
