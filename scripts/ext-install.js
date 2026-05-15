const { execSync } = require('child_process');
const { version } = require('../package.json');

execSync('npx vsce package --allow-missing-repository -o dist/', { stdio: 'inherit' });
execSync(`code.cmd --install-extension dist/argus-${version}.vsix`, { stdio: 'inherit' });
