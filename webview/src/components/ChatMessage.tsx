import React from 'react';
import { UIMessage } from '../types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCall } from './ToolCall';
import { Markdown } from '../utils/markdown';
import { formatDuration } from '../utils/time';

interface Props {
  message: UIMessage;
}

export function ChatMessage({ message }: Props) {
  const { role, content, thinking, toolCalls, responseTime } = message;

  if (role === 'error') {
    return (
      <div className="message assistant" style={{ color: 'var(--error-fg)' }}>
        Error: {content}
      </div>
    );
  }

  if (role === 'user') {
    return (
      <div className="message user">
        {message.images && message.images.length > 0 && (
          <div className="message-images">
            {message.images.map((img, i) => (
              <img key={i} src={`data:${img.mediaType};base64,${img.data}`} alt={`Attachment ${i + 1}`} className="message-image" />
            ))}
          </div>
        )}
        <div className="message-content" style={{ whiteSpace: 'pre-wrap' }}>{content}</div>
      </div>
    );
  }

  return (
    <div className="message assistant">
      {thinking && <ThinkingBlock text={thinking} />}
      {toolCalls?.map(tc => <ToolCall key={tc.id} call={tc} />)}
      {content && (
        <div className="message-content">
          <Markdown>{content}</Markdown>
        </div>
      )}
      {responseTime !== undefined && (
        <div className="response-time">{formatDuration(responseTime)}</div>
      )}
    </div>
  );
}
