import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { postMessage } from '../vscode';
import { FileViewerModal } from '../components/FileViewerModal';
import { DiffViewerModal } from '../components/DiffViewerModal';
import { PreviewEntry } from '../types';
import { matchesRequestedPath } from '../utils/path';
import { formatBytes, mediaKindFor, mediaSrc, type MediaKind } from '../utils/media';

/**
 * What to preview. `key` (a tool call id) identifies the thing being shown, so a
 * result that lands after the modal was opened can refresh it in place.
 */
export type PreviewRequest =
  | { kind: 'file'; key?: string; path: string; content: string; line?: number; copyText?: string }
  | { kind: 'diff'; key?: string; path: string; oldString: string; newString: string }
  /** The clicked path turned out to be a folder; only the host can tell, so this
   *  kind is never opened directly - a 'path' request settles into it. */
  | { kind: 'dir'; key?: string; path: string; entries: PreviewEntry[]; parent?: string; truncated?: number }
  /** No content in hand: the host reads the file and opens once it arrives. */
  | { kind: 'path'; key?: string; path: string; line?: number }
  /** Audio or video, played from the media endpoint. `src` is a granted URL, not bytes:
   *  the file is streamed with Range requests so a 21MB video starts at once and seeks
   *  without downloading the rest. A 'path' request settles into this. */
  | { kind: 'media'; key?: string; path: string; media: MediaKind; mediaType: string; src: string; size: number }
  /** A file there is nothing to render for - a binary, or media that could not be
   *  granted. Says what it is and how big rather than showing its bytes as text. */
  | { kind: 'info'; key?: string; path: string; title: string; detail: string }
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
    // Media never goes through readFilePreview: the bytes would have to cross the
    // WebSocket to get here, which is exactly what made a 21MB video unplayable. Ask
    // for a streaming grant instead, and let the browser's own player fetch it.
    const wantsMedia = req.kind === 'path' && mediaKindFor(req.path) !== null;

    // Replace the frame this request opened. A closed modal leaves no frame with this
    // id, so it is simply a no-op then.
    const settle = (patch: (f: Frame) => Frame) => {
      setStack(prev => prev.map(f => (f.loadId === loadId ? patch(f) : f)));
      setPending(null);
    };
    const settleText = (path: string, content: string) =>
      settle(f => ({ ...f, kind: 'file', path, content, loading: false } as Frame));

    function onMessage(e: MessageEvent) {
      const got: string = e.data?.path ?? '';
      if (wantsMedia) {
        if (e.data?.type !== 'mediaGrant' || !matchesRequestedPath(got, wanted)) return;
        if (!e.data.token) {
          // The host answers either way, so this is a real refusal (gone, unreadable,
          // outside the workspace), not silence - say which, rather than spinning.
          settleText(got || wanted, `Cannot play this file: ${e.data.error ?? 'no media grant'}`);
          return;
        }
        settle(f => ({
          kind: 'media',
          key: f.key,
          loadId,
          path: got || wanted,
          media: e.data.kind === 'audio' ? 'audio' : 'video',
          mediaType: String(e.data.mediaType || ''),
          size: Number(e.data.size) || 0,
          src: mediaSrc(String(e.data.token), Number(e.data.port) || 0),
        }));
        return;
      }
      if (typeof e.data?.content !== 'string') return;
      if (req.kind === 'toolImage') {
        // Matched on the tool call id, which is exact - the path is only a caption
        // here, and the answer may even be the disk fallback for a different one.
        if (e.data.type !== 'toolImage' || e.data.toolUseId !== req.toolUseId) return;
      } else {
        // The backend answers with the resolved absolute path, which a relative or
        // slash-flipped request will only match by suffix (and a directory request
        // carries a trailing separator the resolution drops).
        if (e.data.type !== 'filePreview') return;
        if (!matchesRequestedPath(got, wanted)) return;
      }
      // A listing: this is a folder, not a file. The frame changes kind - it was opened
      // optimistically as a file, before anyone knew which it was.
      if (Array.isArray(e.data.entries)) {
        const dir = e.data;
        settle(f => ({
          kind: 'dir', key: f.key, path: got || wanted, entries: dir.entries, loadId,
          parent: typeof dir.parent === 'string' ? dir.parent : undefined,
          truncated: typeof dir.truncated === 'number' ? dir.truncated : undefined,
        }));
        return;
      }
      // Nothing renderable as text. Reachable when this client's media list and the
      // host's have drifted (an older daemon), and for every other binary: a .zip read
      // as UTF-8 is the same defect that made the video unplayable.
      if (e.data.binary || e.data.media) {
        const size = Number(e.data.binary?.size ?? e.data.media?.size) || 0;
        settle(f => ({
          kind: 'info', key: f.key, loadId, path: got || wanted,
          title: e.data.media ? `${e.data.media.kind === 'audio' ? 'Audio' : 'Video'} file` : 'Binary file',
          detail: `${formatBytes(size)} · nothing to display as text`,
        }));
        return;
      }
      settleText(got || wanted, e.data.content);
    }
    window.addEventListener('message', onMessage);
    postMessage(wantsMedia
      ? { type: 'mediaUrl', path: wanted }
      : req.kind === 'toolImage'
        ? { type: 'readToolImage', toolUseId: req.toolUseId, path: wanted }
        : { type: 'readFilePreview', path: wanted });

    // The host answers even when the read failed (the error arrives as the content), so
    // silence means the message or the reply was lost - a dropped socket, most likely.
    // Say so instead of spinning forever, which reads as a hang rather than a failure.
    const giveUp = window.setTimeout(
      () => settleText(wanted, 'Timed out waiting for this preview. The connection may have dropped - close this and click again.'),
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
      {stack.map((req, i) => {
        if (req.kind === 'diff') {
          return (
            <DiffViewerModal
              key={i}
              path={req.path}
              oldString={req.oldString}
              newString={req.newString}
              onClose={() => closeFrom(i)}
            />
          );
        }
        const dir = req.kind === 'dir' ? req : undefined;
        const file = req.kind === 'file' ? req : undefined;
        const media = req.kind === 'media' ? req : undefined;
        const info = req.kind === 'info' ? req : undefined;
        return (
          <FileViewerModal
            key={i}
            path={req.path}
            content={file?.content ?? ''}
            line={file?.line}
            copyText={file?.copyText}
            entries={dir?.entries}
            dirParent={dir?.parent}
            truncated={dir?.truncated}
            media={media}
            info={info}
            loading={req.loading}
            onClose={() => closeFrom(i)}
          />
        );
      })}
    </PreviewContext.Provider>
  );
}
