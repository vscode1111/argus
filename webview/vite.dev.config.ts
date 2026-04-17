import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { WebSocketServer, type WebSocket } from 'ws';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Plugin } from 'vite';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

function readSkillsDir(dir: string, scope: 'global' | 'project') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ name: e.name, scope }));
}

const BUILTIN_COMMANDS = [
  'clear', 'compact', 'context', 'cost', 'diff', 'doctor',
  'help', 'hooks', 'ide', 'init', 'login', 'logout', 'memory',
  'model', 'permissions', 'plan', 'security-review', 'status',
  'terminal-setup', 'vim',
].map(name => ({ name, scope: 'builtin' as const }));

function getSkills() {
  return [
    ...BUILTIN_COMMANDS,
    ...readSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'global'),
    ...readSkillsDir(path.join(process.cwd(), '.claude', 'skills'), 'project'),
  ];
}

const MODEL = process.env.ARGUS_MODEL ?? 'claude-opus-4-6';
const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

const AUTH_PATTERNS = [/auth/i, /login/i, /token/i, /unauthorized/i, /401/i, /403/i, /credential/i, /oauth/i, /api[_ ]?key/i];
const SESSION_PATTERNS = [/session/i, /resume/i, /expired/i, /not found.*session/i];

type ErrorKind = 'auth' | 'not_found' | 'session' | 'generic';

function classifyError(stderr: string, exitCode: number | null): { message: string; errorKind: ErrorKind } {
  const text = stderr.trim();
  if (text) {
    if (AUTH_PATTERNS.some(p => p.test(text))) return { message: text, errorKind: 'auth' };
    if (SESSION_PATTERNS.some(p => p.test(text))) return { message: text, errorKind: 'session' };
  }
  if (exitCode === 1) return { message: text || 'Claude exited unexpectedly. This usually means authentication is required.', errorKind: 'auth' };
  return { message: text || `claude exited with code ${exitCode}`, errorKind: 'generic' };
}

const URL_PATTERNS = [
  /(https:\/\/[^\s"]+oauth[^\s"]*)/i,
  /(https:\/\/claude\.ai\/[^\s"]+)/i,
  /(https:\/\/console\.anthropic\.com\/[^\s"]+)/i,
  /(https:\/\/[^\s"]+anthropic[^\s"]*)/i,
];

function argusAgentPlugin(): Plugin {
  return {
    name: 'argus-agent',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });

      wss.on('connection', (ws: WebSocket) => {
        let sessionId: string | undefined;
        let currentProc: ReturnType<typeof spawn> | undefined;
        let loginProc: ReturnType<typeof spawn> | undefined;
        let loginSubmitCode: ((code: string) => void) | undefined;
        let loginClosed = false;
        let loginExitCode: number | null = null;

        const sendLog = (level: 'debug' | 'info' | 'warn' | 'error', text: string) => {
          ws.send(JSON.stringify({ type: 'log', level, text, timestamp: new Date().toISOString() }));
        };

        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString()) as {
            type: string;
            text?: string;
            images?: Array<{ data: string; mediaType: string }>;
          };

          if (msg.type === 'send' && msg.text?.trim() === '/clear') {
            sessionId = undefined;
            currentProc?.kill();
            ws.send(JSON.stringify({ type: 'clear' }));
          } else if (msg.type === 'send' && (msg.text || msg.images?.length)) {
            const text = msg.text ?? '';
            const images = msg.images;

            ws.send(JSON.stringify({
              type: 'message',
              message: { id: String(Date.now()), role: 'user', content: text, images },
            }));

            const args = [
              '--print', '--verbose',
              '--output-format', 'stream-json',
              '--input-format', 'stream-json',
              '--model', MODEL,
              '--allowedTools', ALLOWED_TOOLS.join(','),
            ];
            if (sessionId) args.push('--resume', sessionId);

            sendLog('info', `Spawning claude: ${args.join(' ')}`);
            ws.send(JSON.stringify({ type: 'thinking_start' }));

            const proc = spawn('claude', args, {
              cwd: process.cwd(),
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            currentProc = proc;

            const contentBlocks: Array<Record<string, unknown>> = [];
            if (images && images.length > 0) {
              for (const img of images) {
                contentBlocks.push({
                  type: 'image',
                  source: { type: 'base64', media_type: img.mediaType, data: img.data },
                });
              }
              sendLog('debug', `Attaching ${images.length} image(s)`);
            }
            if (text) {
              contentBlocks.push({ type: 'text', text });
            }
            const stdinMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: contentBlocks } });
            sendLog('debug', `stdin: ${stdinMsg.length} bytes`);
            proc.stdin.write(stdinMsg + '\n');
            proc.stdin.end();

            let buffer = '';
            let stderrOutput = '';
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

                sendLog('debug', `event: ${event.type} ${trimmed.slice(0, 120)}`);

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
                      sendLog('info', `tool_start: ${block.name} (${block.id})`);
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
                } else if (event.type === 'user') {
                  const userMsg = event as { type: 'user'; message?: { content?: Array<Record<string, unknown>> }; content?: Array<Record<string, unknown>> };
                  const blocks = userMsg.message?.content ?? userMsg.content ?? [];
                  sendLog('debug', `user message: ${blocks.length} block(s)`);
                  for (const block of blocks) {
                    if (block.type === 'tool_result') {
                      const tc = toolMap.get(block.tool_use_id as string);
                      const content = typeof block.content === 'string'
                        ? block.content
                        : JSON.stringify(block.content);
                      sendLog('debug', `tool_result ${block.tool_use_id}: ${String(content).slice(0, 100)}`);
                      ws.send(JSON.stringify({
                        type: 'tool_end',
                        call: { id: block.tool_use_id, name: tc?.name ?? '', input: tc?.input ?? {}, result: content },
                      }));
                    }
                  }
                }
              }
            });

            proc.stderr.on('data', (chunk: Buffer) => {
              const text = chunk.toString();
              stderrOutput += text;
              console.error('[argus-agent]', text.trim());
              sendLog('warn', `stderr: ${text.trim()}`);
            });

            proc.on('close', (code) => {
              currentProc = undefined;
              sendLog('info', `claude exited with code ${code}`);
              if (code !== 0 && code !== null) {
                const { message, errorKind } = classifyError(stderrOutput, code);
                ws.send(JSON.stringify({ type: 'error', text: message, errorKind }));
              }
              ws.send(JSON.stringify({ type: 'done' }));
            });

            proc.on('error', (err) => {
              currentProc = undefined;
              sendLog('error', `spawn error: ${err.message}`);
              const errText = err.message.includes('ENOENT')
                ? 'Claude Code CLI not found. Install with: npm install -g @anthropic/claude-code'
                : err.message;
              ws.send(JSON.stringify({ type: 'error', text: errText }));
              ws.send(JSON.stringify({ type: 'done' }));
            });

          } else if (msg.type === 'getInfo') {
            ws.send(JSON.stringify({ type: 'workspaceInfo', path: process.cwd() }));
          } else if (msg.type === 'forceError') {
            currentProc?.kill();
            ws.send(JSON.stringify({ type: 'error', text: 'Forced error (kill button)' }));
          } else if (msg.type === 'getSkills') {
            ws.send(JSON.stringify({ type: 'skills', skills: getSkills() }));
          } else if (msg.type === 'login') {
            loginProc?.kill();
            sendLog('info', 'Starting claude login');
            const lp = spawn('claude', ['auth', 'login'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
            loginProc = lp;
            let loginOutput = '';
            let loginResolved = false;
            loginClosed = false;
            loginExitCode = null;

            const checkForUrl = (data: string) => {
              loginOutput += data;
              sendLog('debug', `login output: ${data.trim()}`);
              for (const pattern of URL_PATTERNS) {
                const m = loginOutput.match(pattern);
                if (m && !loginResolved) {
                  loginResolved = true;
                  loginSubmitCode = (code: string) => {
                    lp.stdin.write(code + '\n');
                  };
                  sendLog('info', `Login URL: ${m[1]}`);
                  ws.send(JSON.stringify({ type: 'loginUrl', url: m[1] }));
                  return;
                }
              }
            };

            lp.stdout.on('data', (chunk: Buffer) => checkForUrl(chunk.toString()));
            lp.stderr.on('data', (chunk: Buffer) => checkForUrl(chunk.toString()));
            lp.on('close', (code) => {
              loginClosed = true;
              loginExitCode = code;
              loginProc = undefined;
              if (!loginResolved) {
                ws.send(JSON.stringify({ type: 'loginResult', success: false, message: loginOutput.trim() || `claude login exited with code ${code}` }));
              }
            });
            lp.on('error', (err) => {
              loginClosed = true;
              loginProc = undefined;
              ws.send(JSON.stringify({ type: 'loginResult', success: false, message: err.message }));
            });
          } else if (msg.type === 'loginCode' && msg.text) {
            if (!loginSubmitCode) {
              ws.send(JSON.stringify({ type: 'loginResult', success: false, message: 'No login process active' }));
            } else if (loginClosed) {
              sendLog('warn', `Login process already exited (code ${loginExitCode}) before code was submitted`);
              loginSubmitCode = undefined;
              ws.send(JSON.stringify({ type: 'loginResult', success: false, message: 'Login process exited before code was submitted. Try again.' }));
            } else {
              loginSubmitCode(msg.text);
              loginSubmitCode = undefined;
              loginProc?.on('close', (code) => {
                loginProc = undefined;
                ws.send(JSON.stringify({ type: 'loginResult', success: code === 0, message: code === 0 ? undefined : 'Authentication failed. Check the code and try again.' }));
              });
            }
          } else if (msg.type === 'toolAnswer') {
            const answerId = (msg as { id?: string }).id ?? '';
            const answers = (msg as { answers?: unknown }).answers as Record<string, string> | undefined;
            // If no active process (DevHarness simulation), echo tool_end + continue
            if (!currentProc) {
              ws.send(JSON.stringify({
                type: 'tool_end',
                call: { id: answerId, name: 'AskUserQuestion', input: {}, result: JSON.stringify({ answers }) },
              }));
              const firstAnswer = answers ? Object.values(answers)[0] : undefined;
              const reply = firstAnswer
                ? `Got it - I'll proceed with the **${firstAnswer}** approach.`
                : 'Understood, proceeding without a selection.';
              setTimeout(() => {
                ws.send(JSON.stringify({ type: 'text_chunk', text: reply }));
                ws.send(JSON.stringify({ type: 'done' }));
              }, 300);
            }
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
