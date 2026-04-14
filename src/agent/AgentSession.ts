import { spawn } from 'child_process';
import { getWorkspaceRoot } from '../utils/workspace';
import { getModel } from '../utils/config';
import type { ImageAttachment } from '../chat/ChatMessage';

export type SessionEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; id: string; name: string; input?: unknown }
  | { type: 'tool_end'; id: string; result?: string }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string };

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

const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

import type * as vscode from 'vscode';

export class AgentSession {
  private sessionId: string | undefined;
  private readonly cwd: string | undefined;
  private currentProc: ReturnType<typeof spawn> | undefined;
  private readonly outputChannel: vscode.OutputChannel | undefined;
  private readonly onLog: ((level: 'debug' | 'info' | 'warn' | 'error', text: string) => void) | undefined;

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
    this.currentProc?.kill();
    this.currentProc = undefined;
  }

  async *send(prompt: string, systemPrompt?: string, images?: ImageAttachment[]): AsyncGenerator<SessionEvent> {
    const hasImages = images && images.length > 0;
    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--model', getModel(),
      '--allowedTools', ALLOWED_TOOLS.join(','),
    ];

    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

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
      proc.stdin.end();

      let stderrOutput = '';
      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrOutput += text;
        this.outputChannel?.append(text);
        this.onLog?.('warn', `stderr: ${text.trim()}`);
      });

      const exitCodePromise = new Promise<number | null>((resolve, reject) => {
        proc.on('close', resolve);
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
            for (const block of assistantMsg.message?.content ?? []) {
              if (block.type === 'thinking' && block.thinking) {
                yield { type: 'thinking', text: block.thinking };
              } else if (block.type === 'text' && block.text && !receivedDeltas) {
                yield { type: 'text', text: block.text };
              } else if (block.type === 'tool_use') {
                this.log('info', `tool_start: ${block.name} (${block.id})`);
                yield { type: 'tool_start', id: block.id, name: block.name, input: block.input };
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
                const content = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content);
                this.log('debug', `tool_result ${block.tool_use_id}: ${content?.slice(0, 100)}`);
                yield { type: 'tool_end', id: block.tool_use_id ?? '', result: content ?? '' };
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
        yield { type: 'error', message: stderrOutput || `claude exited with code ${exitCode}` };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', `spawn error: ${errMsg}`);
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ENOENT')) {
        yield { type: 'error', message: 'Claude Code CLI not found. Install it with: npm install -g @anthropic/claude-code' };
      } else {
        yield { type: 'error', message };
      }
    }
  }
}
