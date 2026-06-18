import React, { useCallback, useRef, useState } from 'react';

/**
 * Makes a centered modal draggable by a handle (its header). Returns a pointer-down
 * handler to attach to the handle and an inline style for the modal element.
 *
 * Until the first drag the modal keeps its CSS centering (transform: translate);
 * once dragged it switches to explicit top/left (transform: none). Width/height set
 * by a native CSS `resize` grabber are preserved, since this only touches position.
 */
export function useDraggable(ref: React.RefObject<HTMLElement>) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

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
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [ref]);

  const style: React.CSSProperties | undefined = pos
    ? { top: pos.y, left: pos.x, transform: 'none' }
    : undefined;

  return { pos, setPos, onPointerDown, style };
}
