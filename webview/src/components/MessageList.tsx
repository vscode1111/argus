import React, { useEffect, useLayoutEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { UIMessage, StreamingState, LoginState } from '../types';
import { ChatMessage } from './ChatMessage';
import { StreamingMessage } from './StreamingMessage';
import styles from './MessageList.module.css';

export interface MessageListHandle {
  scrollToBottom: () => void;
}

interface Props {
  messages: UIMessage[];
  streaming: StreamingState | null;
  login: LoginState;
  logCount: number;
  historySessionId: string | null;
  historyBefore: number;
  historyRevision: number;
  onLoadEarlier: (id: string, before: number, revision: number, prefetch: boolean) => void;
}

const SCROLL_THRESHOLD = 80;
const HISTORY_THRESHOLD = 100;
const PREFETCH_PAGES = 3;
const segmentOrigin = (id: string) => /^(.*):block:\d+$/.exec(id)?.[1];

export const MessageList = forwardRef<MessageListHandle, Props>(function MessageList({ messages, streaming, login, logCount, historySessionId, historyBefore, historyRevision, onLoadEarlier }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const pendingPage = useRef<{ id: string; before: number; revision: number; height: number; top: number; manual: boolean } | null>(null);
  const prefetchedPages = useRef<Array<{ id: string; revision: number; requestedBefore: number; before: number; messages: UIMessage[] }>>([]);
  const prefetchPending = useRef<{ id: string; revision: number; before: number } | null>(null);
  const waitingForPrefetch = useRef<boolean | null>(null);
  const lastScrollTop = useRef(0);

  function prefetch(afterBefore: number) {
    const before = prefetchedPages.current.at(-1)?.before ?? afterBefore;
    if (!historySessionId || before <= 0 || prefetchPending.current || prefetchedPages.current.length >= PREFETCH_PAGES) return;
    prefetchPending.current = { id: historySessionId, revision: historyRevision, before };
    onLoadEarlier(historySessionId, before, historyRevision, true);
  }

  useEffect(() => {
    pendingPage.current = null;
    prefetchedPages.current = [];
    prefetchPending.current = null;
    waitingForPrefetch.current = null;
    userScrolledUp.current = false;
    lastScrollTop.current = 0;
    setShowScrollBtn(false);
    setLoadingEarlier(false);
    if (historySessionId && historyBefore > 0) {
      prefetch(historyBefore);
      if (containerRef.current && containerRef.current.scrollHeight <= containerRef.current.clientHeight) loadEarlier(false);
    }
  }, [historyRevision]);

  useEffect(() => {
    function onPage(event: MessageEvent) {
      if (event.data?.type === 'historyPage' && event.data.prefetch === true) {
        const pending = prefetchPending.current;
        if (!pending || event.data.id !== pending.id || event.data.revision !== pending.revision) return;
        prefetchPending.current = null;
        if (!event.data.error) prefetchedPages.current.push({ id: pending.id, revision: pending.revision,
          requestedBefore: pending.before, before: event.data.before, messages: event.data.messages });
        if (waitingForPrefetch.current !== null) {
          const manual = waitingForPrefetch.current;
          waitingForPrefetch.current = null;
          if (event.data.error) setLoadingEarlier(false);
          else loadEarlier(manual);
        } else if (!event.data.error && containerRef.current && containerRef.current.scrollHeight <= containerRef.current.clientHeight) {
          loadEarlier(false);
        }
        if (!event.data.error) prefetch(event.data.before);
        return;
      }
      if (event.data?.type === 'historyPage' && event.data.id === pendingPage.current?.id && event.data.revision === pendingPage.current?.revision && event.data.error) {
        pendingPage.current = null;
        setLoadingEarlier(false);
      }
    }
    window.addEventListener('message', onPage);
    return () => window.removeEventListener('message', onPage);
  });

  useLayoutEffect(() => {
    const pending = pendingPage.current;
    const el = containerRef.current;
    if (!pending || !el || pending.id !== historySessionId || pending.revision !== historyRevision || historyBefore >= pending.before) return;
    if (pending.manual) {
      el.scrollTop = 0;
      requestAnimationFrame(() => { if (pendingPage.current === pending) pendingPage.current = null; });
    } else {
      el.scrollTop = pending.top + el.scrollHeight - pending.height;
      pendingPage.current = null;
    }
    setLoadingEarlier(false);
    prefetch(historyBefore);
    if (!pending.manual && el.scrollHeight <= el.clientHeight && historyBefore > 0) loadEarlier(false);
  }, [messages, historyBefore, historySessionId, historyRevision]);

  function scrollToBottom() {
    userScrolledUp.current = false;
    setShowScrollBtn(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  useImperativeHandle(ref, () => ({
    scrollToBottom() {
      userScrolledUp.current = false;
      setShowScrollBtn(false);
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    },
  }));

  function loadEarlier(manual: boolean) {
    const el = containerRef.current;
    if (!el || !historySessionId || historyBefore <= 0 || pendingPage.current) return;
    const buffered = prefetchedPages.current[0];
    if (buffered && buffered.id === historySessionId && buffered.revision === historyRevision && buffered.requestedBefore === historyBefore) {
      prefetchedPages.current.shift();
      pendingPage.current = { id: historySessionId, before: historyBefore, revision: historyRevision,
        height: el.scrollHeight, top: el.scrollTop, manual };
      if (manual) userScrolledUp.current = true;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'historyPage', id: historySessionId,
        revision: historyRevision, before: buffered.before, messages: buffered.messages } }));
      prefetch(buffered.before);
      return;
    }
    if (prefetchPending.current?.id === historySessionId && prefetchPending.current.revision === historyRevision) {
      waitingForPrefetch.current = manual;
      setLoadingEarlier(true);
      return;
    }
    pendingPage.current = { id: historySessionId, before: historyBefore, revision: historyRevision,
      height: el.scrollHeight, top: el.scrollTop, manual };
    if (manual) userScrolledUp.current = true;
    setLoadingEarlier(true);
    onLoadEarlier(historySessionId, historyBefore, historyRevision, false);
  }

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUp.current = distanceFromBottom > SCROLL_THRESHOLD;
    setShowScrollBtn(distanceFromBottom > SCROLL_THRESHOLD);
    if (el.scrollTop < HISTORY_THRESHOLD && el.scrollTop < lastScrollTop.current) loadEarlier(false);
    lastScrollTop.current = el.scrollTop;
  }

  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, streaming]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.messages} ref={containerRef} onScroll={handleScroll}>
        {historySessionId && historyBefore > 0 && !loadingEarlier && (
          <button type="button" className={styles.loadEarlierBtn} onClick={() => loadEarlier(true)}>
            Load earlier messages
          </button>
        )}
        {messages.map((msg, index) => (
          <ChatMessage key={msg.id} message={msg}
            compact={msg.role === 'assistant' && index > 0 && messages[index - 1].role === 'assistant' && !!segmentOrigin(msg.id)
              && segmentOrigin(msg.id) === segmentOrigin(messages[index - 1].id)}
            login={msg.role === 'error' && msg.errorKind === 'auth' ? login : undefined} />
        ))}
        {streaming && <StreamingMessage streaming={streaming} logCount={logCount} />}
        <div ref={bottomRef} />
      </div>
      {loadingEarlier && <div className={styles.olderLoading} role="status">Loading earlier messages…</div>}
      {showScrollBtn && (
        <button className={styles.scrollBtn} onClick={scrollToBottom} aria-label="Scroll to bottom">↓</button>
      )}
    </div>
  );
});
