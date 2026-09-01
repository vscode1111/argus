# Manual test corpus: URL vs file-path linkification

Real URLs for eyeballing the fix in a live Argus window. Every URL below was probed on
2026-08-27 and returned HTTP 200 (`curl -s -o /dev/null -w "%{http_code}" -L <url>`); re-probe
before blaming the app for a dead link. The user confirmed this set as what they wanted.

## Where to look

- **Vite dev server** (serves the source, no build needed): `http://localhost:5173/?dir=d:/_Projects/scub111g/argus`
- **The daemon-served window shows the fix only after its install is rebuilt** - a daemon from
  `local.argus-*` reads its own `media/`, not this repo's ([common/backend-restart.md](../../common/backend-restart.md)).
  Until then it renders the old broken behaviour, which makes a convenient side-by-side.

## Paste into the assistant-message path (markdown)

Ask Argus to echo this, or inject it via the DevHarness `message` action:

````
Prose: docs at https://nodejs.org/api/fs.html and the bundle at https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js next to webview/src/utils/url.ts

Inline code: `https://unpkg.com/react-markdown@9.0.1/index.js` and `src/backend/session.ts:42`

Trailing full stop: see https://developer.mozilla.org/en-US/docs/Web/API/Window/open.

Parens: https://en.wikipedia.org/wiki/Java_(programming_language)

Query string: https://en.wikipedia.org/w/index.php?title=IP_address&action=history

Bare-IP hosts like the original report: https://1.1.1.1/ and https://8.8.8.8/

```
[WARNING] VMService https://raw.githubusercontent.com/facebook/react/main/README.md .. invalid VM 1 color
[ERROR]   Failed to load resource: 500 @ https://en.wikipedia.org/wiki/IP_address
[INFO]    bundle http://localhost:5173/webview.js from d:\_Projects\scub111g\argus\webview\src\utils\url.ts:6
[DEBUG]   socket ws://localhost:3001/agent
```
````

## Send as a user message (plain text, no markdown)

```
check https://github.com/microsoft/vscode/blob/main/src/vs/base/common/uri.ts against webview/src/utils/filePath.tsx
```

## Expected

| Element | Rendering | Click |
|---------|-----------|-------|
| Any URL | plain link, underline on hover only (`.external-url-link`) | opens the browser; the Argus page stays put |
| Paths (`webview/src/utils/url.ts`, `d:\...\url.ts:6`, `src/backend/session.ts:42`) | dotted underline (`.file-path-link`) | opens a preview inside Argus |
| `…/Java_(programming_language)` | paren stays inside the link | article opens whole, not truncated at `(` |
| `…/Window/open.` | full stop stays **outside** the link | |
| `http://localhost:5173/webview.js` | one link | used to break mid-host into `5173/webview.js` |
| `ws://localhost:3001/agent` | one link | scheme coverage beyond http(s) |

The local URLs (`localhost:5173` / `localhost:3001`) are only live while `yarn dev` runs.
