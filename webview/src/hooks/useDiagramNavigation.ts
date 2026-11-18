import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Point } from '../utils/agentLayout';

const MIN_ZOOM = 0.08, MAX_ZOOM = 3, PAN_STEP = 60;
interface Camera extends Point { scale: number }
export function useDiagramNavigation(points: Point[]) {
  const svg = useRef<SVGSVGElement>(null), pointers = useRef(new Map<number, Point>()), dragged = useRef(false);
  const gestureStart = useRef<Point>({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 800, height: 500 }), [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const initialized = useRef(false);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const zoom = useCallback((factor: number, at?: Point, shift: Point = { x: 0, y: 0 }) => setCamera(c => {
    const scale = Math.max(Math.min(MIN_ZOOM, c.scale), Math.min(MAX_ZOOM, c.scale * factor)), ratio = scale / c.scale, origin = at ?? { x: size.width / 2, y: size.height / 2 };
    return { scale, x: origin.x - (origin.x - c.x) * ratio + shift.x, y: origin.y - (origin.y - c.y) * ratio + shift.y };
  }), [size]);
  const fit = useCallback(() => {
    if (!points.length) return;
    const left = Math.min(...points.map(p => p.x)) - 160, top = Math.min(...points.map(p => p.y)) - 120;
    const width = Math.max(...points.map(p => p.x)) + 160 - left, height = Math.max(...points.map(p => p.y)) + 120 - top;
    const scale = Math.min(1, size.width / width, size.height / height);
    setCamera({ scale, x: (size.width - width * scale) / 2 - left * scale, y: (size.height - height * scale) / 2 - top * scale });
  }, [points, size]);
  useEffect(() => { if (!initialized.current && points.length && size.width > 0) { fit(); initialized.current = true; } }, [fit, points, size]);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); const rect = element.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top }); };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, [zoom]);
  const focus = useCallback((point: Point) => setCamera({ scale: 1, x: size.width / 2 - point.x, y: size.height / 2 - point.y }), [size]);
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    // Node activation and page shortcuts retain their own handlers.
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const moves: Record<string, Point> = { ArrowLeft: { x: PAN_STEP, y: 0 }, ArrowRight: { x: -PAN_STEP, y: 0 }, ArrowUp: { x: 0, y: PAN_STEP }, ArrowDown: { x: 0, y: -PAN_STEP } };
    if (moves[event.key]) setCamera(c => ({ ...c, x: c.x + moves[event.key].x, y: c.y + moves[event.key].y }));
    else if (event.key === '+' || event.key === '=') zoom(1.25);
    else if (event.key === '-') zoom(0.8);
    else if (event.key === '0') fit(); else return;
    event.preventDefault();
  };
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    if (!pointers.current.size) { dragged.current = false; gestureStart.current = { x: event.clientX, y: event.clientY }; }
    else dragged.current = true;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // Keep clicks on focusable nodes directed to that node, even with capture.
    const capture = event.target instanceof Element ? event.target.closest('[data-node-id]') ?? event.currentTarget : event.currentTarget;
    if (event.isTrusted) capture.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const prior = pointers.current.get(event.pointerId);
    if (!prior) return;
    const next = { x: event.clientX, y: event.clientY }, other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
    if (other) {
      const before = Math.hypot(prior.x - other.x, prior.y - other.y), after = Math.hypot(next.x - other.x, next.y - other.y), rect = event.currentTarget.getBoundingClientRect();
      if (before > 0) zoom(after / before, { x: (prior.x + other.x) / 2 - rect.left, y: (prior.y + other.y) / 2 - rect.top }, { x: (next.x - prior.x) / 2, y: (next.y - prior.y) / 2 });
    } else setCamera(c => ({ ...c, x: c.x + next.x - prior.x, y: c.y + next.y - prior.y }));
    if (Math.hypot(next.x - gestureStart.current.x, next.y - gestureStart.current.y) > 4) dragged.current = true;
    pointers.current.set(event.pointerId, next);
  };
  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => { pointers.current.delete(event.pointerId); };
  return { svg, camera, zoom, fit, focus, dragged, events: { onKeyDown, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onLostPointerCapture: onPointerUp } };
}
