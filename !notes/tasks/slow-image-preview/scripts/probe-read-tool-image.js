// Reproduces the reported "image preview takes 3-5s" against the real transcript,
// and isolates where the time goes: raw file read, the split-into-lines regex, or
// the per-line scan/JSON.parse. Node only, no project code besides the compiled
// sessions.js this bug is about.
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SESSIONS_JS = path.join(ROOT, 'out', 'backend', 'sessions.js');
if (!fs.existsSync(SESSIONS_JS)) execSync('npx tsc -p ./', { cwd: ROOT, stdio: 'inherit' });
const { readToolImage, loadSession } = require(SESSIONS_JS);

const SESSION_ID = '8dbb366b-44d5-4b07-bae1-ba0ae03589d8';
const WORKSPACE_DIR = 'd:\\_Projects\\scub111g\\estate-agent';
const TOOL_USE_ID = 'toolu_018B4rQCgo2PsbhZQZMeATK4'; // the Read of avito-form2.png
const TRANSCRIPT = path.join(
  process.env.USERPROFILE || 'C:\\Users\\Admin',
  '.claude', 'projects', 'd---Projects-scub111g-estate-agent', SESSION_ID + '.jsonl',
);

function ms(start) { return Number(process.hrtime.bigint() - start) / 1e6; }

console.log('transcript:', TRANSCRIPT);
console.log('size:', (fs.statSync(TRANSCRIPT).size / (1024 * 1024)).toFixed(1), 'MB');

// 1) The actual function the "click to preview" click invokes server-side.
let t = process.hrtime.bigint();
const img = readToolImage(SESSION_ID, WORKSPACE_DIR, TOOL_USE_ID);
console.log('\nreadToolImage():', ms(t).toFixed(0), 'ms ->',
  img ? `found, ${img.mediaType}, ${(img.data.length / 1024).toFixed(0)} KB base64` : 'NOT FOUND');

// 2) Isolate the raw read + split cost alone (no JSON.parse, no matching), to show
//    the time is spent before the "cheap prefilter" ever runs.
t = process.hrtime.bigint();
const content = fs.readFileSync(TRANSCRIPT, 'utf8');
const readMs = ms(t);
t = process.hrtime.bigint();
const lines = content.split(/\r?\n/);
const splitMs = ms(t);
console.log('\nfs.readFileSync (utf8):', readMs.toFixed(0), 'ms');
console.log('content.split(/\\r?\\n/):', splitMs.toFixed(0), 'ms,', lines.length, 'lines');

// 3) Where the matching line actually sits, so we know whether an early-exit
//    streaming read would help a lot or a little for this specific case.
const idx = lines.findIndex(l => l.includes(TOOL_USE_ID));
console.log('\nmatching line is line', idx, 'of', lines.length,
  `(${((idx / lines.length) * 100).toFixed(1)}% through the file)`);

// 4) loadSession (the whole-transcript replay on open) for context - same pattern,
//    different call site, not what the user complained about here but worth knowing.
t = process.hrtime.bigint();
const msgs = loadSession(SESSION_ID, WORKSPACE_DIR);
console.log('\nloadSession():', ms(t).toFixed(0), 'ms ->', msgs.length, 'messages');
