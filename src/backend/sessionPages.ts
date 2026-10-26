import type WebSocket from 'ws';
import type { ReplayMessage } from './sessions';

export const SESSION_PAGE_SIZE = 30;
const SESSION_PAGE_BYTES = 128 * 1024;

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

function pageBefore<T extends Segmentable>(segments: T[], end: number): number {
  let start = end;
  let bytes = 0;
  while (start > 0 && end - start < SESSION_PAGE_SIZE) {
    const size = Buffer.byteLength(JSON.stringify(segments[start - 1]));
    if (bytes && bytes + size > SESSION_PAGE_BYTES) break;
    bytes += size;
    start--;
  }
  return start;
}

export function latestPage<T extends Segmentable>(messages: T[]) {
  const segments = displaySegments(messages);
  const before = pageBefore(segments, segments.length);
  return { messages: segments.slice(before), before, hasMore: before > 0 };
}

export function sendInitialPage(ws: WebSocket, id: string | undefined, messages: ReplayMessage[]): void {
  ws.send(JSON.stringify({ type: 'sessionLoaded', id, ...latestPage(messages) }));
}

export function sendEarlierPage(ws: WebSocket, id: string, messages: ReplayMessage[], before: number, revision?: number): void {
  const segments = displaySegments(messages);
  const end = Math.min(before, segments.length);
  const start = pageBefore(segments, end);
  ws.send(JSON.stringify({ type: 'historyPage', id, messages: segments.slice(start, end), before: start, revision }));
}
