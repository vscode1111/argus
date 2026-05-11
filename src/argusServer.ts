import { createServer } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IncomingMessage } from 'http';

function readSkillDescription(skillDir: string): string | undefined {
  const skillFile = path.join(skillDir, 'SKILL.md');
  try {
    const content = fs.readFileSync(skillFile, 'utf-8');
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (match) {
      const descMatch = match[1].match(/^description:\s*(.+)$/m);
      if (descMatch) return descMatch[1].trim();
    }
  } catch {}
  return undefined;
}

function readSkillsDir(dir: string, scope: 'global' | 'project') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ name: e.name, scope, description: readSkillDescription(path.join(dir, e.name)) }));
}

function readCommandsDir(dir: string, scope: 'global' | 'project') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => {
      const name = e.name.replace(/\.md$/, '');
      let description: string | undefined;
      try {
        const content = fs.readFileSync(path.join(dir, e.name), 'utf-8');
        const firstLine = content.split('\n')[0]?.trim();
        if (firstLine) description = firstLine;
      } catch {}
      return { name, scope, description };
    });
}

const BUILTIN_COMMANDS: { name: string; scope: 'builtin'; description: string }[] = [
  { name: 'clear', scope: 'builtin', description: 'Clear conversation history' },
  { name: 'compact', scope: 'builtin', description: 'Compact conversation to save context' },
  { name: 'context', scope: 'builtin', description: 'Show context window usage' },
  { name: 'cost', scope: 'builtin', description: 'Show token usage and cost' },
  { name: 'diff', scope: 'builtin', description: 'Show file changes since start' },
  { name: 'doctor', scope: 'builtin', description: 'Check installation health' },
  { name: 'help', scope: 'builtin', description: 'Show available commands' },
  { name: 'hooks', scope: 'builtin', description: 'Manage event hooks' },
  { name: 'ide', scope: 'builtin', description: 'IDE integration status' },
  { name: 'init', scope: 'builtin', description: 'Initialize project with CLAUDE.md' },
  { name: 'login', scope: 'builtin', description: 'Sign in to your account' },
  { name: 'logout', scope: 'builtin', description: 'Sign out of your account' },
  { name: 'memory', scope: 'builtin', description: 'Edit CLAUDE.md memory files' },
  { name: 'model', scope: 'builtin', description: 'Switch or show current model' },
  { name: 'permissions', scope: 'builtin', description: 'View or update tool permissions' },
  { name: 'plan', scope: 'builtin', description: 'Create and execute a plan' },
  { name: 'security-review', scope: 'builtin', description: 'Review code for vulnerabilities' },
  { name: 'status', scope: 'builtin', description: 'Show session and account info' },
  { name: 'terminal-setup', scope: 'builtin', description: 'Install shell integration' },
  { name: 'vim', scope: 'builtin', description: 'Toggle vim keybindings' },
];

function getSkills(cwd: string) {
  return [
    ...BUILTIN_COMMANDS,
    ...readCommandsDir(path.join(os.homedir(), '.claude', 'commands'), 'global'),
    ...readCommandsDir(path.join(cwd, '.claude', 'commands'), 'project'),
    ...readSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'global'),
    ...readSkillsDir(path.join(cwd, '.claude', 'skills'), 'project'),
  ];
}

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'argus.json');

const DEFAULT_CONFIG: ArgusConfig = {
  verboseTools: false,
  showTimer: true,
  showOutput: false,
  showLogs: true,
  showLogTime: true,
  showLogType: true,
  soundOnComplete: true,
  notifyOnComplete: true,
  watchdogTimeout: 120,
  watchdogAutoRetries: 3,
};

export interface ArgusConfig {
  verboseTools: boolean;
  showTimer: boolean;
  showOutput: boolean;
  showLogs: boolean;
  showLogTime: boolean;
  showLogType: boolean;
  soundOnComplete: boolean;
  notifyOnComplete: boolean;
  watchdogTimeout: number;
  watchdogAutoRetries: number;
}

function readConfig(): ArgusConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(config: ArgusConfig): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  } catch {}
}

const DEFAULT_MODEL = process.env.ARGUS_MODEL ?? "claude-opus-4-6";
const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];
const PLAN_BLOCKED_TOOLS = ['Write', 'Edit', 'AskUserQuestion'];

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

export interface StartServerOptions {
  port?: number;
  model?: string;
}

export interface ArgusServer {
  httpServer: ReturnType<typeof createServer>;
  port: number;
  close: () => void;
}

export function startServer(options: StartServerOptions = {}): Promise<ArgusServer> {
  const PORT = options.port ?? 3001;
  const MODEL = options.model ?? DEFAULT_MODEL;

  const httpServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const reqUrl = new URL(req.url ?? '/', 'http://localhost');
    let workspaceDir = reqUrl.searchParams.get('dir') || process.cwd();
    let sessionId: string | undefined;
    let currentProc: ReturnType<typeof spawn> | undefined;
    let currentProcKey: string | undefined;
    let loginProc: ReturnType<typeof spawn> | undefined;
    let loginSubmitCode: ((code: string) => void) | undefined;
    let loginClosed = false;
    let loginExitCode: number | null = null;
    const toolMap = new Map<string, { name: string; input: unknown }>();
    const answeredTools = new Set<string>();
    const pendingAskTools = new Set<string>();
    let cliDone = false;
    let suppressCliOutput = false;
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let buffer = '';
    let stderrOutput = '';
    let textAccum = '';
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let autoRetryCount = 0;
    let lastMessage: { text: string; images?: Array<{ data: string; mediaType: string; name?: string }>; mode?: string } | null = null;
    const RETRY_DELAYS = [5000, 15000, 30000];
    const API_ERROR_RE = /API Error:|Failed to authenticate|Request not allowed|socket connection was closed|overloaded_error|invalid_api_key|permission_error/i;

    let lastEventTime = 0;
    let watchdogActive = false;
    let watchdogRetrying = false;
    const watchdogInterval = setInterval(() => {
      if (!watchdogActive || cliDone || lastEventTime === 0) return;
      const cfg = readConfig();
      const elapsed = (Date.now() - lastEventTime) / 1000;
      if (elapsed < cfg.watchdogTimeout) return;

      if (autoRetryCount < cfg.watchdogAutoRetries && lastMessage) {
        autoRetryCount++;
        const delay = RETRY_DELAYS[Math.min(autoRetryCount - 1, RETRY_DELAYS.length - 1)];
        sendLog('warn', `Watchdog: no CLI events for ${Math.round(elapsed)}s, auto-retry ${autoRetryCount}/${cfg.watchdogAutoRetries} in ${delay / 1000}s`);
        ws.send(JSON.stringify({
          type: 'retry_status',
          attempt: 0,
          maxRetries: 0,
          delayMs: delay,
          autoRetry: autoRetryCount,
          autoRetryMax: cfg.watchdogAutoRetries,
        }));
        lastEventTime = Date.now();
        watchdogRetrying = true;
        currentProc?.kill();
        setTimeout(() => {
          watchdogRetrying = false;
          if (!lastMessage) return;
          const synthetic = JSON.stringify({
            type: 'send',
            text: lastMessage.text,
            images: lastMessage.images,
            mode: lastMessage.mode,
            _silent: true,
          });
          ws.emit('message', Buffer.from(synthetic));
        }, delay);
      } else {
        sendLog('error', `Watchdog: no CLI events for ${Math.round(elapsed)}s, all retries exhausted`);
        watchdogActive = false;
        currentProc?.kill();
        ws.send(JSON.stringify({
          type: 'retry_status',
          attempt: 0, maxRetries: 0, delayMs: 0,
          autoRetry: autoRetryCount,
          autoRetryMax: cfg.watchdogAutoRetries,
          timedOut: true,
        }));
      }
    }, 5000);

    function resetStaleTimer() {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = null;
    }

    function startStaleTimer() {
      resetStaleTimer();
      staleTimer = setTimeout(() => {
        if (cliDone) return;
        if (textAccum && API_ERROR_RE.test(textAccum)) {
          cliDone = true;
          const errText = textAccum.trim();
          textAccum = '';
          const { errorKind } = classifyError(errText, 1);
          ws.send(JSON.stringify({ type: 'error', text: errText, errorKind }));
          ws.send(JSON.stringify({ type: 'done' }));
        }
      }, 3000);
    }
    let receivedDeltas = false;
    const MAX_CONTEXT = 200_000;

    const sendLog = (level: 'debug' | 'info' | 'warn' | 'error', text: string) => {
      ws.send(JSON.stringify({ type: 'log', level, text, timestamp: new Date().toISOString() }));
    };

    const attachProcHandlers = (proc: ReturnType<typeof spawn>) => {
      proc.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(trimmed); } catch {
            sendLog('warn', `non-JSON stdout: ${trimmed.slice(0, 200)}`);
            // Detect raw error text from CLI (not wrapped in JSON event)
            const API_ERROR_RAW = /API Error:|Failed to authenticate|Request not allowed|socket connection was closed/i;
            if (API_ERROR_RAW.test(trimmed) && !cliDone) {
              cliDone = true;
              const { errorKind } = classifyError(trimmed, 1);
              ws.send(JSON.stringify({ type: 'error', text: trimmed, errorKind }));
              ws.send(JSON.stringify({ type: 'done' }));
            }
            continue;
          }

          sendLog('debug', `event: ${event.type} ${trimmed.slice(0, 120)}`);
          lastEventTime = Date.now();

          if (event.type === 'system' && event.subtype === 'init') {
            sessionId = event.session_id as string;
          } else if (event.type === 'system' && event.subtype === 'api_retry') {
            const attempt = event.attempt as number;
            const maxRetries = event.max_retries as number;
            const delayMs = event.retry_delay_ms as number;
            ws.send(JSON.stringify({ type: 'retry_status', attempt, maxRetries, delayMs }));
          } else if (event.type === 'content_block_delta') {
            if (suppressCliOutput) continue;
            const delta = event.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'text_delta' && delta.text) {
              receivedDeltas = true;
              textAccum += delta.text as string;
              startStaleTimer();
              ws.send(JSON.stringify({ type: 'text_chunk', text: delta.text }));
            } else if (delta?.type === 'thinking_delta' && delta.thinking) {
              ws.send(JSON.stringify({ type: 'thinking_chunk', text: delta.thinking }));
            }
          } else if (event.type === 'assistant') {
            autoRetryCount = 0;
            if (suppressCliOutput) {
              receivedDeltas = false;
              continue;
            }
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
                if (block.name === 'AskUserQuestion') {
                  pendingAskTools.add(block.id as string);
                }
              }
            }
            receivedDeltas = false;
            const usage = (event.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
            if (usage) {
              const newInput = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
              const newOutput = usage.output_tokens ?? 0;
              if (newInput > 0 || newOutput > 0) {
                turnInputTokens = newInput;
                turnOutputTokens = newOutput;
                const total = turnInputTokens + turnOutputTokens;
                const percent = Math.min(100, Math.round(total / MAX_CONTEXT * 100));
                ws.send(JSON.stringify({ type: 'contextUsage', percent, inputTokens: turnInputTokens, outputTokens: turnOutputTokens }));
              }
            }
          } else if (event.type === 'tool_result') {
            if (suppressCliOutput) continue;
            const toolId = event.tool_use_id as string;
            if (answeredTools.has(toolId)) {
              answeredTools.delete(toolId);
              sendLog('info', `Suppressing CLI echo for ${toolId} (already answered)`);
            } else if (pendingAskTools.has(toolId)) {
              suppressCliOutput = true;
              sendLog('info', `Suppressing CLI auto-result for AskUserQuestion ${toolId}`);
            } else {
              const tc = toolMap.get(toolId);
              ws.send(JSON.stringify({
                type: 'tool_end',
                call: { id: toolId, name: tc?.name ?? '', input: tc?.input ?? {}, result: event.content },
              }));
            }
          } else if (event.type === 'user') {
            if (suppressCliOutput) continue;
            const userMsg = event as { type: 'user'; message?: { content?: Array<Record<string, unknown>> }; content?: Array<Record<string, unknown>> };
            const raw = userMsg.message?.content ?? userMsg.content ?? [];
            const blocks = Array.isArray(raw) ? raw : [];
            sendLog('debug', `user message: ${blocks.length} block(s)`);
            for (const block of blocks) {
              if (block.type === 'tool_result') {
                const toolId = block.tool_use_id as string;
                if (answeredTools.has(toolId)) {
                  answeredTools.delete(toolId);
                  sendLog('info', `Suppressing CLI echo for ${toolId} (already answered)`);
                  continue;
                }
                if (pendingAskTools.has(toolId)) {
                  suppressCliOutput = true;
                  sendLog('info', `Suppressing CLI auto-result for AskUserQuestion ${toolId}`);
                  continue;
                }
                const tc = toolMap.get(toolId);
                const content = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content);
                sendLog('debug', `tool_result ${toolId}: ${String(content).slice(0, 100)}`);
                ws.send(JSON.stringify({
                  type: 'tool_end',
                  call: { id: toolId, name: tc?.name ?? '', input: tc?.input ?? {}, result: content },
                }));
              }
            }
          } else if (event.type === 'result') {
            cliDone = true;
            resetStaleTimer();
            watchdogActive = false;
            // Detect error results from the CLI (API errors, auth failures, etc.)
            if (event.is_error === true || event.subtype === 'error') {
              const errText = typeof event.error === 'string' ? event.error
                : (event.error as Record<string, unknown>)?.message as string
                ?? event.result as string ?? 'Unknown error';
              const { errorKind } = classifyError(errText, 1);
              ws.send(JSON.stringify({ type: 'error', text: errText, errorKind }));
            }
            if (pendingAskTools.size === 0) {
              ws.send(JSON.stringify({ type: 'done' }));
            }
          } else if (!['content_block_start', 'content_block_stop', 'message_start', 'message_stop', 'message_delta', 'ping', 'rate_limit_event'].includes(event.type as string)) {
            sendLog('warn', `unhandled event type: ${event.type} ${trimmed.slice(0, 120)}`);
          }
        }
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrOutput += text;
        console.error('[argus-server]', text.trim());
        sendLog('warn', `stderr: ${text.trim()}`);
      });

      proc.on('close', (code) => {
        resetStaleTimer();
        const isActiveProc = currentProc === proc;
        if (isActiveProc) {
          currentProc = undefined;
          currentProcKey = undefined;
        }
        sendLog('info', `claude exited with code ${code}${watchdogRetrying ? ' (watchdog retry pending)' : ''}`);
        if (watchdogRetrying) return;
        watchdogActive = false;
        if (code !== 0 && code !== null) {
          const { message, errorKind } = classifyError(stderrOutput, code);
          if (pendingAskTools.size > 0) {
            sendLog('warn', `CLI exited (${errorKind}) with ${pendingAskTools.size} pending question(s): ${message}`);
          } else if (isActiveProc) {
            ws.send(JSON.stringify({ type: 'error', text: message, errorKind }));
            ws.send(JSON.stringify({ type: 'done' }));
          }
        } else if (isActiveProc && pendingAskTools.size === 0 && !cliDone) {
          ws.send(JSON.stringify({ type: 'done' }));
        }
      });

      proc.on('error', (err) => {
        currentProc = undefined;
        currentProcKey = undefined;
        sendLog('error', `spawn error: ${err.message}`);
        const errText = err.message.includes('ENOENT')
          ? 'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code'
          : err.message;
        ws.send(JSON.stringify({ type: 'error', text: errText }));
        ws.send(JSON.stringify({ type: 'done' }));
      });
    };

    ws.on('close', () => {
      watchdogActive = false;
      clearInterval(watchdogInterval);
      resetStaleTimer();
      currentProc?.kill();
      loginProc?.kill();
    });

    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as {
        type: string;
        text?: string;
        images?: Array<{ data: string; mediaType: string; name?: string }>;
        mode?: 'plan' | 'edit';
        _silent?: boolean;
        path?: string;
      };

      if (msg.type === 'send' && msg.text?.trim() === '/clear') {
        sessionId = undefined;
        currentProc?.kill();
        ws.send(JSON.stringify({ type: 'clear' }));
      } else if (msg.type === 'send' && (msg.text || msg.images?.length)) {
        const text = msg.text ?? '';
        const images = msg.images;

        if (!msg._silent) {
          ws.send(JSON.stringify({
            type: 'message',
            message: { id: String(Date.now()), role: 'user', content: text, images },
          }));
        }

        const isPlan = msg.mode === 'plan';
        const tools = isPlan
          ? ALLOWED_TOOLS.filter(t => !PLAN_BLOCKED_TOOLS.includes(t))
          : ALLOWED_TOOLS;
        const baseArgs = [
          '--print', '--verbose',
          '--output-format', 'stream-json',
          '--input-format', 'stream-json',
          '--model', MODEL,
          '--tools', tools.join(','),
          '--allowedTools', tools.join(','),
        ];
        if (isPlan) {
          baseArgs.push('--permission-mode', 'plan');
          baseArgs.push('--disallowedTools', PLAN_BLOCKED_TOOLS.join(','));
        }
        const procKey = baseArgs.join(' ');
        const args = [...baseArgs];
        if (sessionId && (!currentProc || currentProcKey !== procKey)) {
          args.push('--resume', sessionId);
        }

        if (!msg._silent) {
          lastMessage = { text, images, mode: msg.mode };
          autoRetryCount = 0;
        }

        // Reset turn-local state
        buffer = '';
        stderrOutput = '';
        textAccum = '';
        resetStaleTimer();
        watchdogActive = false;
        receivedDeltas = false;
        suppressCliOutput = false;
        cliDone = false;
        toolMap.clear();
        answeredTools.clear();
        pendingAskTools.clear();

        const canReuse = currentProc?.stdin?.writable === true && currentProcKey === procKey;
        let proc: ReturnType<typeof spawn>;
        if (canReuse) {
          proc = currentProc!;
          sendLog('info', 'Reusing claude process');
        } else {
          if (currentProc) {
            sendLog('info', 'Args changed, respawning claude');
            currentProc.kill();
          }
          sendLog('info', `Spawning claude: ${args.join(' ')}`);
          proc = spawn('claude', args, {
            cwd: workspaceDir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          currentProc = proc;
          currentProcKey = procKey;
          attachProcHandlers(proc);
        }

        if (!msg._silent) {
          ws.send(JSON.stringify({ type: 'thinking_start', reused: canReuse }));
        }
        lastEventTime = Date.now();
        watchdogActive = true;

        const contentBlocks: Array<Record<string, unknown>> = [];
        if (images && images.length > 0) {
          for (const img of images) {
            if (img.mediaType.startsWith('text/')) {
              const text = Buffer.from(img.data, 'base64').toString('utf-8');
              const fileName = img.name ?? 'file.txt';
              contentBlocks.push({ type: 'text', text: `[Attached file: ${fileName}]\n${text}` });
            } else if (img.mediaType === 'application/pdf') {
              contentBlocks.push({
                type: 'document',
                source: { type: 'base64', media_type: img.mediaType, data: img.data },
              });
            } else {
              contentBlocks.push({
                type: 'image',
                source: { type: 'base64', media_type: img.mediaType, data: img.data },
              });
            }
          }
          sendLog('debug', `Attaching ${images.length} attachment(s)`);
        }
        if (text) {
          contentBlocks.push({ type: 'text', text });
        }
        const stdinMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: contentBlocks } });
        sendLog('debug', `stdin: ${stdinMsg.length} bytes`);
        proc.stdin!.write(stdinMsg + '\n');

      } else if (msg.type === 'getSettings') {
        ws.send(JSON.stringify({ type: 'settings', settings: readConfig() }));
      } else if (msg.type === 'updateSettings') {
        const patch = (msg as { settings?: Partial<ArgusConfig> }).settings;
        if (patch) {
          const config = { ...readConfig(), ...patch };
          writeConfig(config);
          ws.send(JSON.stringify({ type: 'settings', settings: config }));
        }
      } else if (msg.type === 'getInfo') {
        let version = '';
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
          version = pkg.version ?? '';
        } catch {}
        ws.send(JSON.stringify({ type: 'workspaceInfo', path: workspaceDir, version }));
      } else if (msg.type === 'retry') {
        if (lastMessage) {
          sendLog('info', 'Retrying last message');
          ws.emit('message', Buffer.from(JSON.stringify({
            type: 'send',
            text: lastMessage.text,
            images: lastMessage.images,
            mode: lastMessage.mode,
          })));
        }
      } else if (msg.type === 'forceError') {
        currentProc?.kill();
        ws.send(JSON.stringify({ type: 'error', text: 'Forced error (kill button)' }));
      } else if (msg.type === 'getSkills') {
        ws.send(JSON.stringify({ type: 'skills', skills: getSkills(workspaceDir) }));
      } else if (msg.type === 'login') {
        loginProc?.kill();
        sendLog('info', 'Starting claude login');
        const lp = spawn('claude', ['auth', 'login'], { cwd: workspaceDir, stdio: ['pipe', 'pipe', 'pipe'] });
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
        const content = JSON.stringify({ answers });
        const tc = toolMap.get(answerId);

        pendingAskTools.delete(answerId);
        answeredTools.add(answerId);
        if (currentProc?.stdin?.writable && !cliDone) {
          ws.send(JSON.stringify({
            type: 'tool_end',
            call: { id: answerId, name: tc?.name ?? 'AskUserQuestion', input: tc?.input ?? {}, result: content },
          }));
          const toolResult = JSON.stringify({ type: 'tool_result', tool_use_id: answerId, content });
          sendLog('info', `Sending tool answer for ${answerId}: ${content.slice(0, 100)}`);
          currentProc.stdin.write(toolResult + '\n');
        } else {
          sendLog('info', `Tool answer (fallback) for ${answerId}: ${content.slice(0, 100)}`);
          if (currentProc?.stdin?.writable) {
            currentProc.stdin.end();
          }
          const tc2 = toolMap.get(answerId);
          ws.send(JSON.stringify({
            type: 'tool_end',
            call: { id: answerId, name: tc2?.name ?? 'AskUserQuestion', input: tc2?.input ?? {}, result: content },
          }));
          const willResume = pendingAskTools.size === 0 && sessionId && answers && Object.keys(answers).length > 0;
          if (pendingAskTools.size === 0 && !willResume && cliDone) {
            setTimeout(() => ws.send(JSON.stringify({ type: 'done' })), 100);
          }
          if (willResume) {
            const answerLines = Object.entries(answers!)
              .map(([q, a]) => `- ${q}: ${a}`)
              .join('\n');
            const followUp = `Here are my answers:\n${answerLines}`;
            setTimeout(() => {
              suppressCliOutput = false;
              const synthetic = JSON.stringify({ type: 'send', text: followUp, mode: msg.mode, _silent: true });
              ws.emit('message', Buffer.from(synthetic));
            }, 200);
          }
        }
      } else if (msg.type === 'readFilePreview' && msg.path) {
        const filePath = msg.path;
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          ws.send(JSON.stringify({ type: 'filePreview', path: filePath, content }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'filePreview', path: filePath, content: `Error reading file: ${(err as Error).message}` }));
        }
      } else if (msg.type === 'stop') {
        for (const toolId of pendingAskTools) {
          const tc = toolMap.get(toolId);
          ws.send(JSON.stringify({
            type: 'tool_end',
            call: { id: toolId, name: tc?.name ?? 'AskUserQuestion', input: tc?.input ?? {}, result: JSON.stringify({ cancelled: true }) },
          }));
        }
        pendingAskTools.clear();
        if (currentProc) {
          currentProc.kill();
        } else {
          ws.send(JSON.stringify({ type: 'done' }));
        }
      } else if (msg.type === 'newSession') {
        sessionId = undefined;
      }
    });
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (req.url?.startsWith('/agent')) {
      wss.handleUpgrade(req, socket, head as Buffer, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  return new Promise<ArgusServer>((resolve) => {
    httpServer.listen(PORT, () => {
      const addr = httpServer.address() as { port: number };
      const actualPort = addr.port;
      console.log(`[argus-server] WebSocket agent ready at ws://localhost:${actualPort}/agent`);
      resolve({ httpServer, port: actualPort, close: () => httpServer.close() });
    });
  });
}