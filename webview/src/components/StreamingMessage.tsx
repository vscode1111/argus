import React from 'react';
import { StreamingState } from '../types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCall } from './ToolCall';
import { Markdown } from '../utils/markdown';
import { StreamingTimer } from './StreamingTimer';

interface Props {
  streaming: StreamingState;
}

export function StreamingMessage({ streaming }: Props) {
  const { thinking, text, toolCalls, startTime } = streaming;
  const hasText = text.length > 0;
  const isEmpty = !thinking && toolCalls.length === 0 && !hasText;

  return (
    <div className={[
      'message assistant streaming',
      hasText ? 'has-text' : '',
      isEmpty ? 'empty' : '',
    ].filter(Boolean).join(' ')}>
      {thinking && <ThinkingBlock text={thinking} />}
      {toolCalls.map(tc => <ToolCall key={tc.id} call={tc} />)}
      <div className="message-content">
        {hasText && (
          <>
            <Markdown>{text}</Markdown>
            <span className="cursor" />
          </>
        )}
      </div>
      <StreamingTimer startTime={startTime} />
    </div>
  );
}
