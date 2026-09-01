import { postMessage } from '../vscode';

// Scheme URLs (http, https, ws, file, …) up to the next whitespace or markup delimiter.
// Used both to linkify a bare URL and to keep FILE_PATH_RE off it - a URL's path
// component is indistinguishable from a real path, so whichever scan runs first wins.
export const URL_RE = /\b[a-z][a-z0-9+.\-]*:\/\/[^\s<>"'`]+/gi;

const TRAILING_RE = /[.,;:!?]+$/;

/**
 * Strips sentence punctuation the URL regex swallowed. A line ending in
 * "…/main.js." would otherwise put the full stop inside the link. A closing paren
 * only counts as punctuation when the URL has no opening one, so a wiki-style
 * "…/Foo_(bar)" survives.
 */
export function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING_RE, '');
  while (url.endsWith(')') && !url.includes('(')) {
    url = url.slice(0, -1).replace(TRAILING_RE, '');
  }
  return url;
}

/**
 * Opens a URL outside the app. Both calls fire unconditionally, matching the login
 * link and the Account & Usage footer: in VS Code `openUrl` is VS_ONLY and reaches
 * `vscode.env.openExternal`, while in the browser the WS bridge has no such message
 * and `window.open` is what does the work. Callers must `preventDefault()` - a bare
 * href would navigate the Argus page itself away in browser mode.
 */
export function openExternal(url: string): void {
  postMessage({ type: 'openUrl', url });
  window.open(url, '_blank');
}
