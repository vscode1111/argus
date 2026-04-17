import React, { useEffect, useRef } from 'react';
import { UIMessage, StreamingState, LoginState } from '../types';
import { ChatMessage } from './ChatMessage';
import { StreamingMessage } from './StreamingMessage';
import styles from './MessageList.module.css';

interface Props {
  messages: UIMessage[];
  streaming: StreamingState | null;
  login: LoginState;
}

const SCROLL_THRESHOLD = 80;

export function MessageList({ messages, streaming, login }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUp.current = distanceFromBottom > SCROLL_THRESHOLD;
  }

  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, streaming]);

  return (
    <div className={styles.messages} ref={containerRef} onScroll={handleScroll}>
      {messages.map(msg => (
        <ChatMessage key={msg.id} message={msg} login={msg.role === 'error' && msg.errorKind === 'auth' ? login : undefined} />
      ))}
      {streaming && <StreamingMessage streaming={streaming} />}
      <div ref={bottomRef} />
    </div>
  );
}
