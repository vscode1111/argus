import React, { useEffect, useRef } from 'react';
import { UIMessage, StreamingState } from '../types';
import { ChatMessage } from './ChatMessage';
import { StreamingMessage } from './StreamingMessage';
import styles from './MessageList.module.css';

interface Props {
  messages: UIMessage[];
  streaming: StreamingState | null;
}

export function MessageList({ messages, streaming }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages, streaming]);

  return (
    <div className={styles.messages}>
      {messages.map(msg => (
        <ChatMessage key={msg.id} message={msg} />
      ))}
      {streaming && <StreamingMessage streaming={streaming} />}
      <div ref={bottomRef} />
    </div>
  );
}
