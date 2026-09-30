const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../../..');
const compile = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', './'], { cwd: root, stdio: 'inherit' });
if (compile.status !== 0) process.exit(compile.status || 1);

const result = spawnSync(process.execPath, ['--test', 'e2e/session-transcript-path.test.cjs'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ARGUS_BROWSER_CHECK: '1' },
});
process.exit(result.status ?? 1);
