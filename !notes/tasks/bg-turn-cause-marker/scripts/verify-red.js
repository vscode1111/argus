#!/usr/bin/env node
// Verify-red for the background-task cause marker: revert one change at a time, assert the
// test that exists for it fails, restore. A green suite proves nothing on its own.
//
// The anchors are single-line and matched literally, and every replacement asserts it
// applied - a silent no-op patch once made a whole verify-red round pass while reverting
// nothing (CRLF vs LF on a multi-line anchor), which reads as proof and is the opposite.
//
// Usage: node verify-red.js [caseName...]
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const f = (...p) => path.join(ROOT, ...p);

const CASES = [
  {
    name: 'live-marker',
    file: f('src', 'backend', 'cliHandler.ts'),
    from: "      s.broadcast(JSON.stringify({ type: 'bg_notice', notice }));",
    to: '      void notice;',
    compile: true,
    grep: 're-emitted as a marker',
    why: 'the live path stops announcing the notification',
  },
  {
    name: 'replay-marker',
    file: f('src', 'backend', 'sessions.ts'),
    from: "        if (pendingNotice) { current.blocks!.push({ type: 'bg_notice', notice: pendingNotice }); pendingNotice = null; }",
    to: '        pendingNotice = null;',
    compile: true,
    grep: 'notification prompts are not user bubbles',
    why: 'a replayed watch loses the reason each turn exists',
  },
  {
    name: 'reducer-seeding',
    file: f('webview', 'src', 'reducer.ts'),
    from: "      const blocks: ContentBlock[] = state.pendingNotice ? [{ type: 'bg_notice', notice: state.pendingNotice }] : [];",
    to: '      const blocks: ContentBlock[] = [];',
    grep: 'opens with a marker naming its cause',
    why: 'the notice arrives before the turn and is dropped again',
  },
  {
    name: 'notice-clearing',
    file: f('webview', 'src', 'reducer.ts'),
    from: "      return { ...state, messages: [...state.messages, action.message], pendingNotice: action.message.role === 'user' ? null : state.pendingNotice };",
    to: '      return { ...state, messages: [...state.messages, action.message] };',
    grep: 'does not open the next one the user starts',
    why: 'a stale marker leaks onto the turn the user started',
  },
  {
    name: 'timer-colour',
    file: f('webview', 'src', 'components', 'ChatMessage.tsx'),
    from: "          : message.outcome === 'background_waiting' || message.outcome === 'background_done' ? msg.responseTime",
    to: '',
    grep: 'neutral timer, not success green|final message shows timer',
    why: 'a turn that left work running claims success green again',
  },
];

function patch(file, from, to) {
  const src = fs.readFileSync(file, 'utf8');
  const hits = src.split(from).length - 1;
  if (hits !== 1) throw new Error(`anchor matched ${hits} times in ${file}, expected exactly 1`);
  fs.writeFileSync(file, src.split(from).join(to));
}

function compile() {
  execFileSync('yarn', ['compile'], { cwd: ROOT, stdio: 'ignore', shell: true });
}

const wanted = process.argv.slice(2);
const cases = wanted.length ? CASES.filter(c => wanted.includes(c.name)) : CASES;
const results = [];

for (const c of cases) {
  const backup = fs.readFileSync(c.file, 'utf8');
  let verdict;
  try {
    patch(c.file, c.from, c.to);
    if (c.compile) compile();
    // One quoted command string, not an args array: with shell:true the array is joined
    // without quoting, so a -g pattern containing spaces broke into separate shell tokens.
    // The first round of this reported "3 passed" (a grep of just "does", matching other
    // tests) and "NO TESTS RAN", both of which read as a result rather than as a broken
    // harness. Quote the pattern and let the "no tests ran" guard below catch the rest.
    const cmd = `npx playwright test --project=mock --reporter=line -g "${c.grep}"`;
    const run = spawnSync(cmd, { cwd: ROOT, encoding: 'utf8', shell: true });
    const out = (run.stdout || '') + (run.stderr || '');
    const failed = /\d+ failed/.test(out);
    const ran = /\d+ (passed|failed)/.test(out);
    verdict = !ran ? 'NO TESTS RAN (grep matched nothing)' : failed ? 'red (correct)' : 'STILL GREEN (test proves nothing)';
    const counts = out.match(/\d+ (passed|failed)/g);
    results.push({ case: c.name, verdict, counts: counts ? counts.join(', ') : '-', why: c.why });
  } catch (err) {
    results.push({ case: c.name, verdict: `ERROR: ${err.message}`, counts: '-', why: c.why });
  } finally {
    fs.writeFileSync(c.file, backup);
    if (c.compile) compile();
  }
  const last = results[results.length - 1];
  console.log(`${last.case.padEnd(16)} ${last.verdict.padEnd(32)} ${last.counts}`);
}

console.log('\n--- summary ---');
for (const r of results) console.log(`${r.case.padEnd(16)} ${r.verdict.padEnd(32)} ${r.why}`);
const bad = results.filter(r => r.verdict !== 'red (correct)');
process.exit(bad.length ? 1 : 0);
