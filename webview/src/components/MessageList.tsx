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
  onLoadEarlier: (id: string, before: number, revision: number) => void;
}

const SCROLL_THRESHOLD = 80;
const HISTORY_THRESHOLD = 100;
const segmentOrigin = (id: string) => /^(.*):block:\d+$/.exec(id)?.[1];

export const MessageList = forwardRef<MessageListHandle, Props>(function MessageList({ messages, streaming, login, logCount, historySessionId, historyBefore, historyRevision, onLoadEarlier }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const pendingPage = useRef<{ id: string; before: number; revision: number; height: number; top: number; manual: boolean } | null>(null);

  useEffect(() => {
    pendingPage.current = null;
    setLoadingEarlier(false);
  }, [historyRevision]);

  useEffect(() => {
    function onPage(event: MessageEvent) {
      if (event.data?.type === 'historyPage' && event.data.id === pendingPage.current?.id && event.data.revision === pendingPage.current?.revision && event.data.error) {
        pendingPage.current = null;
        setLoadingEarlier(false);
      }
    }
    window.addEventListener('message', onPage);
    return () => window.removeEventListener('message', onPage);
  }, []);

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
    pendingPage.current = { id: historySessionId, before: historyBefore, revision: historyRevision,
      height: el.scrollHeight, top: el.scrollTop, manual };
    if (manual) userScrolledUp.current = true;
    setLoadingEarlier(true);
    onLoadEarlier(historySessionId, historyBefore, historyRevision);
  }

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUp.current = distanceFromBottom > SCROLL_THRESHOLD;
    setShowScrollBtn(distanceFromBottom > SCROLL_THRESHOLD);
    if (el.scrollTop < HISTORY_THRESHOLD) loadEarlier(false);
  }

  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, streaming]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.messages} ref={containerRef} onScroll={handleScroll}>
        {historySessionId && historyBefore > 0 && (
          <button type="button" className={styles.loadEarlierBtn} onClick={() => loadEarlier(true)} disabled={loadingEarlier}>
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
      {loadingEarlier && <div className={styles.olderLoading} role="status">Loading older messages…</div>}
      {showScrollBtn && (
        <button className={styles.scrollBtn} onClick={scrollToBottom} aria-label="Scroll to bottom">↓</button>
      )}
    </div>
  );
});
