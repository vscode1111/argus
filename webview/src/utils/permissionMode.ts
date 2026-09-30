export type Mode = 'plan' | 'edit' | 'full-access';

export function permissionModeKey(providerId: string): string {
  return providerId === 'codex' ? 'argus.codexPermissionMode' : 'argus.claudePermissionMode';
}

export function savedMode(providerId: string): Mode {
  try {
    const value = localStorage.getItem(permissionModeKey(providerId));
    if (value === 'plan' || value === 'edit' || value === 'full-access') return value;
  } catch {}
  return 'full-access';
}
