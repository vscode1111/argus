// Reproduces the "empty ~1s turn, then the real turn starts N seconds later" bug at
// the CLI boundary, with no Argus code in the request path.
//
// Phase 1: spawn `claude` exactly as handleSend does, start a long background Bash
//          task, then hard-kill the process so the task is orphaned (which is what
//          the previous CLI process leaves behind when the daemon respawns it).
// Phase 2: spawn a fresh `claude --resume <session>`, write a user message
//          immediately, and print every stdout event with its elapsed time.
//
// The question it answers: does the CLI emit a `result` event for its own internal
// task-notification turn, BEFORE it starts working on the queued user message?
// Argus treats any `result` as "the user's turn ended".
//
// Usage: node repro-orphan-notification.js

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function resolveClaudeBin() {
  if (!IS_WIN) return 'claude';
  const out = execFileSync('where', ['claude.cmd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split(/\r?\n/).map(l => l.trim()).find(Boolean);
}

const TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];

function baseArgs() {
  return [
    '--print', '--verbose',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--tools', TOOLS.join(','),
    '--allowedTools', TOOLS.join(','),
  ];
}

function launch(cwd, extraArgs) {
  const bin = resolveClaudeBin();
  const cmd = IS_WIN && /\s/.test(bin) ? `"${bin}"` : bin;
  const args = [...baseArgs(), ...extraArgs];
  return spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true });
}

function userMsg(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}

// Reads NDJSON off stdout and hands each parsed event to onEvent.
function pipeEvents(proc, onEvent) {
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { onEvent(JSON.parse(t)); } catch { onEvent({ type: '<non-json>', raw: t.slice(0, 200) }); }
    }
  });
  proc.stderr.on('data', c => process.stderr.write('[stderr] ' + c.toString()));
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-orphan-'));
console.log('workspace:', workspace);

function phase1() {
  return new Promise((resolve) => {
    const proc = launch(workspace, []);
    let sessionId = '';
    let sawTask = false;
    const t0 = Date.now();

    pipeEvents(proc, (ev) => {
      const el = String(Date.now() - t0).padStart(6);
      if (ev.type === 'system' && ev.subtype === 'init') sessionId = ev.session_id;
      if (ev.type === 'system' && ev.subtype === 'task_started') sawTask = true;
      if (ev.type === 'stream_event') return;
      console.log(`  [p1 +${el}ms] ${ev.type}${ev.subtype ? '/' + ev.subtype : ''}`);
      if (ev.type === 'result') {
        // Turn over, background task still running -> kill hard, exactly as a daemon
        // respawn / kill-all would, leaving the task with no completion record.
        console.log(`  [p1] result seen (task_started=${sawTask}); hard-killing pid ${proc.pid}`);
        setTimeout(() => {
          try { execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore' }); } catch {}
          resolve({ sessionId, sawTask });
        }, 500);
      }
    });

    proc.stdin.write(userMsg(
      'Run this shell command in the background with run_in_background set to true, using the Bash tool: `sleep 300`. ' +
      'Do not wait for it. As soon as it is launched, reply with exactly: STARTED'
    ));
  });
}

function phase2(sessionId) {
  return new Promise((resolve) => {
    const proc = launch(workspace, ['--resume', sessionId]);
    const t0 = Date.now();
    const results = [];
    let assistantSeen = false;

    pipeEvents(proc, (ev) => {
      const el = Date.now() - t0;
      if (ev.type === 'stream_event') return;
      let extra = '';
      if (ev.type === 'assistant') {
        const c = ev.message?.content ?? [];
        extra = ` model=${ev.message?.model} content=${JSON.stringify(c.map(b => b.type === 'text' ? b.text.slice(0, 40) : b.type))}`;
      }
      if (ev.type === 'user') {
        const c = ev.message?.content;
        extra = ' ' + JSON.stringify(typeof c === 'string' ? c.slice(0, 80) : c).slice(0, 100);
      }
      if (ev.type === 'result') {
        extra = ` subtype=${ev.subtype} is_error=${ev.is_error} result=${JSON.stringify(String(ev.result ?? '').slice(0, 60))}`;
        extra += '\n      FULL: ' + JSON.stringify(ev).slice(0, 900);
        results.push({ atMs: el, beforeRealAnswer: !assistantSeen });
      }
      if (ev.type === 'assistant' && ev.message?.model !== '<synthetic>') assistantSeen = true;
      console.log(`  [p2 +${String(el).padStart(6)}ms] ${ev.type}${ev.subtype ? '/' + ev.subtype : ''}${extra}`);

      if (results.length >= 2 || (results.length === 1 && assistantSeen)) {
        setTimeout(() => {
          try { execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore' }); } catch {}
          resolve(results);
        }, 1500);
      }
    });

    // Same tick as the spawn, exactly like handleSend.
    proc.stdin.write(userMsg('Reply with exactly: HELLO'));
  });
}

(async () => {
  console.log('\n--- phase 1: create an orphaned background task ---');
  const { sessionId, sawTask } = await phase1();
  console.log('session:', sessionId, 'background task started:', sawTask);
  if (!sessionId) { console.log('no session id, aborting'); return; }

  console.log('\n--- phase 2: fresh `claude --resume`, user message written immediately ---');
  const results = await phase2(sessionId);

  console.log('\n--- verdict ---');
  const premature = results.filter(r => r.beforeRealAnswer);
  console.log(`result events: ${results.length}, emitted before any real assistant message: ${premature.length}`);
  for (const r of premature) console.log(`  premature result at +${r.atMs}ms  -> Argus would broadcast a "done" here`);
  console.log('transcript:', path.join(os.homedir(), '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl'));
})();
