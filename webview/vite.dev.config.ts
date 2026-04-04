import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { WebSocketServer, type WebSocket } from 'ws';
import { spawn } from 'child_process';
import type { Plugin } from 'vite';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

const MODEL = process.env.ARGUS_MODEL ?? 'claude-opus-4-6';
const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

function argusAgentPlugin(): Plugin {
  return {
    name: 'argus-agent',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });

      wss.on('connection', (ws: WebSocket) => {
        let sessionId: string | undefined;
        let currentProc: ReturnType<typeof spawn> | undefined;

        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString()) as { type: string; text?: string };

          if (msg.type === 'send' && msg.text) {
            const text = msg.text;

            ws.send(JSON.stringify({
              type: 'message',
              message: { id: String(Date.now()), role: 'user', content: text },
            }));

            const args = [
              '--print', '--verbose', '--output-format', 'stream-json',
              '--model', MODEL,
              '--allowedTools', ALLOWED_TOOLS.join(','),
            ];
            if (sessionId) args.push('--resume', sessionId);

            ws.send(JSON.stringify({ type: 'thinking_start' }));

            const proc = spawn('claude', args, {
              cwd: process.cwd(),
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            currentProc = proc;
            proc.stdin.write(text);
            proc.stdin.end();

            let buffer = '';
            let receivedDeltas = false;
            const toolMap = new Map<string, { name: string; input: unknown }>();

            proc.stdout.on('data', (chunk: Buffer) => {
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let event: Record<string, unknown>;
                try { event = JSON.parse(trimmed); } catch { continue; }

                if (event.type === 'system' && event.subtype === 'init') {
                  sessionId = event.session_id as string;
                } else if (event.type === 'content_block_delta') {
                  const delta = event.delta as Record<string, unknown> | undefined;
                  if (delta?.type === 'text_delta' && delta.text) {
                    receivedDeltas = true;
                    ws.send(JSON.stringify({ type: 'text_chunk', text: delta.text }));
                  } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                    ws.send(JSON.stringify({ type: 'thinking_chunk', text: delta.thinking }));
                  }
                } else if (event.type === 'assistant') {
                  const content = (event.message as { content: Array<Record<string, unknown>> })?.content ?? [];
                  for (const block of content) {
                    if (block.type === 'thinking' && block.thinking) {
                      ws.send(JSON.stringify({ type: 'thinking_chunk', text: block.thinking }));
                    } else if (block.type === 'text' && block.text && !receivedDeltas) {
                      ws.send(JSON.stringify({ type: 'text_chunk', text: block.text }));
                    } else if (block.type === 'tool_use') {
                      toolMap.set(block.id as string, { name: block.name as string, input: block.input });
                      ws.send(JSON.stringify({ type: 'tool_start', call: { id: block.id, name: block.name, input: block.input } }));
                    }
                  }
                  receivedDeltas = false;
                } else if (event.type === 'tool_result') {
                  const tc = toolMap.get(event.tool_use_id as string);
                  ws.send(JSON.stringify({
                    type: 'tool_end',
                    call: { id: event.tool_use_id, name: tc?.name ?? '', input: tc?.input ?? {}, result: event.content },
                  }));
                }
              }
            });

            proc.stderr.on('data', (chunk: Buffer) => {
              console.error('[argus-agent]', chunk.toString().trim());
            });

            proc.on('close', (code) => {
              currentProc = undefined;
              if (code !== 0 && code !== null) {
                ws.send(JSON.stringify({ type: 'error', text: `claude exited with code ${code}` }));
              }
              ws.send(JSON.stringify({ type: 'done' }));
            });

            proc.on('error', (err) => {
              currentProc = undefined;
              const errText = err.message.includes('ENOENT')
                ? 'Claude Code CLI not found. Install with: npm install -g @anthropic/claude-code'
                : err.message;
              ws.send(JSON.stringify({ type: 'error', text: errText }));
              ws.send(JSON.stringify({ type: 'done' }));
            });

          } else if (msg.type === 'stop') {
            currentProc?.kill();
          } else if (msg.type === 'newSession') {
            sessionId = undefined;
          }
        });
      });

      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (req.url === '/agent') {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
        }
      });

      console.log('[argus-agent] WebSocket agent ready at ws://localhost:5173/agent');
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [react(), argusAgentPlugin()],
  server: {
    port: 5173,
  },
});
