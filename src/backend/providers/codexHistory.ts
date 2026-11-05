import { array, object, string, type AppServerRpc, type JsonObject } from './rpc';

const HISTORY_ITEM_PAGE_SIZE = 30;

// Continuations stay on the server, alongside the client's displayed replay.
export async function readHistoryItems(rpc: AppServerRpc, threadId: string, cursor?: unknown): Promise<{ turn: JsonObject; cursor?: unknown; previousTurnCursor?: unknown; anchor: string }> {
  const continuation = object(cursor);
  let turn = object(continuation.turn);
  let nextTurn = string(continuation.nextTurn);
  if (!string(turn.id)) {
    const result = await rpc.request('thread/turns/list', {
      threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
      ...(nextTurn ? { cursor: nextTurn } : {}),
    });
    turn = object(array(result.data)[0]);
    nextTurn = string(result.nextCursor);
  }
  if (!string(turn.id)) return { turn: { items: [] }, anchor: '' };
  const result = await rpc.request('thread/items/list', {
    threadId, turnId: string(turn.id), limit: HISTORY_ITEM_PAGE_SIZE, sortDirection: 'desc',
    ...(string(continuation.items) ? { cursor: continuation.items } : {}),
  });
  const items = array(result.data).map(entry => object(object(entry).item)).reverse();
  const nextItems = string(result.nextCursor);
  const next = nextItems ? { turn: { id: turn.id, status: turn.status }, items: nextItems, nextTurn }
    : nextTurn ? { nextTurn } : undefined;
  return { turn: { ...turn, status: string(continuation.items) ? undefined : turn.status, items }, cursor: next,
    previousTurnCursor: nextTurn ? { nextTurn } : undefined, anchor: string(items[0]?.id) };
}
