// Confirm the built webview bundle carries the URL cut-out (the daemon serves
// media/webview.js, not the Vite dev source).
// Run: node "!notes/tasks/url-linkified-as-path/scripts/check-bundle.js"

const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../../../../media/webview.js');
const js = fs.readFileSync(file, 'utf8');

// The minifier can re-escape a regex literal, so match on its distinctive character
// class rather than on the exact source text.
const SCHEME_CLASS = /\[a-z\]\[a-z0-9\+[\\.]*[\\.-]*\]\*/;
const near = js.indexOf('file-path-link');
const window = js.slice(Math.max(0, near - 3000), near + 500);
const found = window.match(/\/[^\n]{0,80}:\\?\/\\?\/[^\n]{0,40}\/[gimsuy]*/);

console.log('file:  ', file);
console.log('mtime: ', fs.statSync(file).mtime.toISOString());
console.log('scheme class present:', SCHEME_CLASS.test(js));
console.log('regex near the link renderer:', found ? found[0] : '(none)');
process.exit(SCHEME_CLASS.test(js) ? 0 : 1);
