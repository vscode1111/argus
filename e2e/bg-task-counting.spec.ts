import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// What counts as a background task. The CLI emits `system`/`task_started` and
// `task_notification` for **every** Bash tool call, foreground included, so `task_started` is
// not the signal it looks like: adding on it blinked the `✻ N` pill on and off for every
// command the agent ran, and made the cause marker announce `echo one`.
//
// Payloads below are captured from real CLI runs by the probes in
// !notes/tasks/bg-turn-cause-marker/scripts/ (probe-foreground-bash.js, probe-pill-flicker.js)
// and from a reported transcript for the case the CLI backgrounded on its own.
//
// No page and no CLI: the whole question is which frames one stdout sequence emits.

const ROOT = path.resolve(__dirname, '..');
const CLI_HANDLER_JS = path.join(ROOT, 'out', 'backend', 'cliHandler.js');

type Ev = Record<string, unknown>;
let handleCliEvent: (s: unknown, event: Ev) => void;

test.beforeAll(() => {
  if (!fs.existsSync(CLI_HANDLER_JS)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
  handleCliEvent = (require(CLI_HANDLER_JS) as { handleCliEvent: typeof handleCliEvent }).handleCliEvent;
});

function makeState(over: Partial<Record<string, unknown>> = {}) {
  const sent: Ev[] = [];
  return {
    sent,
    broadcast: (msg: string) => { sent.push(JSON.parse(msg) as Ev); },
    sendLog: () => {},
    resetStaleTimer: () => {},
    startStaleTimer: () => {},
    flushAskFollowUp: () => {},
    watchdog: { state: { active: true, lastEventTime: 0, autoRetryCount: 0, retrying: false } },
    sessionId: 'sess',
    cliDone: false,
    autonomousTurn: false,
    suppressCliOutput: false,
    textAccum: '',
    receivedDeltas: false,
    toolMap: new Map(),
    answeredTools: new Set(),
    pendingAskTools: new Set(),
    // Mirrors SessionState: a Map since the elapsed-time note (id -> launch time), not a Set.
    pendingBgTasks: new Map<string, number>(),
    currentProc: undefined,
    ...over,
  };
}

const counts = (s: { sent: Ev[] }) => s.sent.filter(m => m.type === 'bgTasks').map(m => m.count);
const notices = (s: { sent: Ev[] }) => s.sent.filter(m => m.type === 'bg_notice');

/** The assistant announcing a Bash call, which is what fills `toolMap`. */
function toolUse(s: unknown, id: string, command: string, background: boolean) {
  handleCliEvent(s, {
    type: 'assistant',
    message: {
      id: 'm1', model: 'claude-opus-5', role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: background ? { command, run_in_background: true } : { command } }],
    },
  });
}

function toolResult(s: unknown, id: string, text: string) {
  handleCliEvent(s, { type: 'tool_result', tool_use_id: id, content: text });
}

const FG_TOOL = 'toolu_01Foreground3m5Jvr';
const BG_TOOL = 'toolu_015tK7V2a7hiXoY5P5yKpCFw';
const AUTO_TOOL = 'toolu_01UHdoKmZDi3eWVGGNWjBa88';

test.describe('only real background tasks reach the pending count', () => {
  test('a plain Bash call is not counted, even though it raises task_started', () => {
    const s = makeState();
    toolUse(s, FG_TOOL, 'echo scub-hello', false);
    toolResult(s, FG_TOOL, 'scub-hello');
    // Captured verbatim: a foreground `echo` produced both of these, 2s apart.
    handleCliEvent(s, { type: 'system', subtype: 'task_started', task_id: 'b6hrftz42', tool_use_id: FG_TOOL });
    handleCliEvent(s, { type: 'system', subtype: 'task_notification', task_id: 'b6hrftz42', tool_use_id: FG_TOOL, status: 'completed', summary: 'Echo scub-hello' });

    expect(counts(s), 'the pill must not move for an ordinary command').toEqual([]);
  });

  test('a run_in_background call is counted and cleared by its notification', () => {
    const s = makeState();
    toolUse(s, BG_TOOL, 'for i in 1 2 3; do echo tick; sleep 3; done', true);
    handleCliEvent(s, { type: 'system', subtype: 'task_started', task_id: 'bagbl8seg', tool_use_id: BG_TOOL });
    expect(counts(s)).toEqual([1]);

    handleCliEvent(s, { type: 'system', subtype: 'task_notification', task_id: 'bagbl8seg', tool_use_id: BG_TOOL, status: 'completed', summary: 'Background command "tick loop" completed (exit code 0)' });
    expect(counts(s), 'up on launch, down on completion').toEqual([1, 0]);
  });

  // The case the input alone misses, and the reason the result text is a second discriminator:
  // the CLI moves a slow command to the background on its own, so nothing in what the model
  // asked for says "background". Result string copied from a real transcript, where the
  // notification for this task arrived five minutes later and woke an autonomous turn.
  test('a command the CLI backgrounds by itself is counted, from its result', () => {
    const s = makeState();
    toolUse(s, AUTO_TOOL, 'grep -rn ToAccountMetas target/', false);
    toolResult(s, AUTO_TOOL, 'Command running in background with ID: bsbym70eo. Output is being written to: C:\\Temp\\tasks\\bsbym70eo.output. You will be notified when it completes.');
    expect(counts(s), 'the CLI said it is in the background, which is enough').toEqual([1]);

    // The task_started that follows names the same id and must not count it twice.
    handleCliEvent(s, { type: 'system', subtype: 'task_started', task_id: 'bsbym70eo', tool_use_id: AUTO_TOOL });
    expect(counts(s)).toEqual([1]);

    handleCliEvent(s, { type: 'system', subtype: 'task_notification', task_id: 'bsbym70eo', tool_use_id: AUTO_TOOL, status: 'completed', summary: 'Background command "grep" completed (exit code 0)' });
    expect(counts(s)).toEqual([1, 0]);
  });

  // The sentence is matched at the start of the result, exactly like the webview's pulse test,
  // so a command that merely prints it cannot inject an id nothing will ever remove. These
  // notes contain that sentence, so `cat`ting them is the real scenario, not a contrived one.
  test('a command that merely prints the launch sentence is not counted', () => {
    const s = makeState();
    toolUse(s, FG_TOOL, 'cat !notes/background-tasks.md', false);
    toolResult(s, FG_TOOL, 'The tool result reads "Command running in background with ID: bsbym70eo" and that is how Argus learns about it.');

    expect(counts(s), 'quoting the sentence is not launching a task').toEqual([]);
  });

  test('the cause marker is raised for a turn nobody asked for, not for every command', () => {
    // Mid-turn: the CLI is working, so this notification folds into the running turn and
    // needs no marker. This is the `echo one` case that spammed one per command.
    const busy = makeState({ cliDone: false });
    handleCliEvent(busy, { type: 'system', subtype: 'task_notification', task_id: 'br08f2ftc', tool_use_id: FG_TOOL, status: 'completed', summary: 'Echo one' });
    expect(notices(busy), 'nothing appeared out of nowhere: a turn is already running').toEqual([]);

    // Idle: this notification is what wakes the autonomous turn, so it must be explained.
    const idle = makeState({ cliDone: true });
    handleCliEvent(idle, { type: 'system', subtype: 'task_notification', task_id: 'bagbl8seg', tool_use_id: BG_TOOL, status: 'completed', summary: 'Background command "Watch CI until all checks complete" completed (exit code 0)' });
    expect(notices(idle)).toHaveLength(1);
    expect((notices(idle)[0].notice as { summary?: string }).summary).toContain('Watch CI');
  });
});
