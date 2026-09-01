import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
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
}

const SCROLL_THRESHOLD = 80;

export const MessageList = forwardRef<MessageListHandle, Props>(function MessageList({ messages, streaming, login, logCount }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

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

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUp.current = distanceFromBottom > SCROLL_THRESHOLD;
    setShowScrollBtn(distanceFromBottom > SCROLL_THRESHOLD);
  }

  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, streaming]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.messages} ref={containerRef} onScroll={handleScroll}>
        {messages.map(msg => (
          <ChatMessage key={msg.id} message={msg} login={msg.role === 'error' && msg.errorKind === 'auth' ? login : undefined} />
        ))}
        {streaming && <StreamingMessage streaming={streaming} logCount={logCount} />}
        <div ref={bottomRef} />
      </div>
      {showScrollBtn && (
        <button className={styles.scrollBtn} onClick={scrollToBottom} aria-label="Scroll to bottom">↓</button>
      )}
    </div>
  );
});
