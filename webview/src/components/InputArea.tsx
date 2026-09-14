import React, { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { ImageAttachment } from '../types';
import { postMessage, isVsCode } from '../vscode';
import { SettingsModal } from './SettingsModal';
import { AccountUsageModal } from './AccountUsageModal';
import { ImageViewerModal } from './ImageViewerModal';
import { type ModelEntry, FALLBACK_MODELS, makeDefaultEntry, sameModel, toModelEntry } from '../utils/model';
import { findMentions } from '../utils/filePath';
import { plural } from '../utils/text';
import { FolderIcon, FileTypeIcon } from './shared/FolderList';
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
  kind?: 'command' | 'skill';
  description?: string;
}

/** Mirrors FileHit in src/backend/fileSearch.ts - the frontend/backend tsconfig split
 *  means the type cannot be imported, the same reason `plural()` is inlined in cli.ts. */
interface FileHit {
  rel: string;
  name: string;
  parent: string;
  isDir: boolean;
  childCount?: number;
}

// Long enough that walking a large workspace doesn't run on every keystroke, short enough
// that the list feels attached to the typing.
const FILE_SEARCH_DEBOUNCE_MS = 120;
const MAX_FILE_ROWS = 60;
/** Breathing room above the picker so it never sits flush against the top edge. */
const MENU_TOP_GAP = 12;
/** Floor for a very short window, where the measured space would be unusably small. */
const MIN_MENU_HEIGHT = 140;

/** Up-one-level arrow for the picker's ".." row, matching FolderList's up affordance. */
function UpIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

// Mention matching is shared with the sent bubble (utils/filePath) so the overlay and the
// message can never disagree about where a path ends - keeping a second copy of the pattern
// here is what made the "@path with spaces" bug land in two places at once.
function renderHighlight(value: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of findMentions(value)) {
    if (m.start > last) out.push(value.slice(last, m.start));
    out.push(<span key={key++} className={styles.mention}>{m.text}</span>);
    last = m.end;
  }
  // Trailing text plus a newline so a final empty line keeps height (matches the textarea caret).
  out.push(value.slice(last) + '\n');
  return out;
}

interface Props {
  isStreaming: boolean;
  prefill: string;
  workspacePath: string;
  version: string;
  contextUsage: { percent: number; inputTokens: number; outputTokens: number; contextWindow?: number } | null;
  bgTasks?: number;
  wsConnected?: boolean;
  wsClosedByPeer?: boolean;
  currentModel?: string;
  currentEffort?: string;
  thinkingEnabled?: boolean;
  onSend?: () => void;
  onStop?: () => void;
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

export function InputArea({ isStreaming, prefill, workspacePath, version, contextUsage, bgTasks = 0, wsConnected = true, wsClosedByPeer = false, currentModel = '', currentEffort = 'high', thinkingEnabled = true, onSend, onStop }: Props) {
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
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [fileHits, setFileHits] = useState<FileHit[]>([]);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileParent, setFileParent] = useState<string | null>(null);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | null>(null);
  const [mode, setMode] = useState<'plan' | 'edit'>('edit');
  const [accountUsageOpen, setAccountUsageOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<ModelEntry[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [runtimeDefaultModel, setRuntimeDefaultModel] = useState('');
  const [text, setText] = useState('');
  const highlightRef = useRef<HTMLDivElement>(null);
  const historyIndex = useRef(-1);
  const savedDraft = useRef('');
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(0);
  const lastHeight = useRef(0);
  const skillsLoaded = useRef(false);
  const justCommitted = useRef(false);
  const hasImagesRef = useRef(false);
  hasImagesRef.current = images.length > 0;

  function adjustHeight() {
    const el = textareaRef.current;
    if (!el) return;
    setText(el.value); // keep the @-mention highlight overlay in sync
    if (wrapperHeight !== null) return; // user has manually resized
    el.style.height = 'auto';
    const maxH = window.innerHeight * MAX_HEIGHT_RATIO_AUTO;
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
  }

  // Listen for skills and modelList messages
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === 'skills') {
        setSkills(e.data.skills ?? []);
      } else if (e.data?.type === 'fileList') {
        setFileHits(Array.isArray(e.data.hits) ? e.data.hits : []);
        setFilesTruncated(!!e.data.truncated);
        // null when at the workspace root or searching, which is exactly when there is
        // nothing to go up to.
        setFileParent(typeof e.data.parent === 'string' ? e.data.parent : null);
        setFilesLoading(false);
      } else if (e.data?.type === 'modelList') {
        const raw: ModelEntry[] = (e.data.models ?? []).map(toModelEntry);
        setFetchedModels(raw.length > 0 ? raw : null);
        setModelsError(raw.length === 0 && e.data.error ? String(e.data.error) : null);
        setModelsLoading(false);
        if (typeof e.data.runtimeDefaultModel === 'string' && e.data.runtimeDefaultModel) {
          setRuntimeDefaultModel(e.data.runtimeDefaultModel);
        }
      }
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
      const text = prefill.split('\x00')[0];
      const existing = textareaRef.current.value;
      textareaRef.current.value = (existing ? existing.trimEnd() + '\n' + text : text) + '\n';
      textareaRef.current.selectionStart = textareaRef.current.selectionEnd = textareaRef.current.value.length;
      textareaRef.current.focus();
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
      adjustHeight();
    }
  }, [prefill]);

  function send() {
    const el = textareaRef.current;
    if (!el) return;
    const text = el.value.trim();
    if (!text && images.length === 0) return;
    if (text) setHistory(prev => [text, ...prev]);
    historyIndex.current = -1;
    savedDraft.current = '';
    el.value = '';
    el.style.height = 'auto';
    setText('');
    setSlashQuery(null);
    postMessage({ type: 'send', text, images: images.length > 0 ? images : undefined, mode });
    setImages([]);
    onSend?.();
    if (!isVsCode && typeof Notification !== 'undefined' && Notification.permission === 'default') {
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
    // Only treat "/" as a command trigger at a word boundary (start of input or after
    // whitespace), so a path-like token such as "werwer/" doesn't open the menu.
    const charBefore = slashIndex > 0 ? textBeforeCursor[slashIndex - 1] : '';
    if (charBefore !== '' && !/\s/.test(charBefore)) return null;
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

  /**
   * The "@" mention under the caret. Unlike the slash trigger, the query MAY contain
   * spaces - the whole point is paths like `Бискуб - Анталья/`, and cutting the query at
   * the first space would make the picker useless for exactly the names it was built for.
   * A newline ends it, and `updateAtState` closes the menu once a query stops matching
   * anything, which is what gets it out of the way when the "@" was ordinary prose.
   */
  function getAtContext(): { query: string; atIndex: number } | null {
    const el = textareaRef.current;
    if (!el || el.selectionStart !== el.selectionEnd) return null;
    const cursor = el.selectionStart ?? 0;
    const before = el.value.slice(0, cursor);
    const atIndex = before.lastIndexOf('@');
    if (atIndex === -1) return null;
    // Word boundary only, so an email address never opens the picker.
    const charBefore = atIndex > 0 ? before[atIndex - 1] : '';
    if (charBefore !== '' && !/\s/.test(charBefore)) return null;
    const raw = before.slice(atIndex + 1);
    if (/\n/.test(raw)) return null;
    // Quotes are transport, not part of the path: a committed mention reads
    // `@"Бискуб .../Архив/"`, and searching for it verbatim would match nothing. Stripping
    // them is what lets a folder that has just been inserted act as the next query.
    return { query: raw.replace(/"/g, ''), atIndex };
  }

  function updateAtState() {
    const ctx = getAtContext();
    if (!ctx) {
      setAtQuery(null);
      return;
    }
    // A file commit leaves a complete mention under the caret, which would match itself and
    // reopen the menu on the `select` event that setSelectionRange fires. Consumed once.
    if (justCommitted.current) {
      justCommitted.current = false;
      setAtQuery(null);
      return;
    }
    setAtQuery(ctx.query);
    setHighlightIndex(0);
  }

  const filteredSkills = slashQuery !== null
    ? skills.filter(s => s.name.toLowerCase().includes(slashQuery.toLowerCase()))
    : [];

  // Synthetic action items surface when the query is a prefix of their trigger words,
  // so they stay out of the way on a bare "/".
  const accountQuery = (slashQuery ?? '').toLowerCase();
  const showModelAction = 'model'.startsWith(accountQuery) || 'switch'.startsWith(accountQuery);
  const showAccountAction = 'account'.startsWith(accountQuery) || 'usage'.startsWith(accountQuery);
  const modelActionIndex = filteredSkills.length;
  const accountActionIndex = filteredSkills.length + (showModelAction ? 1 : 0);
  const totalDropdownItems = filteredSkills.length + (showModelAction ? 1 : 0) + (showAccountAction ? 1 : 0);

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

  // Clear the in-progress "/..." token from the textarea and open the modal.
  function openAccountUsage() {
    const el = textareaRef.current;
    if (el) {
      const ctx = getSlashContext();
      if (ctx) {
        const cursor = el.selectionStart ?? 0;
        el.value = el.value.slice(0, ctx.slashIndex) + el.value.slice(cursor);
        el.setSelectionRange(ctx.slashIndex, ctx.slashIndex);
      }
      adjustHeight();
    }
    setSlashQuery(null);
    setAccountUsageOpen(true);
  }

  // Debounced file search. The host owns the walk, so the webview never guesses where a
  // path ends - which is the whole reason the picker exists (a space-bearing mention is
  // not resolvable lexically; see !notes/tasks/path-with-spaces-mention).
  useEffect(() => {
    if (atQuery === null) return;
    setFilesLoading(true);
    const t = setTimeout(() => postMessage({ type: 'searchFiles', query: atQuery }), FILE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [atQuery]);

  // A stale list must not outlive its menu, or reopening "@" flashes the previous query's
  // hits before the new reply lands.
  useEffect(() => {
    if (atQuery === null) {
      setFileHits([]);
      setFilesTruncated(false);
      setFilesLoading(false);
      setFileParent(null);
    }
  }, [atQuery]);

  const visibleHits = fileHits.slice(0, MAX_FILE_ROWS);
  // The up row is navigable like any other, so keyboard indices have to count it. Kept as
  // one list rather than an index offset, which is where off-by-ones live.
  const showUpRow = fileParent !== null;
  const navCount = visibleHits.length + (showUpRow ? 1 : 0);
  const hitAt = (i: number): FileHit | undefined => visibleHits[showUpRow ? i - 1 : i];
  // Open only when it has something to offer: a query that matches nothing was ordinary
  // prose after an "@", and a menu that lingers there swallows Enter. An up row alone still
  // counts - an empty folder must be escapable.
  const atMenuOpen = atQuery !== null && (navCount > 0 || filesLoading);

  // The menu is anchored `bottom: 100%` inside .inputArea, so it grows upward into space
  // that CSS cannot measure - the class's 260px cap left the list scrolling inside a
  // letterbox with most of the window empty above it. The input area's own top edge IS the
  // free height, and it moves (drag-resize, pasted images, the textarea auto-growing as you
  // type), so this is measured rather than written as a vh fraction, which would spill off
  // the top of the window once the input grew tall.
  useLayoutEffect(() => {
    if (!atMenuOpen) return;
    const measure = () => {
      const el = inputAreaRef.current;
      if (!el) return;
      const avail = Math.round(el.getBoundingClientRect().top - MENU_TOP_GAP);
      setMenuMaxHeight(prev => {
        const next = Math.max(MIN_MENU_HEIGHT, avail);
        return prev === next ? prev : next; // same value must not re-render
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [atMenuOpen, wrapperHeight, images.length, text, fileHits]);

  /**
   * Replaces the whole `@…` run under the caret. The inserted form is quoted when the path
   * contains a space, because the CLI's own "@" parser stops at the first one and drops the
   * mention silently - the bug that started this. Mirrors mentionFor() on the backend.
   *
   * Picking a DIRECTORY drills into it rather than finishing: the mention is written out in
   * full (so the text is a valid, sendable mention at every step - a folder is a legitimate
   * target, it inlines everything underneath) and the menu stays open with that folder as
   * the query, listing its contents. Closing here instead was the reported bug - there was
   * no way to reach anything inside a folder once it had been chosen. To keep the folder
   * itself, just stop: typing a space or sending leaves the mention exactly as inserted.
   */
  function selectFile(hit: FileHit) {
    const el = textareaRef.current;
    if (el) {
      const ctx = getAtContext();
      if (ctx) {
        const cursor = el.selectionStart ?? 0;
        const mention = hit.rel.includes(' ') ? `@"${hit.rel}"` : `@${hit.rel}`;
        // A file ends the mention, so it gets a trailing space to carry on typing.
        const replacement = hit.isDir ? mention : `${mention} `;
        el.value = el.value.slice(0, ctx.atIndex) + replacement + el.value.slice(cursor);
        const newCursor = ctx.atIndex + replacement.length;
        el.setSelectionRange(newCursor, newCursor);
      }
      el.focus();
      adjustHeight();
    }
    if (hit.isDir) {
      setAtQuery(hit.rel);
      setHighlightIndex(0);
    } else {
      justCommitted.current = true;
      setAtQuery(null);
    }
  }

  /** Browse one level out. `rel` is '' at the workspace root, where the mention is a bare "@". */
  function goUp(rel: string) {
    const el = textareaRef.current;
    if (el) {
      const ctx = getAtContext();
      if (ctx) {
        const cursor = el.selectionStart ?? 0;
        const mention = rel ? (rel.includes(' ') ? `@"${rel}"` : `@${rel}`) : '@';
        el.value = el.value.slice(0, ctx.atIndex) + mention + el.value.slice(cursor);
        const newCursor = ctx.atIndex + mention.length;
        el.setSelectionRange(newCursor, newCursor);
      }
      el.focus();
      adjustHeight();
    }
    setAtQuery(rel);
    setHighlightIndex(0);
  }

  // Reset the model picker whenever the slash menu closes.
  useEffect(() => { if (slashQuery === null) setModelPickerOpen(false); }, [slashQuery]);

  function openModelPicker() {
    setModelPickerOpen(v => {
      if (!v && fetchedModels === null && !modelsLoading) {
        setModelsLoading(true);
        postMessage({ type: 'getModels' });
      }
      return !v;
    });
  }

  function pickModel(id: string) {
    const el = textareaRef.current;
    if (el) {
      const ctx = getSlashContext();
      if (ctx) {
        const cursor = el.selectionStart ?? 0;
        el.value = el.value.slice(0, ctx.slashIndex) + el.value.slice(cursor);
        el.setSelectionRange(ctx.slashIndex, ctx.slashIndex);
      }
      adjustHeight();
      el.focus();
    }
    postMessage({ type: 'switchModel', model: id });
    setModelPickerOpen(false);
    setSlashQuery(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Checked before the slash menu: both can never be open at once (the triggers are
    // different characters), but the "@" query may contain "/" from a path, so ordering
    // here is what keeps a path segment from being read as a command.
    if (atMenuOpen) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIndex(i => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIndex(i => Math.min(navCount - 1, i + 1));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (showUpRow && highlightIndex === 0) {
          e.preventDefault();
          goUp(fileParent!);
          return;
        }
        const hit = hitAt(highlightIndex);
        if (hit) {
          e.preventDefault();
          selectFile(hit);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAtQuery(null);
        return;
      }
    }

    if (slashQuery !== null && totalDropdownItems > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIndex(i => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIndex(i => Math.min(totalDropdownItems - 1, i + 1));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (highlightIndex < filteredSkills.length) {
          selectSkill(filteredSkills[highlightIndex].name);
        } else if (showModelAction && highlightIndex === modelActionIndex) {
          openModelPicker();
        } else if (showAccountAction && highlightIndex === accountActionIndex) {
          openAccountUsage();
        }
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
      const el = textareaRef.current;
      if (!el) return;
      const cursorOnFirstLine = el.selectionStart === el.selectionEnd
        && el.value.lastIndexOf('\n', el.selectionStart - 1) === -1;
      if (!cursorOnFirstLine) return;
      e.preventDefault();
      if (historyIndex.current === -1) savedDraft.current = el.value;
      historyIndex.current = Math.min(historyIndex.current + 1, history.length - 1);
      el.value = history[historyIndex.current];
      adjustHeight();
    } else if (e.key === 'ArrowDown' && historyIndex.current !== -1 && slashQuery === null) {
      const el = textareaRef.current;
      if (!el) return;
      const cursorOnLastLine = el.selectionStart === el.selectionEnd
        && el.value.indexOf('\n', el.selectionStart) === -1;
      if (!cursorOnLastLine) return;
      e.preventDefault();
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
      {atMenuOpen && (
        <div
          className={styles.slashMenu}
          style={{ left: 0, ...(menuMaxHeight != null ? { maxHeight: menuMaxHeight } : {}) }}
          data-testid="at-menu"
        >
          {navCount === 0 && filesLoading && (
            <div className={styles.slashMenuEmpty}>Loading...</div>
          )}
          {showUpRow && (
            <div
              data-testid="at-menu-up"
              className={[styles.slashMenuItem, styles.fileRow, highlightIndex === 0 ? styles.slashMenuItemActive : ''].filter(Boolean).join(' ')}
              onMouseDown={e => { e.preventDefault(); goUp(fileParent!); }}
              title={fileParent ? `Up to ${fileParent}` : 'Up to the workspace root'}
            >
              <UpIcon />
              <span className={styles.fileName}>..</span>
              <span className={styles.fileParent}>
                <bdi className={styles.fileParentText}>{fileParent || '/'}</bdi>
              </span>
            </div>
          )}
          {visibleHits.map((hit, hitIdx) => {
            const i = showUpRow ? hitIdx + 1 : hitIdx;
            return (
            <div
              key={hit.rel}
              data-testid="at-menu-item"
              data-rel={hit.rel}
              ref={i === highlightIndex ? el => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              className={[styles.slashMenuItem, styles.fileRow, i === highlightIndex ? styles.slashMenuItemActive : ''].filter(Boolean).join(' ')}
              // onMouseDown, not onClick: a click would blur the textarea first and the
              // caret-relative getAtContext() would then have nothing to replace.
              onMouseDown={e => { e.preventDefault(); selectFile(hit); }}
              title={hit.rel}
            >
              {hit.isDir ? <FolderIcon /> : <FileTypeIcon name={hit.name} />}
              <span className={styles.fileName}>{hit.name}{hit.isDir ? '/' : ''}</span>
              {/* A folder mention inlines every file underneath it, so the count is the
                  only warning the user gets before committing to that. */}
              {hit.isDir && hit.childCount != null && (
                <span className={styles.fileCount}>{hit.childCount}</span>
              )}
              {/* Two elements on purpose. The outer is direction:rtl so the ellipsis eats
                  the HEAD of a deep path and leaves the folder the file is actually in.
                  But an RTL paragraph reorders the NEUTRAL characters at each end, which
                  rendered `.vscode/` as `/vscode.`; putting the isolate on the same element
                  does not help, since the class then forces the isolate itself to RTL. The
                  inner one restores LTR for the text, the outer keeps the truncation side. */}
              <span className={styles.fileParent}>
                <bdi className={styles.fileParentText}>{hit.parent}</bdi>
              </span>
            </div>
            );
          })}
          {filesTruncated && (
            <div className={styles.slashMenuEmpty}>Too many matches - keep typing to narrow</div>
          )}
        </div>
      )}
      {slashQuery !== null && (
        <div className={styles.slashMenu} style={{ left: 0 }}>
          <div className={styles.slashMenuHeader}>Slash Commands</div>
          {filteredSkills.length === 0 && !showModelAction && !showAccountAction && (
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
              <span className={[styles.slashMenuName, skill.kind === 'command' ? styles.slashMenuNameCustom : ''].filter(Boolean).join(' ')}>/{skill.name}</span>
              {skill.description && <span className={styles.slashMenuDesc}>{skill.description.length > 100 ? skill.description.slice(0, 100) + '...' : skill.description}</span>}
              {skill.scope !== 'builtin' && (
                <span className={[styles.slashMenuScope, skill.scope === 'project' ? styles.slashMenuScopeProject : ''].filter(Boolean).join(' ')}>{skill.scope}</span>
              )}
            </div>
          ))}
          {(showModelAction || showAccountAction) && (
            <div className={styles.slashMenuHeader}>Model</div>
          )}
          {showModelAction && (
            <>
              <div
                ref={highlightIndex === modelActionIndex ? el => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                className={[styles.slashMenuItem, highlightIndex === modelActionIndex ? styles.slashMenuItemActive : ''].filter(Boolean).join(' ')}
                onMouseDown={e => e.preventDefault()}
                onClick={openModelPicker}
              >
                <span className={styles.slashMenuName}>Switch model...</span>
                <span className={styles.slashMenuHint}>{(() => {
                  const all = [makeDefaultEntry(runtimeDefaultModel), ...(fetchedModels ?? FALLBACK_MODELS)];
                  const found = all.find(m => sameModel(m.id, currentModel));
                  return found ? found.displayName.replace(/^Claude /, '') : (currentModel || 'Default');
                })()}</span>
              </div>
              {modelPickerOpen && (
                modelsLoading ? (
                  <div className={styles.slashMenuEmpty}>Loading models...</div>
                ) : modelsError && !fetchedModels ? (
                  <div className={styles.slashMenuEmpty}>Failed to load: {modelsError}</div>
                ) : (
                  [makeDefaultEntry(runtimeDefaultModel), ...(fetchedModels ?? FALLBACK_MODELS)].map(m => (
                    <div
                      key={m.id || '__default__'}
                      className={styles.slashMenuItem}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => pickModel(m.id)}
                    >
                      <span className={styles.slashMenuCheck}>{sameModel(m.id, currentModel) ? '✓' : ''}</span>
                      <div className={styles.slashMenuModelInfo}>
                        <span className={styles.slashMenuName}>{m.displayName}</span>
                        {m.description && <span className={styles.slashMenuModelDesc}>{m.description}</span>}
                      </div>
                    </div>
                  ))
                )
              )}
            </>
          )}
          {showModelAction && !modelPickerOpen && (
            <>
              <div
                className={styles.slashMenuControl}
                onMouseDown={e => e.preventDefault()}
              >
                <span className={styles.slashMenuName}>Effort ({currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1)})</span>
                <div className={styles.slashMenuDots}>
                  {EFFORT_LEVELS.map(level => (
                    <span
                      key={level}
                      title={level.charAt(0).toUpperCase() + level.slice(1)}
                      className={[styles.slashMenuDot, level === (EFFORT_LEVELS.includes(currentEffort as EffortLevel) ? currentEffort : 'high') ? styles.slashMenuDotActive : ''].filter(Boolean).join(' ')}
                      onClick={() => { postMessage({ type: 'switchEffort', effort: level }); }}
                    />
                  ))}
                </div>
              </div>
              <div
                className={styles.slashMenuControl}
                onMouseDown={e => e.preventDefault()}
                onClick={() => postMessage({ type: 'switchThinking', thinking: !thinkingEnabled })}
              >
                <span className={styles.slashMenuName}>Thinking</span>
                <div className={[styles.slashMenuToggleTrack, thinkingEnabled ? styles.slashMenuToggleTrackOn : ''].filter(Boolean).join(' ')}>
                  <div className={[styles.slashMenuToggleThumb, thinkingEnabled ? styles.slashMenuToggleThumbOn : ''].filter(Boolean).join(' ')} />
                </div>
              </div>
            </>
          )}
          {showAccountAction && (
            <div
              ref={highlightIndex === accountActionIndex ? el => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              className={[styles.slashMenuItem, highlightIndex === accountActionIndex ? styles.slashMenuItemActive : ''].filter(Boolean).join(' ')}
              onMouseDown={e => e.preventDefault()}
              onClick={openAccountUsage}
            >
              <span className={styles.slashMenuName}>Account &amp; usage...</span>
            </div>
          )}
        </div>
      )}
      <div
        className={styles.inputWrapper}
        ref={wrapperRef}
        style={wrapperHeight !== null ? { height: wrapperHeight } : undefined}
      >
        <div className={[styles.editorStack, images.length > 0 && styles.hasImages].filter(Boolean).join(' ')}>
          <div className={styles.highlight} ref={highlightRef} aria-hidden="true">
            {renderHighlight(text)}
          </div>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            placeholder={PLACEHOLDER_TEXT}
            rows={images.length > 0 ? TEXTAREA_ROWS_WITH_IMAGES : TEXTAREA_ROWS_DEFAULT}
            onInput={() => { adjustHeight(); updateSlashState(); updateAtState(); }}
            // Arrow keys and clicks move the caret without firing onInput, and the "@"
            // query is caret-relative, so the menu would keep showing hits for a run the
            // cursor has already left.
            onSelect={() => updateAtState()}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={() => setSlashQuery(null)}
            onScroll={e => { if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop; }}
          />
        </div>
        {images.length > 0 && (
          <div className={styles.imagePreviews} onMouseDown={e => { e.preventDefault(); textareaRef.current?.focus(); }}>
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
        {!wsClosedByPeer && (
          <span
            className={[styles.wsDot, wsConnected ? styles.wsDotOn : styles.wsDotOff].join(' ')}
            data-testid="ws-dot"
            title={wsConnected ? 'Connected' : 'Disconnected, reconnecting...'}
          />
        )}
      </div>
      {/* A connection closed from another panel's client list never comes back by itself,
          so the pulsing "reconnecting" dot would be a standing lie - it is replaced by the
          button that brings it back, published by the bridge (one file, all three hosts).
          It sits OUTSIDE .inputWrapper on purpose: that box is `overflow: hidden`, which
          clips anything at a negative offset - the dot survives as a visible sliver, but a
          button clipped that way has its clickable centre outside itself, and the click
          lands on .inputArea instead (caught by the integration spec, not by the eye). */}
      {wsClosedByPeer && (
        <button
          className={styles.wsReconnect}
          data-testid="ws-reconnect"
          title="Disconnected from another panel. Click to reconnect."
          onClick={() => window.argusReconnect?.()}
        >
          Reconnect
        </button>
      )}
      <div className={styles.btnGroup}>
        <div className={styles.btnRow}>
          <button
            className={[styles.modePill, mode === 'plan' ? styles.modePlan : ''].filter(Boolean).join(' ')}
            onClick={() => setMode(m => m === 'edit' ? 'plan' : 'edit')}
            title={mode === 'edit' ? 'Switch to Plan mode' : 'Switch to Edit mode'}
          >
            {mode === 'edit' ? 'Edit' : 'Plan'}
          </button>
          {bgTasks > 0 && (
            // The one durable home for the pending count. The per-message note reports what
            // a *finished* turn left behind and is rewritten away by the next turn, so in a
            // watch session it is visible nowhere; this says what is running right now and
            // clears itself when the tasks report back. Static on purpose, like that note:
            // a spinner here would run for the hours a dev server or a CDP browser lives.
            <span
              className={styles.bgPill}
              data-testid="bg-tasks-pill"
              title={`${plural(bgTasks, 'background task')} running now.\nStarted with run_in_background; each reports back when it completes.`}
            >
              ✻ {bgTasks}
            </span>
          )}
          {contextUsage && (
            <span
              className={[styles.contextPill, contextUsage.percent >= 80 ? styles.contextHigh : contextUsage.percent >= 50 ? styles.contextMedium : ''].filter(Boolean).join(' ')}
              title={`${contextUsage.percent}% used\nInput: ${contextUsage.inputTokens.toLocaleString()} tokens\nOutput: ${contextUsage.outputTokens.toLocaleString()} tokens${contextUsage.contextWindow ? `\nWindow: ${contextUsage.contextWindow.toLocaleString()} tokens` : ''}`}
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
        <div className={styles.sendRow}>
          <button className={styles.btnSend} onClick={send} title="Send" aria-label="Send">
            <svg width="16" height="20" viewBox="0 0 16 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M8 17V3M8 3L3.5 7.5M8 3L12.5 7.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {isStreaming && (
            <button className={styles.btnStop} onClick={() => { postMessage({ type: 'stop' }); onStop?.(); }} title="Stop" aria-label="Stop">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <rect x="1" y="1" width="10" height="10" rx="1"/>
              </svg>
            </button>
          )}
        </div>
      </div>
      {viewerIndex !== null && images[viewerIndex] && (
        <ImageViewerModal
          src={`data:${images[viewerIndex].mediaType};base64,${images[viewerIndex].data}`}
          alt={`Attachment ${viewerIndex + 1}`}
          onClose={() => setViewerIndex(null)}
        />
      )}
      {accountUsageOpen && <AccountUsageModal onClose={() => setAccountUsageOpen(false)} currentModel={currentModel} currentEffort={currentEffort} thinkingEnabled={thinkingEnabled} />}
    </div>
  );

  function removeImage(index: number) {
    setImages(prev => prev.filter((_, i) => i !== index));
  }
}
