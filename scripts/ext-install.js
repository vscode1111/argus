const { execSync } = require('child_process');
const { mkdirSync, rmSync, statSync } = require('fs');
const { version } = require('../package.json');

try {
  const st = statSync('dist');
  if (!st.isDirectory()) rmSync('dist');
} catch {}
mkdirSync('dist', { recursive: true });
execSync('npx vsce package --allow-missing-repository -o dist/', { input: 'y\n', stdio: ['pipe', 'inherit', 'inherit'] });
execSync(`code.cmd --install-extension dist/argus-${version}.vsix`, { stdio: 'inherit' });
