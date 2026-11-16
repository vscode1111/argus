import type { WebSocket } from 'ws';
import { sessionJournal, type JournalCursor } from './sessionJournal';

const pending = new WeakMap<WebSocket, AbortController>();
export async function watchSession(ws: WebSocket, message: Record<string, unknown>): Promise<void> {
  const requestId = typeof message.requestId === 'string' && message.requestId.length <= 128 ? message.requestId : undefined;
  const reply = (value: object) => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > 1024 * 1024) { ws.close(1009, 'Observation client is too slow'); return; }
    ws.send(JSON.stringify({ type: 'sessionEvents', requestId, ...value }));
  };
  let abort: AbortController | undefined;
  try {
    if (typeof requestId !== 'string' || requestId.length > 128 || typeof message.sessionId !== 'string'
      || !/^[a-zA-Z0-9:_-]{1,160}$/.test(message.sessionId) || message.full !== undefined && typeof message.full !== 'boolean'
      || message.wait !== undefined && (typeof message.wait !== 'number' || !Number.isFinite(message.wait) || message.wait < 0 || message.wait > 30)
      || message.since !== undefined && (!message.since || typeof message.since !== 'object' || Array.isArray(message.since))) throw Error('invalid_request');
    if (pending.has(ws)) throw Error('busy');
    abort = new AbortController(); pending.set(ws, abort);
    const close = () => abort?.abort(); ws.once('close', close);
    try {
      const page = await sessionJournal.watch(message.sessionId, message.since as JournalCursor | undefined, message.full === true,
        typeof message.wait === 'number' ? message.wait : 0, abort.signal);
      if (!abort.signal.aborted) reply({ ok: true, ...page });
    } finally { ws.removeListener('close', close); pending.delete(ws); }
  } catch (error) {
    if (!abort?.signal.aborted) reply({ ok: false, error: { code: error instanceof Error ? error.message : 'observation_failed', message: 'Cannot observe this session' } });
  }
}
