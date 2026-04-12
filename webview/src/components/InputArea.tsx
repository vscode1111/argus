import React, { useRef, useState, useEffect } from 'react';
import { ImageAttachment } from '../types';
import { postMessage } from '../vscode';
import { SettingsModal } from './SettingsModal';

interface Props {
  isStreaming: boolean;
  prefill: string;
  workspacePath: string;
}

export function InputArea({ isStreaming, prefill, workspacePath }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const historyIndex = useRef(-1);
  const savedDraft = useRef('');

  function adjustHeight() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
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
        const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
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
    <div id="input-area">
      {images.length > 0 && (
        <div className="image-previews">
          {images.map((img, i) => (
            <div key={i} className="image-preview">
              <img src={`data:${img.mediaType};base64,${img.data}`} alt={`Attachment ${i + 1}`} />
              <button className="image-remove" onClick={() => removeImage(i)} title="Remove image">x</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        id="input"
        placeholder="Ask Argus... (paste images with Ctrl+V)"
        rows={3}
        onInput={adjustHeight}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />
      <div id="btn-group">
        <div id="btn-row">
          {isStreaming && (
            <button id="btn-stop" onClick={() => postMessage({ type: 'stop' })}>Stop</button>
          )}
          <button
            id="btn-kill"
            title="Kill process (test error)"
            onClick={() => postMessage({ type: 'forceError' })}
          >
            ✕
          </button>
          <div className="settings-anchor">
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
        <button id="btn-send" disabled={isStreaming} onClick={send}>Send</button>
      </div>
    </div>
  );
}
