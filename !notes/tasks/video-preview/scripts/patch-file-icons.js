// Adds the video and audio glyphs to the directory-listing icon set.
// A script rather than `node -e`: multi-line replacements do not survive a double-quoted
// shell argument, and backticks in one get executed by bash before node ever sees them.
const fs = require('fs');

const ROOT = 'd:/_Projects/scub111g/argus/';
let failures = 0;

function patch(file, from, to, label) {
  const full = ROOT + file;
  const src = fs.readFileSync(full, 'utf-8');
  const crlf = /\r\n/.test(src);
  const needle = crlf ? from.split('\n').join('\r\n') : from;
  const count = src.split(needle).length - 1;
  if (count !== 1) {
    console.error(`FAIL (${count} matches): ${label}`);
    failures++;
    return;
  }
  fs.writeFileSync(full, src.replace(needle, crlf ? to.split('\n').join('\r\n') : to));
  console.log(`ok: ${label}`);
}

patch(
  'webview/src/utils/fileIcon.ts',
  `export type IconKind = 'doc' | 'code' | 'braces' | 'image' | 'archive' | 'config' | 'shell' | 'db';`,
  `export type IconKind = 'doc' | 'code' | 'braces' | 'image' | 'video' | 'audio' | 'archive' | 'config' | 'shell' | 'db';`,
  'IconKind gains video + audio',
);

patch(
  'webview/src/utils/fileIcon.ts',
  `  avif: ['image', 'purple'], svg: ['image', 'orange'],`,
  `  avif: ['image', 'purple'], svg: ['image', 'orange'],
  // Playable media, with its own glyphs and colours rather than sharing the image
  // purple: a stories folder is wall-to-wall .mp4 next to a frames/ folder of .jpg, and
  // on one colour those two are told apart only by a 15px glyph.
  mp4: ['video', 'red'], m4v: ['video', 'red'], webm: ['video', 'red'],
  ogv: ['video', 'red'], mov: ['video', 'red'], mkv: ['video', 'red'],
  avi: ['video', 'red'], mpeg: ['video', 'red'], mpg: ['video', 'red'],
  mp3: ['audio', 'green'], wav: ['audio', 'green'], m4a: ['audio', 'green'],
  ogg: ['audio', 'green'], oga: ['audio', 'green'], opus: ['audio', 'green'],
  flac: ['audio', 'green'], aac: ['audio', 'green'], weba: ['audio', 'green'],`,
  'media extension table',
);

patch(
  'webview/src/components/shared/FolderList.tsx',
  `  archive: <>
    <polyline points="21 8 21 21 3 21 3 8" />`,
  `  video: <>
    <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
    <line x1="7" y1="4" x2="7" y2="20" />
    <line x1="17" y1="4" x2="17" y2="20" />
    <line x1="2" y1="12" x2="22" y2="12" />
  </>,
  audio: <>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </>,
  archive: <>
    <polyline points="21 8 21 21 3 21 3 8" />`,
  'film + note glyphs',
);

process.exit(failures ? 1 : 0);
