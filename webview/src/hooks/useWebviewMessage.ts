import { useEffect, useRef } from 'react';

/**
 * Subscribes to extension -> webview `message` events for the lifetime of the
 * component and optionally runs `onMount` once after subscribing (typically to
 * post the initial request). The latest `handler`/`onMount` are read via refs so
 * the listener is attached exactly once, matching the hand-rolled effects this
 * replaces.
 */
export function useWebviewMessage(
  handler: (e: MessageEvent) => void,
  onMount?: () => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;

  useEffect(() => {
    const listener = (e: MessageEvent) => handlerRef.current(e);
    window.addEventListener('message', listener);
    onMountRef.current?.();
    return () => window.removeEventListener('message', listener);
  }, []);
}
