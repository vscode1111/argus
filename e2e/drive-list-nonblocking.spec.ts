import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as path from 'path';

// Listing the drive roots ("This PC" in the Workspace History Browse tab) must not
// hold the server's event loop. A persistent network mapping whose server is
// unreachable makes the first access to its root try to reconnect - measured 6.8s
// for a disconnected \\server\share - and the old synchronous existsSync probe froze
// every client of the server for that long; the browse spec then timed out waiting
// for its own reply (!notes/tasks/fix-e2e-2026-11-23/notes.md).
//
// Driven on the compiled bundle in a child process, with `fs` patched there so one
// letter behaves like that hung mapping on both the sync and the async probe. The
// decisive assertion is that a timer keeps ticking while the listing runs; the
// control is a second fake letter that answers at once and must still be listed, so
// a build that simply returned no drives would fail.

const SESSIONS_JS = path.resolve(__dirname, '..', 'out', 'backend', 'sessions.js');

const PROBE = `
const fs = require('fs');
const BS = String.fromCharCode(92);
const HUNG = 'O:' + BS, FAKE = 'Y:' + BS, HANG_MS = 3000;
const exists = fs.existsSync, access = fs.promises.access;
fs.existsSync = p => {
  if (p === HUNG) { const end = Date.now() + HANG_MS; while (Date.now() < end); return false; }
  if (p === FAKE) return true;
  return exists(p);
};
fs.promises.access = (p, ...rest) => {
  if (p === HUNG) return new Promise((_, reject) => setTimeout(() => reject(new Error('EHOSTDOWN')), HANG_MS));
  if (p === FAKE) return Promise.resolve();
  return access(p, ...rest);
};
const { listDir } = require(process.argv[1]);
let ticks = 0; const timer = setInterval(() => ticks++, 10);
const start = Date.now();
Promise.resolve(listDir('')).then(listing => {
  clearInterval(timer);
  console.log(JSON.stringify({ ms: Date.now() - start, ticks, roots: listing.entries.map(e => e.path) }));
});
`;

test.describe('drive root listing', () => {
  test.skip(process.platform !== 'win32', 'drive letters exist only on Windows');

  test('a hung network drive neither blocks the event loop nor hides the other drives', () => {
    const out = execFileSync(process.execPath, ['-e', PROBE, SESSIONS_JS], { encoding: 'utf8', timeout: 20_000 });
    const result = JSON.parse(out.trim().split(/\r?\n/).pop()!) as { ms: number; ticks: number; roots: string[] };

    // The event loop kept running: a 10ms interval fired throughout the listing.
    // The blocking probe gives 0 ticks here, since the interval cannot fire until it returns.
    expect(result.ticks).toBeGreaterThan(30);
    // Answered at the probe deadline rather than waiting out the hung drive.
    expect(result.ms).toBeLessThan(2500);
    expect(result.roots).not.toContain('O:\\');
    // Control: responsive drives are still listed, the real system drive included.
    expect(result.roots).toContain('Y:\\');
    expect(result.roots).toContain('C:\\');
  });
});
