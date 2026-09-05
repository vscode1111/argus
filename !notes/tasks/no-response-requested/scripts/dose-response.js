// Dose-response: does the chance of the model emitting "No response requested." itself
// rise with the number of CLI placeholders already sitting in that session's context?
// Also prints the user message that preceded each real emission.
const fs = require('fs');
const path = require('path');

const PHRASE = 'No response requested.';
const root = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects');

const files = [];
for (const dir of fs.readdirSync(root)) {
  const full = path.join(root, dir);
  let st; try { st = fs.statSync(full); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(full)) if (f.endsWith('.jsonl')) files.push(path.join(full, f));
}

const short = (s, n = 200) => { s = String(s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + `…(${s.length})` : s; };
const buckets = new Map(); // synthCount -> {sessions, withReal}
const reals = [];

for (const file of files) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (!raw.includes(PHRASE)) continue;
  const lines = raw.split('\n');
  let synth = 0; const realHits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(PHRASE)) continue;
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type !== 'assistant') continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c) || c.length !== 1 || c[0].type !== 'text' || c[0].text.trim() !== PHRASE) continue;
    if (o.message.model === '<synthetic>') synth++;
    else realHits.push({ line: i + 1, ts: o.timestamp, priorSynth: synth });
  }
  const key = Math.min(synth, 10);
  if (!buckets.has(key)) buckets.set(key, { sessions: 0, withReal: 0 });
  const b = buckets.get(key); b.sessions++; if (realHits.length) b.withReal++;

  for (const h of realHits) {
    // walk back for the last real user text
    let prev = null;
    for (let j = h.line - 2; j >= 0 && !prev; j--) {
      let p; try { p = JSON.parse(lines[j]); } catch { continue; }
      if (p.type !== 'user' || p.isMeta) continue;
      const c = p.message && p.message.content;
      const txt = Array.isArray(c) ? c.filter(b2 => b2.type === 'text').map(b2 => b2.text).join(' ') : (typeof c === 'string' ? c : '');
      if (txt) prev = txt;
    }
    reals.push({ file: path.basename(file), line: h.line, ts: h.ts, priorSynth: h.priorSynth, prompt: short(prev || '(none)') });
  }
}

console.log('placeholders in session -> sessions / of which produced a real model emission');
for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
  const b = buckets.get(k);
  console.log(`  ${k === 10 ? '10+' : k}\t${b.sessions}\t${b.withReal}\t${(100 * b.withReal / b.sessions).toFixed(1)}%`);
}
console.log('\nreal model emissions:');
for (const r of reals) console.log(`  ${r.file}:${r.line} ${r.ts} priorPlaceholders=${r.priorSynth}\n     user said: ${r.prompt}`);
