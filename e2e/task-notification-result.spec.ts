import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The CLI runs turns of its own for background-task notifications, and every one of them
// emits a `result` event indistinguishable in type from the end of the user's turn. Two
// of those turns exist and they must be treated in opposite ways:
//
//   1. On `--resume` startup the CLI replays a notification for every background task
//      orphaned by the previous CLI process. That turn runs *before* the user's message
//      is dequeued (`num_turns: 0`, empty result) - so its `result` is not the end of
//      anything the user is waiting on. Taken as one, it committed an empty assistant
//      message with a ~1s timer, and the real answer then arrived 5-15s later through the
//      autonomous-turn recovery branch as a second message.
//   2. A background task that finishes while the session is idle. Argus surfaces that turn
//      itself (the recovery branch sends its `thinking_start`), so its `result` really is
//      the end of the turn on screen and must still commit it.
//
// Both carry `origin: {kind: 'task-notification'}` - measured against a real CLI in
// !notes/tasks/empty-1s-turn/scripts/, which is where these payloads come from. So origin
// alone cannot separate them; who started the turn is what does.
//
// This drives the compiled event handler directly: no page and no CLI, because the whole
// question is which WS frames handleCliEvent emits for a given stdout sequence.

const ROOT = path.resolve(__dirname, '..');
const CLI_HANDLER_JS = path.join(ROOT, 'out', 'backend', 'cliHandler.js');

type Ev = Record<string, unknown>;
let handleCliEvent: (s: unknown, event: Ev) => void;

test.beforeAll(() => {
  if (!fs.existsSync(CLI_HANDLER_JS)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
  handleCliEvent = (require(CLI_HANDLER_JS) as { handleCliEvent: typeof handleCliEvent }).handleCliEvent;
});

// Captured from a real `claude --resume` whose previous process left a background task
// running: emitted right after the task_notification replay, before the queued user
// message was touched.
const ORPHAN_REPLAY_RESULT: Ev = {
  type: 'result', subtype: 'success', is_error: false,
  duration_ms: 68, num_turns: 0, result: '',
  session_id: '5d41936f-3522-48c6-bf4d-1bec16988c13',
  usage: { input_tokens: 0, output_tokens: 0 },
  origin: { kind: 'task-notification' },
};

// Captured from a background task that completed normally while the session was idle.
const BG_COMPLETION_RESULT: Ev = {
  type: 'result', subtype: 'success', is_error: false,
  duration_ms: 1836, num_turns: 1, result: 'Background task finished successfully, output `SCUB_TASK_FINISHED`',
  session_id: '5d41936f-3522-48c6-bf4d-1bec16988c13',
  usage: { input_tokens: 4, output_tokens: 21 },
  origin: { kind: 'task-notification' },
};

const USER_TURN_RESULT: Ev = {
  type: 'result', subtype: 'success', is_error: false,
  duration_ms: 1640, num_turns: 1, result: 'HELLO',
  session_id: '5d41936f-3522-48c6-bf4d-1bec16988c13',
  usage: { input_tokens: 2, output_tokens: 6 },
};

function assistantEvent(text: string, model = 'claude-sonnet-5'): Ev {
  return { type: 'assistant', message: { model, content: [{ type: 'text', text }] } };
}

// Minimal stand-in for SessionState carrying only what these event paths touch.
function makeState(over: Partial<Record<string, unknown>> = {}) {
  const sent: Ev[] = [];
  const state = {
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
    receivedDeltas: false,
    receivedThinkingDeltas: false,
    textAccum: '',
    liveOutputChars: 0,
    completedOutputTokens: 0,
    turnInputTokens: 0,
    turnOutputTokens: 0,
    toolMap: new Map(),
    answeredTools: new Set(),
    pendingAskTools: new Set(),
    pendingBgTasks: new Map(),
    pendingFollowUp: undefined,
    currentProc: undefined,
    ...over,
  };
  return state;
}

const types = (s: { sent: Ev[] }) => s.sent.map(m => m.type);

test.describe('task-notification result events', () => {
  test('the orphan replay does not end the user turn, the real result does', () => {
    // The user's send has just spawned the CLI: handleSend cleared both flags and the
    // turn on screen is the user's.
    const s = makeState({ cliDone: false, autonomousTurn: false });

    handleCliEvent(s, ORPHAN_REPLAY_RESULT);
    expect(types(s), 'the queued user message has not been answered yet').not.toContain('done');
    expect(s.cliDone, 'the turn must stay open for the answer that is still coming').toBe(false);

    // The CLI dequeues the user message and answers. Because the turn was never closed,
    // this lands in the message the user is already watching - no recovery thinking_start,
    // so no second bubble.
    handleCliEvent(s, assistantEvent('HELLO'));
    expect(types(s), 'a recovery turn would mean the empty message was committed').not.toContain('thinking_start');

    handleCliEvent(s, USER_TURN_RESULT);
    expect(types(s).filter(t => t === 'done'), 'exactly one turn, ended once').toHaveLength(1);
    expect(s.cliDone).toBe(true);
  });

  test('a background task finishing while idle still ends its own turn', () => {
    // Nothing is streaming: the previous turn set cliDone, and the notification turn is
    // announced by the recovery branch rather than by a send.
    const s = makeState({ cliDone: true, autonomousTurn: false });

    handleCliEvent(s, assistantEvent('Background task finished successfully, output `SCUB_TASK_FINISHED`'));
    expect(types(s), 'the recovery branch opens the turn').toContain('thinking_start');
    expect(s.autonomousTurn, 'and marks it as the CLI\'s own').toBe(true);

    handleCliEvent(s, BG_COMPLETION_RESULT);
    expect(types(s), 'this result is the end of the turn on screen').toContain('done');
    expect(s.cliDone).toBe(true);
  });

  test('an ordinary user turn is unaffected', () => {
    const s = makeState({ cliDone: false, autonomousTurn: false });
    handleCliEvent(s, assistantEvent('HELLO'));
    handleCliEvent(s, USER_TURN_RESULT);
    expect(types(s).filter(t => t === 'done')).toHaveLength(1);
  });

  test('an errored result still reports, whoever owns the turn', () => {
    const s = makeState({ cliDone: true, autonomousTurn: true });
    handleCliEvent(s, { ...BG_COMPLETION_RESULT, is_error: true, result: 'API Error: 500' });
    expect(types(s)).toContain('error');
    expect(types(s)).toContain('done');
  });
});
