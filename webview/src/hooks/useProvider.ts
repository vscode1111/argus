import { useState } from 'react';
import type { ProviderDescriptor } from '../../../src/shared/provider';
import { useWebviewMessage } from './useWebviewMessage';
import { postMessage } from '../vscode';

export function useProvider(providerId: string): ProviderDescriptor | undefined {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  useWebviewMessage(e => {
    if (e.data?.type === 'providers' && Array.isArray(e.data.providers)) setProviders(e.data.providers);
  }, () => postMessage({ type: 'getProviders' }));
  return providers.find(p => p.id === providerId);
}
