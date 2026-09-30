const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '../../../..');
const result = spawnSync(process.execPath, [
  path.join(root, 'node_modules/@playwright/test/cli.js'), 'test',
  '--config', path.join(__dirname, 'playwright.config.ts'),
], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
