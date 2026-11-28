import { useEffect, useRef } from 'react';

const handlers: Array<{ handler: { current: () => void }; fallback: boolean }> = [];

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const entry = handlers[handlers.length - 1];
  if (entry?.fallback && (e.defaultPrevented || e.repeat || e.isComposing)) return;
  entry?.handler.current();
}

export function useEscapeKey(onClose: () => void, { fallback = false, enabled = true } = {}): void {
  const handler = useRef(onClose);
  handler.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    const entry = { handler, fallback };
    if (fallback) handlers.unshift(entry);
    else handlers.push(entry);
    if (handlers.length === 1) window.addEventListener('keydown', onKey);
    return () => {
      const index = handlers.indexOf(entry);
      if (index >= 0) handlers.splice(index, 1);
      if (handlers.length === 0) window.removeEventListener('keydown', onKey);
    };
  }, [enabled, fallback]);
}
