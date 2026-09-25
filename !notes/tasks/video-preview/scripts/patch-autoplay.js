// Turns on autoplay for the preview player (user's call, overriding the earlier
// no-autoplay decision). CRLF-aware, like the other patches against this file.
const fs = require('fs');

const FILE = 'd:/_Projects/scub111g/argus/webview/src/components/FileViewerModal.tsx';
const crlf = (s) => s.split('\n').join('\r\n');

const edits = [
  // The doc comment made a promise the code no longer keeps.
  [
    ` * \`preload="metadata"\` is what makes the timeline appear without pulling the file -
 * the browser fetches the header, learns the duration, and then fetches only what is
 * played. No autoplay: this opens inside a chat panel, and a video that starts talking
 * on its own is worse than one extra click.
 */`,
    ` * \`preload="metadata"\` is what makes the timeline appear without pulling the file -
 * the browser fetches the header, learns the duration, and then fetches only what is
 * played.
 *
 * It autoplays. Opening the preview is itself a deliberate click, which is also what
 * makes it *work*: Chrome permits unmuted autoplay while the document has user
 * activation, so a video opened from a link in the transcript starts with sound. A
 * preview opened with no gesture at all (the \`?file=\` launch param on a cold page) is
 * blocked by that same policy and simply sits paused behind its controls - deliberately
 * not worked around by muting, since a silent concert clip is a worse answer than a
 * visible play button.
 */`,
  ],
  [
    `      <video
        className={styles.videoEl}
        src={frame.src}
        controls
        playsInline
        preload="metadata"`,
    `      <video
        className={styles.videoEl}
        src={frame.src}
        controls
        autoPlay
        playsInline
        preload="metadata"`,
  ],
  [
    `        <audio
          className={styles.audioEl}
          src={frame.src}
          controls
          preload="metadata"`,
    `        <audio
          className={styles.audioEl}
          src={frame.src}
          controls
          autoPlay
          preload="metadata"`,
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
fs.writeFileSync(FILE, src);
console.log(`applied ${edits.length} edits`);
