import { spawn } from 'child_process';
import { IS_WIN, resolveClaudeBin, killProc, interruptProc, plural } from '../cli';
import { readConfig } from '../config';
import { noteUsageActivity } from '../usagePoller';
import { attachProcHandlers, broadcastBgTasks } from '../cliHandler';
import type { SessionState } from '../sessionState';
const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];
const PLAN_BLOCKED_TOOLS = ['Write', 'Edit', 'AskUserQuestion'];
const STOP_INTERRUPT_TIMEOUT_MS = 5_000;
let cliLaunchCount = 0;
export function getCliLaunchCount(): number { return cliLaunchCount; }
export function resetCliLaunchCount(): void { cliLaunchCount = 0; }

export function handleSend(s: SessionState, msg: { type?: string; text?: string; images?: Array<{ data: string; mediaType: string; name?: string }>; mode?: string; _silent?: boolean; _askResume?: boolean }) {
  const text = msg.text ?? '';
  const images = msg.images;
  // Any send spends tokens, including a mid-turn inject and a silent retry, so it is
  // what keeps the usage poller awake (and wakes it after a paused hour).
  noteUsageActivity();

  if (s.currentProc?.stdin?.writable && !s.cliDone && !msg._silent && !msg._askResume) {
    s.lastMessage = { text, images, mode: msg.mode };
    const contentBlocks: Array<Record<string, unknown>> = [];
    if (images && images.length > 0) {
      for (const img of images) {
        if (img.mediaType.startsWith('text/')) {
          contentBlocks.push({ type: 'text', text: `[Attached file: ${img.name ?? 'file.txt'}]\n${Buffer.from(img.data, 'base64').toString('utf-8')}` });
        } else if (img.mediaType === 'application/pdf') {
          contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
        } else {
          contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
        }
      }
    }
    if (text) contentBlocks.push({ type: 'text', text });
    const stdinMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: contentBlocks } });
    s.sendLog('info', `Mid-turn inject: ${stdinMsg.length} bytes to stdin`);
    s.currentProc.stdin.write(stdinMsg + '\n');
    // The turn stops being the CLI's own the moment the user speaks into it: they are now
    // waiting on this answer, so it must ring on completion. This branch returns before the
    // reset block below that normally clears the flag.
    s.autonomousTurn = false;
    s.broadcast(JSON.stringify({ type: 'user_inject', text }));
    return;
  }

  if (!msg._silent) {
    s.broadcast(JSON.stringify({ type: 'message', message: { id: String(Date.now()), role: 'user', content: text, images } }));
  }

  const isPlan = msg.mode === 'plan';
  const tools = isPlan ? ALLOWED_TOOLS.filter(t => !PLAN_BLOCKED_TOOLS.includes(t)) : ALLOWED_TOOLS;
  const baseArgs = [
    '--print', '--verbose',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--tools', tools.join(','),
    '--allowedTools', tools.join(','),
  ];
  // Derived from the config at spawn time (see getInfo): the latest switchModel /
  // switchEffort / switchThinking always wins, whichever channel or process it came from.
  const cfg = { ...readConfig(), ...s.selection };
  const model = cfg.model || s.serverDefaultModel;
  if (model) baseArgs.push('--model', model);
  if (!cfg.thinking) {
    baseArgs.push('--effort', 'low');
  } else if (cfg.effort) {
    baseArgs.push('--effort', cfg.effort);
  }
  if (cfg.appendSystemPrompt) baseArgs.push('--append-system-prompt', cfg.appendSystemPrompt);
  if (isPlan) {
    baseArgs.push('--permission-mode', 'plan', '--disallowedTools', PLAN_BLOCKED_TOOLS.join(','));
  } else if (msg.mode === 'full-access') {
    baseArgs.push('--permission-mode', 'bypassPermissions');
  }
  const procKey = baseArgs.join(' ');
  const args = [...baseArgs];
  if (s.sessionId && (!s.currentProc || s.currentProcKey !== procKey)) {
    args.push('--resume', s.sessionId);
  }

  if (!msg._silent) {
    s.lastMessage = { text, images, mode: msg.mode };
    s.watchdog.state.autoRetryCount = 0;
  }

  s.buffer = '';
  s.stderrOutput = '';
  s.textAccum = '';
  s.resetStaleTimer();
  s.watchdog.state.active = false;
  s.receivedDeltas = false;
  s.receivedThinkingDeltas = false;
  s.liveOutputChars = 0;
  s.completedOutputTokens = 0;
  s.liveInputTokens = 0;
  s.suppressCliOutput = false;
  s.cliDone = false;
  s.autonomousTurn = false;
  s.toolMap.clear();
  s.answeredTools.clear();
  s.pendingAskTools.clear();
  s.pendingFollowUp = undefined;

  // A stop that has not settled yet (the interrupted turn still owes its `result`) must not
  // hand its process to this turn: that pending result would be read as *this* turn's and
  // end it a few milliseconds in, which is the empty-1s-turn failure in another costume.
  // Measured, the acknowledgement takes single-digit ms, so this only trips when a send
  // lands in that window - it falls back to the old kill-and-respawn, never to a wrong turn.
  if (s.stopping) abortPendingStop(s, 'Send arrived before the stopped turn settled; respawning');

  const canReuse = s.currentProc?.stdin?.writable === true && s.currentProcKey === procKey;
  let proc: ReturnType<typeof spawn>;
  if (canReuse) {
    proc = s.currentProc!;
    s.sendLog('info', 'Reusing claude process');
  } else {
    if (s.currentProc) {
      s.sendLog('info', 'Args changed, respawning claude');
      killProc(s.currentProc);
    }
    const claudeBin = resolveClaudeBin();
    const spawnCmd = IS_WIN && /\s/.test(claudeBin) ? `"${claudeBin}"` : claudeBin;
    s.sendLog('info', `Spawning claude: ${args.join(' ')}`);
    // spawn() throws synchronously when the OS refuses a new process (e.g. resource
    // exhaustion -> "spawn UNKNOWN"). That must stay a per-turn error: uncaught it
    // kills the server process and every other client's connection with it.
    try {
      proc = spawn(spawnCmd, args, { cwd: s.workspaceDir, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      s.currentProc = undefined;
      s.currentProcKey = undefined;
      s.cliDone = true;
      s.sendLog('error', `spawn failed: ${message}`);
      s.broadcast(JSON.stringify({ type: 'error', text: `Failed to start Claude CLI: ${message}` }));
      s.broadcast(JSON.stringify({ type: 'done' }));
      return;
    }
    cliLaunchCount++;
    s.currentProc = proc;
    s.currentProcKey = procKey;
    attachProcHandlers(s, proc);
  }

  // Reaped when a *new* process is spawned, not on every send. An orphan is created by a
  // process dying (hard kill, kill-all, daemon respawn - see
  // !notes/tasks/empty-1s-turn/notes.md), and the replacement cannot deliver the
  // notifications its predecessor's tasks owed, so that set is worthless to it; a reused
  // process still owns its tasks and will report them. Clearing on every send instead
  // dropped tasks that were genuinely still running - tolerable while the count was a
  // footnote on one message, wrong now that it is a live indicator, because typing
  // anything mid-watch zeroed it and nothing could restore it (`task_started` is emitted
  // once per task and never re-emitted, measured in
  // !notes/tasks/bg-task-indicators/scripts/probe-task-started.js).
  if (!canReuse && s.pendingBgTasks.size > 0) {
    s.pendingBgTasks.clear();
    broadcastBgTasks(s);
  }
  if (!msg._askResume) {
    s.broadcast(JSON.stringify({ type: 'thinking_start', reused: canReuse }));
  }
  s.watchdog.state.lastEventTime = Date.now();
  s.watchdog.state.active = true;

  const contentBlocks: Array<Record<string, unknown>> = [];
  if (images && images.length > 0) {
    for (const img of images) {
      if (img.mediaType.startsWith('text/')) {
        contentBlocks.push({ type: 'text', text: `[Attached file: ${img.name ?? 'file.txt'}]\n${Buffer.from(img.data, 'base64').toString('utf-8')}` });
      } else if (img.mediaType === 'application/pdf') {
        contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      } else {
        contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      }
    }
    s.sendLog('debug', `Attaching ${plural(images.length, 'attachment')}`);
  }
  if (text) contentBlocks.push({ type: 'text', text });
  const stdinMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: contentBlocks } });
  s.sendLog('debug', `stdin: ${stdinMsg.length} bytes`);
  proc.stdin!.write(stdinMsg + '\n');
}

export function handleToolAnswer(s: SessionState, msg: { type: string; id?: string; answers?: unknown; mode?: string }) {
  const answerId = msg.id ?? '';
  const answers = msg.answers as Record<string, string> | undefined;
  const content = JSON.stringify({ answers });
  const tc = s.toolMap.get(answerId);

  s.pendingAskTools.delete(answerId);
  s.answeredTools.add(answerId);

  s.broadcast(JSON.stringify({ type: 'tool_end', call: { id: answerId, name: tc?.name ?? 'AskUserQuestion', input: tc?.input ?? {}, result: content } }));
  s.sendLog('info', `Tool answer for ${answerId}: ${content.slice(0, 100)}`);

  if (s.pendingAskTools.size === 0 && s.sessionId && answers && Object.keys(answers).length > 0) {
    s.pendingFollowUp = { answers, toolId: answerId, mode: msg.mode };
    if (s.cliDone) s.flushAskFollowUp();
  } else {
    if (s.pendingAskTools.size === 0) s.suppressCliOutput = false;
    if (s.currentProc?.stdin?.writable) s.currentProc.stdin.end();
    if (s.pendingAskTools.size === 0 && s.cliDone) {
      setTimeout(() => s.broadcast(JSON.stringify({ type: 'done' })), 100);
    }
  }
}

// Gives up on an in-flight interrupt and falls back to the old kill-and-detach. Used
// wherever a stopped turn's process must not survive into whatever comes next: a send that
// beat the interrupt's acknowledgement, and the /clear reset. (newSession is deliberately
// not one of them - it moves this client to a fresh entry and leaves the old one, process
// and pending stop included, to whichever clients are still in it.)
export function abortPendingStop(s: SessionState, reason: string) {
  if (!s.stopping) return;
  s.stopping = false;
  if (s.stopKillTimer) { clearTimeout(s.stopKillTimer); s.stopKillTimer = null; }
  if (!s.currentProc) return;
  const stale = s.currentProc;
  s.currentProc = undefined;
  s.currentProcKey = undefined;
  s.sendLog('info', reason);
  killProc(stale);
}

export function handleStop(s: SessionState) {
  s.watchdog.state.active = false;
  if (s.watchdog.state.retryTimer) {
    clearTimeout(s.watchdog.state.retryTimer);
    s.watchdog.state.retryTimer = null;
  }
  s.watchdog.state.retrying = false;
  for (const toolId of s.pendingAskTools) {
    const tc = s.toolMap.get(toolId);
    s.broadcast(JSON.stringify({ type: 'tool_end', call: { id: toolId, name: tc?.name ?? 'AskUserQuestion', input: tc?.input ?? {}, result: JSON.stringify({ cancelled: true }) } }));
  }
  s.pendingAskTools.clear();
  // Interrupt a live turn rather than killing the process. A killed CLI leaves its
  // transcript ending on a user message nobody answered, and the CLI repairs that on the
  // next `--resume` by splicing a synthetic "No response requested." assistant turn into
  // the conversation - which it then sends to the model on every later turn (measured, see
  // !notes/tasks/no-response-requested/notes.md), until the model starts answering real
  // questions with those four words. The repair only fires when the *last* message is a
  // user message, so keeping the process alive is what fixes it: the next send reuses it
  // with no `--resume`, that answer lands after the abandoned message, and the abandoned
  // message is no longer last.
  const proc = s.currentProc;
  if (proc && !s.cliDone && interruptProc(proc)) {
    s.stopping = true;
    s.sendLog('info', 'Stop: interrupting the turn, keeping the CLI for reuse');
    s.stopKillTimer = setTimeout(() => {
      // The interrupt was written but never acknowledged with a `result`. Fall back to the
      // old behaviour rather than leave a stopped turn generating where nobody can see it.
      if (!s.stopping) return;
      s.stopping = false;
      s.stopKillTimer = null;
      s.sendLog('warn', 'Stop: interrupt not acknowledged, killing the CLI');
      if (s.currentProc === proc) { s.currentProc = undefined; s.currentProcKey = undefined; }
      killProc(proc);
    }, STOP_INTERRUPT_TIMEOUT_MS);
  } else if (proc) {
    // No live turn to interrupt, or the pipe is already gone. Detach before killing,
    // exactly like the /clear handler: `close` arrives a beat after killProc, and until it
    // does the dying proc still has a writable stdin - so a send issued right after a stop
    // was taken for a mid-turn inject (or reused the proc outright), wrote into a pipe
    // nobody reads, and the pending close then ended the fresh turn with a bare `done`.
    // Detached, it can be neither reused nor injected into, and its close is a no-op.
    s.currentProc = undefined;
    s.currentProcKey = undefined;
    killProc(proc);
  }
  s.cliDone = true;
  s.broadcast(JSON.stringify({ type: 'done' }));
}
