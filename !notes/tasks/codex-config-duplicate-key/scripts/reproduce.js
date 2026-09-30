const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const binRoot = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
const codexExe = fs.readdirSync(binRoot).map(folder => path.join(binRoot, folder, 'codex.exe'))
  .find(candidate => fs.existsSync(candidate));
assert.ok(codexExe, 'installed Codex executable was not found');

const run = spawnSync(codexExe, ['features', 'list'], { encoding: 'utf8', timeout: 10000 });
const errorLine = run.stderr.split(/\r?\n/).find(line => /duplicate key|failed to load bootstrap configuration/.test(line));
console.log(JSON.stringify({ exitCode: run.status, errorLine: errorLine?.trim() || null }));
assert.equal(run.status, 0, 'Codex must load its configuration');
