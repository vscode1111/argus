import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'http';

import { handleConnection } from './session';

export type { ArgusConfig } from './config';

const DEFAULT_MODEL = process.env.ARGUS_MODEL ?? "claude-opus-4-6";

export interface StartServerOptions {
  port?: number;
  model?: string;
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
    const allowed = !origin || origin.startsWith('vscode-webview:') || /^https?:\/\/localhost(:\d+)?$/.test(origin);
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
