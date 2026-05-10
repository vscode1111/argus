import React, { useRef, useState, useEffect, useCallback } from 'react';
import { ImageAttachment } from '../types';
import { postMessage } from '../vscode';
import { SettingsModal } from './SettingsModal';
import { ImageViewerModal } from './ImageViewerModal';
import styles from './InputArea.module.css';
import settings from './SettingsModal.module.css';

const DEFAULT_FALLBACK_HEIGHT = 100;
const MIN_HEIGHT_WITH_IMAGES = 120;
const MIN_HEIGHT_DEFAULT = 73;
const MAX_HEIGHT_RATIO_AUTO = 0.5;
const MAX_HEIGHT_RATIO_DRAG = 0.7;
const TEXTAREA_ROWS_DEFAULT = 3;
const TEXTAREA_ROWS_WITH_IMAGES = 1;
const PLACEHOLDER_TEXT = 'Ask Argus... (paste images, text, or PDFs with Ctrl+V)';
const PASTE_ERROR_TIMEOUT_MS = 8000;
const TEXT_FILE_EXTENSIONS = /\.(txt|md|markdown|json|jsonc|yaml|yml|toml|ini|cfg|conf|log|csv|tsv|xml|html|htm|css|scss|sass|less|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|c|h|cpp|hpp|cs|swift|kt|kts|sh|bash|zsh|ps1|sql|env|gitignore|dockerfile)$/i;

interface Skill {
  name: string;
  scope: 'global' | 'project' | 'builtin';
  description?: string;
}

interface Props {
  isStreaming: boolean;
  prefill: string;
  workspacePath: string;
  version: string;
  contextUsage: { percent: number; inputTokens: number; outputTokens: number } | null;
  onSend?: () => void;
  onStop?: () => void;
}

export function InputArea({ isStreaming, prefill, workspacePath, version, contextUsage, onSend, onStop }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const pasteErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [wrapperHeight, setWrapperHeight] = useState<number | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [mode, setMode] = useState<'plan' | 'edit'>('edit');
  const historyIndex = useRef(-1);
  const savedDraft = useRef('');
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(0);
  const lastHeight = useRef(0);
  const skillsLoaded = useRef(false);
  const hasImagesRef = useRef(false);
  hasImagesRef.current = images.length > 0;

  function adjustHeight() {
    if (wrapperHeight !== null) return; // user has manually resized
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxH = window.innerHeight * MAX_HEIGHT_RATIO_AUTO;
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
  }

  // Listen for skills message from extension
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === 'skills') setSkills(e.data.skills ?? []);
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const onDragMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const delta = dragStartY.current - e.clientY;
    const minH = hasImagesRef.current ? MIN_HEIGHT_WITH_IMAGES : MIN_HEIGHT_DEFAULT;
    const newH = Math.max(minH, Math.min(dragStartH.current + delta, window.innerHeight * MAX_HEIGHT_RATIO_DRAG));
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
    dragStartH.current = wrapperRef.current?.offsetHeight ?? DEFAULT_FALLBACK_HEIGHT;
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
    setSlashQuery(null);
    postMessage({ type: 'send', text, images: images.length > 0 ? images : undefined, mode });
    setImages([]);
    onSend?.();
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function showPasteError(message: string) {
    setPasteError(message);
    if (pasteErrorTimeoutRef.current) clearTimeout(pasteErrorTimeoutRef.current);
    pasteErrorTimeoutRef.current = setTimeout(() => setPasteError(null), PASTE_ERROR_TIMEOUT_MS);
  }

  function classifyPastedFile(file: File): 'image' | 'pdf' | 'text' | 'unsupported' {
    const t = file.type;
    if (t.startsWith('image/')) return 'image';
    if (t === 'application/pdf') return 'pdf';
    if (t.startsWith('text/')) return 'text';
    // Some text files (.md, .yml, .env) report empty MIME on Windows - fall back to extension
    if (t === '' && TEXT_FILE_EXTENSIONS.test(file.name)) return 'text';
    return 'unsupported';
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData.items;
    const accepted: { kind: 'image' | 'pdf' | 'text'; file: File }[] = [];
    const unsupported: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      const kind = classifyPastedFile(file);
      if (kind === 'unsupported') unsupported.push(file.name || file.type || 'unknown');
      else accepted.push({ kind, file });
    }

    if (accepted.length === 0 && unsupported.length === 0) return;
    e.preventDefault();

    if (unsupported.length > 0) {
      const list = unsupported.join(', ');
      showPasteError(`Unsupported file type: ${list}. Supported types: images (PNG, JPG, GIF, WebP), text files, and PDFs.`);
    }

    for (const { kind, file } of accepted) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const match = dataUrl.match(/^data:([^;]*);base64,(.+)$/);
        if (!match) return;
        // Normalize text-file media type when the OS reports it as empty
        const detectedType = match[1];
        const mediaType = kind === 'text' && !detectedType.startsWith('text/') ? 'text/plain' : detectedType;
        setImages(prev => [...prev, { data: match[2], mediaType, name: file.name }]);
      };
      reader.readAsDataURL(file);
    }
  }

  function getSlashContext(): { query: string; slashIndex: number } | null {
    const el = textareaRef.current;
    if (!el) return null;
    const cursor = el.selectionStart ?? 0;
    const textBeforeCursor = el.value.slice(0, cursor);
    const slashIndex = textBeforeCursor.lastIndexOf('/');
    if (slashIndex === -1) return null;
    const textAfterSlash = textBeforeCursor.slice(slashIndex + 1);
    // Close if there's whitespace between "/" and cursor - user moved past the word
    if (/[\s\n]/.test(textAfterSlash)) return null;
    return { query: textAfterSlash, slashIndex };
  }

  function updateSlashState() {
    const ctx = getSlashContext();
    if (ctx) {
      setSlashQuery(ctx.query);
      setHighlightIndex(0);
      if (!skillsLoaded.current) {
        skillsLoaded.current = true;
        postMessage({ type: 'getSkills' });
      }
    } else {
      setSlashQuery(null);
    }
  }

  const filteredSkills = slashQuery !== null
    ? skills.filter(s => s.name.toLowerCase().includes(slashQuery.toLowerCase()))
    : [];

  function selectSkill(name: string) {
    const el = textareaRef.current;
    if (el) {
      const ctx = getSlashContext();
      const cursor = el.selectionStart ?? 0;
      if (ctx) {
        const replacement = `/${name} `;
        el.value = el.value.slice(0, ctx.slashIndex) + replacement + el.value.slice(cursor);
        const newCursor = ctx.slashIndex + replacement.length;
        el.setSelectionRange(newCursor, newCursor);
      }
      el.focus();
      adjustHeight();
    }
    setSlashQuery(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashQuery !== null && filteredSkills.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIndex(i => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIndex(i => Math.min(filteredSkills.length - 1, i + 1));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectSkill(filteredSkills[highlightIndex].name);
        return;
      }
      if (e.key === 'Escape') {
        setSlashQuery(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && history.length > 0 && slashQuery === null) {
      e.preventDefault();
      const el = textareaRef.current;
      if (!el) return;
      if (historyIndex.current === -1) savedDraft.current = el.value;
      historyIndex.current = Math.min(historyIndex.current + 1, history.length - 1);
      el.value = history[historyIndex.current];
      adjustHeight();
    } else if (e.key === 'ArrowDown' && historyIndex.current !== -1 && slashQuery === null) {
      e.preventDefault();
      const el = textareaRef.current;
      if (!el) return;
      historyIndex.current--;
      el.value = historyIndex.current === -1 ? savedDraft.current : history[historyIndex.current];
      adjustHeight();
    }
  }

  return (
    <div className={styles.inputArea} ref={inputAreaRef}>
      {pasteError && (
        <div className={styles.pasteError} role="alert">
          <span>{pasteError}</span>
          <button className={styles.pasteErrorClose} aria-label="Dismiss" onClick={() => setPasteError(null)}>×</button>
        </div>
      )}
      <div className={styles.inputResizeHandle} onMouseDown={onDragStart} />
      {slashQuery !== null && (
        <div className={styles.slashMenu} style={{ left: 0 }}>
          <div className={styles.slashMenuHeader}>Slash Commands</div>
          {filteredSkills.length === 0 && (
            <div className={styles.slashMenuEmpty}>
              {skillsLoaded.current ? 'No matching commands' : 'Loading...'}
            </div>
          )}
          {filteredSkills.map((skill, i) => (
            <div
              key={skill.scope + ':' + skill.name}
              ref={i === highlightIndex ? el => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              className={[styles.slashMenuItem, i === highlightIndex ? styles.slashMenuItemActive : ''].filter(Boolean).join(' ')}
              onMouseDown={e => e.preventDefault()}
              onClick={() => selectSkill(skill.name)}
            >
              <span className={styles.slashMenuName}>/{skill.name}</span>
              {skill.description && <span className={styles.slashMenuDesc}>{skill.description.length > 100 ? skill.description.slice(0, 100) + '...' : skill.description}</span>}
              {skill.scope !== 'builtin' && (
                <span className={[styles.slashMenuScope, skill.scope === 'project' ? styles.slashMenuScopeProject : ''].filter(Boolean).join(' ')}>{skill.scope}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div
        className={styles.inputWrapper}
        ref={wrapperRef}
        style={wrapperHeight !== null ? { height: wrapperHeight } : undefined}
      >
        <textarea
          ref={textareaRef}
          className={[styles.textarea, images.length > 0 && styles.hasImages].filter(Boolean).join(' ')}
          placeholder={PLACEHOLDER_TEXT}
          rows={images.length > 0 ? TEXTAREA_ROWS_WITH_IMAGES : TEXTAREA_ROWS_DEFAULT}
          onInput={() => { adjustHeight(); updateSlashState(); }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => setSlashQuery(null)}
        />
        {images.length > 0 && (
          <div className={styles.imagePreviews}>
            {images.map((img, i) => {
              const isImage = img.mediaType.startsWith('image/');
              const label = img.name ?? `image.${img.mediaType.split('/')[1] ?? 'png'}`;
              return isImage ? (
                <div key={i} className={styles.imagePreview} onClick={() => setViewerIndex(i)} title={label}>
                  <img src={`data:${img.mediaType};base64,${img.data}`} alt={`Attachment ${i + 1}`} />
                  <button className={styles.imageRemove} aria-label={`Remove attachment ${i + 1}`} onClick={e => { e.stopPropagation(); removeImage(i); }} title="Remove attachment">×</button>
                </div>
              ) : (
                <div key={i} className={styles.filePreview} title={label}>
                  <span className={styles.fileIcon} aria-hidden="true">📄</span>
                  <span className={styles.fileName}>{label}</span>
                  <button className={styles.imageRemove} aria-label={`Remove attachment ${i + 1}`} onClick={e => { e.stopPropagation(); removeImage(i); }} title="Remove attachment">×</button>
                </div>
              );
            })}
            <button className={styles.imageClearAll} aria-label="Remove all attachments" onClick={() => setImages([])} title="Remove all attachments">×</button>
          </div>
        )}
      </div>
      <div className={styles.btnGroup}>
        <div className={styles.btnRow}>
          {isStreaming && (
            <button className={styles.btnStop} onClick={() => { postMessage({ type: 'stop' }); onStop?.(); }}>Stop</button>
          )}
          <button
            className={[styles.modePill, mode === 'plan' ? styles.modePlan : ''].filter(Boolean).join(' ')}
            onClick={() => setMode(m => m === 'edit' ? 'plan' : 'edit')}
            title={mode === 'edit' ? 'Switch to Plan mode' : 'Switch to Edit mode'}
          >
            {mode === 'edit' ? 'Edit' : 'Plan'}
          </button>
          {contextUsage && (
            <span
              className={[styles.contextPill, contextUsage.percent >= 80 ? styles.contextHigh : contextUsage.percent >= 50 ? styles.contextMedium : ''].filter(Boolean).join(' ')}
              title={`${contextUsage.percent}% used\nInput: ${contextUsage.inputTokens.toLocaleString()} tokens\nOutput: ${contextUsage.outputTokens.toLocaleString()} tokens`}
            >
              {contextUsage.percent}%
            </span>
          )}
          <div className={settings.anchor}>
            <button
              className="btn-icon"
              title="Settings"
              aria-label="Settings"
              onClick={() => setSettingsOpen(v => !v)}
            >
              ⚙
            </button>
            {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} workspacePath={workspacePath} version={version} />}
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

  function removeImage(index: number) {
    setImages(prev => prev.filter((_, i) => i !== index));
  }
}
