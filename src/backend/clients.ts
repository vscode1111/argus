import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { clientChannelInfo } from './channel';

export interface ClientInfo {
  /** Connection id, unique within this server process; the list's React key. */
  id: number;
  /** The socket that asked for the list - the panel reading it right now. */
  current: boolean;
  /** Unix ms the socket was accepted; 0 when it was never recorded (see listClients). */
  connectedAt: number;
  /** Peer address, IPv6-unwrapped ("::ffff:192.168.0.12" -> "192.168.0.12"). */
  address: string;
  /** Came from the machine the server runs on. */
  local: boolean;
  origin: string;
  kind: 'vscode' | 'browser' | 'unknown';
  /** Platform lifted verbatim from the User-Agent, when it names one we recognise. */
  device?: string;
  userAgent?: string;
  /** Workspace channel the socket joined; absent only if it left between the two reads. */
  workspacePath?: string;
  /** Session its entry is bound to. Absent until the CLI names one (a brand-new chat). */
  sessionId?: string;
  /** A different transcript the client navigated to via Session History. */
  viewingSessionId?: string;
  /** That entry is mid-turn right now - the connection driving a live turn. */
  running: boolean;
}

export interface CloseClientResult {
  id: number;
  closed: boolean;
  /** Why not, when it could not be closed; the row is already gone from the caller's table. */
  error?: string;
}

/**
 * Close code for "a panel disconnected you on purpose".
 *
 * It has to be distinguishable from every other close, because `ws-bridge.js`
 * reconnects from all of them: a plain close would hand the connection back within a
 * second and the button would read as broken. On this code alone the bridge stays down
 * until the user clicks Reconnect.
 */
export const CLOSE_CODE_DISCONNECTED = 4001;

interface ClientMeta {
  id: number;
  connectedAt: number;
  origin: string;
  address: string;
  userAgent: string;
  browser: boolean;
}

const meta = new WeakMap<WebSocket, ClientMeta>();
let seq = 0;

// Enough to identify a device; a full UA is mostly version noise and travels per row.
const MAX_UA_CHARS = 200;

// IPv6 wraps a v4 peer as `::ffff:127.0.0.1`, and a loopback connection made over IPv6
// arrives as `::1`. Both are this machine, and a reader scanning for "which of these is
// the phone" should not have to know that.
export function normalizeAddress(address: string): string {
  const a = address.replace(/^::ffff:/, '');
  return a === '::1' ? '127.0.0.1' : a;
}

export function isLocalAddress(address: string): boolean {
  return normalizeAddress(address) === '127.0.0.1';
}

// Which host the connection is. The VS Code webview announces itself in the Origin and
// the browser UI passes `client=browser`; anything else (a Node client, a probe, a
// future host) stays `unknown` rather than being guessed into one of the two.
export function clientKind(origin: string, browser: boolean): ClientInfo['kind'] {
  if (origin.startsWith('vscode-webview:')) return 'vscode';
  if (browser || /^https?:\/\//.test(origin)) return 'browser';
  return 'unknown';
}

// Ordered so the specific tokens win: an iPhone's UA also says "Mac OS X" and an
// Android's also says "Linux", so a naive scan reports the wrong device for both.
const DEVICE_TOKENS: Array<[RegExp, string]> = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bMacintosh\b|\bMac OS X\b/, 'Mac'],
  [/\bWindows\b/, 'Windows'],
  [/\bLinux\b/, 'Linux'],
];

export function deviceFromUserAgent(ua: string): string | undefined {
  for (const [re, label] of DEVICE_TOKENS) if (re.test(ua)) return label;
  return undefined;
}

// Record what the upgrade request says about a connection. Everything here is known
// only at accept time (the headers are gone afterwards), so it is captured once and
// read back per listing rather than re-derived.
export function noteClientConnect(ws: WebSocket, req: IncomingMessage, opts: { browser: boolean }): void {
  meta.set(ws, {
    id: ++seq,
    connectedAt: Date.now(),
    origin: req.headers.origin ?? '',
    address: normalizeAddress(req.socket.remoteAddress ?? ''),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, MAX_UA_CHARS),
    browser: opts.browser,
  });
}

// Every client socket this server is serving, with where it sits in the session
// registry. Only OPEN sockets, the same filter the "Active connections" count uses -
// the number and the list it opens must never disagree.
//
// A socket with no recorded metadata is still listed, with `connectedAt: 0` for "not
// known" rather than being skipped: dropping it would make the list one shorter than
// the count, which is the disagreement this shares a filter to avoid.
export function listClients(sockets: Iterable<WebSocket>, self?: WebSocket): ClientInfo[] {
  const out: ClientInfo[] = [];
  for (const ws of sockets) {
    if (ws.readyState !== 1) continue;
    const m = meta.get(ws);
    const where = clientChannelInfo(ws);
    const origin = m?.origin ?? '';
    const address = m?.address ?? '';
    const ua = m?.userAgent ?? '';
    out.push({
      id: m?.id ?? 0,
      current: ws === self,
      connectedAt: m?.connectedAt ?? 0,
      address,
      local: isLocalAddress(address),
      origin,
      kind: clientKind(origin, m?.browser ?? false),
      device: deviceFromUserAgent(ua),
      userAgent: ua || undefined,
      workspacePath: where?.workspacePath,
      sessionId: where?.sessionId,
      viewingSessionId: where?.viewingSessionId,
      running: where?.running ?? false,
    });
  }
  // Oldest first, so a list re-read every few seconds does not reshuffle under the eye.
  return out.sort((a, b) => a.connectedAt - b.connectedAt || a.id - b.id);
}

// Disconnect ONE client by the connection id the list handed out. The id is looked up
// in the live socket set rather than trusted, so a stale or invented id closes nothing -
// and since ids are per server process and never reused, it cannot land on the socket
// that replaced it either.
//
// Nothing is torn down here beyond the socket: the session entry and its CLI process
// stay put (an abandoned entry is reclaimed by the existing grace timer), so closing a
// connection mid-turn loses the view of that turn, not the turn.
//
// `self` is the socket that asked, and closing it is allowed - a panel may disconnect
// itself. That case has to be **deferred by a tick**: `ws.close()` puts the socket into
// CLOSING immediately, so the reply the caller sends right after would never leave.
export function closeClient(sockets: Iterable<WebSocket>, id: number, self?: WebSocket): CloseClientResult {
  if (!Number.isInteger(id) || id <= 0) return { id, closed: false, error: 'invalid connection id' };
  for (const ws of sockets) {
    if (meta.get(ws)?.id !== id || ws.readyState !== 1) continue;
    const close = () => ws.close(CLOSE_CODE_DISCONNECTED, 'Disconnected from another panel');
    try {
      if (ws === self) setImmediate(close);
      else close();
    } catch (err) {
      return { id, closed: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { id, closed: true };
  }
  return { id, closed: false, error: 'that connection is no longer open' };
}
