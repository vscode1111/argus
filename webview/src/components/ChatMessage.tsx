import React, { useState } from 'react';
import { UIMessage } from '../types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCall } from './ToolCall';
import { Markdown } from '../utils/markdown';
import { formatDuration } from '../utils/time';
import { ImageViewerModal } from './ImageViewerModal';

interface Props {
  message: UIMessage;
}

export function ChatMessage({ message }: Props) {
  const { role, content, thinking, toolCalls, responseTime } = message;
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

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
              <img key={i} src={`data:${img.mediaType};base64,${img.data}`} alt={`Attachment ${i + 1}`} className="message-image" onClick={() => setViewerIndex(i)} style={{ cursor: 'pointer' }} />
            ))}
          </div>
        )}
        {viewerIndex !== null && message.images?.[viewerIndex] && (
          <ImageViewerModal
            src={`data:${message.images[viewerIndex].mediaType};base64,${message.images[viewerIndex].data}`}
            alt={`Attachment ${viewerIndex + 1}`}
            onClose={() => setViewerIndex(null)}
          />
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
