import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { postMessage } from '../vscode';
import { FileViewerModal } from '../components/FileViewerModal';
import { DiffViewerModal } from '../components/DiffViewerModal';

/**
 * What to preview. `key` (a tool call id) identifies the thing being shown, so a
 * result that lands after the modal was opened can refresh it in place.
 */
export type PreviewRequest =
  | { kind: 'file'; key?: string; path: string; content: string; line?: number; copyText?: string }
  | { kind: 'diff'; key?: string; path: string; oldString: string; newString: string }
  /** No content in hand: the host reads the file and opens once it arrives. */
  | { kind: 'path'; key?: string; path: string; line?: number };

/** A request that can actually be rendered (content already resolved). */
type OpenEntry = Exclude<PreviewRequest, { kind: 'path' }>;

export interface PreviewApi {
  open: (req: PreviewRequest) => void;
  /** Replace an already-open preview in place; a no-op unless its `key` is open. */
  refresh: (req: OpenEntry) => void;
}

const PreviewContext = createContext<PreviewApi>({ open: () => {}, refresh: () => {} });

export const usePreview = () => useContext(PreviewContext);

/**
 * Owns every file/diff/image preview for the whole app.
 *
 * The open state deliberately does NOT live in the component that was clicked.
 * A tool block is rendered by StreamingMessage while its turn runs and by
 * ChatMessage once the turn is committed, so the clicked component is unmounted
 * the moment the turn finishes - which used to close the modal under the user's
 * cursor mid-read. Hoisting the state above the message list makes the preview
 * outlive whatever churn happens behind it; only the user closes it.
 */
export function PreviewProvider({ children }: { children: React.ReactNode }) {
  // A stack, not a single slot: previewed markdown linkifies file paths too, so a
  // path clicked inside a preview opens on top of it instead of replacing it.
  const [stack, setStack] = useState<OpenEntry[]>([]);
  const [pending, setPending] = useState<Extract<PreviewRequest, { kind: 'path' }> | null>(null);

  const open = useCallback((req: PreviewRequest) => {
    if (req.kind === 'path') setPending(req);
    else setStack(prev => [...prev, req]);
  }, []);

  const refresh = useCallback((req: OpenEntry) => {
    if (!req.key) return;
    // Same array reference when nothing matches, so React bails out instead of
    // re-rendering the provider on every tool result that lands.
    setStack(prev => (prev.some(e => e.key === req.key)
      ? prev.map(e => (e.key === req.key ? req : e))
      : prev));
  }, []);

  const api = useMemo<PreviewApi>(() => ({ open, refresh }), [open, refresh]);

  // A path-only request: ask the backend for the content and open once it lands,
  // so nothing flashes an empty modal while the read is in flight.
  useEffect(() => {
    if (!pending) return;
    const wanted = pending.path;
    function onMessage(e: MessageEvent) {
      if (e.data?.type !== 'filePreview' || typeof e.data.content !== 'string') return;
      // The backend answers with the resolved absolute path, which a relative or
      // slash-flipped request will only match by suffix.
      const got: string = e.data.path ?? '';
      if (got !== wanted && !got.endsWith(wanted) && !got.endsWith(wanted.replace(/\//g, '\\'))) return;
      setStack(prev => [...prev, {
        kind: 'file',
        key: pending!.key,
        path: got || wanted,
        content: e.data.content,
        line: pending!.line,
      }]);
      setPending(null);
    }
    window.addEventListener('message', onMessage);
    postMessage({ type: 'readFilePreview', path: wanted });
    return () => window.removeEventListener('message', onMessage);
  }, [pending]);

  // Closing a frame drops everything opened on top of it too.
  const closeFrom = useCallback((i: number) => setStack(prev => prev.slice(0, i)), []);

  return (
    <PreviewContext.Provider value={api}>
      {children}
      {stack.map((req, i) => (req.kind === 'diff'
        ? <DiffViewerModal
            key={i}
            path={req.path}
            oldString={req.oldString}
            newString={req.newString}
            onClose={() => closeFrom(i)}
          />
        : <FileViewerModal
            key={i}
            path={req.path}
            content={req.content}
            line={req.line}
            copyText={req.copyText}
            onClose={() => closeFrom(i)}
          />
      ))}
    </PreviewContext.Provider>
  );
}
