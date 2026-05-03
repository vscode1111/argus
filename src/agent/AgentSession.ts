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

type QueueItem =
  | SessionEvent
  | { type: '__turn_end' }
  | { type: '__proc_close'; code: number | null; stderr: string };

export class AgentSession {
  private sessionId: string | undefined;
  private readonly cwd: string | undefined;
  private currentProc: ReturnType<typeof spawn> | undefined;
  private currentProcKey: string | undefined;
  private loginProc: ReturnType<typeof spawn> | undefined;
  private readonly outputChannel: vscode.OutputChannel | undefined;
  private readonly onLog: ((level: 'debug' | 'info' | 'warn' | 'error', text: string) => void) | undefined;
  private skipNextToolEnd = new Set<string>();
  private pendingAskTools = new Set<string>();
  private toolMap = new Map<string, { name: string; input: unknown }>();
  private eventQueue: QueueItem[] = [];
  private eventResolver: (() => void) | undefined;
  private buffer = '';
  private stderrOutput = '';
  private receivedDeltas = false;
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
    const proc = this.currentProc;
    this.currentProc = undefined;
    this.currentProcKey = undefined;
    proc?.kill('SIGTERM');
  }

  abort(): void {
    const proc = this.currentProc;
    if (!proc) return;
    this.currentProc = undefined;
    this.currentProcKey = undefined;
    for (const id of this.pendingAskTools) {
      this.pushEvent({ type: 'tool_end', id, result: JSON.stringify({ cancelled: true }) });
    }
    this.pendingAskTools.clear();
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 3000);
  }

  private pushEvent(item: QueueItem): void {
    this.eventQueue.push(item);
    const r = this.eventResolver;
    this.eventResolver = undefined;
    r?.();
  }

  private nextEvent(): Promise<QueueItem> {
    if (this.eventQueue.length > 0) {
      return Promise.resolve(this.eventQueue.shift()!);
    }
    return new Promise<QueueItem>(resolve => {
      this.eventResolver = () => resolve(this.eventQueue.shift()!);
    });
  }

  private attachProcHandlers(proc: ReturnType<typeof spawn>): void {
    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: CliMessage;
        try { msg = JSON.parse(trimmed) as CliMessage; } catch { continue; }
        this.handleCliMessage(msg, trimmed);
      }
    });

    proc.stderr!.on('data', (data: Buffer) => {
      const text = data.toString();
      this.stderrOutput += text;
      this.outputChannel?.append(text);
      this.onLog?.('warn', `stderr: ${text.trim()}`);
    });

    proc.on('close', (code) => {
      const wasActive = this.currentProc === proc;
      if (wasActive) {
        this.currentProc = undefined;
        this.currentProcKey = undefined;
      }
      this.log('info', `claude exited with code ${code}`);
      this.pushEvent({ type: '__proc_close', code, stderr: this.stderrOutput });
    });

    proc.on('error', (err) => {
      this.currentProc = undefined;
      this.currentProcKey = undefined;
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `spawn error: ${message}`);
      const errorKind: ErrorKind = message.includes('ENOENT') ? 'not_found' : 'generic';
      const friendly = errorKind === 'not_found'
        ? 'Claude Code CLI not found. Install it with: npm install -g @anthropic/claude-code'
        : message;
      this.pushEvent({ type: 'error', message: friendly, errorKind });
      this.pushEvent({ type: '__turn_end' });
    });
  }

  private handleCliMessage(msg: CliMessage, raw: string): void {
    const evtType = 'type' in msg ? String(msg.type) : 'unknown';
    this.log('debug', `event: ${evtType} ${raw.slice(0, 120)}`);

    if ('type' in msg && msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
      this.sessionId = (msg as SystemInitMessage).session_id;
      return;
    }

    if ('type' in msg && msg.type === 'content_block_delta') {
      const delta = (msg as Record<string, unknown>).delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        this.receivedDeltas = true;
        this.pushEvent({ type: 'text', text: delta.text });
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        this.pushEvent({ type: 'thinking', text: delta.thinking });
      }
      return;
    }

    if ('type' in msg && msg.type === 'assistant') {
      const assistantMsg = msg as AssistantMessage;
      const usage = (assistantMsg.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
      if (usage) {
        const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        const outputTokens = usage.output_tokens ?? 0;
        if (inputTokens > 0 || outputTokens > 0) {
          this.pushEvent({ type: 'usage', inputTokens, outputTokens });
        }
      }
      for (const block of assistantMsg.message?.content ?? []) {
        if (block.type === 'thinking' && block.thinking) {
          this.pushEvent({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'text' && block.text && !this.receivedDeltas) {
          this.pushEvent({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          this.log('info', `tool_start: ${block.name} (${block.id})`);
          this.toolMap.set(block.id, { name: block.name, input: block.input });
          this.pushEvent({ type: 'tool_start', id: block.id, name: block.name, input: block.input });
          if (block.name === 'AskUserQuestion') {
            this.pendingAskTools.add(block.id);
          }
        }
      }
      this.receivedDeltas = false;
      return;
    }

    if ('type' in msg && msg.type === 'tool_result') {
      const tr = msg as ToolResultMessage;
      if (this.skipNextToolEnd.has(tr.tool_use_id)) {
        this.skipNextToolEnd.delete(tr.tool_use_id);
        this.log('info', `Skipping CLI auto-result for ${tr.tool_use_id} (answered interactively)`);
        return;
      }
      this.pushEvent({ type: 'tool_end', id: tr.tool_use_id, result: tr.content });
      return;
    }

    if ('type' in msg && msg.type === 'user') {
      const userMsg = msg as { type: 'user'; message?: { content?: Array<{ type: string; tool_use_id?: string; content?: unknown }> }; content?: Array<{ type: string; tool_use_id?: string; content?: unknown }> };
      const raw2 = userMsg.message?.content ?? userMsg.content ?? [];
      const blocks = Array.isArray(raw2) ? raw2 : [];
      this.log('debug', `user message: ${blocks.length} block(s) [${blocks.map(b => `${b.type}:${b.tool_use_id}`).join(', ')}]`);
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const toolId = block.tool_use_id ?? '';
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          this.log('debug', `tool_result ${toolId}: ${content?.slice(0, 100)}`);
          if (this.skipNextToolEnd.has(toolId)) {
            this.skipNextToolEnd.delete(toolId);
            this.log('info', `Skipping CLI auto-result for ${toolId} (answered interactively)`);
            continue;
          }
          this.pushEvent({ type: 'tool_end', id: toolId, result: content ?? '' });
        }
      }
      return;
    }

    if ('result' in msg && typeof msg.result === 'string') {
      this.pushEvent({ type: 'result', text: msg.result });
      this.pushEvent({ type: '__turn_end' });
      return;
    }

    this.log('warn', `unhandled event type: ${evtType} keys: ${Object.keys(msg).join(',')} ${raw.slice(0, 200)}`);
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
    if (this.pendingAskTools.has(toolUseId)) {
      this.pendingAskTools.delete(toolUseId);
      this.skipNextToolEnd.add(toolUseId);
      this.pushEvent({ type: 'tool_end', id: toolUseId, result: content });
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
    const baseArgs = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--model', getModel(),
      '--tools', tools.join(','),
      '--allowedTools', tools.join(','),
    ];
    if (isPlan) {
      baseArgs.push('--permission-mode', 'plan');
      baseArgs.push('--disallowedTools', PLAN_BLOCKED_TOOLS.join(','));
    }

    // procKey excludes --resume (added per-spawn) and --system-prompt
    // (changes when active file changes; stale system prompt is acceptable)
    const procKey = baseArgs.join(' ');

    // Reset turn-local state
    this.eventQueue = [];
    this.eventResolver = undefined;
    this.buffer = '';
    this.stderrOutput = '';
    this.receivedDeltas = false;
    this.skipNextToolEnd.clear();
    this.pendingAskTools.clear();
    this.toolMap.clear();

    const canReuse = this.currentProc?.stdin?.writable === true && this.currentProcKey === procKey;
    let proc: ReturnType<typeof spawn>;
    if (canReuse) {
      proc = this.currentProc!;
      this.log('info', 'Reusing claude process');
    } else {
      if (this.currentProc) {
        this.log('info', 'Args changed, respawning claude');
        this.currentProc.kill();
      }
      const args = [...baseArgs];
      if (this.sessionId) {
        args.push('--resume', this.sessionId);
      }
      if (systemPrompt) {
        args.push('--system-prompt', systemPrompt);
      }
      this.log('info', `Spawning claude: ${args.join(' ')}`);
      try {
        proc = spawn('claude', args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.log('error', `spawn error: ${errMsg}`);
        if (errMsg.includes('ENOENT')) {
          yield { type: 'error', message: 'Claude Code CLI not found. Install it with: npm install -g @anthropic/claude-code', errorKind: 'not_found' };
        } else {
          yield { type: 'error', message: errMsg, errorKind: 'generic' };
        }
        return;
      }
      this.currentProc = proc;
      this.currentProcKey = procKey;
      this.attachProcHandlers(proc);
    }

    const content: Array<Record<string, unknown>> = [];
    if (hasImages) {
      for (const img of images) {
        if (img.mediaType.startsWith('text/')) {
          const text = Buffer.from(img.data, 'base64').toString('utf-8');
          const fileName = img.name ?? 'file.txt';
          content.push({ type: 'text', text: `[Attached file: ${fileName}]\n${text}` });
        } else if (img.mediaType === 'application/pdf') {
          content.push({
            type: 'document',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          });
        } else {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          });
        }
      }
      const totalBytes = images.reduce((s, i) => s + i.data.length, 0);
      this.log('debug', `Attaching ${images.length} attachment(s), total base64: ${totalBytes} bytes`);
    }
    if (prompt) {
      content.push({ type: 'text', text: prompt });
    }
    const stdinMsg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
    this.log('debug', `stdin: ${stdinMsg.length} bytes`);
    proc.stdin!.write(stdinMsg + '\n');

    while (true) {
      const item = await this.nextEvent();
      if (item.type === '__turn_end') return;
      if (item.type === '__proc_close') {
        if (item.code !== 0 && item.code !== null) {
          const classified = classifyError(item.stderr, item.code);
          yield { type: 'error', ...classified };
        }
        return;
      }
      yield item;
    }
  }
}
