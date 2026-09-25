// FileViewerModal.tsx is CRLF while most of the repo is LF, so an editor patch written
// with \n silently matches nothing. Every search/replace here is authored in LF and
// converted before use, which keeps the file's own line endings untouched (the repo
// rule is never to reformat a file as a side effect of a change).
const fs = require('fs');

const FILE = 'd:/_Projects/scub111g/argus/webview/src/components/FileViewerModal.tsx';
const crlf = (s) => s.split('\n').join('\r\n');

const edits = [
  // 1. Imports.
  [
    `import { matchesRequestedPath, vscodeFileUri } from '../utils/path';`,
    `import { matchesRequestedPath, vscodeFileUri } from '../utils/path';
import { formatBytes, mediaKindFor, mediaSrc, type MediaKind } from '../utils/media';`,
  ],

  // 2. Props + the two new frame shapes.
  [
    `interface Props {
  path: string;
  content: string;
  line?: number;
  copyText?: string;`,
    `/** A granted media stream: what to play and where from. Never the bytes themselves. */
export interface MediaFrame {
  media: MediaKind;
  mediaType: string;
  src: string;
  size: number;
}

/** A file with nothing to render - a binary, or media that could not be granted. */
export interface InfoFrame {
  title: string;
  detail: string;
}

interface Props {
  path: string;
  content: string;
  line?: number;
  copyText?: string;`,
  ],

  // 3. Props fields.
  [
    `  /** Entries the host dropped past its cap. */
  truncated?: number;
  /** Opened before its content exists: hold a spinner until the host answers. */
  loading?: boolean;
  onClose: () => void;
}`,
    `  /** Entries the host dropped past its cap. */
  truncated?: number;
  /** Set for audio/video: render a player streaming from the media endpoint. */
  media?: MediaFrame;
  /** Set when there is nothing to render: say what the file is instead. */
  info?: InfoFrame;
  /** Opened before its content exists: hold a spinner until the host answers. */
  loading?: boolean;
  onClose: () => void;
}`,
  ],

  // 4. The internal navigation stack carries media/info too, so a video opened from a
  //    directory listing inside the previewer behaves like one opened from a link.
  [
    `interface Frame {
  path: string;
  content: string;
  line?: number;
  entries?: PreviewEntry[];
  dirParent?: string;
  truncated?: number;
}`,
    `interface Frame {
  path: string;
  content: string;
  line?: number;
  entries?: PreviewEntry[];
  dirParent?: string;
  truncated?: number;
  media?: MediaFrame;
  info?: InfoFrame;
}

/**
 * The player. Native controls on purpose: play/pause, scrub, volume, fullscreen,
 * picture-in-picture and speed all come free and behave the way the viewer already
 * expects, where a hand-rolled control strip would be a lot of surface to get wrong.
 *
 * \`preload="metadata"\` is what makes the timeline appear without pulling the file -
 * the browser fetches the header, learns the duration, and then fetches only what is
 * played. No autoplay: this opens inside a chat panel, and a video that starts talking
 * on its own is worse than one extra click.
 */
function MediaBody({ frame, filename }: { frame: MediaFrame; filename: string }) {
  // A container the browser has no decoder for (much .mkv, most .avi) fails at load
  // rather than at grant time, so the honest report can only be made from here.
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [frame.src]);

  if (failed) {
    return (
      <div className={styles.infoBody} data-testid="media-unsupported">
        <div className={styles.infoTitle}>This {frame.media} cannot be played here</div>
        <div className={styles.infoDetail}>{formatBytes(frame.size)} · {frame.mediaType || 'unknown format'}</div>
        <div className={styles.infoHint}>
          The browser has no decoder for this container or codec. Open it in an external player.
        </div>
      </div>
    );
  }

  if (frame.media === 'audio') {
    return (
      <div className={styles.audioBody} data-testid="media-player">
        <audio
          className={styles.audioEl}
          src={frame.src}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
        />
        <div className={styles.mediaMeta}>{formatBytes(frame.size)} · {frame.mediaType}</div>
      </div>
    );
  }

  return (
    <div className={styles.videoBody} data-testid="media-player">
      <video
        className={styles.videoEl}
        src={frame.src}
        controls
        playsInline
        preload="metadata"
        aria-label={\`Video: \${filename}\`}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/** Nothing to render: a binary file, or media the host refused to grant. */
function InfoBody({ title, detail }: InfoFrame) {
  return (
    <div className={styles.infoBody} data-testid="preview-info">
      <div className={styles.infoTitle}>{title}</div>
      <div className={styles.infoDetail}>{detail}</div>
    </div>
  );
}`,
  ],

  // 5. Destructure the new props.
  [
    `export function FileViewerModal({ path, content, line, copyText, entries, dirParent, truncated, loading, onClose }: Props) {`,
    `export function FileViewerModal({ path, content, line, copyText, entries, dirParent, truncated, media, info, loading, onClose }: Props) {`,
  ],

  // 6. Root frame carries them.
  [
    `  const current: Frame = stack.length
    ? stack[stack.length - 1]
    : { path, content, line, entries, dirParent, truncated };`,
    `  const current: Frame = stack.length
    ? stack[stack.length - 1]
    : { path, content, line, entries, dirParent, truncated, media, info };`,
  ],

  // 7. Navigating to a media path asks for a grant, not for its bytes - the same
  //    branch PreviewContext takes, so a click here and a click on a link agree.
  [
    `  const openPath = useCallback((target: string) => {
    setPendingPath(target);
    postMessage({ type: 'readFilePreview', path: target });
  }, []);`,
    `  const openPath = useCallback((target: string) => {
    setPendingPath(target);
    postMessage(mediaKindFor(target)
      ? { type: 'mediaUrl', path: target }
      : { type: 'readFilePreview', path: target });
  }, []);`,
  ],

  // 8. ...and accepts the matching reply.
  [
    `    function onMessage(e: MessageEvent) {
      if (e.data?.type !== 'filePreview') return;
      const got: string = e.data.path ?? '';
      if (!matchesRequestedPath(got, pendingPath!)) return;
      setStack(prev => [...prev, {
        path: got || pendingPath!,
        content: e.data.content,
        entries: Array.isArray(e.data.entries) ? e.data.entries : undefined,
        dirParent: typeof e.data.parent === 'string' ? e.data.parent : undefined,
        truncated: typeof e.data.truncated === 'number' ? e.data.truncated : undefined,
      }]);
      setPendingPath(null);
    }`,
    `    function onMessage(e: MessageEvent) {
      const type = e.data?.type;
      if (type !== 'filePreview' && type !== 'mediaGrant') return;
      const got: string = e.data.path ?? '';
      if (!matchesRequestedPath(got, pendingPath!)) return;
      const push = (frame: Frame) => {
        setStack(prev => [...prev, frame]);
        setPendingPath(null);
      };
      if (type === 'mediaGrant') {
        push(e.data.token
          ? {
              path: got || pendingPath!,
              content: '',
              media: {
                media: e.data.kind === 'audio' ? 'audio' : 'video',
                mediaType: String(e.data.mediaType || ''),
                size: Number(e.data.size) || 0,
                src: mediaSrc(String(e.data.token), Number(e.data.port) || 0),
              },
            }
          : { path: got || pendingPath!, content: \`Cannot play this file: \${e.data.error ?? 'no media grant'}\` });
        return;
      }
      if (e.data.binary || e.data.media) {
        const size = Number(e.data.binary?.size ?? e.data.media?.size) || 0;
        push({
          path: got || pendingPath!,
          content: '',
          info: {
            title: e.data.media ? \`\${e.data.media.kind === 'audio' ? 'Audio' : 'Video'} file\` : 'Binary file',
            detail: \`\${formatBytes(size)} · nothing to display as text\`,
          },
        });
        return;
      }
      push({
        path: got || pendingPath!,
        content: e.data.content,
        entries: Array.isArray(e.data.entries) ? e.data.entries : undefined,
        dirParent: typeof e.data.parent === 'string' ? e.data.parent : undefined,
        truncated: typeof e.data.truncated === 'number' ? e.data.truncated : undefined,
      });
    }`,
  ],

  // 9. Derived flags: media and info render nothing text-like, so every control that
  //    acts on text has to stand down for them.
  [
    `  const dirEntries = current.entries;
  const isDir = dirEntries !== undefined;
  const isImage = isDataUrl(current.content);`,
    `  const dirEntries = current.entries;
  const isDir = dirEntries !== undefined;
  const currentMedia = current.media;
  const currentInfo = current.info;
  const isPlain = currentMedia === undefined && currentInfo === undefined;
  const isImage = isDataUrl(current.content);`,
  ],

  // 10. html detection must not fire for a non-text frame.
  [
    `  const isHtml = HTML_RE.test(current.path) && !isImage && !isDir;`,
    `  const isHtml = HTML_RE.test(current.path) && !isImage && !isDir && isPlain;`,
  ],

  // 11. Encoding select is meaningless with no text to decode.
  [
    `            {!isImage && !renderHtml && !isDir && !loading && <EncodingSelect value={encoding} onChange={setEncoding} />}`,
    `            {!isImage && !renderHtml && !isDir && !loading && isPlain && <EncodingSelect value={encoding} onChange={setEncoding} />}`,
  ],

  // 12. Render branches, ahead of the text ones.
  [
    `          ) : dirEntries ? (
            <DirListingBody`,
    `          ) : currentMedia ? (
            <MediaBody frame={currentMedia} filename={filename} />
          ) : currentInfo ? (
            <InfoBody title={currentInfo.title} detail={currentInfo.detail} />
          ) : dirEntries ? (
            <DirListingBody`,
  ],
];

let src = fs.readFileSync(FILE, 'utf-8');
let failures = 0;
for (const [from, to] of edits) {
  const needle = crlf(from);
  const count = src.split(needle).length - 1;
  if (count !== 1) {
    console.error(`FAIL (${count} matches): ${from.split('\n')[0].slice(0, 70)}`);
    failures++;
    continue;
  }
  src = src.replace(needle, crlf(to));
}
if (failures) {
  console.error(`\n${failures} edit(s) did not apply - file left untouched.`);
  process.exit(1);
}
fs.writeFileSync(FILE, src);
console.log(`applied ${edits.length} edits, CRLF preserved`);
