import * as fs from 'fs';
import * as path from 'path';

// Version of the build this server process is running from. Resolved from the
// package.json above the compiled output (out/backend -> repo root), so a daemon
// launched out of an installed extension folder reports that extension's version,
// not whatever is checked out elsewhere on the machine. The extension and the
// daemon are separate installs sharing one discovery file, so the webview needs
// this to tell whether it is talking to a server built from the same code.
export function readServerVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '';
  } catch {
    return '';
  }
}
