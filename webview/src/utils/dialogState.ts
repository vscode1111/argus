// Per-dialog geometry/tab store for centered dialogs. Persisted to localStorage
// so a dialog reopens where it was left (position, size, selected tab) and the
// layout survives a full page refresh. Cleared on demand via clearDialogState()
// (the Settings "Reset layout" button).

export interface DialogState {
  pos?: { x: number; y: number };
  size?: { w: number; h: number };
  tab?: string;
}

const STORAGE_KEY = 'argus.dialogState';

function readStore(): Record<string, DialogState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, DialogState>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore quota errors / unavailable storage; geometry is non-critical.
  }
}

export function getDialogState(key: string): DialogState | undefined {
  return readStore()[key];
}

export function patchDialogState(key: string, patch: Partial<DialogState>): void {
  const store = readStore();
  store[key] = { ...store[key], ...patch };
  writeStore(store);
}

export function clearDialogState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}
