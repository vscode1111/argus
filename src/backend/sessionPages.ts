import type WebSocket from 'ws';
import type { ReplayMessage } from './sessions';
import type { ProviderHistoryPage } from './providers/types';

export const SESSION_PAGE_SIZE = 30;
export const INITIAL_HISTORY_BATCHES = 5;
const SESSION_PAGE_BYTES = 128 * 1024;
const INITIAL_PAGE_MIN_SEGMENTS = 3;
const INITIAL_PAGE_MAX_BYTES = 512 * 1024;
export interface HistoryPageSource {
  cursor?: unknown;
  turnId?: string;
  previousTurnCursor?: unknown;
  cursorTurnId?: string;
  previousTurnMessages?: ReplayMessage[];
  load(cursor: unknown): Promise<ProviderHistoryPage>;
}
interface ClientReplay {
  id: string;
  segments: ReplayMessage[];
  offset: number;
  source?: HistoryPageSource;
  loading?: Promise<void>;
}
const clientReplays = new WeakMap<WebSocket, ClientReplay>();

export function rememberSessionReplay(ws: WebSocket, id: string | undefined, messages: ReplayMessage[], source?: HistoryPageSource): void {
  clientReplays.delete(ws);
  if (id) {
    const segments = displaySegments(messages);
    clientReplays.set(ws, { id, segments, offset: source?.cursor !== undefined ? Number.MAX_SAFE_INTEGER - segments.length : 0, source });
  }
}

export function replayPageBefore(ws: WebSocket, before: number): number {
  const replay = clientReplays.get(ws);
  if (!replay) return before;
  return before > 0 || replay.source?.cursor !== undefined ? replay.offset + before : 0;
}

export function sendCachedEarlierPage(ws: WebSocket, id: string, before: number, revision?: number, prefetch = false): boolean {
  const replay = clientReplays.get(ws);
  if (!replay || replay.id !== id) return false;
  if (before <= replay.offset && replay.source?.cursor !== undefined) return false;
  sendSegmentPage(ws, replay, before, revision, prefetch);
  return true;
}

export async function sendProviderEarlierPage(ws: WebSocket, id: string, before: number, revision?: number, prefetch = false): Promise<boolean> {
  const replay = clientReplays.get(ws);
  if (!replay || replay.id !== id || !replay.source) return false;
  if (before <= replay.offset && replay.source.cursor !== undefined) {
    if (!replay.loading) {
      replay.loading = extendReplay(replay).finally(() => { replay.loading = undefined; });
    }
    await replay.loading;
  }
  if (clientReplays.get(ws) === replay) sendSegmentPage(ws, replay, before, revision, prefetch);
  return true;
}

async function extendReplay(replay: ClientReplay): Promise<void> {
  const source = replay.source!;
  for (let skipped = 0; skipped < SESSION_PAGE_SIZE; skipped++) {
    const previous = JSON.stringify(source.cursor);
    const page = await source.load(source.cursor);
    if (page.cursor !== undefined && JSON.stringify(page.cursor) === previous) throw new Error('History cursor did not advance');
    const segments = displaySegments(page.messages);
    replay.segments = [...segments, ...replay.segments];
    replay.offset -= segments.length;
    source.cursor = page.cursor;
    if (segments.length || source.cursor === undefined) return;
  }
  throw new Error('No visible messages in the requested history pages');
}

type Segmentable = {
  id: string;
  content: string;
  blocks?: Array<{ type: string; text?: string }>;
  thinking?: string;
  interaction?: unknown;
  outcome?: unknown;
  bgTasksPending?: number;
  bgTasksSince?: number;
};

export function displaySegments<T extends Segmentable>(messages: T[]): T[] {
  return messages.flatMap(message => {
    if (!message.blocks?.length || Buffer.byteLength(JSON.stringify(message)) <= SESSION_PAGE_BYTES) return [message];
    return message.blocks.map((block, index) => {
      const last = index === message.blocks!.length - 1;
      const { blocks, content, thinking, interaction, outcome, bgTasksPending, bgTasksSince, ...base } = message;
      return {
        ...base,
        id: `${message.id}:block:${index}`,
        content: block.type === 'text' ? block.text : '',
        blocks: [block],
        ...(index === 0 && thinking ? { thinking } : {}),
        ...(last ? { interaction, outcome, bgTasksPending, bgTasksSince } : {}),
      } as T;
    });
  });
}

function pageBefore<T extends Segmentable>(segments: T[], end: number, minimum = 0, maxBytes = SESSION_PAGE_BYTES, batches = 1): number {
  let start = end;
  let bytes = 0;
  while (start > 0 && end - start < SESSION_PAGE_SIZE * batches) {
    const size = Buffer.byteLength(JSON.stringify(segments[start - 1]));
    if (bytes && bytes + size > maxBytes) break;
    if (bytes && bytes + size > SESSION_PAGE_BYTES * batches && end - start >= minimum) break;
    bytes += size;
    start--;
  }
  return start;
}

export function latestPage<T extends Segmentable>(messages: T[]) {
  const segments = displaySegments(messages);
  const before = pageBefore(segments, segments.length, INITIAL_PAGE_MIN_SEGMENTS, INITIAL_PAGE_MAX_BYTES * INITIAL_HISTORY_BATCHES, INITIAL_HISTORY_BATCHES);
  return { messages: segments.slice(before), before, hasMore: before > 0 };
}

export function sendInitialPage(ws: WebSocket, id: string | undefined, messages: ReplayMessage[], source?: HistoryPageSource): void {
  rememberSessionReplay(ws, id, messages, source);
  const page = latestPage(messages);
  const before = replayPageBefore(ws, page.before);
  ws.send(JSON.stringify({ type: 'sessionLoaded', id, ...page, before, hasMore: before > 0 }));
}

export function sendEarlierPage(ws: WebSocket, id: string, messages: ReplayMessage[], before: number, revision?: number, prefetch = false): void {
  rememberSessionReplay(ws, id, messages);
  sendCachedEarlierPage(ws, id, before, revision, prefetch);
}

function sendSegmentPage(ws: WebSocket, replay: ClientReplay, before: number, revision?: number, prefetch = false): void {
  const { id, segments, offset, source } = replay;
  const end = Math.max(0, Math.min(before - offset, segments.length));
  const start = pageBefore(segments, end);
  ws.send(JSON.stringify({ type: 'historyPage', id, messages: segments.slice(start, end), before: start > 0 || source?.cursor !== undefined ? offset + start : 0, revision, ...(prefetch ? { prefetch: true } : {}) }));
}
