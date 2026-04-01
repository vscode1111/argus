import { spawn } from 'child_process';
import { getWorkspaceRoot } from '../utils/workspace';
import { getModel } from '../utils/config';

export type SessionEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; name: string; input?: unknown }
  | { type: 'tool_end'; name: string; result?: string }
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

export class AgentSession {
  private sessionId: string | undefined;
  private readonly cwd: string | undefined;
  private currentProc: ReturnType<typeof spawn> | undefined;

  constructor() {
    this.cwd = getWorkspaceRoot();
  }

  reset(): void {
    this.sessionId = undefined;
  }

  abort(): void {
    this.currentProc?.kill();
    this.currentProc = undefined;
  }

  async *send(prompt: string, systemPrompt?: string): AsyncGenerator<SessionEvent> {
    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
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
      console.log('[Argus] Spawning claude with args:', args.join(' '));

      const proc = spawn('claude', args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;

      proc.stdin.write(prompt);
      proc.stdin.end();

      let stderrOutput = '';
      proc.stderr.on('data', (data: Buffer) => { stderrOutput += data.toString(); });

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
          console.log('[Argus] Event type:', evtType, trimmed.slice(0, 120));

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
                yield { type: 'tool_start', name: block.name, input: block.input };
              }
            }
            receivedDeltas = false; // reset for next turn
            continue;
          }

          if ('type' in msg && msg.type === 'tool_result') {
            const tr = msg as ToolResultMessage;
            yield { type: 'tool_end', name: '', result: tr.content };
            continue;
          }

          if ('result' in msg && typeof msg.result === 'string') {
            yield { type: 'result', text: msg.result };
          }
        }
      }

      this.currentProc = undefined;
      const exitCode = await exitCodePromise;
      if (exitCode !== 0 && exitCode !== null) {
        yield { type: 'error', message: stderrOutput || `claude exited with code ${exitCode}` };
      }
    } catch (err) {
      console.error('[Argus] Query error:', err);
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ENOENT')) {
        yield { type: 'error', message: 'Claude Code CLI not found. Install it with: npm install -g @anthropic/claude-code' };
      } else {
        yield { type: 'error', message };
      }
    }
  }
}
