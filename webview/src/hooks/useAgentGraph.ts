import { useCallback, useEffect, useRef, useState } from 'react';
import { postMessage } from '../vscode';
import type { AgentGraphService } from '../../../src/backend/agentGraphRequests';

// The accepted wire projection remains owned by the backend graph service.
export type GraphSnapshot = ReturnType<AgentGraphService['filter']>;
export type GraphNode = GraphSnapshot['nodes'][number];
export interface GraphView { snapshot: GraphSnapshot | null; loading: boolean; error: string; refresh(): void }
let requestSequence = 0;
export function useAgentGraph(connected: boolean): GraphView {
  const [view, setView] = useState<Omit<GraphView, 'refresh'>>({ snapshot: null, loading: true, error: '' });
  const refreshRef = useRef(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    let current: GraphSnapshot | null = null, pending = '', timeout: number | undefined, online = connected;
    setView({ snapshot: null, loading: connected, error: '' });
    if (!connected) return;
    const request = () => {
      if (!online) return;
      current = null; pending = `graph-${++requestSequence}`;
      setView({ snapshot: null, loading: true, error: '' }); window.clearTimeout(timeout);
      timeout = window.setTimeout(() => { pending = ''; setView({ snapshot: null, loading: false, error: 'Linked sessions are unavailable. Try again.' }); }, 5000);
      postMessage({ type: 'getAgentGraph', requestId: pending, subscribe: true });
    };
    refreshRef.current = request;
    const receive = ({ data: message }: MessageEvent) => {
      // Connection transitions can be batched into one React render.
      if (message?.type === 'ws_status') {
        if (!message.connected) { online = false; current = null; pending = ''; window.clearTimeout(timeout); setView({ snapshot: null, loading: false, error: '' }); }
        else if (!online) { online = true; request(); }
        return;
      }
      if (message?.type !== 'agentGraph') return;
      if (message.requestId) {
        if (message.requestId !== pending) return;
        window.clearTimeout(timeout); pending = '';
        const value = message.snapshot as GraphSnapshot | undefined;
        if (message.ok === false || !value?.revision || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.scopes)) {
          setView({ snapshot: null, loading: false, error: 'Linked sessions are unavailable. Try again.' }); return;
        }
        current = value;
      } else {
        if (pending) return;
        if (message.ok === false) { if (message.error?.code === 'graph_refresh_failed' && current) { request(); return; } current = null; setView({ snapshot: null, loading: false, error: 'Linked sessions are unavailable. Try again.' }); return; }
        if (!current) return;
        const { baseRevision: base, revision } = message;
        if (revision?.epoch === current.revision.epoch && revision.seq <= current.revision.seq) return;
        if (!revision || base?.epoch !== current.revision.epoch || base.seq !== current.revision.seq) { request(); return; }
        const next = { ...current, revision };
        for (const key of ['nodes', 'edges', 'scopes'] as const) {
          const values = message.upsert?.[key], removed = message.remove?.[key];
          if (!Array.isArray(values) || !Array.isArray(removed)) { request(); return; }
          const identity = (v: { id?: string; company?: string; goal?: string }) => v.id ?? JSON.stringify([v.company, v.goal]);
          const entries = new Map<string, unknown>(current[key].map(v => [identity(v), v]));
          for (const id of removed) entries.delete(id);
          for (const value of values) entries.set(identity(value), value);
          // Each collection retains its existing backend wire type.
          Object.assign(next, { [key]: [...entries.values()] });
        }
        current = next;
      }
      setView({ snapshot: current, loading: false, error: '' });
    };
    window.addEventListener('message', receive); request();
    return () => { pending = ''; refreshRef.current = () => {}; window.clearTimeout(timeout); window.removeEventListener('message', receive); };
  }, [connected]);
  return { ...view, refresh };
}
