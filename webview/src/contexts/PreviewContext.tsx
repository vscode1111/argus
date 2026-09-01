import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
  | { kind: 'path'; key?: string; path: string; line?: number }
  /** The image a tool call returned, fetched from the transcript by tool_use_id. The
   *  bytes are not in the message (they are stripped before it crosses the wire), and
   *  the transcript copy outlives the file, which may have moved since. */
  | { kind: 'toolImage'; key?: string; path: string; toolUseId: string };

/** A request that can actually be rendered (content already resolved). */
type OpenEntry = Exclude<PreviewRequest, { kind: 'path' | 'toolImage' }>;

/** A request whose content the host still has to fetch. */
type PendingEntry = Extract<PreviewRequest, { kind: 'path' | 'toolImage' }>;

/**
 * A frame on the stack. `loadId` marks one opened before its content existed: the
 * modal is on screen (title, spinner) while the host reads, and the reply fills this
 * exact frame in - by id, because the user may have opened another preview meanwhile.
 */
type Frame = OpenEntry & { loading?: boolean; loadId?: number };

export interface PreviewApi {
  open: (req: PreviewRequest) => void;
  /** Replace an already-open preview in place; a no-op unless its `key` is open. */
  refresh: (req: OpenEntry) => void;
}

/** How long before an unanswered fetch is reported instead of spinning on. */
const PREVIEW_TIMEOUT_MS = 20_000;

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
  const [stack, setStack] = useState<Frame[]>([]);
  const [pending, setPending] = useState<{ req: PendingEntry; loadId: number } | null>(null);
  const nextLoadId = useRef(0);

  const open = useCallback((req: PreviewRequest) => {
    if (req.kind === 'path' || req.kind === 'toolImage') {
      // Open the modal now and fill it in when the host answers. The click is what the
      // user acted on, so the window has to appear on it: an image no longer travels
      // inside the message, and over a remote link waiting for the bytes before showing
      // anything left the click looking ignored for a second or more.
      const loadId = ++nextLoadId.current;
      setStack(prev => [...prev, {
        kind: 'file',
        key: req.key,
        path: req.path,
        content: '',
        line: req.kind === 'path' ? req.line : undefined,
        loading: true,
        loadId,
      }]);
      setPending({ req, loadId });
    } else {
      setStack(prev => [...prev, req]);
    }
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

  // Fill the frame opened above once the host answers. Matching is by loadId, so a
  // second preview opened while this one is in flight cannot be overwritten by it.
  useEffect(() => {
    if (!pending) return;
    const { req, loadId } = pending;
    const wanted = req.path;
    const settle = (path: string, content: string) => {
      // A closed modal leaves no frame with this id, so this is simply a no-op then.
      setStack(prev => prev.map(f => (f.loadId === loadId
        ? { ...f, path, content, loading: false }
        : f)));
      setPending(null);
    };
    function onMessage(e: MessageEvent) {
      if (typeof e.data?.content !== 'string') return;
      const got: string = e.data.path ?? '';
      if (req.kind === 'toolImage') {
        // Matched on the tool call id, which is exact - the path is only a caption
        // here, and the answer may even be the disk fallback for a different one.
        if (e.data.type !== 'toolImage' || e.data.toolUseId !== req.toolUseId) return;
      } else {
        // The backend answers with the resolved absolute path, which a relative or
        // slash-flipped request will only match by suffix.
        if (e.data.type !== 'filePreview') return;
        if (got !== wanted && !got.endsWith(wanted) && !got.endsWith(wanted.replace(/\//g, '\\'))) return;
      }
      settle(got || wanted, e.data.content);
    }
    window.addEventListener('message', onMessage);
    postMessage(req.kind === 'toolImage'
      ? { type: 'readToolImage', toolUseId: req.toolUseId, path: wanted }
      : { type: 'readFilePreview', path: wanted });

    // The host answers even when the read failed (the error arrives as the content), so
    // silence means the message or the reply was lost - a dropped socket, most likely.
    // Say so instead of spinning forever, which reads as a hang rather than a failure.
    const giveUp = window.setTimeout(
      () => settle(wanted, 'Timed out waiting for this preview. The connection may have dropped - close this and click again.'),
      PREVIEW_TIMEOUT_MS,
    );

    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(giveUp);
    };
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
            loading={req.loading}
            onClose={() => closeFrom(i)}
          />
      ))}
    </PreviewContext.Provider>
  );
}
