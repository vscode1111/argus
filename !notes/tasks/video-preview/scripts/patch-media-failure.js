// Makes the player's failure card tell the truth.
//
// It blamed the codec for every failure, including a 404 - which a media element reports
// with the SAME code as an undecodable container, so the element alone cannot tell them
// apart. Grants live in the server's memory and the daemon idle-exits, so "the link
// expired" is the common failure, and "no decoder for this codec" sends the viewer off
// to find a converter for a file that is perfectly fine.
const fs = require('fs');

const FILE = 'd:/_Projects/scub111g/argus/webview/src/components/FileViewerModal.tsx';
const crlf = (s) => s.split('\n').join('\r\n');

const edits = [
  [
    `import { formatBytes, mediaKindFor, mediaSrc, type MediaKind } from '../utils/media';`,
    `import { diagnoseMediaFailure, formatBytes, mediaKindFor, mediaSrc, type MediaKind } from '../utils/media';`,
  ],
  [
    `function MediaBody({ frame, filename }: { frame: MediaFrame; filename: string }) {
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
  }`,
    `function MediaBody({ frame, filename }: { frame: MediaFrame; filename: string }) {
  // Anything that stops playback surfaces here rather than at grant time - a codec the
  // browser lacks, but equally an expired link or a dropped connection. Which of those
  // it was cannot be read off the element, so the card waits for the diagnosis.
  const [failure, setFailure] = useState<{ title: string; hint: string } | null>(null);
  useEffect(() => { setFailure(null); }, [frame.src]);

  const onError = useCallback(() => {
    let live = true;
    diagnoseMediaFailure(frame.src, frame.media).then((f) => { if (live) setFailure(f); });
    return () => { live = false; };
  }, [frame.src, frame.media]);

  if (failure) {
    return (
      <div className={styles.infoBody} data-testid="media-unsupported">
        <div className={styles.infoTitle}>{failure.title}</div>
        <div className={styles.infoDetail}>{formatBytes(frame.size)} · {frame.mediaType || 'unknown format'}</div>
        <div className={styles.infoHint}>{failure.hint}</div>
      </div>
    );
  }`,
  ],
  [
    `          controls
          autoPlay
          preload="metadata"
          onError={() => setFailed(true)}
        />`,
    `          controls
          autoPlay
          preload="metadata"
          onError={onError}
        />`,
  ],
  [
    `        aria-label={\`Video: \${filename}\`}
        onError={() => setFailed(true)}
      />`,
    `        aria-label={\`Video: \${filename}\`}
        onError={onError}
      />`,
  ],
];

let src = fs.readFileSync(FILE, 'utf-8');
let failures = 0;
for (const [from, to] of edits) {
  const needle = crlf(from);
  if (src.split(needle).length - 1 !== 1) {
    console.error(`FAIL: ${from.split('\n')[0].trim().slice(0, 60)}`);
    failures++;
    continue;
  }
  src = src.replace(needle, crlf(to));
}
if (failures) process.exit(1);

// useCallback must be imported; the file already imports several hooks.
if (!/import React, \{[^}]*useCallback/.test(src)) {
  console.error('FAIL: useCallback is not imported');
  process.exit(1);
}

fs.writeFileSync(FILE, src);
console.log(`applied ${edits.length} edits`);
