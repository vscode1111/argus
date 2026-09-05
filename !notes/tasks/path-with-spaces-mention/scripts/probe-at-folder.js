// The picker must offer FOLDERS as well as files, so: what does the CLI do with an
// "@folder"? Three possible answers, and they call for different UI:
//   nothing        -> offering folders is a trap, the mention silently does nothing
//   a listing      -> useful and cheap ("what's in here")
//   full contents  -> useful but can blow the context on a big folder, needs a warning
//
// Also settles the hypothesis left open in notes.md: two unquoted space-bearing paths
// failed with "Prompt is too long", which directory inlining would explain.
//
// Discriminator: distinct tokens inside two files, every file-reading tool disallowed.
// Naming the FILENAMES = a listing. Naming the TOKENS = contents were inlined.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function runTurn(cwd, text) {
  return new Promise(resolve => {
    const proc = spawn('claude', [
      '--print', '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--disallowedTools', 'Read,Glob,Grep,Bash,PowerShell,ToolSearch,Edit,Write,NotebookEdit,Task,WebFetch,WebSearch',
      '--effort', 'low',
    ], { cwd, shell: IS_WIN, windowsHide: true });

    const events = [];
    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const l of lines) { if (l.trim()) { try { events.push(JSON.parse(l)); } catch {} } }
    });
    proc.on('close', () => {
      const reply = events.filter(e => e.type === 'assistant')
        .flatMap(e => (e.message?.content || []).filter(b => b.type === 'text').map(b => b.text)).join(' ');
      // input_tokens is the direct measure of how much the mention inlined.
      const usage = events.filter(e => e.type === 'assistant').map(e => e.message?.usage).filter(Boolean).pop();
      const inTok = usage ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : 0;
      resolve({ reply: reply.trim(), inTok });
    });
    proc.on('error', e => resolve({ reply: 'SPAWN ERROR: ' + e.message, inTok: 0 }));
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
    proc.stdin.end();
    setTimeout(() => { try { proc.kill(); } catch {} }, 90_000);
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-folder-'));
  const dir = path.join(root, 'Папка Тест');
  fs.mkdirSync(dir, { recursive: true });
  const tokA = 'scub-alpha-' + Math.random().toString(36).slice(2, 8);
  const tokB = 'scub-beta-' + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(path.join(dir, 'первый.md'), `token ${tokA}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'второй.md'), `token ${tokB}\n`, 'utf8');

  const ask = ' List any file names you can see and any scub- tokens inside them. Say NO-ACCESS if you see neither.';
  const forms = [
    ['folder + slash',   '@"Папка Тест/"'],
    ['folder no slash',  '@"Папка Тест"'],
    ['BASELINE no mention', '(no mention)'],
  ];

  for (const [label, mention] of forms) {
    const res = await runTurn(root, (mention === '(no mention)' ? '' : mention) + ask);
    const names = /первый|второй/i.test(res.reply);
    const tokens = res.reply.includes(tokA) || res.reply.includes(tokB);
    console.log(`--- ${label}  (${mention})`);
    console.log(`  input tokens : ${res.inTok}`);
    console.log(`  filenames    : ${names ? 'YES' : 'no'}`);
    console.log(`  file CONTENTS: ${tokens ? 'YES' : 'no'}`);
    console.log(`  reply        : ${res.reply.slice(0, 160).replace(/\s+/g, ' ')}\n`);
  }
  fs.rmSync(root, { recursive: true, force: true });
})();
