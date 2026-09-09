// Rewrites the ui-that-reads-as-broken.md Summary cell in BOTH index copies in one run, so the
// two cannot drift. The rows are byte-identical apart from the link path, so the same anchor and
// the same replacement apply to each. Idempotent: exits quietly once MARKER is present.
//
// In a file rather than `node -e` on purpose: the payload carries backticks and hyphens that get
// mangled crossing shell quoting, and the failure mode is a silent no-op.
const fs = require('fs');

const FILES = ['!notes/common/INDEX.md', '!notes/INDEX.md'];
const ANCHOR = 'neither is caught by layout or logic assertions, so compare computed colours and assert the reason text';
const MARKER = 'proportion to their content width';
const REPLACEMENT = ANCHOR +
  '; a flex row shrinks its items in proportion to their content width, so a short label beside a very long one is crushed to a few characters at every window width (name the item that is meant to truncate: `flex-shrink: 0` plus a `max-width` cap, never a bare `flex: 1 1 0` on its neighbour); and work that outlives the turn that reported it needs something on screen still moving, or a correct frozen state and a dead session render identically - a count-up from a past timestamp is allowed where a spinner is not, and with no timestamp render nothing rather than starting a clock at zero';

let changed = 0;
for (const f of FILES) {
  const before = fs.readFileSync(f, 'utf8');
  if (before.includes(MARKER)) { console.log('SKIP (already applied):', f); continue; }
  if (!before.includes(ANCHOR)) { console.log('NOT FOUND - anchor missing, nothing written:', f); continue; }
  fs.writeFileSync(f, before.replace(ANCHOR, REPLACEMENT));
  console.log('UPDATED:', f);
  changed++;
}
console.log('files changed:', changed);
