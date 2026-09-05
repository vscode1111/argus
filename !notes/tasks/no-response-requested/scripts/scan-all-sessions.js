// Scan every CLI transcript for assistant turns whose only text is "No response requested."
// and split them into CLI placeholders (model "<synthetic>") vs real model output.
// Falsification probe: does a real-model occurrence ever happen in a session with no
// synthetic precedent? If not, the model is imitating the placeholders in its own context.
const fs = require('fs');
const path = require('path');

const PHRASE = 'No response requested.';
const root = process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects');

const files = [];
for (const dir of fs.readdirSync(root)) {
  const full = path.join(root, dir);
  let st; try { st = fs.statSync(full); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(full)) {
    if (f.endsWith('.jsonl')) files.push(path.join(full, f));
  }
}

const rows = [];
let scanned = 0;
for (const file of files) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
  scanned++;
  if (!raw.includes(PHRASE)) continue;
  const lines = raw.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(PHRASE)) continue;
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type !== 'assistant') continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c) || c.length !== 1 || c[0].type !== 'text') continue;
    if (c[0].text.trim() !== PHRASE) continue;
    hits.push({
      line: i + 1,
      ts: o.timestamp,
      model: o.message.model,
      out: o.message.usage && o.message.usage.output_tokens,
      cr: o.message.usage && o.message.usage.cache_read_input_tokens,
      real: o.message.model !== '<synthetic>',
    });
  }
  if (hits.length) rows.push({ file, hits });
}

let totalSynth = 0, totalReal = 0;
const realWithPrecedent = [], realWithout = [];
for (const r of rows) {
  const synth = r.hits.filter(h => !h.real);
  const real = r.hits.filter(h => h.real);
  totalSynth += synth.length; totalReal += real.length;
  console.log(`\n${path.basename(path.dirname(r.file))}/${path.basename(r.file)}`);
  console.log(`  synthetic: ${synth.length}   real-model: ${real.length}`);
  for (const h of r.hits) {
    console.log(`   line ${String(h.line).padStart(5)}  ${h.ts}  ${h.real ? 'REAL ' : 'synth'}  model=${h.model}  out=${h.out}  ctx=${h.cr}`);
  }
  for (const h of real) {
    const priorSynth = synth.filter(s => s.line < h.line).length;
    (priorSynth > 0 ? realWithPrecedent : realWithout).push({ file: r.file, line: h.line, priorSynth });
  }
}

console.log(`\n===== summary =====`);
console.log(`transcripts scanned: ${scanned}, containing the phrase: ${rows.length}`);
console.log(`synthetic placeholders: ${totalSynth}`);
console.log(`real-model emissions:   ${totalReal}`);
console.log(`  with synthetic precedent earlier in the SAME session: ${realWithPrecedent.length}`);
console.log(`  with NO synthetic precedent (would falsify imitation): ${realWithout.length}`);
for (const r of realWithout) console.log(`    ${path.basename(r.file)}:${r.line}`);
for (const r of realWithPrecedent) console.log(`    precedent count ${r.priorSynth} before ${path.basename(r.file)}:${r.line}`);
