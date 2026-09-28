import React, { useState } from 'react';
import { postMessage } from '../vscode';
import { useWebviewMessage } from '../hooks/useWebviewMessage';
import type { ProviderDescriptor } from '../../../src/shared/provider';
import styles from './ProviderSelector.module.css';

export function ProviderSelector({ providerId }: { providerId: string }) {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  useWebviewMessage(e => {
    if (e.data?.type === 'providers' && Array.isArray(e.data.providers)) setProviders(e.data.providers);
  }, () => postMessage({ type: 'getProviders' }));
  return <div className={styles.row}>
    <label>Provider <span className={styles.selectWrap}>
      <select aria-label="Provider" value={providerId} onChange={e => postMessage({ type: 'switchProvider', providerId: e.target.value })}>
        {providers.length ? providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>) : <option value={providerId}>{providerId}</option>}
      </select>
      <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden="true"><path d="m2 4 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
    </span></label>
    <span className={styles.hint}>Switching provider opens a new conversation. Your selection is saved for future conversations.</span>
  </div>;
}
