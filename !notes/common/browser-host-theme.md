# Browser host theme parity

The React webview and CSS Modules are shared by the VS Code panel, the Vite browser host (`webview/index.html`), and the daemon-served browser host (`media/browser.html`). VS Code injects its `--vscode-*` theme variables into the panel. Both browser hosts define a local snapshot of those variables.

When a component starts using a theme variable, check both browser hosts. An undefined variable can silently select a CSS fallback with a different color. For example, Bash command text uses `--vscode-symbolIcon-variableForeground`; without it the browser used the yellow `#dcdcaa` fallback, while the installed VS Code 2026 Dark theme supplied blue `#75BEFF`. The browser templates now define that blue value.

Font metrics matter as well as font size. On this Windows setup, `Cascadia Code` produced a 17-pixel step between file-change rows and `Consolas` produced the panel's 18-pixel step. Both browser hosts now use `Consolas` in `--vscode-editor-font-family`.

For a visual change, measure computed styles in both browser hosts and compare them with the actual VS Code panel. Run the probes in [browser colors](../tasks/browser-webview-colors/notes.md) and [browser typography](../tasks/browser-webview-density/notes.md). The hardcoded browser values mirror the tested theme; another VS Code theme may require a different snapshot.
