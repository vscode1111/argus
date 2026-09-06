// The one path the fix could plausibly break: a real mid-turn inject. Argus broadcasts its
// own bubble when it writes to stdin, but cliHandler ALSO renders the CLI's echo of it - so
// if the CLI tagged that echo isSynthetic, the new gate would swallow it.
// Writes a second user message into a turn already in flight and prints every user event.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveClaudeBin() {
  if (process.platform !== 'win32') return 'claude';
  try {
    const out = execFileSync('where', ['claude.cmd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const hit = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (hit && fs.existsSync(hit)) return hit;
  } catch {}
  return 'claude';
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-inject-'));
const proc = spawn(resolveClaudeBin(), [
  '--print', '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--tools', 'Bash', '--allowedTools', 'Bash',
], { cwd, shell: process.platform === 'win32', windowsHide: true });

const say = (text) => proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');

let buf = '';
let injected = false;
proc.stdout.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'user') {
      const c = e.message?.content;
      const shown = typeof c === 'string' ? c.slice(0, 90)
        : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? `text:${JSON.stringify(String(b.text).slice(0, 90))}` : b?.type)).join(' | ')
        : typeof c;
      console.log(`USER EVENT isSynthetic=${e.isSynthetic}  ${shown}`);
    }
    if (e.type === 'result') { console.log(`RESULT num_turns=${e.num_turns}`); proc.stdin.end(); }
  }
  // Inject once the turn is visibly under way.
  if (!injected) {
    injected = true;
    setTimeout(() => { console.log('--- injecting mid-turn ---'); say('Also tell me what 123 + 456 is.'); }, 2500);
  }
});
proc.stderr.on('data', (d) => process.stderr.write(d));
proc.on('close', (code) => console.log(`exit=${code}`));

say('Run a bash command that sleeps for 12 seconds, then say the word ready.');
setTimeout(() => { try { proc.kill(); } catch {} }, 150000);
