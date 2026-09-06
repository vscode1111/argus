// Two questions the bucket audit raised:
//  1) meta user records that ALSO carry an image/document block - would hiding the whole
//     record throw away something the human actually pasted?
//  2) CLI-authored user text that is NOT flagged meta - i.e. phantom bubbles this fix
//     would still leave on screen.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const root = path.join(os.homedir(), '.claude', 'projects');
const mixed = [];
const unflagged = new Map();
const unflaggedSample = new Map();

const CLI_AUTHORED = [
  /^\[Image: /, /^\[Image source: /, /^\[Request interrupted/, /^<local-command-caveat>/,
  /^<command-name>/, /^<local-command-stdout>/, /^Caveat: The messages below/,
  /^\[Your previous response had no visible output/, /^Base directory for this skill:/,
  /^This session is being continued from a previous conversation/,
  /^Continue from where you left off\.$/,
];

async function scanFile(f) {
  const rl = readline.createInterface({ input: fs.createReadStream(f, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"user"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const meta = o.isMeta === true || o.isVisibleInTranscriptOnly === true;
    const c = o.message?.content;
    const blocks = Array.isArray(c) ? c : [];
    const kinds = new Set(blocks.map((b) => b?.type));

    if (meta && (kinds.has('image') || kinds.has('document'))) {
      mixed.push({
        file: path.basename(f),
        kinds: [...kinds].join('+'),
        isMeta: o.isMeta, transcriptOnly: o.isVisibleInTranscriptOnly,
        text: blocks.filter((b) => b?.type === 'text').map((b) => String(b.text).replace(/\s+/g, ' ').slice(0, 110)),
      });
    }

    if (!meta) {
      const texts = typeof c === 'string' ? [c] : blocks.filter((b) => b?.type === 'text').map((b) => b.text);
      for (const t of texts) {
        const s = String(t).replace(/\s+/g, ' ').trim();
        const hit = CLI_AUTHORED.find((re) => re.test(s));
        if (!hit) continue;
        const k = String(hit);
        unflagged.set(k, (unflagged.get(k) || 0) + 1);
        if (!unflaggedSample.has(k)) unflaggedSample.set(k, `${path.basename(f)} :: ${s.slice(0, 120)}`);
      }
    }
  }
}

(async () => {
  for (const d of fs.readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    const dir = path.join(root, d.name);
    let entries = [];
    try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of entries) await scanFile(path.join(dir, f));
  }
  console.log(`== meta records carrying image/document: ${mixed.length}`);
  for (const m of mixed) console.log(JSON.stringify(m));
  console.log(`\n== CLI-authored text NOT flagged meta:`);
  for (const [k, n] of [...unflagged.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(5)}  ${k}\n       ${unflaggedSample.get(k)}`);
  }
})();
