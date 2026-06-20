import * as fs from 'fs';
import type { spawn } from 'child_process';
import { plural, classifyError, API_ERROR_RE, killProc } from './cli';
import { parseRateLimitEvent } from './accountUsage';
import type { SessionState } from './sessionState';

const MAX_CONTEXT = 200_000;

export function handleCliEvent(s: SessionState, event: Record<string, unknown>): void {
  s.sendLog('debug', `event: ${event.type} ${JSON.stringify(event).slice(0, 120)}`);
  if (event.type !== 'ping' && event.type !== 'rate_limit_event') {
    s.watchdog.state.lastEventTime = Date.now();
  }

  if (s.cliDone && s.pendingAskTools.size === 0 && (event.type === 'content_block_delta' || event.type === 'assistant' || event.type === 'message_start')) {
    s.cliDone = false;
    s.textAccum = '';
    s.receivedDeltas = false;
    s.suppressCliOutput = false;
    s.toolMap.clear();
    s.answeredTools.clear();
    s.pendingAskTools.clear();
    s.pendingFollowUp = undefined;
    s.resetStaleTimer();
    s.watchdog.state.active = true;
    s.ws.send(JSON.stringify({ type: 'thinking_start', reused: true }));
    s.sendLog('info', 'Background task notification: starting autonomous turn');
  }

  if (event.type === 'rate_limit_event') {
    const info = parseRateLimitEvent(event);
    if (info) s.rateLimits.set(info.rateLimitType, info);
  } else if (event.type === 'system') {
    handleSystemEvent(s, event);
  } else if (event.type === 'stream_event') {
    const inner = event.event as Record<string, unknown> | undefined;
    if (inner?.type === 'content_block_delta') handleDelta(s, inner);
  } else if (event.type === 'content_block_delta') {
    handleDelta(s, event);
  } else if (event.type === 'assistant') {
    handleAssistant(s, event);
  } else if (event.type === 'tool_result') {
    handleToolResult(s, event);
  } else if (event.type === 'user') {
    handleUserEvent(s, event);
  } else if (event.type === 'result') {
    handleResult(s, event);
  }
}

function handleSystemEvent(s: SessionState, event: Record<string, unknown>): void {
  if (event.subtype === 'init') {
    s.sessionId = event.session_id as string;
  } else if (event.subtype === 'task_started') {
    s.pendingBgTasks.add(event.task_id as string);
    s.totalBgTasks++;
  } else if (event.subtype === 'task_updated') {
    s.pendingBgTasks.delete(event.task_id as string);
  } else if (event.subtype === 'task_notification') {
    s.pendingBgTasks.delete(event.task_id as string);
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
      s.ws.send(JSON.stringify({ type: 'tool_end', call: { id: toolUseId, name: 'Bash', input: {}, result } }));
    }
  } else if (event.subtype === 'api_retry') {
    s.ws.send(JSON.stringify({ type: 'retry_status', attempt: event.attempt, maxRetries: event.max_retries, delayMs: event.retry_delay_ms }));
  }
}

function handleDelta(s: SessionState, event: Record<string, unknown>): void {
  if (s.suppressCliOutput) return;
  const delta = event.delta as Record<string, unknown> | undefined;
  if (delta?.type === 'text_delta' && delta.text) {
    s.receivedDeltas = true;
    s.textAccum += delta.text as string;
    s.startStaleTimer();
    s.ws.send(JSON.stringify({ type: 'text_chunk', text: delta.text }));
  } else if (delta?.type === 'thinking_delta' && delta.thinking) {
    s.ws.send(JSON.stringify({ type: 'thinking_chunk', text: delta.thinking }));
  }
}

function handleAssistant(s: SessionState, event: Record<string, unknown>): void {
  s.watchdog.state.autoRetryCount = 0;
  if (s.suppressCliOutput) { s.receivedDeltas = false; return; }
  const content = (event.message as { content: Array<Record<string, unknown>> })?.content ?? [];
  for (const block of content) {
    if (block.type === 'thinking' && block.thinking) {
      s.ws.send(JSON.stringify({ type: 'thinking_chunk', text: block.thinking }));
    } else if (block.type === 'text' && block.text && !s.receivedDeltas) {
      s.ws.send(JSON.stringify({ type: 'text_chunk', text: block.text }));
    } else if (block.type === 'tool_use' && !s.toolMap.has(block.id as string) && !s.answeredTools.has(block.id as string)) {
      s.sendLog('info', `tool_start: ${block.name} (${block.id})`);
      s.toolMap.set(block.id as string, { name: block.name as string, input: block.input });
      s.ws.send(JSON.stringify({ type: 'tool_start', call: { id: block.id, name: block.name, input: block.input } }));
      if (block.name === 'AskUserQuestion') {
        // The CLI no longer pauses on a tool that's outside --allowedTools: it
        // hands the model a synthetic "Answer questions?" result and lets it
        // barrel ahead on its own defaults (all suppressed -> invisible in the
        // chat, and the user's real answers never get injected). Enforce the
        // pause ourselves: make the question a hard turn boundary by stopping
        // generation now and suppressing anything the model already streamed
        // past it. Setting cliDone=true lets handleToolAnswer flush the real
        // answers via a clean --resume once the user responds.
        s.pendingAskTools.add(block.id as string);
        s.suppressCliOutput = true;
        s.cliDone = true;
        s.watchdog.state.active = false;
        if (s.currentProc) killProc(s.currentProc);
        break;
      }
    }
  }
  s.receivedDeltas = false;
  const usage = (event.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
  if (usage) {
    const newInput = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const newOutput = usage.output_tokens ?? 0;
    if (newInput > 0 || newOutput > 0) {
      s.turnInputTokens = newInput;
      s.turnOutputTokens = newOutput;
      const total = s.turnInputTokens + s.turnOutputTokens;
      const percent = Math.min(100, Math.round(total / MAX_CONTEXT * 100));
      s.ws.send(JSON.stringify({ type: 'contextUsage', percent, inputTokens: s.turnInputTokens, outputTokens: s.turnOutputTokens }));
    }
  }
}

function suppressToolResult(s: SessionState, toolId: string): boolean {
  if (s.answeredTools.has(toolId)) {
    s.answeredTools.delete(toolId);
    if (s.toolMap.get(toolId)?.name === 'AskUserQuestion') s.suppressCliOutput = true;
    s.sendLog('info', `Suppressing CLI echo for ${toolId} (already answered)`);
    return true;
  }
  if (s.pendingAskTools.has(toolId)) {
    s.suppressCliOutput = true;
    s.sendLog('info', `Suppressing CLI auto-result for AskUserQuestion ${toolId}`);
    return true;
  }
  return false;
}

function handleToolResult(s: SessionState, event: Record<string, unknown>): void {
  if (s.suppressCliOutput) return;
  const toolId = event.tool_use_id as string;
  if (suppressToolResult(s, toolId)) return;
  const tc = s.toolMap.get(toolId);
  s.ws.send(JSON.stringify({ type: 'tool_end', call: { id: toolId, name: tc?.name ?? '', input: tc?.input ?? {}, result: event.content } }));
}

function handleUserEvent(s: SessionState, event: Record<string, unknown>): void {
  if (s.suppressCliOutput) return;
  const userMsg = event as { message?: { content?: Array<Record<string, unknown>> }; content?: Array<Record<string, unknown>> };
  const raw = userMsg.message?.content ?? userMsg.content ?? [];
  const blocks = Array.isArray(raw) ? raw : [];
  s.sendLog('debug', `user message: ${plural(blocks.length, 'block')}`);
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const toolId = block.tool_use_id as string;
      if (suppressToolResult(s, toolId)) continue;
      const tc = s.toolMap.get(toolId);
      const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      s.sendLog('debug', `tool_result ${toolId}: ${String(content).slice(0, 100)}`);
      s.ws.send(JSON.stringify({ type: 'tool_end', call: { id: toolId, name: tc?.name ?? '', input: tc?.input ?? {}, result: content } }));
    } else if (block.type === 'text' && block.text) {
      s.ws.send(JSON.stringify({ type: 'user_inject', text: block.text }));
    }
  }
}

function handleResult(s: SessionState, event: Record<string, unknown>): void {
  s.cliDone = true;
  s.resetStaleTimer();
  s.watchdog.state.active = false;
  if (event.is_error === true || event.subtype === 'error') {
    const errText = typeof event.error === 'string' ? event.error
      : (event.error as Record<string, unknown>)?.message as string
      ?? event.result as string ?? 'Unknown error';
    const { errorKind } = classifyError(errText, 1);
    s.ws.send(JSON.stringify({ type: 'error', text: errText, errorKind }));
  }
  if (s.pendingFollowUp) {
    s.flushAskFollowUp();
  } else if (s.pendingAskTools.size === 0) {
    s.ws.send(JSON.stringify({ type: 'done', ...(s.pendingBgTasks.size > 0 ? { pendingBackgroundTasks: s.pendingBgTasks.size, totalBackgroundTasks: s.totalBgTasks } : {}) }));
  }
}

export function attachProcHandlers(s: SessionState, proc: ReturnType<typeof spawn>): void {
  proc.stdout!.on('data', (chunk: Buffer) => {
    s.buffer += chunk.toString();
    const lines = s.buffer.split('\n');
    s.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(trimmed); } catch {
        s.sendLog('warn', `non-JSON stdout: ${trimmed.slice(0, 200)}`);
        const API_ERROR_RAW = /API Error:|Failed to authenticate|Request not allowed|socket connection was closed/i;
        if (API_ERROR_RAW.test(trimmed) && !s.cliDone) {
          s.cliDone = true;
          const { errorKind } = classifyError(trimmed, 1);
          s.ws.send(JSON.stringify({ type: 'error', text: trimmed, errorKind }));
          s.ws.send(JSON.stringify({ type: 'done' }));
        }
        continue;
      }
      handleCliEvent(s, event);
    }
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    s.stderrOutput += text;
    console.error('[argus-server]', text.trim());
    s.sendLog('warn', `stderr: ${text.trim()}`);
  });

  proc.stdin!.on('error', (err) => {
    s.sendLog('warn', `stdin error (CLI likely crashed): ${err.message}`);
  });

  proc.on('close', (code) => {
    s.resetStaleTimer();
    const isActiveProc = s.currentProc === proc;
    if (isActiveProc) {
      s.currentProc = undefined;
      s.currentProcKey = undefined;
    }
    s.sendLog('info', `claude exited with code ${code}${s.watchdog.state.retrying ? ' (watchdog retry pending)' : ''}`);
    if (s.watchdog.state.retrying) return;
    s.watchdog.state.active = false;
    if (s.userStopped) {
      s.userStopped = false;
      if (isActiveProc) s.ws.send(JSON.stringify({ type: 'done' }));
    } else if (code !== 0 && code !== null) {
      const { message, errorKind } = classifyError(s.stderrOutput, code);
      if (s.pendingAskTools.size > 0) {
        s.sendLog('warn', `CLI exited (${errorKind}) with ${plural(s.pendingAskTools.size, 'pending question')}: ${message}`);
      } else if (isActiveProc) {
        s.ws.send(JSON.stringify({ type: 'error', text: message, errorKind }));
        s.ws.send(JSON.stringify({ type: 'done' }));
      }
    } else if (isActiveProc && s.pendingAskTools.size === 0 && !s.cliDone) {
      if (code === null) {
        const accErr = s.textAccum.trim() || s.stderrOutput.trim();
        if (accErr && API_ERROR_RE.test(accErr)) {
          const { errorKind } = classifyError(accErr, 1);
          s.ws.send(JSON.stringify({ type: 'error', text: accErr, errorKind }));
        }
      }
      s.ws.send(JSON.stringify({ type: 'done' }));
    }
  });

  proc.on('error', (err) => {
    s.currentProc = undefined;
    s.currentProcKey = undefined;
    s.sendLog('error', `spawn error: ${err.message}`);
    const errText = err.message.includes('ENOENT')
      ? 'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code'
      : err.message;
    s.ws.send(JSON.stringify({ type: 'error', text: errText }));
    s.ws.send(JSON.stringify({ type: 'done' }));
  });
}
