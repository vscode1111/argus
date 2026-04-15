import React, { useState } from 'react';
import { UIMessage } from '../types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCall } from './ToolCall';
import { Markdown } from '../utils/markdown';
import { formatDuration } from '../utils/time';
import { ImageViewerModal } from './ImageViewerModal';
import msg from './shared/message.module.css';
import styles from './ChatMessage.module.css';

interface Props {
  message: UIMessage;
}

export function ChatMessage({ message }: Props) {
  const { role, content, thinking, toolCalls, responseTime } = message;

  if (role === 'error') {
    return (
      <div className={[msg.message, msg.assistant].join(' ')} style={{ color: 'var(--error-fg)' }}>
        Error: {content}
      </div>
    );
  }

  if (role === 'user') {
    return <UserMessage message={message} />;
  }

  return (
    <div className={[msg.message, msg.assistant].join(' ')}>
      {thinking && <ThinkingBlock text={thinking} />}
      {toolCalls?.map(tc => <ToolCall key={tc.id} call={tc} />)}
      {content && (
        <div className={msg.messageContent}>
          <Markdown>{content}</Markdown>
        </div>
      )}
      {responseTime !== undefined && (
        <div className={msg.responseTimeSuccess}>{formatDuration(responseTime)}</div>
      )}
    </div>
  );
}

function UserMessage({ message }: Props) {
  const { content } = message;
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  return (
    <div className={[msg.message, msg.user].join(' ')}>
      <div className={msg.messageContent} style={{ whiteSpace: 'pre-wrap' }}>{content}</div>
      {message.images && message.images.length > 0 && (
        <div className={styles.messageImages}>
          {message.images.map((img, i) => (
            <img key={i} src={`data:${img.mediaType};base64,${img.data}`} alt={`Attachment ${i + 1}`} className={styles.messageImage} onClick={() => setViewerIndex(i)} />
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
    </div>
  );
}
