// The CLI expands "@notes.md" but not "@My Folder/some file.md" (probe-cli-at-expansion.js).
// So a path with spaces needs some escaped/quoted form - or none exists and Argus has to
// rewrite the mention into something else entirely. This decides what the @ picker inserts.
//
// Same discriminator: unique token in the file, every file-reading tool disallowed, so a
// correct answer can only come from the CLI expanding the mention.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const REL = 'My Folder/some file.md';

function runTurn(cwd, text) {
  return new Promise(resolve => {
    const args = [
      '--print', '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--disallowedTools', 'Read,Glob,Grep,Bash,PowerShell,ToolSearch,Edit,Write,NotebookEdit,Task,WebFetch,WebSearch',
      '--effort', 'low',
    ];
    const proc = spawn('claude', args, { cwd, shell: IS_WIN, windowsHide: true });
    const events = [];
    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* partial */ }
      }
    });
    proc.on('close', () => {
      const reply = events
        .filter(e => e.type === 'assistant')
        .flatMap(e => (e.message?.content || []).filter(b => b.type === 'text').map(b => b.text))
        .join(' ');
      const tools = events
        .filter(e => e.type === 'assistant')
        .flatMap(e => (e.message?.content || []).filter(b => b.type === 'tool_use').map(b => b.name));
      resolve({ reply: reply.trim(), tools });
    });
    proc.on('error', e => resolve({ reply: 'SPAWN ERROR: ' + e.message, tools: [] }));
    proc.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n');
    proc.stdin.end();
    setTimeout(() => { try { proc.kill(); } catch {} }, 90_000);
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-quote-'));
  const abs = path.join(root, REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const forms = [
    ['double-quoted',   p => `@"${p}"`],
    ['single-quoted',   p => `@'${p}'`],
    ['backslash-esc',   p => '@' + p.replace(/ /g, '\\ ')],
    ['quote-outside',   p => `"@${p}"`],
    ['abs double-quote', p => `@"${path.join(root, p)}"`],
    ['abs bare',        p => `@${path.join(root, p)}`],
    ['CONTROL no-space', () => '@ctl.md'],
  ];

  for (const [label, build] of forms) {
    const token = 'scub-token-' + Math.random().toString(36).slice(2, 10);
    fs.writeFileSync(abs, `The token is ${token}\n`, 'utf8');
    fs.writeFileSync(path.join(root, 'ctl.md'), `The token is ${token}\n`, 'utf8');
    const mention = build(REL);
    const res = await runTurn(root, `${mention} What token is written inside that file? Reply with the token only, or say NO-ACCESS if you cannot see its contents.`);
    const ok = res.reply.includes(token);
    console.log(`${ok ? 'PASS' : 'fail'}  ${label.padEnd(17)} ${mention}`);
    if (!ok) console.log(`        reply: ${res.reply.slice(0, 90)}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
})();
