import { useEffect, useRef } from 'react';

const handlers: Array<{ current: () => void }> = [];

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') handlers[handlers.length - 1]?.current();
}

export function useEscapeKey(onClose: () => void): void {
  const handler = useRef(onClose);
  handler.current = onClose;
  useEffect(() => {
    handlers.push(handler);
    if (handlers.length === 1) window.addEventListener('keydown', onKey);
    return () => {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
      if (handlers.length === 0) window.removeEventListener('keydown', onKey);
    };
  }, []);
}
