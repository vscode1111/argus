declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
};

const api = acquireVsCodeApi();

export function postMessage(msg: object): void {
  api.postMessage(msg);
}

// True when running inside a VS Code webview (vs the browser dev/app window).
// Used to route notifications to the extension host and to skip browser-only
// permission prompts that are meaningless in the webview.
export const isVsCode = typeof location !== 'undefined' && location.protocol === 'vscode-webview:';
