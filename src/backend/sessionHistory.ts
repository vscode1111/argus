import { providerForSession } from './providers/registry';
import { INITIAL_HISTORY_BATCHES, type HistoryPageSource } from './sessionPages';
import type { AgentProvider, ProviderHistoryPage } from './providers/types';
import type { ReplayMessage } from './sessions';

const MAX_EMPTY_HISTORY_PAGES = 30;

export async function loadSessionHistory(id: string, cwd: string): Promise<{ messages: ReplayMessage[]; source?: HistoryPageSource }> {
  const provider = providerForSession(id);
  if (!provider.loadPage) return { messages: await provider.load(id, cwd) };
  const collect = (read: (cursor?: unknown) => Promise<ProviderHistoryPage>) => collectHistory(id, cwd, provider, read);
  return provider.withHistoryReader
    ? provider.withHistoryReader(id, cwd, collect)
    : collect(cursor => provider.loadPage!(id, cwd, cursor));
}

async function collectHistory(id: string, cwd: string, provider: AgentProvider, read: (cursor?: unknown) => Promise<ProviderHistoryPage>) {
  const pages: ProviderHistoryPage[] = [];
  let cursor: unknown;
  let page: ProviderHistoryPage;
  let emptyPages = 0;
  do {
    page = await read(cursor);
    if (cursor !== undefined && page.cursor !== undefined && JSON.stringify(page.cursor) === JSON.stringify(cursor)) throw new Error('History cursor did not advance');
    cursor = page.cursor;
    if (page.messages.length) pages.push(page);
    else if (++emptyPages > MAX_EMPTY_HISTORY_PAGES) throw new Error('No visible messages in the requested history pages');
  } while (cursor !== undefined && pages.length < INITIAL_HISTORY_BATCHES);
  const latest = pages[0];
  const chronological = [...pages].reverse();
  const source: HistoryPageSource = {
    cursor,
    turnId: latest?.turnId,
    previousTurnCursor: latest?.previousTurnCursor,
    cursorTurnId: page.turnId,
    previousTurnMessages: chronological.filter(batch => batch.turnId !== latest?.turnId).flatMap(batch => batch.messages),
    load: cursor => provider.loadPage!(id, cwd, cursor),
  };
  return { messages: chronological.flatMap(batch => batch.messages), source };
}
