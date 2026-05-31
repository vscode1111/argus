import { createServer } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { IncomingMessage } from 'http';

import { IS_WIN, resolveClaudeBin, killProc, plural, classifyError, URL_PATTERNS, API_ERROR_RE } from './cli';
import { readConfig, writeConfig, DEFAULT_CONFIG, type ArgusConfig } from './config';
import { getSkills } from './skills';

export type { ArgusConfig } from './config';

const DEFAULT_MODEL = process.env.ARGUS_MODEL ?? "claude-opus-4-6";
const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];
const PLAN_BLOCKED_TOOLS = ['Write', 'Edit', 'AskUserQuestion'];

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
    let userStopped = false;
    let suppressCliOutput = false;
    let pendingFollowUp: { answers: Record<string, string>; toolId: string; mode?: string } | undefined;
    const pendingBgTasks = new Set<string>();
    let totalBgTasks = 0;
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let buffer = '';
    let stderrOutput = '';
    let textAccum = '';
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let autoRetryCount = 0;
    let lastMessage: { text: string; images?: Array<{ data: string; mediaType: string; name?: string }>; mode?: string } | null = null;
    function getRetryDelay(attempt: number, baseDelaySec: number, factor: number): number {
      return baseDelaySec * 1000 * Math.pow(factor, attempt);
    }

    let lastEventTime = 0;
    let watchdogActive = false;
    let watchdogRetrying = false;
    let watchdogRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const watchdogInterval = setInterval(() => {
      if (!watchdogActive || cliDone || lastEventTime === 0 || pendingAskTools.size > 0) return;
      const cfg = readConfig();
      if (!cfg.watchdogEnabled) return;
      const elapsed = (Date.now() - lastEventTime) / 1000;
      if (elapsed < cfg.watchdogTimeout) return;

      const errContent = textAccum.trim() || stderrOutput.trim();
      if (errContent && API_ERROR_RE.test(errContent)) {
        cliDone = true;
        resetStaleTimer();
        watchdogActive = false;
        const { errorKind } = classifyError(errContent, 1);
        if (currentProc) killProc(currentProc);
        ws.send(JSON.stringify({ type: 'error', text: errContent, errorKind }));
        ws.send(JSON.stringify({ type: 'done' }));
        return;
      }

      if (autoRetryCount < cfg.watchdogAutoRetries && lastMessage) {
        autoRetryCount++;
        const delay = getRetryDelay(autoRetryCount - 1, cfg.watchdogRetryDelay, cfg.watchdogDelayFactor);
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
        if (currentProc) killProc(currentProc);
        watchdogRetryTimer = setTimeout(() => {
          watchdogRetryTimer = null;
          watchdogRetrying = false;
          if (!lastMessage || cliDone) return;
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
        cliDone = true;
        if (watchdogRetryTimer) {
          clearTimeout(watchdogRetryTimer);
          watchdogRetryTimer = null;
        }
        watchdogRetrying = false;
        if (currentProc) killProc(currentProc);
        ws.send(JSON.stringify({
          type: 'retry_status',
          attempt: 0, maxRetries: 0, delayMs: 0,
          autoRetry: autoRetryCount,
          autoRetryMax: cfg.watchdogAutoRetries,
          timedOut: true,
        }));
        ws.send(JSON.stringify({ type: 'done' }));
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

    function flushAskFollowUp() {
      if (!pendingFollowUp) return;
      const { answers, toolId, mode } = pendingFollowUp;
      pendingFollowUp = undefined;
      const tc = toolMap.get(toolId);
      const questions = (tc?.input as Record<string, unknown>)?.questions as Array<{
        question: string;
        options?: Array<{ label: string; description?: string }>;
      }> | undefined;
      const answerLines = Object.entries(answers).map(([q, a]) => {
        const qDef = questions?.find(qd => qd.question === q);
        const optIdx = qDef?.options?.findIndex(o => o.label === a);
        const optDesc = qDef?.options?.find(o => o.label === a)?.description;
        let line = `Question: "${q}"\nSelected: "${a}"`;
        if (optIdx !== undefined && optIdx >= 0) line += ` (option ${optIdx + 1} of ${qDef!.options!.length})`;
        if (optDesc) line += `\nDescription: ${optDesc}`;
        return line;
      }).join('\n\n');
      const followUp = `The user selected the following answers. Proceed with exactly these choices:\n\n${answerLines}`;
      setTimeout(() => {
        suppressCliOutput = false;
        const synthetic = JSON.stringify({ type: 'send', text: followUp, mode, _silent: true, _askResume: true });
        ws.emit('message', Buffer.from(synthetic));
      }, 200);
    }

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
          if (event.type !== 'ping' && event.type !== 'rate_limit_event') {
            lastEventTime = Date.now();
          }

          if (cliDone && (event.type === 'content_block_delta' || event.type === 'assistant' || event.type === 'message_start')) {
            cliDone = false;
            textAccum = '';
            receivedDeltas = false;
            suppressCliOutput = false;
            toolMap.clear();
            answeredTools.clear();
            pendingAskTools.clear();
            pendingFollowUp = undefined;
            resetStaleTimer();
            watchdogActive = true;
            ws.send(JSON.stringify({ type: 'thinking_start', reused: true }));
            sendLog('info', 'Background task notification: starting autonomous turn');
          }

          if (event.type === 'system' && event.subtype === 'init') {
            sessionId = event.session_id as string;
          } else if (event.type === 'system' && event.subtype === 'task_started') {
            pendingBgTasks.add(event.task_id as string);
            totalBgTasks++;
          } else if (event.type === 'system' && event.subtype === 'task_updated') {
            pendingBgTasks.delete(event.task_id as string);
          } else if (event.type === 'system' && event.subtype === 'task_notification') {
            pendingBgTasks.delete(event.task_id as string);
            const toolUseId = event.tool_use_id as string | undefined;
            const summary = event.summary as string | undefined;
            const outputFile = event.output_file as string | undefined;
            if (toolUseId && summary) {
              let result = summary;
              if (outputFile) {
                try {
                  const output = fs.readFileSync(outputFile, 'utf-8').trim();
                  if (output) result += '\n\nOutput:\n' + output;
                } catch {}
              }
              ws.send(JSON.stringify({ type: 'tool_end', call: { id: toolUseId, name: 'Bash', input: {}, result } }));
            }
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
              } else if (block.type === 'tool_use' && !toolMap.has(block.id as string) && !answeredTools.has(block.id as string)) {
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
              if (toolMap.get(toolId)?.name === 'AskUserQuestion') suppressCliOutput = true;
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
            sendLog('debug', `user message: ${plural(blocks.length, 'block')}`);
            for (const block of blocks) {
              if (block.type === 'tool_result') {
                const toolId = block.tool_use_id as string;
                if (answeredTools.has(toolId)) {
                  answeredTools.delete(toolId);
                  if (toolMap.get(toolId)?.name === 'AskUserQuestion') suppressCliOutput = true;
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
            if (event.is_error === true || event.subtype === 'error') {
              const errText = typeof event.error === 'string' ? event.error
                : (event.error as Record<string, unknown>)?.message as string
                ?? event.result as string ?? 'Unknown error';
              const { errorKind } = classifyError(errText, 1);
              ws.send(JSON.stringify({ type: 'error', text: errText, errorKind }));
            }
            if (pendingFollowUp) {
              flushAskFollowUp();
            } else if (pendingAskTools.size === 0) {
              ws.send(JSON.stringify({ type: 'done', ...(pendingBgTasks.size > 0 ? { pendingBackgroundTasks: pendingBgTasks.size, totalBackgroundTasks: totalBgTasks } : {}) }));
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

      proc.stdin!.on('error', (err) => {
        sendLog('warn', `stdin error (CLI likely crashed): ${err.message}`);
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
        if (userStopped) {
          userStopped = false;
          if (isActiveProc) ws.send(JSON.stringify({ type: 'done' }));
        } else if (code !== 0 && code !== null) {
          const { message, errorKind } = classifyError(stderrOutput, code);
          if (pendingAskTools.size > 0) {
            sendLog('warn', `CLI exited (${errorKind}) with ${plural(pendingAskTools.size, 'pending question')}: ${message}`);
          } else if (isActiveProc) {
            ws.send(JSON.stringify({ type: 'error', text: message, errorKind }));
            ws.send(JSON.stringify({ type: 'done' }));
          }
        } else if (isActiveProc && pendingAskTools.size === 0 && !cliDone) {
          if (code === null) {
            const accErr = textAccum.trim() || stderrOutput.trim();
            if (accErr && API_ERROR_RE.test(accErr)) {
              const { errorKind } = classifyError(accErr, 1);
              ws.send(JSON.stringify({ type: 'error', text: accErr, errorKind }));
            }
          }
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
      if (currentProc) killProc(currentProc);
      if (loginProc) killProc(loginProc);
    });

    ws.on('message', (data: Buffer) => {
      let msg: {
        type: string;
        text?: string;
        images?: Array<{ data: string; mediaType: string; name?: string }>;
        mode?: 'plan' | 'edit';
        _silent?: boolean;
        _askResume?: boolean;
        path?: string;
      };
      try { msg = JSON.parse(data.toString()); } catch {
        sendLog('warn', `Malformed WS message: ${data.toString().slice(0, 200)}`);
        return;
      }

      if (msg.type === 'send' && msg.text?.trim() === '/clear') {
        sessionId = undefined;
        if (currentProc) {
          const proc = currentProc;
          currentProc = undefined;
          currentProcKey = undefined;
          killProc(proc);
        }
        pendingBgTasks.clear();
        totalBgTasks = 0;
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
          '--allowedTools', tools.filter(t => t !== 'AskUserQuestion').join(','),
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

        buffer = '';
        stderrOutput = '';
        textAccum = '';
        resetStaleTimer();
        watchdogActive = false;
        receivedDeltas = false;
        suppressCliOutput = false;
        userStopped = false;
        cliDone = false;
        toolMap.clear();
        answeredTools.clear();
        pendingAskTools.clear();
        pendingFollowUp = undefined;

        const canReuse = currentProc?.stdin?.writable === true && currentProcKey === procKey;
        let proc: ReturnType<typeof spawn>;
        if (canReuse) {
          proc = currentProc!;
          sendLog('info', 'Reusing claude process');
        } else {
          if (currentProc) {
            sendLog('info', 'Args changed, respawning claude');
            killProc(currentProc);
          }
          const claudeBin = resolveClaudeBin();
          const spawnCmd = IS_WIN && /\s/.test(claudeBin) ? `"${claudeBin}"` : claudeBin;
          sendLog('info', `Spawning claude: ${args.join(' ')}`);
          proc = spawn(spawnCmd, args, {
            cwd: workspaceDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: IS_WIN,
          });
          currentProc = proc;
          currentProcKey = procKey;
          attachProcHandlers(proc);
        }

        pendingBgTasks.clear();
        totalBgTasks = 0;
        if (!msg._askResume) {
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
          sendLog('debug', `Attaching ${plural(images.length, 'attachment')}`);
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
          const allowed: Record<string, boolean> = {};
          for (const k of Object.keys(DEFAULT_CONFIG)) allowed[k] = true;
          const filtered: Partial<ArgusConfig> = {};
          for (const [k, v] of Object.entries(patch)) {
            if (allowed[k]) (filtered as any)[k] = v;
          }
          const config = { ...readConfig(), ...filtered };
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
          ws.send(JSON.stringify({ type: 'retry_clean' }));
          ws.emit('message', Buffer.from(JSON.stringify({
            type: 'send',
            text: lastMessage.text,
            images: lastMessage.images,
            mode: lastMessage.mode,
            _silent: true,
          })));
        }
      } else if (msg.type === 'forceError') {
        if (currentProc) killProc(currentProc);
        ws.send(JSON.stringify({ type: 'error', text: 'Forced error (kill button)' }));
      } else if (msg.type === 'getSkills') {
        ws.send(JSON.stringify({ type: 'skills', skills: getSkills(workspaceDir) }));
      } else if (msg.type === 'login') {
        if (loginProc) killProc(loginProc);
        sendLog('info', 'Starting claude login');
        const loginBin = resolveClaudeBin();
        const loginCmd = IS_WIN && /\s/.test(loginBin) ? `"${loginBin}"` : loginBin;
        const lp = spawn(loginCmd, ['auth', 'login'], { cwd: workspaceDir, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN });
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

        ws.send(JSON.stringify({
          type: 'tool_end',
          call: { id: answerId, name: tc?.name ?? 'AskUserQuestion', input: tc?.input ?? {}, result: content },
        }));
        sendLog('info', `Tool answer for ${answerId}: ${content.slice(0, 100)}`);

        if (pendingAskTools.size === 0 && sessionId && answers && Object.keys(answers).length > 0) {
          pendingFollowUp = { answers, toolId: answerId, mode: msg.mode };
          if (cliDone) flushAskFollowUp();
        } else {
          if (pendingAskTools.size === 0) suppressCliOutput = false;
          if (currentProc?.stdin?.writable) currentProc.stdin.end();
          if (pendingAskTools.size === 0 && cliDone) {
            setTimeout(() => ws.send(JSON.stringify({ type: 'done' })), 100);
          }
        }
      } else if (msg.type === 'readFilePreview' && msg.path) {
        const filePath = path.isAbsolute(msg.path) ? msg.path : path.resolve(workspaceDir, msg.path);
        const resolved = path.resolve(filePath);
        if (!path.isAbsolute(msg.path) && !resolved.startsWith(workspaceDir + path.sep) && resolved !== workspaceDir) {
          ws.send(JSON.stringify({ type: 'filePreview', path: msg.path, content: 'Error: path outside workspace' }));
          return;
        }
        try {
          const ext = path.extname(filePath).toLowerCase();
          const imageExts: Record<string, string> = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
            '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff',
          };
          const mime = imageExts[ext];
          if (mime) {
            const base64 = fs.readFileSync(filePath).toString('base64');
            ws.send(JSON.stringify({ type: 'filePreview', path: filePath, content: `data:${mime};base64,${base64}` }));
          } else {
            const content = fs.readFileSync(filePath, 'utf-8');
            ws.send(JSON.stringify({ type: 'filePreview', path: filePath, content }));
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'filePreview', path: filePath, content: `Error reading file: ${(err as Error).message}` }));
        }
      } else if (msg.type === 'stop') {
        watchdogActive = false;
        if (watchdogRetryTimer) {
          clearTimeout(watchdogRetryTimer);
          watchdogRetryTimer = null;
        }
        watchdogRetrying = false;
        for (const toolId of pendingAskTools) {
          const tc = toolMap.get(toolId);
          ws.send(JSON.stringify({
            type: 'tool_end',
            call: { id: toolId, name: tc?.name ?? 'AskUserQuestion', input: tc?.input ?? {}, result: JSON.stringify({ cancelled: true }) },
          }));
        }
        pendingAskTools.clear();
        if (currentProc) {
          userStopped = true;
          killProc(currentProc);
        } else {
          ws.send(JSON.stringify({ type: 'done' }));
        }
      } else if (msg.type === 'newSession') {
        sessionId = undefined;
        pendingBgTasks.clear();
        totalBgTasks = 0;
      }
    });
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
    wss.handleUpgrade(req, socket, head as Buffer, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  return new Promise<ArgusServer>((resolve) => {
    httpServer.listen(PORT, () => {
      const addr = httpServer.address() as { port: number };
      const actualPort = addr.port;
      console.log(`[argus-server] WebSocket agent ready at ws://localhost:${actualPort}/agent`);
      resolve({ httpServer, port: actualPort, close: () => { clearInterval(pingTimer); wss.close(); httpServer.close(); } });
    });
  });
}
