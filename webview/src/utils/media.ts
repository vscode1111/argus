/**
 * Playable media: which paths are one, and the URL that streams them.
 *
 * The extension lists mirror `src/backend/filePreview.ts` deliberately rather than
 * importing it - the webview and backend sit on opposite sides of a tsconfig boundary,
 * the same reason `plural()` is duplicated in `src/backend/cli.ts`. The backend copy is
 * the guard (it must never read a video as UTF-8 whoever asks); this copy is the fast
 * path, so a click goes straight to a grant instead of a preview round trip first.
 */

export type MediaKind = 'video' | 'audio';

const VIDEO_RE = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|mpe?g)$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|ogg|oga|opus|flac|aac|weba)$/i;

/** Which player a path wants, or null when it is not media at all. */
export function mediaKindFor(path: string): MediaKind | null {
  if (VIDEO_RE.test(path)) return 'video';
  if (AUDIO_RE.test(path)) return 'audio';
  return null;
}

/**
 * The same key `ws-bridge.js` keeps the remote session token under. Read here rather
 * than threaded through React state because a media URL is built in the render path and
 * the bridge owns the token's lifetime; this is the one other place that reads it.
 */
const AUTH_KEY = 'argus.authToken';

function authToken(): string {
  try {
    return window.localStorage.getItem(AUTH_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * Where this client can reach the server's HTTP side.
 *
 * Never `localhost` outside the VS Code webview: for a remote viewer that names their
 * own machine, which is the bug that makes a feature look broken only over the tunnel.
 * In browser mode the page is served by this very server, so the expression reproduces
 * its own origin; under Vite the host is right and only the port differs.
 */
export function httpBase(port: number): string {
  if (window.location.protocol === 'vscode-webview:') return `http://localhost:${port}`;
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

/**
 * The `src` for a granted token. The token is the capability; `auth` rides along
 * because the server also demands a live session from any non-local peer, and a media
 * element cannot set headers any more than a WebSocket handshake can.
 */
export function mediaSrc(token: string, port: number): string {
  const auth = authToken();
  return `${httpBase(port)}/media/${encodeURIComponent(token)}${auth ? `?auth=${encodeURIComponent(auth)}` : ''}`;
}

/** Human-readable byte size for the player caption and the binary-file card. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Why a media element failed, in words a viewer can act on.
 *
 * A `MediaError` cannot answer this on its own: Chrome reports a 404 as
 * `MEDIA_ERR_SRC_NOT_SUPPORTED`, the very same code it uses for a container it has no
 * decoder for. The two need opposite advice, and the difference is not academic - a
 * grant lives in the server's memory, so a daemon that idle-exits (ten minutes with no
 * client, by default) invalidates every preview link still on screen. Blaming the codec
 * there sends the viewer looking for a converter when the fix is to click the file
 * again. So ask the server what it thinks before saying anything.
 */
export async function diagnoseMediaFailure(
  src: string,
  kind: MediaKind,
): Promise<{ title: string; hint: string }> {
  const noun = kind === 'audio' ? 'audio' : 'video';
  try {
    const res = await fetch(src, { method: 'HEAD' });
    if (res.status === 404) {
      return {
        title: `This ${noun} link has expired`,
        hint: 'The server restarted, so the playback link is no longer valid. Close this and open the file again.',
      };
    }
    if (res.status === 401) {
      return {
        title: 'Not signed in to this server',
        hint: 'The session ended. Sign in again, then reopen the file.',
      };
    }
    if (!res.ok) {
      return {
        title: `This ${noun} could not be loaded`,
        hint: `The server refused it (HTTP ${res.status}).`,
      };
    }
    // The server served it happily, so the browser genuinely cannot decode it.
    return {
      title: `This ${noun} cannot be played here`,
      hint: 'The browser has no decoder for this container or codec. Open it in an external player.',
    };
  } catch {
    return {
      title: `This ${noun} could not be loaded`,
      hint: 'The server could not be reached to stream it. Check the connection and try again.',
    };
  }
}
