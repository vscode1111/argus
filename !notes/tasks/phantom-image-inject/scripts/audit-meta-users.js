// Population check: across every CLI transcript on this machine, what do user-role records
// tagged isMeta / isVisibleInTranscriptOnly actually contain? If the flag only ever marks
// CLI bookkeeping, hiding those bubbles is safe; if it ever marks something a human said,
// the whole fix is wrong.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const root = path.join(os.homedir(), '.claude', 'projects');
const buckets = new Map();
const samples = new Map();
let files = 0, lines = 0, metaCount = 0, plainUser = 0;

const bucketOf = (text) => {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (/^\[Image: /.test(t)) return '[Image: ...]';
  if (/^\[Image source: /.test(t)) return '[Image source: ...]';
  if (/^<command-name>|^<local-command-stdout>|^<command-message>/.test(t)) return '<command-*>';
  if (/^Caveat: The messages below/.test(t)) return 'Caveat: ...';
  if (/^\[Request interrupted/.test(t)) return '[Request interrupted...]';
  if (/^<system-reminder>/.test(t)) return '<system-reminder>';
  return `OTHER: ${t.slice(0, 70)}`;
};

async function scanFile(f) {
  const rl = readline.createInterface({ input: fs.createReadStream(f, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    if (!line.includes('"type":"user"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const meta = o.isMeta === true || o.isVisibleInTranscriptOnly === true;
    if (!meta) { plainUser++; continue; }
    metaCount++;
    const c = o.message?.content;
    const texts = typeof c === 'string' ? [c]
      : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text)
      : [];
    const kinds = Array.isArray(c) ? [...new Set(c.map((b) => b?.type))].join('+') : typeof c;
    for (const t of texts.length ? texts : ['<no text block>']) {
      const k = `${kinds} :: ${bucketOf(t)}`;
      buckets.set(k, (buckets.get(k) || 0) + 1);
      if (!samples.has(k)) samples.set(k, String(t).replace(/\s+/g, ' ').slice(0, 160));
    }
  }
}

(async () => {
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let entries = [];
    try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of entries) { files++; await scanFile(path.join(dir, f)); }
  }
  console.log(`files=${files} lines=${lines} plainUserRecords=${plainUser} metaUserRecords=${metaCount}\n`);
  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, n] of sorted) console.log(`${String(n).padStart(6)}  ${k}\n         e.g. ${samples.get(k)}`);
})();
