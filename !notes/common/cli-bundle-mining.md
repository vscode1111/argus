# Mining the Claude CLI bundle

How to locate and extract implementation details (UI strings, algorithms, constants) from the installed Claude CLI. The CLI ships as a Bun-compiled native exe with the JS source embedded, so the official client's logic can be recovered by grepping the binary - this is how Argus mirrors official behavior exactly instead of guessing.

## Locating the bundle

- `where claude.cmd` finds the npm shim (e.g. `C:\nvm4w\nodejs\claude.cmd`); the shim runs `%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe` (see the package's `package.json` `bin` field - since ~2.1.x it is a native exe, no `cli.js` on disk).
- The nvm4w dir is a link; the real package lives under `C:\Users\Admin\AppData\Local\nvm\v<node-version>\node_modules\@anthropic-ai\claude-code\`.
- `src/backend/modelData.ts` `resolveClaudeBundle()` does this resolution programmatically (win32 + POSIX).

## Two string regions inside the exe

A `grep -aob "some anchor" claude.exe` typically reports several offset clusters. They are not equivalent:

- **Bun bytecode/heap section** (~206M offsets in 2.1.197): strings appear as length-prefixed constants surrounded by binary. Identifiers and copy are visible (`cache_miss`, `% of your usage was at >150k context`), but there is no readable code around them - a window extracted here looks like `ÿÿÿÿ...` noise with island strings.
- **Plain minified JS** (~227M offsets in 2.1.197): the actual source. Windows extracted here contain `function X(e){...}` code and are fully analyzable, including numeric constants (`XNf=150000`) and JSX (`pu.jsx(...)` Ink components).

If the first extraction window shows binary around the anchor, try the other clusters before concluding the logic is not greppable.

## Workflow

1. `grep -aob "anchor string" claude.exe | head` - collect candidate offsets (`-a` binary-as-text, `-b` byte offsets).
2. Extract a window around each offset with a Node one-off (write it to the task's `scripts/` folder): `fs.openSync` + `fs.readSync` into a Buffer, decode as `latin1`, save to a scratch `.js.txt`.
3. Grep/slice the scratch file iteratively for identifiers and constants; minified names are stable within one build, so following a helper (e.g. cost function `T$f`) across the window works.
4. Verify the recovered algorithm by re-implementing it and comparing output against the official UI on the same machine (screenshots / live panel) - a faithful mirror reproduces the numbers to within timing drift.

## Users of this technique

- `src/backend/modelData.ts` `extractFamilyDescriptions()` - model-picker family wording (anchored `value:"X",label:"Y",description:"Z"` scans).
- `src/backend/usageInsights.ts` - the entire "What's contributing to your limits usage?" analysis (cost weighting, behavior thresholds, attribution fields). Extraction record: [tasks/usage-insights/notes.md](../tasks/usage-insights/notes.md).
