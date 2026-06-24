import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { getDialogState, patchDialogState } from '../utils/dialogState';

interface Options {
  // When set, the dialog's position and size are remembered (in-memory, reset on
  // page refresh) under this key, so closing and reopening restores both.
  persistKey?: string;
  // Default width applied when no size has been persisted yet.
  defaultWidth?: number;
  // Apply the tall fixed height when no size has been persisted yet.
  fullHeight?: boolean;
}

/**
 * Makes a centered modal draggable by a handle (its header) and, optionally,
 * remembers its position and size across open/close via the in-memory dialog
 * store (`persistKey`).
 *
 * Until the first drag the modal keeps its CSS centering (transform: translate);
 * once dragged it switches to explicit top/left (transform: none). Size is
 * applied imperatively to the element (not through React's controlled style) so
 * the native CSS `resize` grabber owns width/height afterwards without React
 * resetting it on re-render; a ResizeObserver records the user's resizes.
 */
export function useDialogGeometry(ref: React.RefObject<HTMLElement>, opts: Options = {}) {
  const { persistKey, defaultWidth, fullHeight } = opts;
  const saved = persistKey ? getDialogState(persistKey) : undefined;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(saved?.pos ?? null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (saved?.size) {
      el.style.boxSizing = 'border-box';
      el.style.width = `${saved.size.w}px`;
      el.style.height = `${saved.size.h}px`;
    } else {
      if (defaultWidth) el.style.width = `${defaultWidth}px`;
      if (fullHeight) el.style.height = 'calc(100vh - 64px)';
    }
    if (!persistKey) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const e = ref.current;
        if (e) patchDialogState(persistKey, { size: { w: e.offsetWidth, h: e.offsetHeight } });
      });
    });
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Ignore drags that start on interactive controls inside the handle.
    if ((e.target as HTMLElement).closest('button, input, textarea, select, a')) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      const el = ref.current;
      if (!d || !el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const x = Math.min(Math.max(0, ev.clientX - d.dx), window.innerWidth - w);
      const y = Math.min(Math.max(0, ev.clientY - d.dy), window.innerHeight - h);
      setPos({ x, y });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const el = ref.current;
      if (persistKey && el) {
        const r = el.getBoundingClientRect();
        patchDialogState(persistKey, { pos: { x: r.left, y: r.top } });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [ref, persistKey]);

  const style: React.CSSProperties | undefined = pos
    ? { top: pos.y, left: pos.x, transform: 'none' }
    : undefined;

  return { pos, setPos, onPointerDown, style };
}
