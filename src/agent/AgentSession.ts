import { spawn } from 'child_process';
import { getWorkspaceRoot } from '../utils/workspace';
import { getModel } from '../utils/config';
import type { ImageAttachment } from '../chat/ChatMessage';

export type ErrorKind = 'auth' | 'not_found' | 'session' | 'generic';

export type SessionEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; id: string; name: string; input?: unknown }
  | { type: 'tool_end'; id: string; result?: string }
  | { type: 'result'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string; errorKind: ErrorKind };

interface SystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
}

interface AssistantMessage {
  type: 'assistant';
  message: {
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >;
  };
}

interface ToolResultMessage {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

interface ResultMessage {
  result: string;
  [key: string]: unknown;
}

type CliMessage = SystemInitMessage | AssistantMessage | ToolResultMessage | ResultMessage | Record<string, unknown>;

const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];
const PLAN_BLOCKED_TOOLS = ['Write', 'Edit', 'AskUserQuestion'];

const AUTH_PATTERNS = [/auth/i, /login/i, /token/i, /unauthorized/i, /401/i, /403/i, /credential/i, /oauth/i, /api[_ ]?key/i];
const SESSION_PATTERNS = [/session/i, /resume/i, /expired/i, /not found.*session/i];

function classifyError(stderr: string, exitCode: number | null): { message: string; errorKind: ErrorKind } {
  const text = stderr.trim();

  if (text) {
    if (AUTH_PATTERNS.some(p => p.test(text))) {
      return { message: text, errorKind: 'auth' };
    }
    if (SESSION_PATTERNS.some(p => p.test(text))) {
      return { message: text, errorKind: 'session' };
    }
  }

  // Exit code 1 typically means auth issue with Claude CLI
  if (exitCode === 1) {
    return { message: text || 'Claude exited unexpectedly. This usually means authentication is required.', errorKind: 'auth' };
  }

  return { message: text || `claude exited with code ${exitCode}`, errorKind: 'generic' };
}

import type * as vscode from 'vscode';

export type LoginResult =
  | { phase: 'url'; url: string; submitCode: (code: string) => Promise<boolean> }
  | { phase: 'error'; message: string };

export class AgentSession {
  private sessionId: string | undefined;
  private readonly cwd: string | undefined;
  private currentProc: ReturnType<typeof spawn> | undefined;
  private loginProc: ReturnType<typeof spawn> | undefined;
  private readonly outputChannel: vscode.OutputChannel | undefined;
  private readonly onLog: ((level: 'debug' | 'info' | 'warn' | 'error', text: string) => void) | undefined;
  private pendingToolResolvers = new Map<string, (result: string) => void>();
  private skipNextToolEnd = new Set<string>();
  public mode: 'plan' | 'edit' = 'edit';

  constructor(outputChannel?: vscode.OutputChannel, onLog?: (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void) {
    this.cwd = getWorkspaceRoot();
    this.outputChannel = outputChannel;
    this.onLog = onLog;
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', text: string): void {
    const line = `[${level.toUpperCase()}] ${text}`;
    this.outputChannel?.appendLine(line);
    this.onLog?.(level, text);
  }

  reset(): void {
    this.sessionId = undefined;
  }

  abort(): void {
    const proc = this.currentProc;
    if (!proc) return;
    this.currentProc = undefined;
    // Resolve pending interactive tool promises to unblock the generator
    for (const [, resolver] of this.pendingToolResolvers) {
      resolver(JSON.stringify({ cancelled: true }));
    }
    this.pendingToolResolvers.clear();
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 3000);
  }

  abortLogin(): void {
    if (this.loginProc) {
      this.loginProc.kill('SIGTERM');
      this.loginProc = undefined;
    }
  }

  async startLogin(): Promise<LoginResult> {
    this.abortLogin();
    this.log('info', 'Starting claude login');

    return new Promise((resolve) => {
      const proc = spawn('claude', ['auth', 'login'], {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.loginProc = proc;

      let output = '';
      let resolved = false;
      let closed = false;
      let closedCode: number | null = null;

      const checkForUrl = (data: string) => {
        output += data;
        this.log('debug', `login output: ${data.trim()}`);
        const urlMatch = output.match(/(https:\/\/[^\s"]+oauth[^\s"]*)/i)
          ?? output.match(/(https:\/\/claude\.ai\/[^\s"]+)/i)
          ?? output.match(/(https:\/\/console\.anthropic\.com\/[^\s"]+)/i)
          ?? output.match(/(https:\/\/[^\s"]+anthropic[^\s"]*)/i);
        if (urlMatch && !resolved) {
          resolved = true;
          const url = urlMatch[1];
          this.log('info', `Login URL captured: ${url}`);
          resolve({
            phase: 'url',
            url,
            submitCode: (code: string) => {
              return new Promise<boolean>((res) => {
                if (closed) {
                  this.log('warn', `Login process already exited (code ${closedCode}) before code was submitted`);
                  res(false);
                  return;
                }
                proc.stdin.write(code + '\n', (err) => {
                  if (err) {
                    this.log('error', `Failed to write login code: ${err.message}`);
                    res(false);
                  }
                });
                proc.on('close', (exitCode) => {
                  this.loginProc = undefined;
                  this.log('info', `Login process exited with code ${exitCode}`);
                  res(exitCode === 0);
                });
              });
            },
          });
        }
      };

      proc.stdout.on('data', (data: Buffer) => checkForUrl(data.toString()));
      proc.stderr.on('data', (data: Buffer) => checkForUrl(data.toString()));

      proc.on('close', (exitCode) => {
        closed = true;
        closedCode = exitCode;
        this.loginProc = undefined;
        if (!resolved) {
          resolved = true;
          this.log('warn', `Login process exited (code ${exitCode}) without producing a URL`);
          resolve({ phase: 'error', message: output.trim() || `claude login exited with code ${exitCode}` });
        }
      });

      proc.on('error', (err) => {
        this.loginProc = undefined;
        if (!resolved) {
          resolved = true;
          this.log('error', `Login spawn error: ${err.message}`);
          resolve({ phase: 'error', message: err.message });
        }
      });
    });
  }

  sendToolResult(toolUseId: string, content: string): void {
    const resolver = this.pendingToolResolvers.get(toolUseId);
    if (resolver) {
      this.pendingToolResolvers.delete(toolUseId);
      this.log('info', `Resolving interactive tool ${toolUseId}: ${content.slice(0, 100)}`);
      resolver(content);
    }
    const proc = this.currentProc;
    if (!proc?.stdin?.writable) return;
    const msg = JSON.stringify({ type: 'tool_result', tool_use_id: toolUseId, content });
    this.log('info', `Sending tool result for ${toolUseId}: ${content.slice(0, 100)}`);
    proc.stdin.write(msg + '\n');
  }

  async *send(prompt: string, systemPrompt?: string, images?: ImageAttachment[]): AsyncGenerator<SessionEvent> {
    const hasImages = images && images.length > 0;
    const isPlan = this.mode === 'plan';
    const tools = isPlan
      ? ALLOWED_TOOLS.filter(t => !PLAN_BLOCKED_TOOLS.includes(t))
      : ALLOWED_TOOLS;
    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--model', getModel(),
      '--tools', tools.join(','),
      '--allowedTools', tools.join(','),
    ];

    if (isPlan) {
      args.push('--permission-mode', 'plan');
      args.push('--disallowedTools', PLAN_BLOCKED_TOOLS.join(','));
    }

    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    this.pendingToolResolvers.clear();
    this.skipNextToolEnd.clear();

    try {
      this.log('info', `Spawning claude: ${args.join(' ')}`);

      const proc = spawn('claude', args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;

      // Always use stream-json input format (NDJSON)
      const content: Array<Record<string, unknown>> = [];
      if (hasImages) {
        for (const img of images) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mediaType,
              data: img.data,
            },
          });
        }
        const totalBytes = images.reduce((s, i) => s + i.data.length, 0);
        this.log('debug', `Attaching ${images.length} image(s), total base64: ${totalBytes} bytes`);
      }
      if (prompt) {
        content.push({ type: 'text', text: prompt });
      }
      const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
      this.log('debug', `stdin: ${msg.length} bytes`);
      proc.stdin.write(msg + '\n');

      let stderrOutput = '';
      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrOutput += text;
        this.outputChannel?.append(text);
        this.onLog?.('warn', `stderr: ${text.trim()}`);
      });

      const exitCodePromise = new Promise<number | null>((resolve, reject) => {
        proc.on('close', (code) => {
          // Resolve any pending interactive tool promises to unblock the generator
          for (const [, resolver] of this.pendingToolResolvers) {
            resolver(JSON.stringify({ cancelled: true }));
          }
          this.pendingToolResolvers.clear();
          resolve(code);
        });
        proc.on('error', reject);
      });

      let buffer = '';
      let receivedDeltas = false;
      for await (const chunk of proc.stdout) {
        buffer += (chunk as Buffer).toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) { continue; }

          let msg: CliMessage;
          try {
            msg = JSON.parse(trimmed) as CliMessage;
          } catch {
            continue;
          }

          const evtType = 'type' in msg ? String(msg.type) : 'unknown';
          this.log('debug', `event: ${evtType} ${trimmed.slice(0, 120)}`);

          if ('type' in msg && msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
            this.sessionId = (msg as SystemInitMessage).session_id;
            continue;
          }

          // Streaming deltas from the API (token-level streaming)
          if ('type' in msg && msg.type === 'content_block_delta') {
            const delta = (msg as Record<string, unknown>).delta as Record<string, unknown> | undefined;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
              receivedDeltas = true;
              yield { type: 'text', text: delta.text };
            } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
              yield { type: 'thinking', text: delta.thinking };
            }
            continue;
          }

          if ('type' in msg && msg.type === 'assistant') {
            const assistantMsg = msg as AssistantMessage;
            const usage = (assistantMsg.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
            if (usage) {
              const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
              const outputTokens = usage.output_tokens ?? 0;
              if (inputTokens > 0 || outputTokens > 0) {
                yield { type: 'usage', inputTokens, outputTokens };
              }
            }
            for (const block of assistantMsg.message?.content ?? []) {
              if (block.type === 'thinking' && block.thinking) {
                yield { type: 'thinking', text: block.thinking };
              } else if (block.type === 'text' && block.text && !receivedDeltas) {
                yield { type: 'text', text: block.text };
              } else if (block.type === 'tool_use') {
                this.log('info', `tool_start: ${block.name} (${block.id})`);
                yield { type: 'tool_start', id: block.id, name: block.name, input: block.input };
                if (block.name === 'AskUserQuestion') {
                  const userResult = await new Promise<string>(resolve => {
                    this.pendingToolResolvers.set(block.id, resolve);
                  });
                  this.log('info', `AskUserQuestion ${block.id} answered: ${userResult.slice(0, 100)}`);
                  this.skipNextToolEnd.add(block.id);
                  yield { type: 'tool_end', id: block.id, result: userResult };
                }
              }
            }
            receivedDeltas = false; // reset for next turn
            continue;
          }

          if ('type' in msg && msg.type === 'tool_result') {
            const tr = msg as ToolResultMessage;
            yield { type: 'tool_end', id: tr.tool_use_id, result: tr.content };
            continue;
          }

          // CLI wraps tool results in a "user" message with content array
          if ('type' in msg && msg.type === 'user') {
            const userMsg = msg as { type: 'user'; message?: { content?: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>  }; content?: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> };
            const blocks = userMsg.message?.content ?? userMsg.content ?? [];
            this.log('debug', `user message: ${blocks.length} block(s) [${blocks.map(b => `${b.type}:${b.tool_use_id}`).join(', ')}]`);
            for (const block of blocks) {
              if (block.type === 'tool_result') {
                const toolId = block.tool_use_id ?? '';
                const content = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content);
                this.log('debug', `tool_result ${toolId}: ${content?.slice(0, 100)}`);
                if (this.skipNextToolEnd.has(toolId)) {
                  this.skipNextToolEnd.delete(toolId);
                  this.log('info', `Skipping CLI auto-result for ${toolId} (answered interactively)`);
                  continue;
                }
                yield { type: 'tool_end', id: toolId, result: content ?? '' };
              }
            }
            continue;
          }

          if ('result' in msg && typeof msg.result === 'string') {
            yield { type: 'result', text: msg.result };
            continue;
          }

          this.log('warn', `unhandled event type: ${evtType} keys: ${Object.keys(msg).join(',')} ${trimmed.slice(0, 200)}`);
        }
      }

      this.currentProc = undefined;
      const exitCode = await exitCodePromise;
      this.log('info', `claude exited with code ${exitCode}`);
      if (exitCode !== 0 && exitCode !== null) {
        const classified = classifyError(stderrOutput, exitCode);
        yield { type: 'error', ...classified };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', `spawn error: ${errMsg}`);
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ENOENT')) {
        yield { type: 'error', message: 'Claude Code CLI not found. Install it with: npm install -g @anthropic/claude-code', errorKind: 'not_found' as ErrorKind };
      } else {
        yield { type: 'error', message, errorKind: 'generic' as ErrorKind };
      }
    }
  }
}
