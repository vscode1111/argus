// In-memory geometry/tab store for dialogs. Module-level, so a dialog reopens
// where it was left (position, size, selected tab) while the page lives, but
// everything resets on a full page refresh because the module is re-evaluated.
// Intentionally NOT sessionStorage/localStorage, which would survive a refresh.

export interface DialogState {
  pos?: { x: number; y: number };
  size?: { w: number; h: number };
  tab?: string;
}

const store = new Map<string, DialogState>();

export function getDialogState(key: string): DialogState | undefined {
  return store.get(key);
}

export function patchDialogState(key: string, patch: Partial<DialogState>): void {
  store.set(key, { ...store.get(key), ...patch });
}
