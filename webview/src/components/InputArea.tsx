import React, { useRef, useState, useEffect, useCallback } from 'react';
import { ImageAttachment } from '../types';
import { postMessage } from '../vscode';
import { SettingsModal } from './SettingsModal';
import { ImageViewerModal } from './ImageViewerModal';
import styles from './InputArea.module.css';
import settings from './SettingsModal.module.css';

interface Props {
  isStreaming: boolean;
  prefill: string;
  workspacePath: string;
}

export function InputArea({ isStreaming, prefill, workspacePath }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [wrapperHeight, setWrapperHeight] = useState<number | null>(null);
  const historyIndex = useRef(-1);
  const savedDraft = useRef('');
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(0);
  const lastHeight = useRef(0);

  function adjustHeight() {
    if (wrapperHeight !== null) return; // user has manually resized
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxH = window.innerHeight * 0.5;
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
  }

  const onDragMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const delta = dragStartY.current - e.clientY;
    const newH = Math.max(60, Math.min(dragStartH.current + delta, window.innerHeight * 0.7));
    lastHeight.current = newH;
    if (wrapperRef.current) wrapperRef.current.style.height = newH + 'px';
  }, []);

  const onDragEnd = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    if (lastHeight.current) setWrapperHeight(lastHeight.current);
  }, [onDragMove]);

  // Cleanup drag listeners on unmount
  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('mouseup', onDragEnd);
    };
  }, [onDragMove, onDragEnd]);

  function onDragStart(e: React.MouseEvent) {
    e.preventDefault();
    dragging.current = true;
    dragStartY.current = e.clientY;
    dragStartH.current = wrapperRef.current?.offsetHeight ?? 100;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  }

  useEffect(() => {
    if (prefill && textareaRef.current) {
      textareaRef.current.value = prefill;
      textareaRef.current.focus();
      adjustHeight();
    }
  }, [prefill]);

  function send() {
    const el = textareaRef.current;
    if (!el) return;
    const text = el.value.trim();
    if (!text && images.length === 0) return;
    if (isStreaming) return;
    if (text) setHistory(prev => [text, ...prev]);
    historyIndex.current = -1;
    savedDraft.current = '';
    el.value = '';
    el.style.height = 'auto';
    postMessage({ type: 'send', text, images: images.length > 0 ? images : undefined });
    setImages([]);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData.items;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;
    e.preventDefault();

    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        // dataUrl format: "data:image/png;base64,iVBOR..."
        const match = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
        if (!match) return;
        setImages(prev => [...prev, { data: match[2], mediaType: match[1] }]);
      };
      reader.readAsDataURL(file);
    }
  }

  function removeImage(index: number) {
    setImages(prev => prev.filter((_, i) => i !== index));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && history.length > 0) {
      e.preventDefault();
      const el = textareaRef.current;
      if (!el) return;
      if (historyIndex.current === -1) savedDraft.current = el.value;
      historyIndex.current = Math.min(historyIndex.current + 1, history.length - 1);
      el.value = history[historyIndex.current];
      adjustHeight();
    } else if (e.key === 'ArrowDown' && historyIndex.current !== -1) {
      e.preventDefault();
      const el = textareaRef.current;
      if (!el) return;
      historyIndex.current--;
      el.value = historyIndex.current === -1 ? savedDraft.current : history[historyIndex.current];
      adjustHeight();
    }
  }

  return (
    <div className={styles.inputArea}>
      <div className={styles.inputResizeHandle} onMouseDown={onDragStart} />
      <div
        className={styles.inputWrapper}
        ref={wrapperRef}
        style={wrapperHeight !== null ? { height: wrapperHeight } : undefined}
      >
        <textarea
          ref={textareaRef}
          className={[styles.textarea, images.length > 0 && styles.hasImages].filter(Boolean).join(' ')}
          placeholder="Ask Argus... (paste images with Ctrl+V)"
          rows={images.length > 0 ? 1 : 3}
          onInput={adjustHeight}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        {images.length > 0 && (
          <div className={styles.imagePreviews}>
            {images.map((img, i) => (
              <div key={i} className={styles.imagePreview} onClick={() => setViewerIndex(i)} title={`image.${img.mediaType.split('/')[1] ?? 'png'}`}>
                <img src={`data:${img.mediaType};base64,${img.data}`} alt={`Attachment ${i + 1}`} />
                <button className={styles.imageRemove} aria-label={`Remove attachment ${i + 1}`} onClick={e => { e.stopPropagation(); removeImage(i); }} title="Remove image">×</button>
              </div>
            ))}
            <button className={styles.imageClearAll} aria-label="Remove all attachments" onClick={() => setImages([])} title="Remove all attachments">×</button>
          </div>
        )}
      </div>
      <div className={styles.btnGroup}>
        <div className={styles.btnRow}>
          {isStreaming && (
            <button className={styles.btnStop} onClick={() => postMessage({ type: 'stop' })}>Stop</button>
          )}
          <button
            className={styles.btnKill}
            title="Kill process (test error)"
            onClick={() => postMessage({ type: 'forceError' })}
          >
            ✕
          </button>
          <div className={settings.anchor}>
            <button
              className="btn-icon"
              title="Settings"
              aria-label="Settings"
              onClick={() => setSettingsOpen(v => !v)}
            >
              ⚙
            </button>
            {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} workspacePath={workspacePath} />}
          </div>
        </div>
        <button className={styles.btnSend} disabled={isStreaming} onClick={send}>Send</button>
      </div>
      {viewerIndex !== null && images[viewerIndex] && (
        <ImageViewerModal
          src={`data:${images[viewerIndex].mediaType};base64,${images[viewerIndex].data}`}
          alt={`Attachment ${viewerIndex + 1}`}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </div>
  );
}
