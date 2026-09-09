import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The CLI writes user-role messages of its own and both feeds them back on the stream and
// records them in the transcript. The one that prompted this: every Read of an image is
// followed by a note giving the downscale factor, so a session that read a dozen scans
// showed a dozen bubbles the user never typed. A `/skill` invocation and the
// compact-continuation summary arrive the same way.
//
// The flag is the only sound test - the text is whatever the tool or skill happened to say -
// and it is spelled differently on each path: `isSynthetic` on the stream,
// `isMeta`/`isVisibleInTranscriptOnly` in the transcript. Payloads captured from a real CLI
// by !notes/tasks/phantom-image-inject/scripts/probe-cli-image.js.
//
// No page and no CLI: the question is which frames one stdout sequence emits, and which
// messages one transcript replays into.

const ROOT = path.resolve(__dirname, '..');
const CLI_HANDLER_JS = path.join(ROOT, 'out', 'backend', 'cliHandler.js');
const SESSIONS_JS = path.join(ROOT, 'out', 'backend', 'sessions.js');

type Ev = Record<string, unknown>;
type ReplayBlock = { type: string; notice?: { summary?: string } };
type ReplayMessage = { role: string; content: string; images?: unknown[]; blocks?: ReplayBlock[] };

let handleCliEvent: (s: unknown, event: Ev) => void;
let loadSession: (sessionId: string, workspaceDir: string) => ReplayMessage[];

test.beforeAll(() => {
  if (!fs.existsSync(CLI_HANDLER_JS) || !fs.existsSync(SESSIONS_JS)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
  handleCliEvent = (require(CLI_HANDLER_JS) as { handleCliEvent: typeof handleCliEvent }).handleCliEvent;
  loadSession = (require(SESSIONS_JS) as { loadSession: typeof loadSession }).loadSession;
});

const IMAGE_NOTE = '[Image: original 2200x3200, displayed at 1375x2000. Multiply coordinates by 1.60 to map to original image.]';

// Exactly as it came off the wire, two events after a Read of a large PNG.
const SYNTHETIC_IMAGE_NOTE: Ev = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: IMAGE_NOTE }] },
  parent_tool_use_id: null,
  isSynthetic: true,
  session_id: 'sess', uuid: 'u1', timestamp: '2026-09-06T08:10:43.526Z',
};

// A real mid-turn inject echoed back by the CLI: same shape, no flag.
const REAL_INJECT: Ev = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'also check the second file' }] },
  parent_tool_use_id: null,
  session_id: 'sess', uuid: 'u2', timestamp: '2026-09-06T08:10:44.000Z',
};

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
    toolMap: new Map(),
    answeredTools: new Set(),
    pendingAskTools: new Set(),
    pendingBgTasks: new Map(),
    currentProc: undefined,
    ...over,
  };
}

const injects = (s: { sent: Ev[] }) => s.sent.filter(m => m.type === 'user_inject').map(m => m.text);

test.describe('CLI-authored user messages are not shown as things the user said', () => {
  test('live: the image note produces no bubble, a real inject still does', () => {
    const s = makeState();

    handleCliEvent(s, SYNTHETIC_IMAGE_NOTE);
    expect(injects(s), 'the CLI wrote this note, not the user').toEqual([]);

    // Control: without it, suppressing every user text block would pass the first
    // assertion and silently delete the mid-turn inject feature.
    handleCliEvent(s, REAL_INJECT);
    expect(injects(s), 'a message the user really typed still renders').toEqual(['also check the second file']);
  });

  test('live: a tool result inside a synthetic event is still delivered', () => {
    const s = makeState({ toolMap: new Map([['toolu_1', { name: 'Read', input: { file_path: 'a.txt' } }]]) });

    handleCliEvent(s, {
      ...SYNTHETIC_IMAGE_NOTE,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }] },
    });

    // The flag says who wrote the text, not whether the event is worthless: gating the
    // whole event instead of the text block would drop the tool's result.
    const ends = s.sent.filter(m => m.type === 'tool_end');
    expect(ends, 'the tool result must survive the synthetic envelope').toHaveLength(1);
    expect((ends[0].call as { result?: string }).result).toBe('file body');
  });

  test('replay: the note is gone, real turns and a pasted image survive', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-replay-'));
    const id = '11111111-2222-4333-8444-555555555555';
    const workspace = path.join(dir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    // Same encoding the CLI uses for the project folder (encodeDir in sessions.ts).
    const encoded = path.resolve(workspace).replace(/[^a-zA-Z0-9]/g, '-');
    const projects = path.join(dir, '.claude', 'projects', encoded);
    fs.mkdirSync(projects, { recursive: true });

    const png = 'iVBORw0KGgoAAAANSUhEUg==';
    const lines = [
      { type: 'user', message: { role: 'user', content: 'read the scan' } },
      { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'scan.png' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] } },
      // String content + isMeta: how the image note is recorded.
      { type: 'user', isMeta: true, message: { role: 'user', content: IMAGE_NOTE } },
      // Block content + isMeta, carrying a skill body AND an image the user pasted.
      { type: 'user', isMeta: true, message: { role: 'user', content: [
        { type: 'text', text: 'Base directory for this skill: /tmp/skills/scub # Skill body' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      ] } },
      // The other flag, which occurs on its own: the compact-continuation summary.
      { type: 'user', isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } },
      { type: 'assistant', message: { id: 'm2', model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }] } },
    ];
    fs.writeFileSync(path.join(projects, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'));

    const home = process.env.USERPROFILE;
    const homeUnix = process.env.HOME;
    process.env.USERPROFILE = dir;
    process.env.HOME = dir;
    let messages: ReplayMessage[];
    try {
      messages = loadSession(id, workspace);
    } finally {
      if (home === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = home;
      if (homeUnix === undefined) delete process.env.HOME; else process.env.HOME = homeUnix;
    }

    const userMsgs = messages.filter(m => m.role === 'user');
    expect(userMsgs.map(m => m.content).filter(Boolean), 'the only text the user typed').toEqual(['read the scan']);

    // The image pasted with the skill call survives, as a message carrying no text: the
    // skill body was the CLI's, the image was the user's.
    const withImages = userMsgs.filter(m => (m.images?.length ?? 0) > 0);
    expect(withImages, 'exactly the pasted image, and not the one the Read returned').toHaveLength(1);
    expect(withImages[0].content).toBe('');

    expect(messages.filter(m => m.role === 'assistant').length, 'assistant turns are untouched').toBeGreaterThan(0);
  });

  // A background task's completion is a CLI-authored user prompt too, and it is the one
  // that carries *neither* isMeta nor isVisibleInTranscriptOnly, so isSynthetic is false
  // for it. Its mark is origin.kind. Shape copied from a real transcript
  // (d---Projects-GMTrade/a519d7b5-...jsonl), where a CI watch left 42 of these among 115
  // user bubbles on replay. Live nothing rendered them for a simpler reason than the one
  // recorded here earlier: the stream does not carry this record at all (probe cited two
  // tests below), so the live case is a guard against a CLI that starts sending it rather
  // than a reproduction of something seen.
  const SUMMARY = 'Background command "Watch CI until all checks complete" completed (exit code 0)';
  const NOTIFICATION_PROMPT = [
    '<task-notification>',
    '<task-id>byn35acls</task-id>',
    '<tool-use-id>toolu_015xR8XGLX4w3Yh6AavnpeuX</tool-use-id>',
    '<output-file>C:\\Users\\Admin\\AppData\\Local\\Temp\\claude\\tasks\\byn35acls.output</output-file>',
    '<status>completed</status>',
    `<summary>${SUMMARY}</summary>`,
    '</task-notification>',
  ].join('\n');

  test('live: a background-task notification prompt produces no bubble', () => {
    const s = makeState();

    handleCliEvent(s, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: NOTIFICATION_PROMPT }] },
      origin: { kind: 'task-notification' },
      session_id: 'sess', uuid: 'u3', timestamp: '2026-09-07T13:31:59.000Z',
    });
    expect(injects(s), 'the CLI woke itself; the user typed nothing').toEqual([]);

    // Control: the discriminator is origin.kind, not the presence of angle brackets.
    handleCliEvent(s, REAL_INJECT);
    expect(injects(s)).toEqual(['also check the second file']);
  });

  // Hidden is not the same as discarded: the turn a notification starts must say why it
  // exists. Live that announcement is the `system` event, NOT the prompt above - a full
  // background-task cycle against a real CLI emitted three user events, every one a
  // tool_result with no origin, and the prompt only ever reaches the transcript
  // (!notes/tasks/bg-turn-cause-marker/scripts/probe-notification-event.js). Payload below
  // is that probe's capture, field for field.
  test('live: the system notification is re-emitted as a marker carrying the CLI summary', () => {
    // Idle, because that is when this notification wakes a turn of its own and therefore
    // needs explaining. Every Bash call raises this event, so the mid-turn case is silent;
    // both halves of that gate are in e2e/bg-task-counting.spec.ts.
    const s = makeState({ cliDone: true });

    handleCliEvent(s, {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'baqv0e8j5',
      tool_use_id: 'toolu_01T9G2G2uSzk1M1xcAnyMYVz',
      status: 'completed',
      output_file: 'C:\\Users\\Admin\\AppData\\Local\\Temp\\claude\\probe\\tasks\\baqv0e8j5.output',
      summary: SUMMARY,
      session_id: 'sess', uuid: 'u4',
    });

    const notices = s.sent.filter(m => m.type === 'bg_notice');
    expect(notices, 'one marker per notification').toHaveLength(1);
    expect(notices[0].notice).toMatchObject({
      taskId: 'baqv0e8j5',
      toolUseId: 'toolu_01T9G2G2uSzk1M1xcAnyMYVz',
      status: 'completed',
      summary: SUMMARY,
    });

    // Control: an ordinary user event produces no marker, so this is not "anything that
    // mentions a task".
    handleCliEvent(s, REAL_INJECT);
    expect(s.sent.filter(m => m.type === 'bg_notice')).toHaveLength(1);
  });

  test('replay: notification prompts are not user bubbles', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-notif-'));
    const id = '99999999-8888-4777-8666-555555555555';
    const workspace = path.join(dir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const encoded = path.resolve(workspace).replace(/[^a-zA-Z0-9]/g, '-');
    const projects = path.join(dir, '.claude', 'projects', encoded);
    fs.mkdirSync(projects, { recursive: true });

    const lines = [
      { type: 'user', message: { role: 'user', content: 'Да, следи' } },
      { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', content: [{ type: 'text', text: 'Обе джобы идут.' }] } },
      // No isMeta, no isVisibleInTranscriptOnly: only origin marks it.
      { type: 'user', origin: { kind: 'task-notification' }, promptSource: 'sdk', message: { role: 'user', content: NOTIFICATION_PROMPT } },
      { type: 'assistant', message: { id: 'm2', model: 'claude-opus-5', content: [{ type: 'text', text: 'Жду.' }] } },
    ];
    fs.writeFileSync(path.join(projects, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'));

    const home = process.env.USERPROFILE;
    const homeUnix = process.env.HOME;
    process.env.USERPROFILE = dir;
    process.env.HOME = dir;
    let messages: ReplayMessage[];
    try {
      messages = loadSession(id, workspace);
    } finally {
      if (home === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = home;
      if (homeUnix === undefined) delete process.env.HOME; else process.env.HOME = homeUnix;
    }

    const userMsgs = messages.filter(m => m.role === 'user');
    expect(userMsgs.map(m => m.content), 'the only thing the user typed').toEqual(['Да, следи']);
    // Control: the turns the notification triggered are the session's content and stay.
    const assistants = messages.filter(m => m.role === 'assistant');
    expect(assistants, 'both answers survive').toHaveLength(2);

    // The prompt is hidden as a bubble but carried over as the marker that opens the turn
    // it started. Reading the session back is where this matters most: a watch replays as
    // a column of answers to questions that are nowhere on screen.
    expect(assistants[0].blocks?.some(b => b.type === 'bg_notice'), 'the first turn was asked for').toBe(false);
    const marker = assistants[1].blocks?.[0];
    expect(marker?.type, 'the notification turn opens with its marker').toBe('bg_notice');
    expect((marker as { notice?: { summary?: string } })?.notice?.summary).toBe(SUMMARY);
  });
});
