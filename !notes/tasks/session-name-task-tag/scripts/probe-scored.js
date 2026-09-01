// Probe 2: does scoring by *engagement* instead of *mention* fix the precision
// problem found by probe-titles.js?
//
// Probe 1 showed the pollution source: a session that reads !notes/tasks/INDEX.md
// or a chat log inherits every ticket id in that file. So this pass ignores
// tool_result content entirely and scores only evidence that the session chose
// the subject: the user's own words, and the paths/URLs the agent wrote to or
// fetched.
//
// Usage: node probe-scored.js [limit]

const fs = require('fs');
const os = require('os');
const path = require('path');

const LIMIT = Number(process.argv[2] || 300);
const ROOT = path.join(os.homedir(), '.claude', 'projects');

const TICKET_RE = /\b([A-Z][A-Z]{1,9})-(\d{1,6})\b/g;
const STOP = new Set(['UTF', 'ISO', 'SHA', 'MD', 'RFC', 'AES', 'RGB', 'RGBA', 'SSE', 'IPV', 'HTTP', 'HTTPS', 'TLS', 'SQL', 'API', 'UUID', 'JSON', 'CSS', 'HTML', 'PNG', 'JPEG', 'GPT', 'CI', 'CD', 'PR', 'MR', 'ID', 'OK', 'TODO']);
// A task folder, not a file directly inside tasks/ (that is how INDEX.md leaked in).
const NOTES_DIR_RE = /!notes[\/\\]tasks[\/\\]([A-Za-z0-9._-]+)[\/\\]/g;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const FETCH_TOOLS = new Set(['WebFetch', 'WebSearch']);

function tickets(text) {
  const out = [];
  TICKET_RE.lastIndex = 0;
  let m;
  while ((m = TICKET_RE.exec(text))) if (!STOP.has(m[1])) out.push(`${m[1]}-${m[2]}`);
  return out;
}
function notesDirs(text) {
  const out = [];
  NOTES_DIR_RE.lastIndex = 0;
  let m;
  while ((m = NOTES_DIR_RE.exec(text))) out.push(m[1]);
  return out;
}

function score(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const pts = new Map();          // tag -> score
  const why = new Map();          // tag -> reasons
  const add = (tag, n, reason) => {
    if (!tag) return;
    pts.set(tag, (pts.get(tag) || 0) + n);
    if (!why.has(tag)) why.set(tag, new Set());
    why.get(tag).add(reason);
  };

  let aiTitle = '', customTitle = '', firstPrompt = '', seenFirst = false;

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }

    if (o.type === 'custom-title' && typeof o.customTitle === 'string') { customTitle = o.customTitle; continue; }
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string') { aiTitle = o.aiTitle; continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const content = o.message && o.message.content;
    if (!content) continue;

    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (Array.isArray(content) ? content : []);
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;

      // (a) The user's own words. The first prompt is the strongest single signal.
      if (o.type === 'user' && b.type === 'text' && typeof b.text === 'string') {
        const t = b.text;
        if (t.startsWith('<') || !t.trim()) continue;   // system-injected reminders
        const isFirst = !seenFirst;
        if (isFirst) { firstPrompt = t.slice(0, 300); seenFirst = true; }
        for (const tag of tickets(t)) add(tag, isFirst ? 10 : 4, isFirst ? 'first-prompt' : 'user-text');
        for (const d of notesDirs(t)) add(d, isFirst ? 8 : 3, isFirst ? 'first-prompt' : 'user-text');
      }

      // (b) What the agent chose to act on. tool_result is deliberately NOT read:
      // that is where probe 1's false positives came from.
      if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
        const name = b.name;
        const fp = typeof b.input.file_path === 'string' ? b.input.file_path : '';
        const url = typeof b.input.url === 'string' ? b.input.url : '';
        if (WRITE_TOOLS.has(name) && fp) {
          for (const d of notesDirs(fp + path.sep)) add(d, 8, 'wrote-notes');
          for (const tag of tickets(fp)) add(tag, 6, 'wrote-path');
        }
        if (FETCH_TOOLS.has(name) && url) {
          for (const tag of tickets(url)) add(tag, 6, 'fetched-url');
        }
      }
    }
  }

  // (c) The CLI's own title, if it already names the subject.
  for (const tag of tickets(aiTitle)) add(tag, 5, 'ai-title');

  const ranked = [...pts.entries()].sort((a, b) => b[1] - a[1]);
  return { aiTitle, customTitle, firstPrompt, ranked, why };
}

const files = [];
for (const proj of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, proj);
  let st; try { st = fs.statSync(dir); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    try { const s = fs.statSync(full); if (s.size > 0) files.push({ full, proj, mtime: s.mtimeMs }); } catch { /* ignore */ }
  }
}
files.sort((a, b) => b.mtime - a.mtime);

let withTag = 0, total = 0, ambiguous = 0;
for (const f of files.slice(0, LIMIT)) {
  const r = score(f.full);
  if (!r) continue;
  total++;
  const top = r.ranked[0];
  const second = r.ranked[1];
  if (!top) continue;
  withTag++;
  const close = second && second[1] >= top[1] * 0.8;
  if (close) ambiguous++;
  console.log('---');
  console.log('proj  :', f.proj);
  console.log('title :', r.aiTitle || '(none)');
  console.log('prompt:', JSON.stringify(r.firstPrompt.slice(0, 110)));
  console.log('TAG   :', top[0], `(score ${top[1]}, ${[...r.why.get(top[0])].join('+')})`, close ? `  <-- AMBIGUOUS vs ${second[0]}(${second[1]})` : '');
  console.log('runners-up:', r.ranked.slice(1, 4).map(([t, n]) => `${t}:${n}`).join(', ') || '-');
}

console.log('\n===== SUMMARY over', total, 'transcripts =====');
console.log('produced a tag :', withTag);
console.log('ambiguous top-2:', ambiguous);
