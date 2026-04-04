import React, { useRef, useState, useEffect } from 'react';
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
    if (!text || isStreaming) return;
    setHistory(prev => [text, ...prev]);
    historyIndex.current = -1;
    savedDraft.current = '';
    el.value = '';
    el.style.height = 'auto';
    postMessage({ type: 'send', text });
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
      <textarea
        ref={textareaRef}
        id="input"
        placeholder="Ask Argus..."
        rows={3}
        onInput={adjustHeight}
        onKeyDown={handleKeyDown}
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
