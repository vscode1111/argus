import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve, isAbsolute, join } from 'path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'http';

import { attachClientHandlers } from './session';
import { getOrCreateChannel } from './channel';
import { readConfig } from './config';

export type { ArgusConfig } from './config';

const DEFAULT_MODEL = process.env.ARGUS_MODEL ?? '';
// Extra origin hosts (IPs or hostnames) allowed to connect, comma-separated.
// e.g. ARGUS_ALLOWED_ORIGINS="203.0.113.1,dev.example.com" - used for the VLESS
// reverse-mesh entry IP so a remote phone reaches this dev box over the tunnel.
const DEFAULT_ALLOWED_ORIGINS = process.env.ARGUS_ALLOWED_ORIGINS ?? '';

export interface StartServerOptions {
  port?: number;
  model?: string;
  allowedOrigins?: string;
  // When set, the server shuts itself down after this many ms with zero connected
  // clients (idle). Used by the daemon entry; left undefined by the extension/dev
  // paths so they never self-exit. onIdleShutdown fires after close() so the caller
  // (the daemon) can process.exit - startServer never exits the process itself.
  idleTimeoutMs?: number;
  onIdleShutdown?: () => void;
  // Supplied only by the daemon: spawn a force-start replacement that takes over the
  // port. Its presence is what enables the "restart daemon" request (the dev server
  // does not pass it, so a restart request there is a no-op).
  onRespawn?: () => void;
}

// Build a matcher for `http(s)://<host>(:port)` from a comma-separated host list.
function buildOriginMatcher(list: string): (origin: string) => boolean {
  const patterns = list
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((host) => new RegExp(`^https?:\\/\\/${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:\\d+)?$`));
  return (origin: string) => patterns.some((re) => re.test(origin));
}

export interface ArgusServer {
  httpServer: ReturnType<typeof createServer>;
  port: number;
  nonce: string;
  close: () => void;
}

export function startServer(options: StartServerOptions = {}): Promise<ArgusServer> {
  const PORT = options.port ?? 3001;
  const MODEL = options.model ?? DEFAULT_MODEL;
  const nonce = randomBytes(16).toString('hex');

  // Serve the built webview directly over HTTP so a plain browser can use Argus at
  // http://localhost:<port>/ without Vite (the daemon hosts the same bundle the VS
  // Code webview loads). Fixed allowlist - no arbitrary path serving, no traversal.
  // Requires `yarn build` to have produced media/webview.{js,css}.
  const MEDIA_DIR = join(__dirname, '..', '..', 'media');
  const STATIC: Record<string, [file: string, type: string]> = {
    '/': ['browser.html', 'text/html; charset=utf-8'],
    '/webview.js': ['webview.js', 'text/javascript; charset=utf-8'],
    '/webview.css': ['webview.css', 'text/css; charset=utf-8'],
    '/ws-bridge.js': ['ws-bridge.js', 'text/javascript; charset=utf-8'],
    '/argus-icon.ico': ['argus-icon.ico', 'image/x-icon'],
  };

  const httpServer = createServer((req, res) => {
    if (req.url === '/nonce') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(nonce);
      return;
    }
    const urlPath = (req.url ?? '').split('?')[0];
    const asset = STATIC[urlPath];
    if (asset) {
      try {
        const buf = readFileSync(join(MEDIA_DIR, asset[0]));
        res.writeHead(200, { 'Content-Type': asset[1] });
        res.end(buf);
      } catch {
        res.writeHead(asset[0] === 'browser.html' ? 503 : 404);
        res.end(asset[0] === 'browser.html' ? 'Argus webview not built. Run `yarn build`.' : '');
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  // Remembers each live connection's Origin so it can be re-checked when the
  // Network settings change (not only at upgrade time).
  const wsOrigin = new WeakMap<WebSocket, string>();

  // Whether an Origin may connect, given the current config. Local origins (no
  // Origin, the VS Code webview, localhost/loopback) are always allowed; non-local
  // origins (private-LAN ranges + configured extra hosts) are gated by
  // allowNetworkAccess. Reads config fresh so edits to argus.json apply at once.
  function originAllowed(origin: string): boolean {
    const localOk = !origin
      || origin.startsWith('vscode-webview:')
      || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (localOk) return true;
    const cfg = readConfig();
    return cfg.allowNetworkAccess !== false && (
      /^https?:\/\/(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin)
      || buildOriginMatcher(
        [options.allowedOrigins, DEFAULT_ALLOWED_ORIGINS, cfg.allowedOrigins].filter(Boolean).join(','),
      )(origin)
    );
  }

  // Drop any live connection whose Origin is no longer allowed. Called after a
  // settings change so turning Network access off (or removing an allowed origin)
  // disconnects remote clients immediately instead of only blocking new upgrades.
  function enforceOrigins(): void {
    for (const client of wss.clients) {
      if (!originAllowed(wsOrigin.get(client) ?? '')) {
        try { client.close(4403, 'Network access revoked'); } catch { /* already closing */ }
      }
    }
  }

  // Number of currently-open client sockets. Counts only OPEN (readyState 1) so a
  // socket mid-close (during its own 'close' event) is excluded, regardless of when
  // ws removes it from wss.clients.
  function clientCount(): number {
    let n = 0;
    for (const client of wss.clients) if (client.readyState === 1) n++;
    return n;
  }

  // Push the live client count to every open client. Sent on connect/disconnect so
  // the Settings "Network" tab reflects connections opening and closing in real time.
  function broadcastClientCount(): void {
    const msg = JSON.stringify({ type: 'clientCount', count: clientCount() });
    for (const client of wss.clients) {
      if (client.readyState === 1) { try { client.send(msg); } catch { /* closing */ } }
    }
  }

  // Idle self-shutdown: when idleTimeoutMs is set, start a timer once the last
  // client disconnects and exit if nobody reconnects within the window. Connection
  // count based (not activity based): an open panel keeps its socket open, so a long
  // agent turn is never killed mid-task; closing the last panel starts the countdown.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function clearIdleTimer(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
  }
  function scheduleIdleShutdown(): void {
    if (options.idleTimeoutMs === undefined) return;
    clearIdleTimer();
    if (clientCount() > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (clientCount() > 0) return; // a client reconnected in the meantime
      console.log('[argus-server] idle timeout reached, shutting down');
      clearInterval(pingTimer);
      wss.close();
      httpServer.close();
      options.onIdleShutdown?.();
    }, options.idleTimeoutMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  // Restart the daemon (browser-served path): tell every client the URL the new
  // daemon will listen on, spawn the replacement, then exit so it can take the port.
  // Only meaningful when onRespawn is provided (the daemon); a no-op otherwise.
  function doRestart(): void {
    if (!options.onRespawn) return;
    const cfg = readConfig();
    const newPort = cfg.daemonPort || PORT;
    const url = `http://localhost:${newPort}/`;
    const msg = JSON.stringify({ type: 'daemonRestarting', port: newPort, url });
    for (const client of wss.clients) {
      if (client.readyState === 1) { try { client.send(msg); } catch { /* closing */ } }
    }
    options.onRespawn();
    setTimeout(() => {
      clearIdleTimer();
      clearInterval(pingTimer);
      wss.close();
      httpServer.close();
      options.onIdleShutdown?.();
    }, 500);
  }

  const wsAlive = new WeakMap<WebSocket, boolean>();
  const PING_INTERVAL = 15_000;
  const pingTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (wsAlive.get(client) === false) {
        client.terminate();
        continue;
      }
      wsAlive.set(client, false);
      client.ping();
    }
  }, PING_INTERVAL);
  wss.on('close', () => clearInterval(pingTimer));

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    wsAlive.set(ws, true);
    wsOrigin.set(ws, req.headers.origin ?? '');
    clearIdleTimer();
    ws.on('pong', () => { wsAlive.set(ws, true); });
    ws.on('close', () => { broadcastClientCount(); scheduleIdleShutdown(); });
    const reqUrl = new URL(req.url ?? '/', 'http://localhost');
    const rawDir = reqUrl.searchParams.get('dir') || process.cwd();
    const workspaceDir = resolve(rawDir);
    if (!isAbsolute(workspaceDir) || !existsSync(workspaceDir)) {
      ws.close(4400, 'Invalid workspace directory');
      return;
    }
    const serverPort = req.socket.localPort ?? PORT;
    const channel = getOrCreateChannel(workspaceDir);
    attachClientHandlers(ws, channel, MODEL, { onSettingsChange: enforceOrigins, getClientCount: clientCount, getServerPort: () => serverPort, onRestartRequest: options.onRespawn ? doRestart : undefined });
    broadcastClientCount();
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (!req.url?.startsWith('/agent')) return;
    if (!originAllowed(req.headers.origin ?? '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const reqUrl = new URL(req.url, 'http://localhost');
    if (reqUrl.searchParams.get('nonce') !== nonce) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head as Buffer, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  return new Promise<ArgusServer>((resolve, reject) => {
    httpServer.once('error', reject); // e.g. EADDRINUSE - let the caller retry/handle
    httpServer.listen(PORT, () => {
      httpServer.removeListener('error', reject);
      const addr = httpServer.address() as { port: number };
      const actualPort = addr.port;
      console.log(`[argus-server] WebSocket agent ready at ws://localhost:${actualPort}/agent`);
      // Arm the idle timer at startup too, so a daemon that never gets a client still
      // exits (no-op unless idleTimeoutMs is set; the first connection clears it).
      scheduleIdleShutdown();
      resolve({ httpServer, port: actualPort, nonce, close: () => { clearIdleTimer(); clearInterval(pingTimer); wss.close(); httpServer.close(); } });
    });
  });
}
