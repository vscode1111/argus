import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The follow-up prompt that carries AskUserQuestion answers back to the model, built from
// the model's own tool input - which is not schema-guaranteed. The CLI delivers `questions`
// as a JSON string as readily as an array (both calls recorded on this machine were
// strings), and `questions.find` on a string threw out of the WS message handler: with no
// uncaughtException net in the daemon that killed the shared server process and dropped
// every client on it, from one Submit click.
//
// No page and no CLI - the whole question is what one payload turns into. The `questions`
// string below is copied verbatim from the reported transcript
// (f576b729-8c1a-4da0-a079-14e598a30ccb.jsonl line 62). The end-to-end proof that the
// server survives lives in
// !notes/tasks/ask-submit-kills-daemon/scripts/repro-ask-submit-crash.js.

const ROOT = path.resolve(__dirname, '..');
const SESSION_JS = path.join(ROOT, 'out', 'backend', 'session.js');

let buildAskFollowUp: (rawQuestions: unknown, answers: Record<string, string>) => string;

test.beforeAll(() => {
  if (!fs.existsSync(SESSION_JS)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
  buildAskFollowUp = (require(SESSION_JS) as { buildAskFollowUp: typeof buildAskFollowUp }).buildAskFollowUp;
});

const QUESTIONS = [
  {
    question: "Should each row have an action (like the CLI list's per-row terminate), or is this read-only?",
    header: 'Row action',
    multiSelect: false,
    options: [
      { label: 'Read-only list', description: 'Just the list, no way to kick a client.' },
      { label: 'Disconnect button', description: 'Per-row close, mirroring the CLI list trash button.' },
      { label: 'Disconnect + block origin', description: 'Closes the socket AND blocks its origin.' },
    ],
  },
  {
    question: 'Which columns? This decides what the backend records per socket.',
    header: 'Columns',
    multiSelect: false,
    options: [
      { label: 'Full (kind, address, workspace, session, connected, idle)', description: 'Everything.' },
      { label: 'No address column', description: 'Same minus the remote IP.' },
    ],
  },
];

const ANSWER = { [QUESTIONS[0].question]: 'Disconnect button' };

test('answers on a string-encoded questions payload still name the chosen option', () => {
  // The reported shape: the model recorded `questions` as a JSON string.
  const followUp = buildAskFollowUp(JSON.stringify(QUESTIONS), ANSWER);

  expect(followUp).toContain('Disconnect button');
  // The index and the description are the whole point of the follow-up - they are what
  // tells the model *which* option was picked. A build that merely stopped throwing (an
  // empty questions array) would still lose both.
  expect(followUp).toContain('(option 2 of 3)');
  expect(followUp).toContain('Per-row close, mirroring the CLI list trash button.');
});

test('a string payload and an array payload produce identical text', () => {
  // The control. Without it, "return [] and never throw" satisfies the case above's
  // no-crash intent while silently degrading every answer the user submits.
  const fromString = buildAskFollowUp(JSON.stringify(QUESTIONS), ANSWER);
  const fromArray = buildAskFollowUp(QUESTIONS, ANSWER);
  expect(fromString).toBe(fromArray);
});

test('every answered question of a multi-question dialog reaches the model', () => {
  // The reported dialog had three tabs; an answer map covering several questions must not
  // lose any of them.
  const followUp = buildAskFollowUp(JSON.stringify(QUESTIONS), {
    [QUESTIONS[0].question]: 'Read-only list',
    [QUESTIONS[1].question]: 'No address column',
  });
  expect(followUp).toContain('(option 1 of 3)');
  expect(followUp).toContain('(option 2 of 2)');
  expect(followUp).toContain(QUESTIONS[0].question);
  expect(followUp).toContain(QUESTIONS[1].question);
});

test('a malformed or unusable payload degrades instead of throwing', () => {
  // Truncated JSON, a wholly unexpected type, and a missing field: each loses the option
  // index (nothing to look it up in) but must still deliver question and answer, because
  // the alternative measured in production was the server process exiting.
  for (const raw of ['[{"question":"x","options":[', 42, null, undefined, { questions: 'nested' }]) {
    const followUp = buildAskFollowUp(raw, { 'scub question': 'scub answer' });
    expect(followUp).toContain('scub question');
    expect(followUp).toContain('scub answer');
    expect(followUp).not.toContain('option ');
  }
});

test('an options list that is itself not an array is survivable', () => {
  // The same untrusted shape one level down: `options` as a string used to reach
  // `.findIndex` and throw exactly as `questions.find` did.
  const followUp = buildAskFollowUp(
    JSON.stringify([{ question: 'scub q', header: 'h', options: 'not-an-array' }]),
    { 'scub q': 'scub a' },
  );
  expect(followUp).toContain('scub q');
  expect(followUp).toContain('scub a');
});
