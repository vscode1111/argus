# Rendered preview for .html files

| | |
|---|---|
| Requested | 2026-09-02, from session `db2aea7b-0b20-45cd-bc5e-eae83dad630a` (`d:\_Projects\scub111g\people-research`) |
| Produced by | Claude Code, model claude-opus-5 |
| Status | Implemented, tests green (mock), not committed |

## Problem

Clicking a Read of an exported `.html` document opened the previewer on its **markup**:
45 visible lines of `<td>`, `<th>` and `mermaid.initialize`. The file is a document the
user hands over (a psychologist's brief exported from markdown), so the useful view is the
page, not the source. Markdown files already render; HTML did not.

## Change

`webview/src/components/FileViewerModal.tsx`:

- `.html`/`.htm` renders by default, in a **`<iframe srcDoc sandbox="">`**.
- A `Source` / `Preview` button in the header (`modal.btnOpen`, next to the encoding
  select) switches views; the encoding select hides while rendering, since there is no
  text on screen to re-decode.
- **An `offset` does not switch to Source** (corrected the same day, see below).
- **The document is repainted in the panel's theme** (asked for right after the first
  render landed). `darkThemeStyle()` builds a stylesheet from the live panel's own custom
  properties - `--bg`, `--fg`, `--border`, `--tool-bg`, `--vscode-textLink-foreground`,
  `--thinking-fg` - resolved in JS, because a sandboxed `srcdoc` frame cannot see the
  parent's variables. It is **appended after** the file's markup, not injected into its
  head: a style before the doctype would trigger quirks mode, and coming last it wins
  every specificity tie; `!important` covers the document's own rules (a markdown export
  ships VS Code's markdown.css, which paints its own colours). Applied only when the panel
  is dark - in a light theme the document's own styling is already right.
- `.htmlFrame` uses `var(--bg)` rather than white, so the frame itself matches while the
  document loads.

The reusable half of all this - privilege, theming, and how to test a frame you cannot
script - is in [../../common/embedded-document-previews.md](../../common/embedded-document-previews.md),
which the next preview type (SVG, a notebook, a PDF) should start from.

## Why the sandbox is empty

`sandbox=""` is the maximum restriction: no scripts, no forms, no same-origin. The file is
whatever the agent happened to write or read, and scripts inserted via `srcdoc` inherit
this page's CSP, which allows `connect-src http(s)` - so an inline `onerror=` in a file
that came off disk could read the document and post it out, from the app's own origin,
next to the live WebSocket. Rendering static text of a document that wanted its script
(the unpkg mermaid export in the reported file) is the right trade; the user's own review
of that file argued the mermaid line should be deleted anyway.

## Verification

- `scripts/shot-html-preview.js` - opens the real reported file through the real backend
  and screenshots both views (`preview-dark.png`, `source.png`); prints the `sandbox`
  attribute and the first heading read from *inside* the frame. The first themed capture
  is what showed the rule `thead, th { background }` turning that export's empty header
  row (the user's own defect #4) into a grey bar, so the table fills were dropped and the
  sheet kept to colours only.
- `e2e/html-preview.spec.ts` - renders and reads the `<h1>` through a `frameLocator`;
  asserts a `<script>` in the fixture did **not** run (`#ran` absent, a behavioural check
  rather than an attribute one); toggle both ways; offset opens Source; and a control that
  a `.ts` file gets neither an iframe nor a toggle button.
- Red-verified twice by mutating the new code back: `isHtml = false && ...` (3 failed, the
  control passed) and `srcDoc={code}` without the theme (only the theme test failed, which
  is what makes it a test of the cascade rather than of the markup).
- The theme test reads the **computed** `backgroundColor` from inside the frame and
  compares it to the panel's own, against a fixture that paints itself white - so it fails
  unless the injected sheet actually wins the cascade. It also proves Playwright can
  evaluate inside a `sandbox=""` frame, which the sandbox does not block.
- Full mock suite: 261 passed, 1 failed - `model-picker.spec.ts`, the known
  config-dependent failure of the mock-only escape hatch, unrelated.

## Superseded: "a Read with an offset opens in Source"

**Was:** an `.html` Read carrying an `offset` opened in the source view, on the reasoning
that the content is a slice and the caller asked for a specific line.

**Actually:** the user reported "не вижу эффекта" against the very read from the request
(`...html:359-499`). Every `.html` Read in that session carried an offset, so the feature
was invisible in exactly the case it was built for. A browser renders a fragment fine, and
the slice at 359 starts at `<body>`, so it renders as the document (plainer, since the
`<head><style>` is outside the slice). Now `.html` always opens rendered.

**Why it was wrong:** the rule was derived from the shape of the data (a slice, a line
number) instead of from what the user was doing (opening a document to read it). The one
sample available - their own screenshot - already showed an offset read, and it was read
as an edge case rather than as the normal case.

**And the reason given for it does not hold either:** "the line only exists in the source
view" assumed the source view can reach that line. Measured with
`scripts/shot-html-offset.js` on the real file: `stripLineNumbers` removes the tool's
`   359\t` prefixes and SyntaxHighlighter numbers from 1, so `data-line` runs **1..140**
while the scroll target passed by `ToolCall` is the absolute `359` - `ABSENT (no scroll,
no highlight)`. The follow-up test was briefly written to assert that scroll and passed
only because it used `offset: 2` on a 3-line fixture, where 2 exists by accident. Pre-
existing, not caused by this feature, and it applies to every offset Read, not just html.

**Corrected by:** this task, same day.

## Gotchas

- The modal overlay is `aria-hidden`, so `getByRole('button', { name: 'Source' })` cannot
  see the toggle. Locate through `[role="dialog"]` - already recorded in
  [../../common/markdown-file-paths.md](../../common/markdown-file-paths.md), and it cost a
  probe run here anyway.
- The first probe tried to open the file through a path link in prose and timed out: the
  folder is `разделы-для-психолога` and `FILE_PATH_RE` is built on `\w`, which is
  ASCII-only, so **no path containing Cyrillic ever linkifies**. Not fixed here (see
  Remaining work); the probe was rerouted through the tool row, which is how the user
  opened it too.

## Remaining work

- Not committed.
- **Open:** paths with non-ASCII segments do not linkify in prose or code spans. It only
  surfaced as a probe failure because the report came through a tool row (whose link is an
  `<a>` regardless of the regex), but half of this user's tree is Cyrillic
  (`разделы-для-психолога`, `квартира-снегири-сиреневый-79`). The fix is a `u`-flagged
  pattern over `\p{L}` in both regexes, which is a wider change than the hyphen one in
  [../hyphen-in-filename-truncates-link/](../hyphen-in-filename-truncates-link/notes.md)
  and wants its own red/green pass.
- Not offered yet: an "open in real browser" action for a document that genuinely needs
  its scripts.
- The theme sheet is colours only. A document that paints an **opaque light panel** on its
  own containers (`div { background: #fff }`) still shows that block; a blanket
  `* { background: transparent !important }` would fix it and destroy legitimate
  backgrounds (badges, code blocks), so it was not taken. Revisit if a real document hits
  it.
- **Open, pre-existing:** scroll-to-line does nothing for **any** Read with an `offset`
  (html or not). `ToolCall` passes the absolute offset as the scroll target while the
  source view renumbers the slice from 1, so `[data-line="359"]` never exists. Two ways
  out: pass `startingLineNumber` into the highlighter so the slice shows its real file
  numbers (best - the numbers on screen would then match the file), or map the target to
  `line - offset + 1`. Evidence in `scripts/shot-html-offset.js`.
