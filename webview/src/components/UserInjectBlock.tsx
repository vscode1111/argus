import React, { useState, useCallback } from 'react';
import msg from './shared/message.module.css';
import { isOrchestratorPrompt } from '../utils/orchestratorMarker';
import { ImageViewerModal } from './ImageViewerModal';
import type { ImageAttachment } from '../types';
import styles from './ChatMessage.module.css';
import { copyTextToClipboard } from '../utils/clipboard';

export function UserInjectBlock({ text, images }: { text: string; images?: ImageAttachment[] }) {
  const [copied, setCopied] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const handleCopy = useCallback(() => {
    copyTextToClipboard(text).then(copiedSuccessfully => {
      if (!copiedSuccessfully) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <div className={[msg.userInject, isOrchestratorPrompt(text) ? msg.orchestrator : ''].filter(Boolean).join(' ')}>
      {text}
      {images && images.length > 0 && <div className={styles.messageImages}>
        {images.map((img, i) => <img key={i} src={`data:${img.mediaType};base64,${img.data}`} alt={`Attachment ${i + 1}`} className={styles.messageImage} onClick={() => setViewerIndex(i)} />)}
      </div>}
      <button className={msg.userInjectCopy} onClick={handleCopy} title="Copy to clipboard" aria-label="Copy to clipboard">{copied ? '✓' : '⧉'}</button>
      {viewerIndex !== null && images?.[viewerIndex] && <ImageViewerModal
        src={`data:${images[viewerIndex].mediaType};base64,${images[viewerIndex].data}`}
        alt={`Attachment ${viewerIndex + 1}`}
        onClose={() => setViewerIndex(null)}
      />}
    </div>
  );
}
