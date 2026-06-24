import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'http';

import { handleConnection } from './session';
import { readConfig } from './config';

export type { ArgusConfig } from './config';

const DEFAULT_MODEL = process.env.ARGUS_MODEL ?? '';
// Extra origin hosts (IPs or hostnames) allowed to connect, comma-separated.
// e.g. ARGUS_ALLOWED_ORIGINS="45.45.45.45,dev.example.com" - used for the VLESS
// reverse-mesh entry IP so a remote phone reaches this dev box over the tunnel.
const DEFAULT_ALLOWED_ORIGINS = process.env.ARGUS_ALLOWED_ORIGINS ?? '';

export interface StartServerOptions {
  port?: number;
  model?: string;
  allowedOrigins?: string;
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

  const httpServer = createServer((req, res) => {
    if (req.url === '/nonce') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(nonce);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

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
    ws.on('pong', () => { wsAlive.set(ws, true); });
    const reqUrl = new URL(req.url ?? '/', 'http://localhost');
    const rawDir = reqUrl.searchParams.get('dir') || process.cwd();
    const workspaceDir = resolve(rawDir);
    if (!isAbsolute(workspaceDir) || !existsSync(workspaceDir)) {
      ws.close(4400, 'Invalid workspace directory');
      return;
    }
    handleConnection(ws, workspaceDir, MODEL);
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (!req.url?.startsWith('/agent')) return;
    const origin = req.headers.origin ?? '';
    const cfg = readConfig();
    // Local access is always allowed: no Origin, the VS Code webview, and localhost/loopback.
    const localOk = !origin
      || origin.startsWith('vscode-webview:')
      || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    // Non-local access (LAN ranges + configured extra origins) is gated by allowNetworkAccess.
    const networkOk = cfg.allowNetworkAccess !== false && (
      // Private-LAN origins so dev devices on the same network (phone, tablet) can connect.
      /^https?:\/\/(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin)
      // Extra origins from options / ARGUS_ALLOWED_ORIGINS / argus.json allowedOrigins
      // (e.g. the VLESS reverse-mesh entry IP so a remote phone reaches this dev box over the tunnel).
      || buildOriginMatcher(
        [options.allowedOrigins, DEFAULT_ALLOWED_ORIGINS, cfg.allowedOrigins].filter(Boolean).join(','),
      )(origin)
    );
    const allowed = localOk || networkOk;
    if (!allowed) {
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

  return new Promise<ArgusServer>((resolve) => {
    httpServer.listen(PORT, () => {
      const addr = httpServer.address() as { port: number };
      const actualPort = addr.port;
      console.log(`[argus-server] WebSocket agent ready at ws://localhost:${actualPort}/agent`);
      resolve({ httpServer, port: actualPort, nonce, close: () => { clearInterval(pingTimer); wss.close(); httpServer.close(); } });
    });
  });
}
