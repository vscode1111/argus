// Does the Claude CLI expand an "@path" mention in the exact mode Argus spawns it?
// (--print --input-format stream-json, text delivered as NDJSON on stdin.)
//
// Decisive design: put a unique token inside a file and DISALLOW every file-reading
// tool. If the CLI expands the mention, the content is injected into the user message
// and the model can say the token with no tools at all. If it does not expand, the
// model cannot know the token and must say so.
//
// Two shapes: an ASCII path with a space, and the reported Cyrillic-with-spaces shape.
// Temp dir on purpose - a workspace under ~/.claude/projects would load its own
// memory/CLAUDE.md into the turn.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-mention-'));
  // The no-space case is the CONTROL and the whole point of the probe: without it,
  // "the CLI never expands @ in this mode" and "it expands, but a space breaks its own
  // parser" produce identical output, and they call for opposite fixes.
  const cases = [
    { label: 'CONTROL no-space', rel: 'notes.md', token: 'scub-token-' + Math.random().toString(36).slice(2, 10) },
    { label: 'ascii+space', rel: 'My Folder/some file.md', token: 'scub-token-' + Math.random().toString(36).slice(2, 10) },
    { label: 'cyrillic+space', rel: 'Бискуб Тест/Военный билет 12.md', token: 'scub-token-' + Math.random().toString(36).slice(2, 10) },
  ];
  for (const c of cases) {
    const abs = path.join(root, c.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `The token is ${c.token}\n`, 'utf8');
  }
  return { root, cases };
}

function runTurn(cwd, text) {
  return new Promise(resolve => {
    const args = [
      '--print', '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      // Every path to the file's contents is closed, so answering the token can only
      // come from the CLI having expanded the mention itself.
      // PowerShell and ToolSearch were reached on the first run - block every route to
      // the bytes, or a tool call rather than expansion could explain a correct answer.
      '--disallowedTools', 'Read,Glob,Grep,Bash,PowerShell,ToolSearch,Edit,Write,NotebookEdit,Task,WebFetch,WebSearch',
      '--effort', 'low',
    ];
    const proc = spawn('claude', args, { cwd, shell: IS_WIN, windowsHide: true });
    const events = [];
    let out = '';
    proc.stdout.on('data', d => {
      out += d.toString();
      const lines = out.split('\n');
      out = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* partial */ }
      }
    });
    proc.on('close', () => {
      const text = events
        .filter(e => e.type === 'assistant')
        .flatMap(e => (e.message?.content || []).filter(b => b.type === 'text').map(b => b.text))
        .join(' ');
      const tools = events
        .filter(e => e.type === 'assistant')
        .flatMap(e => (e.message?.content || []).filter(b => b.type === 'tool_use').map(b => b.name));
      resolve({ text: text.trim(), tools });
    });
    proc.on('error', e => resolve({ text: 'SPAWN ERROR: ' + e.message, tools: [] }));

    proc.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n');
    proc.stdin.end();
    setTimeout(() => { try { proc.kill(); } catch {} }, 90_000);
  });
}

(async () => {
  const { root, cases } = makeWorkspace();
  console.log('workspace:', root, '\n');
  for (const c of cases) {
    const prompt = `@${c.rel} What token is written inside that file? Reply with the token only, or say NO-ACCESS if you cannot see its contents.`;
    const res = await runTurn(root, prompt);
    const expanded = res.text.includes(c.token);
    console.log(`--- ${c.label}`);
    console.log(`  mention : @${c.rel}`);
    console.log(`  token   : ${c.token}`);
    console.log(`  tools   : ${res.tools.length ? res.tools.join(',') : '(none)'}`);
    console.log(`  reply   : ${res.text.slice(0, 200)}`);
    console.log(`  EXPANDED: ${expanded ? 'YES - CLI injected the file' : 'NO - mention was plain text'}\n`);
  }
  fs.rmSync(root, { recursive: true, force: true });
})();
