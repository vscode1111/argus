export type ProviderVpnMode = string;
export type VpnProvider = 'claude' | 'codex';

export interface ProviderVpnProfile {
  id: string;
  label: string;
}

export const providerVpnSetting = {
  claude: 'claudeVpnMode',
  codex: 'codexVpnMode',
} as const;

export interface ProviderVpnCheck {
  provider: VpnProvider;
  mode: ProviderVpnMode;
  checkedAt: string;
  exitIp?: string;
  apiStatus?: number;
  error?: string;
  apiError?: string;
}
