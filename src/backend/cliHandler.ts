import * as fs from 'fs';
import type { spawn } from 'child_process';
import { plural, classifyError, API_ERROR_RE, killProc } from './cli';
import { parseRateLimitEvent } from './accountUsage';
import { contextWindowFor } from './modelData';
import { stringifyToolResult } from './toolResult';
import { noticeFromSystemEvent, noticeLabel } from './taskNotification';
import type { SessionState } from './sessionState';

// The pending set is the only live inventory of background tasks anywhere in Argus, and
// until now it was read once per turn, on `done`. A watch session runs for hours between
// user sends, so the count needs to reach the UI when it changes rather than when a turn
// happens to end. Broadcast only on a real change: `task_started` is emitted once per task
// and the two deletes are idempotent, so a no-op mutation must not put a frame on the wire.
export function broadcastBgTasks(s: SessionState): void {
  s.broadcast(JSON.stringify({ type: 'bgTasks', count: s.pendingBgTasks.size }));
}

function addBgTask(s: SessionState, id: string | undefined): void {
  if (!id || s.pendingBgTasks.has(id)) return;
  s.pendingBgTasks.set(id, Date.now());
  broadcastBgTasks(s);
}

// When the oldest task still running was launched, so a turn can report the age of the work
// it left behind. The oldest rather than the newest: it is the one the reader is waiting on,
// and it is the only choice that never goes backwards while tasks come and go.
export function oldestBgTaskStart(s: SessionState): number | undefined {
  let oldest: number | undefined;
  for (const startedAt of s.pendingBgTasks.values()) {
    if (oldest === undefined || startedAt < oldest) oldest = startedAt;
  }
  return oldest;
}

// A Bash call is not a background task, and `task_started` does not distinguish them: the CLI
// emits `task_started` + `task_notification` for **every** Bash tool call. Measured with a run
// that did nothing but a plain `echo scub-hello` with no `run_in_background`, which produced
// both events (scripts/probe-foreground-bash.js in !notes/tasks/bg-turn-cause-marker/). Adding
// on that event therefore blinked the `✻ N` pill on and off for every command the agent ran,
// which is how it was reported ("появляется и исчезает").
//
// Two discriminators, and both are needed:
//   - `run_in_background` on the tool input - what the model asked for;
//   - `Command running in background with ID: <task-id>` in the tool result - what the CLI
//     actually did. This is the only one that catches a command the CLI backgrounds on its
//     own: in a real session a Bash with no `run_in_background` came back with exactly this
//     string, and its notification arrived five minutes later and woke an autonomous turn.
// The id in that string is the same `task_id` the system events carry (verified on both a
// probe and a reported transcript), so either path feeds the same set.
// Anchored at the start, like the webview's own pulse test (`result.startsWith(...)`), so the
// two agree and a tool that merely *prints* this sentence - a `cat` of these notes would -
// cannot inject a phantom id that nothing would ever remove.
const BG_LAUNCH_RE = /^Command running in background with ID:\s*([A-Za-z0-9_-]+)/;

function isBackgroundTool(s: SessionState, toolUseId: unknown): boolean {
  if (typeof toolUseId !== 'string') return false;
  const input = s.toolMap.get(toolUseId)?.input as Record<string, unknown> | undefined;
  return input?.run_in_background === true;
}

function noteBackgroundLaunch(s: SessionState, result: unknown): void {
  if (typeof result !== 'string') return;
  const id = BG_LAUNCH_RE.exec(result.trimStart())?.[1];
  if (id) addBgTask(s, id);
}

function removeBgTask(s: SessionState, id: string | undefined): void {
  if (!id || !s.pendingBgTasks.delete(id)) return;
  broadcastBgTasks(s);
}

export function handleCliEvent(s: SessionState, event: Record<string, unknown>): void {
  s.sendLog('debug', `event: ${event.type} ${JSON.stringify(event).slice(0, 120)}`);

  // A stop interrupts the CLI instead of killing it, so the turn the user ended keeps
  // emitting for a few more milliseconds and signs off with an is_error `result`. None of
  // that may be acted on: the process is no longer detached (that is the point - it gets
  // reused), so without this guard the trailing chunks would append to a message the UI has
  // already committed, the recovery branch below would read them as a background-task turn
  // and raise a phantom `thinking_start`, and the result would surface a "stopped" error
  // block. The result is also the signal that the interrupt landed, which retires the
  // fallback kill.
  if (s.stopping) {
    if (event.type === 'result') {
      s.stopping = false;
      if (s.stopKillTimer) { clearTimeout(s.stopKillTimer); s.stopKillTimer = null; }
      s.sendLog('info', 'Stop: interrupted turn ended, CLI kept alive for reuse');
    }
    return;
  }

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
    s.autonomousTurn = true;
    s.broadcast(JSON.stringify({ type: 'thinking_start', reused: true }));
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
    else if (inner?.type === 'message_start') handleMessageStart(s, inner);
    else if (inner?.type === 'message_delta') handleMessageDelta(s, inner);
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
    const id = event.session_id as string;
    const changed = id && id !== s.sessionId;
    s.sessionId = id;
    // Announce the id the CLI just assigned so the browser shims can put it in the
    // address bar. Until this, a brand-new chat had no id anywhere in the URL and the
    // page could not be shared or reloaded back into the same conversation.
    if (changed) s.broadcast(JSON.stringify({ type: 'sessionId', id }));
  } else if (event.subtype === 'task_started') {
    // Foreground calls raise this event too; the result-text path adds the ones the CLI
    // backgrounds by itself, whose input says nothing.
    if (isBackgroundTool(s, event.tool_use_id)) addBgTask(s, event.task_id as string);
  } else if (event.subtype === 'task_updated') {
    removeBgTask(s, event.task_id as string);
  } else if (event.subtype === 'task_notification') {
    removeBgTask(s, event.task_id as string);
    // The turn the CLI is about to run for this task has no other visible cause: it wakes
    // itself, answers, and closes with a completion line identical to one the user asked
    // for ("there was no request from me, how can these turns be real"). This event is the
    // only live announcement of it - the prompt the CLI writes to itself is a transcript
    // record and never reaches the stream, measured in
    // !notes/tasks/bg-turn-cause-marker/scripts/probe-notification-event.js.
    //
    // Only when the CLI is idle, because that is exactly when this notification is about to
    // wake a turn nobody asked for. A task that finishes *during* a turn is folded into the
    // running one, which already has a cause on screen. The gate is `cliDone` rather than
    // "was this a background task" on purpose: every Bash call emits this event, so without
    // it the marker announced `echo one` / `echo two` / `echo three` (seen in
    // scripts/probe-pill-flicker.log), and gating on the background test instead would drop
    // the marker for any task the two discriminators failed to classify - the one case where
    // the turn really does appear out of nowhere.
    const notice = s.cliDone ? noticeFromSystemEvent(event) : null;
    if (notice) {
      s.broadcast(JSON.stringify({ type: 'bg_notice', notice }));
      s.sendLog('info', `Background task reported: ${noticeLabel(notice)}`);
    }
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
      s.broadcast(JSON.stringify({ type: 'tool_end', call: { id: toolUseId, name: 'Bash', input: {}, result } }));
    }
  } else if (event.subtype === 'api_retry') {
    s.broadcast(JSON.stringify({ type: 'retry_status', attempt: event.attempt, maxRetries: event.max_retries, delayMs: event.retry_delay_ms }));
  }
}

function handleDelta(s: SessionState, event: Record<string, unknown>): void {
  if (s.suppressCliOutput) return;
  const delta = event.delta as Record<string, unknown> | undefined;
  if (delta?.type === 'text_delta' && delta.text) {
    s.receivedDeltas = true;
    s.textAccum += delta.text as string;
    s.liveOutputChars += (delta.text as string).length;
    s.startStaleTimer();
    s.broadcast(JSON.stringify({ type: 'text_chunk', text: delta.text }));
    s.broadcast(JSON.stringify({ type: 'token_update', outputTokens: s.completedOutputTokens + Math.ceil(s.liveOutputChars / 4) }));
  } else if (delta?.type === 'thinking_delta' && delta.thinking) {
    s.receivedThinkingDeltas = true;
    s.liveOutputChars += (delta.thinking as string).length;
    s.broadcast(JSON.stringify({ type: 'thinking_chunk', text: delta.thinking }));
    s.broadcast(JSON.stringify({ type: 'token_update', outputTokens: s.completedOutputTokens + Math.ceil(s.liveOutputChars / 4) }));
  }
}

function handleMessageStart(s: SessionState, inner: Record<string, unknown>): void {
  const usage = (inner.message as Record<string, unknown> | undefined)?.usage as Record<string, number> | undefined;
  if (!usage) return;
  const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  if (inputTokens > 0) {
    s.liveInputTokens = inputTokens;
    s.broadcast(JSON.stringify({ type: 'token_update', inputTokens }));
  }
  // Reset per-message char counter; completedOutputTokens carries the previous messages' totals.
  s.liveOutputChars = 0;
}

function handleMessageDelta(s: SessionState, inner: Record<string, unknown>): void {
  const usage = inner.usage as Record<string, number> | undefined;
  const real = usage?.output_tokens;
  if (real != null) {
    s.completedOutputTokens += real;
    s.liveOutputChars = 0;
    s.broadcast(JSON.stringify({ type: 'token_update', outputTokens: s.completedOutputTokens }));
  }
}

function handleAssistant(s: SessionState, event: Record<string, unknown>): void {
  s.watchdog.state.autoRetryCount = 0;
  if (s.suppressCliOutput) { s.receivedDeltas = false; return; }
  const content = (event.message as { content: Array<Record<string, unknown>> })?.content ?? [];
  for (const block of content) {
    if (block.type === 'thinking' && block.thinking && !s.receivedThinkingDeltas) {
      s.broadcast(JSON.stringify({ type: 'thinking_chunk', text: block.thinking }));
    } else if (block.type === 'text' && block.text && !s.receivedDeltas) {
      s.broadcast(JSON.stringify({ type: 'text_chunk', text: block.text }));
    } else if (block.type === 'tool_use' && !s.toolMap.has(block.id as string) && !s.answeredTools.has(block.id as string)) {
      s.sendLog('info', `tool_start: ${block.name} (${block.id})`);
      s.toolMap.set(block.id as string, { name: block.name as string, input: block.input });
      s.broadcast(JSON.stringify({ type: 'tool_start', call: { id: block.id, name: block.name, input: block.input } }));
      if (block.name === 'AskUserQuestion') {
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
      // Window is per-model (200k on the 4.x line, 1M from opus-4-6 / sonnet-5 on),
      // resolved from the model this very message was produced by. Output tokens are
      // deliberately left out of the numerator: they are already counted in the next
      // request's input, and the CLI's own percentage uses input alone.
      const contextWindow = contextWindowFor((event.message as { model?: string })?.model ?? '');
      const percent = Math.min(100, Math.round(s.turnInputTokens / contextWindow * 100));
      s.broadcast(JSON.stringify({ type: 'contextUsage', percent, inputTokens: s.turnInputTokens, outputTokens: s.turnOutputTokens, contextWindow }));
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
  // Same flattening as the `user` path above: `content` can be a block array here too,
  // and the webview's ToolCall treats `result` as a string (it calls .trim() on it).
  const result = stringifyToolResult(event.content);
  noteBackgroundLaunch(s, result);
  s.broadcast(JSON.stringify({ type: 'tool_end', call: { id: toolId, name: tc?.name ?? '', input: tc?.input ?? {}, result } }));
}

function handleUserEvent(s: SessionState, event: Record<string, unknown>): void {
  if (s.suppressCliOutput) return;
  const userMsg = event as { message?: { content?: Array<Record<string, unknown>> }; content?: Array<Record<string, unknown>> };
  const raw = userMsg.message?.content ?? userMsg.content ?? [];
  const blocks = Array.isArray(raw) ? raw : [];
  // The CLI writes user-role messages of its own and streams them back like any other:
  // the note that follows every image Read ("[Image: original 2200x3200, displayed at
  // 1375x2000. Multiply coordinates by 1.60...]"), the body a slash command expands into,
  // the compact-continuation summary. Rendered as user_inject they became bubbles the user
  // never typed - a dozen of them down one document-reading session. The stream tags them
  // `isSynthetic` (the CLI computes it as `isMeta || isVisibleInTranscriptOnly` when it
  // serialises the event; measured against a real CLI in
  // !notes/tasks/phantom-image-inject/scripts/probe-cli-image.js), which is the only
  // sound test - the text itself is whatever the tool or the skill happened to say.
  // Gated per block rather than per event, because a synthetic message can still carry a
  // real one: a `/skill` invocation that had an image pasted with it arrives as the
  // expanded skill text plus the user's own image.
  // A background task's completion arrives as a user-role prompt too, and that one carries
  // neither isMeta nor isVisibleInTranscriptOnly, so `isSynthetic` is false for it. Its own
  // mark is origin.kind, the field handleResult already trusts below. Nothing rendered it
  // live only by accident: the event lands while cliDone is still true, so the recovery
  // branch has not raised thinking_start yet and the reducer drops a user_inject with no
  // streaming state. Anything that raises the spinner earlier would surface the raw
  // `<task-notification><task-id>...` XML as a bubble the user never typed.
  const origin = event.origin as { kind?: string } | undefined;
  const synthetic = event.isSynthetic === true || origin?.kind === 'task-notification';
  s.sendLog('debug', `user message: ${plural(blocks.length, 'block')}${synthetic ? ' (synthetic)' : ''}`);
  // No marker is emitted here even though origin.kind marks the prompt: the stream does not
  // carry that record at all (probe-notification-event.js saw three user events in a full
  // background-task cycle, all tool_results), so the live marker rides the
  // `system`/`task_notification` event in handleSystemEvent instead. The origin test stays
  // in `synthetic` above because it costs nothing and keeps the prompt out of the bubbles
  // if a future CLI does start streaming it.
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const toolId = block.tool_use_id as string;
      if (suppressToolResult(s, toolId)) continue;
      const tc = s.toolMap.get(toolId);
      // Images are replaced by a marker: the bytes are fetched per click straight from
      // the transcript (readToolImage), so a remote client never pays for an image it
      // does not open, and one deleted since the tool ran still previews.
      const content = stringifyToolResult(block.content);
      noteBackgroundLaunch(s, content);
      s.sendLog('debug', `tool_result ${toolId}: ${String(content).slice(0, 100)}`);
      s.broadcast(JSON.stringify({ type: 'tool_end', call: { id: toolId, name: tc?.name ?? '', input: tc?.input ?? {}, result: content } }));
    } else if (block.type === 'text' && block.text && !synthetic) {
      s.broadcast(JSON.stringify({ type: 'user_inject', text: block.text }));
    }
  }
}

function handleResult(s: SessionState, event: Record<string, unknown>): void {
  // The CLI runs mini-turns of its own for background-task notifications, and each one
  // emits a `result` like any other turn. One of them lands before the user's message is
  // even dequeued: on `--resume` startup the CLI replays a notification for every task
  // orphaned by the previous CLI process, so a fresh spawn answers the *notification*
  // first (`num_turns: 0`, empty result) while the user's send waits in its queue. Taken
  // as the end of the user's turn it committed an empty ~1s assistant message and pushed
  // the real answer into the autonomous-turn recovery path above, which is the reported
  // "finished in 1s, then starts working 5-15s later".
  // A notification turn Argus itself surfaced (a background task that finished while the
  // session was idle) must still end normally - measured, that one carries the very same
  // origin.kind, so who started the turn is the only sound discriminator.
  const origin = event.origin as { kind?: string } | undefined;
  if (origin?.kind === 'task-notification' && !s.autonomousTurn) {
    s.sendLog('info', 'Ignoring task-notification result: the user turn it interrupted is still queued');
    return;
  }
  s.cliDone = true;
  s.resetStaleTimer();
  s.watchdog.state.active = false;
  if (event.is_error === true || event.subtype === 'error') {
    const errText = typeof event.error === 'string' ? event.error
      : (event.error as Record<string, unknown>)?.message as string
      ?? event.result as string ?? 'Unknown error';
    const { errorKind } = classifyError(errText, 1);
    s.broadcast(JSON.stringify({ type: 'error', text: errText, errorKind }));
  }
  if (s.pendingFollowUp) {
    s.flushAskFollowUp();
  } else if (s.pendingAskTools.size === 0) {
    // `autonomous` marks a turn the user did not start: the CLI woke itself to report a
    // background task. It ends like any other turn, but it must not ring the completion
    // sound or raise an OS toast - a CI watch produced 156 of these in one session, one
    // every four minutes, each announcing "finished" for work the user was already waiting
    // on. See !notes/tasks/bg-turn-completion-noise/notes.md.
    s.broadcast(JSON.stringify({
      type: 'done',
      ...(s.pendingBgTasks.size > 0 ? { pendingBackgroundTasks: s.pendingBgTasks.size, backgroundTasksSince: oldestBgTaskStart(s) } : {}),
      ...(s.autonomousTurn ? { autonomous: true } : {}),
    }));
  }
}

export function attachProcHandlers(s: SessionState, proc: ReturnType<typeof spawn>): void {
  // A detached proc (stop, /clear, respawn on changed args) is dead to this session:
  // what it still has buffered belongs to a turn the user already ended and must not
  // land in the state of the turn that replaced it. The spawn path assigns
  // s.currentProc before attaching these handlers, so this never drops legitimate
  // output, and a reused proc is unaffected (s.currentProc === proc).
  const detached = () => s.currentProc !== proc;

  proc.stdout!.on('data', (chunk: Buffer) => {
    if (detached()) return;
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
          s.broadcast(JSON.stringify({ type: 'error', text: trimmed, errorKind }));
          s.broadcast(JSON.stringify({ type: 'done' }));
        }
        continue;
      }
      handleCliEvent(s, event);
    }
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    console.error('[argus-server]', text.trim());
    s.sendLog('warn', `stderr: ${text.trim()}`);
    // Logged either way (it is diagnostics), but a dead proc's stderr must not end up
    // in s.stderrOutput, which classifyError reads to explain the *current* turn.
    if (detached()) return;
    s.stderrOutput += text;
  });

  proc.stdin!.on('error', (err) => {
    s.sendLog('warn', `stdin error (CLI likely crashed): ${err.message}`);
  });

  proc.on('close', (code) => {
    s.sendLog('info', `claude exited with code ${code}${s.watchdog.state.retrying ? ' (watchdog retry pending)' : ''}`);
    // Detached: the turn it belonged to is over and something else may already be
    // running. Touching shared state here is how a stopped proc used to disarm the
    // next turn's watchdog and end it with a stray `done`.
    if (detached()) return;
    s.resetStaleTimer();
    s.currentProc = undefined;
    s.currentProcKey = undefined;
    if (s.watchdog.state.retrying) return;
    s.watchdog.state.active = false;
    if (code !== 0 && code !== null) {
      const { message, errorKind } = classifyError(s.stderrOutput, code);
      if (s.pendingAskTools.size > 0) {
        s.sendLog('warn', `CLI exited (${errorKind}) with ${plural(s.pendingAskTools.size, 'pending question')}: ${message}`);
      } else {
        s.broadcast(JSON.stringify({ type: 'error', text: message, errorKind }));
        s.broadcast(JSON.stringify({ type: 'done' }));
      }
    } else if (s.pendingAskTools.size === 0 && !s.cliDone) {
      if (code === null) {
        const accErr = s.textAccum.trim() || s.stderrOutput.trim();
        if (accErr && API_ERROR_RE.test(accErr)) {
          const { errorKind } = classifyError(accErr, 1);
          s.broadcast(JSON.stringify({ type: 'error', text: accErr, errorKind }));
        }
      }
      s.broadcast(JSON.stringify({ type: 'done' }));
    }
  });

  proc.on('error', (err) => {
    s.currentProc = undefined;
    s.currentProcKey = undefined;
    s.sendLog('error', `spawn error: ${err.message}`);
    const errText = err.message.includes('ENOENT')
      ? 'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code'
      : err.message;
    s.broadcast(JSON.stringify({ type: 'error', text: errText }));
    s.broadcast(JSON.stringify({ type: 'done' }));
  });
}
