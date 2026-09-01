// Probe: can a task short name be detected from a real CLI transcript?
//
// Scans the most recent transcripts under ~/.claude/projects and, for each,
// reports what each candidate detector would produce, so the false-positive
// rate of the cheap prose regex can be measured against the evidence-based
// detectors (notes path / tracker URL / branch) rather than guessed at.
//
// Usage: node probe-titles.js [limit]

const fs = require('fs');
const os = require('os');
const path = require('path');

const LIMIT = Number(process.argv[2] || 60);
const ROOT = path.join(os.homedir(), '.claude', 'projects');

// Candidate A: bare ticket id in prose. Prefix is letters only (2-10) so that
// UTF-8 / SHA-256 / GPT-4 style tokens do not match; digits-in-prefix ids are
// rare enough to lose.
const TICKET_RE = /\b([A-Z][A-Z]{1,9})-(\d{1,6})\b/g;
const TICKET_STOP = new Set(['UTF', 'ISO', 'SHA', 'MD', 'RFC', 'AES', 'RGB', 'RGBA', 'SSE', 'IPV', 'HTTP', 'HTTPS', 'TLS', 'SQL', 'API', 'UUID', 'JSON', 'CSS', 'HTML', 'PNG', 'JPEG', 'GPT', 'CI', 'CD', 'PR', 'MR']);

// Candidate B: a !notes task folder touched by any tool call.
const NOTES_RE = /!notes[\/\\]tasks[\/\\]([A-Za-z0-9._-]+)/g;

// Candidate C: a tracker URL.
const TRACKER_RE = /https?:\/\/[^\s"')]*?(?:youtrack[^\s"')]*\/issue\/([A-Z][A-Z0-9]*-\d+)|linear\.app\/[^\s"')]*\/issue\/([A-Z][A-Z0-9]*-\d+)|atlassian\.net\/browse\/([A-Z][A-Z0-9]*-\d+))/g;

// Candidate D: a git branch carrying an id.
const BRANCH_RE = /(?:checkout -b|switch -c|branch)\s+['"]?([A-Za-z0-9._\/-]+)/g;

function collect(re, text, pick = m => m[1]) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const v = pick(m);
    if (v) out.push(v);
  }
  return out;
}

function tickets(text) {
  return collect(TICKET_RE, text, m => (TICKET_STOP.has(m[1]) ? null : `${m[1]}-${m[2]}`));
}

function walkText(content, sink) {
  if (typeof content === 'string') { sink(content); return; }
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') sink(b.text);
    else if (b.type === 'tool_use' && b.input) sink(JSON.stringify(b.input));
    else if (b.type === 'tool_result') walkText(b.content, sink);
  }
}

function readOne(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const r = {
    aiTitle: '', customTitle: '', firstPrompt: '',
    promptTickets: [], anyTickets: [], notes: [], trackers: [], branches: [],
  };
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') r.customTitle = o.customTitle;
    else if (o.type === 'ai-title' && typeof o.aiTitle === 'string') r.aiTitle = o.aiTitle;
    else if ((o.type === 'user' || o.type === 'assistant') && o.message) {
      const isUser = o.type === 'user';
      walkText(o.message.content, text => {
        if (isUser && !r.firstPrompt && !text.startsWith('<') && text.trim()) {
          r.firstPrompt = text.slice(0, 400);
          r.promptTickets = tickets(r.firstPrompt);
        }
        r.anyTickets.push(...tickets(text));
        r.notes.push(...collect(NOTES_RE, text));
        r.trackers.push(...collect(TRACKER_RE, text, m => m[1] || m[2] || m[3]));
        r.branches.push(...collect(BRANCH_RE, text));
      });
    }
  }
  const uniq = a => [...new Set(a)];
  r.anyTickets = uniq(r.anyTickets);
  r.notes = uniq(r.notes);
  r.trackers = uniq(r.trackers);
  r.branches = uniq(r.branches).filter(b => /\d/.test(b)).slice(0, 3);
  return r;
}

const files = [];
for (const proj of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, proj);
  let st;
  try { st = fs.statSync(dir); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    try {
      const s = fs.statSync(full);
      if (s.size > 0) files.push({ full, proj, mtime: s.mtimeMs, size: s.size });
    } catch { /* ignore */ }
  }
}
files.sort((a, b) => b.mtime - a.mtime);

const picked = files.slice(0, LIMIT);
let hasAi = 0, hasCustom = 0, hitPrompt = 0, hitAny = 0, hitNotes = 0, hitTracker = 0, hitAnyDetector = 0;

for (const f of picked) {
  const r = readOne(f.full);
  if (!r) continue;
  if (r.aiTitle) hasAi++;
  if (r.customTitle) hasCustom++;
  if (r.promptTickets.length) hitPrompt++;
  if (r.anyTickets.length) hitAny++;
  if (r.notes.length) hitNotes++;
  if (r.trackers.length) hitTracker++;
  const any = r.promptTickets.length || r.notes.length || r.trackers.length;
  if (any) hitAnyDetector++;
  console.log('---');
  console.log('proj    :', f.proj);
  console.log('ai-title:', r.aiTitle || '(none)');
  if (r.customTitle) console.log('custom  :', r.customTitle);
  console.log('prompt  :', JSON.stringify(r.firstPrompt.slice(0, 150)));
  console.log('  ticket(prompt):', r.promptTickets.join(', ') || '-');
  console.log('  ticket(any)   :', r.anyTickets.slice(0, 6).join(', ') || '-');
  console.log('  notes task    :', r.notes.slice(0, 4).join(', ') || '-');
  console.log('  tracker url   :', r.trackers.slice(0, 4).join(', ') || '-');
  console.log('  branch        :', r.branches.join(', ') || '-');
}

console.log('\n===== SUMMARY over', picked.length, 'transcripts =====');
console.log('with ai-title        :', hasAi);
console.log('with custom-title    :', hasCustom);
console.log('ticket in 1st prompt :', hitPrompt);
console.log('ticket anywhere      :', hitAny);
console.log('!notes/tasks touched :', hitNotes);
console.log('tracker url          :', hitTracker);
console.log('ANY detector fired   :', hitAnyDetector);
