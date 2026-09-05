// Renders real transcripts through the OLD (git HEAD) and NEW (working tree) regexes and
// reports every link the widening added or removed, so the change is audited against
// prose people actually wrote rather than against invented bait. The last widening of
// these branches passed a 17-case corpus and then produced `/api/probes/` links on the
// first real session it saw.
//
// Run: node !notes/tasks/at-in-filename-truncates-link/scripts/audit-transcript.js [sessionOrDir...]
// With no argument it scans the reported session.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '../../../..');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const REPORTED = path.join(PROJECTS, 'd---Projects-GMTrade', '6cbf4cbd-afda-4e43-8d32-44af9de707d1.jsonl');

// Two shapes to support. A single-line literal (the HEAD form) is eval'd directly. The
// working tree later composed these regexes from named parts - they ran past ~500 inline
// characters once Unicode classes and the spaced/lazy final segment went in - so a
// `new RegExp(...)` is eval'd together with the PATH_*/WIN_* constants it is built from,
// collected in source order beforehand.
// `partsSrc` is where the PATH_*/WIN_* building blocks are declared, which is not always
// the file holding the regex: WIN_PATH_RE lives in markdown.tsx but imports its parts from
// filePath.tsx, deliberately, so the two patterns cannot drift out of step.
function pickRegex(src, name, partsSrc = src) {
  const lines = src.split('\n');
  const literal = lines.find(l => new RegExp(`^(export )?const ${name} = /`).test(l.trim()));
  if (literal) return eval(`(${literal.slice(literal.indexOf('/'), literal.lastIndexOf(';'))})`);

  const parts = [];
  for (const l of partsSrc.split('\n')) {
    const t = l.trim();
    if (/^(?:export )?const (?:PATH_|WIN_)\w+ = ['`]/.test(t)) parts.push(t.replace(/^export /, ''));
  }
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (new RegExp(`^(?:export )?const ${name} = new RegExp\\($`).test(t)) {
      const body = [];
      for (let j = i + 1; j < lines.length && lines[j].trim() !== ');'; j++) body.push(lines[j]);
      return eval(`${parts.join('\n')}\nnew RegExp(\n${body.join('\n')}\n)`);
    }
  }
  throw new Error(`${name} not found`);
}
const readNew = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const readOld = f => execFileSync('git', ['show', `HEAD:${f}`], { cwd: ROOT, encoding: 'utf8' });

const build = read => {
  const pathSrc = read('webview/src/utils/filePath.tsx');
  return {
    file: pickRegex(pathSrc, 'FILE_PATH_RE'),
    win: pickRegex(read('webview/src/utils/markdown.tsx'), 'WIN_PATH_RE', pathSrc),
    url: pickRegex(read('webview/src/utils/url.ts'), 'URL_RE'),
  };
};
const OLD = build(readOld);
const NEW = build(readNew);

// linkifyPaths matches URLs first and only scans the spans between them.
function links(text, re) {
  const out = [];
  let last = 0;
  re.url.lastIndex = 0;
  let u;
  const scan = s => {
    re.file.lastIndex = 0;
    let m;
    while ((m = re.file.exec(s)) !== null) out.push(m[0]);
  };
  while ((u = re.url.exec(text)) !== null) {
    scan(text.slice(last, u.index));
    last = u.index + u[0].length;
  }
  scan(text.slice(last));
  return out;
}

// Prose reaches the linkifier through the escape pass and the markdown parser; a code
// span reaches it verbatim. Both are scanned, since a path shows up in either.
const escapeWin = (t, re) => t.replace(re.win, m => m.replace(/\\/g, '\\\\'));
const unescape = t => t.replace(/\\(.)/g, '$1');
const rendered = (t, re) => unescape(escapeWin(t, re));

function texts(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const content = rec?.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }]
      : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (typeof b?.text === 'string') out.push(b.text);
      if (typeof b?.thinking === 'string') out.push(b.thinking);
      if (b?.type === 'tool_result') {
        const c = b.content;
        if (typeof c === 'string') out.push(c);
        else if (Array.isArray(c)) for (const p of c) if (typeof p?.text === 'string') out.push(p.text);
      }
    }
  }
  return out;
}

const args = process.argv.slice(2);
const files = (args.length ? args : [REPORTED]).flatMap(a => {
  const p = path.resolve(a);
  return fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).filter(f => f.endsWith('.jsonl')).map(f => path.join(p, f))
    : [p];
});

const added = new Map();
const removed = new Map();
let blocks = 0;
for (const f of files) {
  for (const raw of texts(f)) {
    blocks++;
    for (const [label, text] of [['code', raw], ['prose', null]]) {
      const t = label === 'code' ? raw : rendered(raw, NEW);
      const oldT = label === 'code' ? raw : rendered(raw, OLD);
      const a = links(t, NEW);
      const b = links(oldT, OLD);
      const bag = new Map();
      for (const x of b) bag.set(x, (bag.get(x) || 0) + 1);
      for (const x of a) {
        if (bag.get(x)) bag.set(x, bag.get(x) - 1);
        else added.set(x, (added.get(x) || 0) + 1);
      }
      for (const [x, n] of bag) if (n > 0) removed.set(x, (removed.get(x) || 0) + n);
    }
  }
}

console.log(`scanned ${files.length} transcript(s), ${blocks} content blocks\n`);
const show = (title, map) => {
  console.log(`${title}: ${map.size} distinct`);
  for (const [x, n] of [...map].sort((p, q) => q[1] - p[1])) {
    const exists = /^([A-Za-z]:[\\\/]|\/)/.test(x) && fs.existsSync(x);
    console.log(`  ${String(n).padStart(4)}x  ${JSON.stringify(x)}${exists ? '   [exists]' : ''}`);
  }
  console.log();
};
show('ADDED links (audit every one)', added);
show('REMOVED links', removed);
