// Idempotent: add the two index rows this task needs, writing the common-doc row
// byte-identical into common/INDEX.md and the root INDEX.md in one run (hand-editing
// the two copies separately is exactly how they drift).
const fs = require('fs');

const COMMON_SUMMARY = 'Answer every request exactly once, including on failure: two `.catch(() => {})` made a handler send **zero** frames, leaving the modal on "Loading..." forever with nothing to time out; `execFile`/`spawn` throw **synchronously** when the OS refuses a process, which rejects a promise documented as always resolving, so guard them like `handleSend` does; the probe that proves it only works against the **compiled** bundle, because ESM binds the import and the same patch silently does nothing';
const TOPIC = 'Answering a client request that failed';

function addRow(file, line, marker) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(marker)) { console.log('already present:', file); return; }
  const lines = src.split(/\r?\n/);
  // Insert after the last table row of the first table that already has rows.
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trimStart().startsWith('|') && lines[i].includes('](')) last = i;
  if (last < 0) { console.error('no table row found in', file); process.exit(1); }
  lines.splice(last + 1, 0, line);
  fs.writeFileSync(file, lines.join('\n'));
  console.log('added row to', file);
}

addRow('!notes/common/INDEX.md',
  `| [request-reply-invariant.md](request-reply-invariant.md) | ${TOPIC} | ${COMMON_SUMMARY} |`,
  'request-reply-invariant.md');

addRow('!notes/INDEX.md',
  `| [request-reply-invariant.md](common/request-reply-invariant.md) | ${TOPIC} | ${COMMON_SUMMARY} |`,
  'request-reply-invariant.md');

addRow('!notes/tasks/INDEX.md',
  '| [dir-preview/](dir-preview/) | backend/filePreview, webview/FileViewerModal+PreviewContext+FolderList+fileIcon+filePath+markdown+path, e2e | A clicked directory path rendered `EISDIR` instead of a listing, and the link covered only `C:\Users\Admin\.claude` rather than the folder the sentence named. Directory preview now reuses the Browse tab rows (files included, capped at 1000) with Seti-style file icons; the Windows path branch drops the extension requirement (slash branches tried and reverted - a URL path in prose is shaped exactly like a directory). Five pre-existing spec failures found and routed to their owning notes |',
  'dir-preview/');
