import * as path from 'path';

// Guard against a reused dev server that was started without ARGUS_CONFIG.
//
// playwright.config.ts sets `reuseExistingServer: true`, so a `yarn dev` the user
// already had running is adopted as the backend. If that process was launched from
// a plain shell it reads and WRITES the real ~/.claude/argus.json instead of
// e2e/argus.json: tests that change settings through the UI corrupt the user's
// config, and tests that depend on e2e/argus.json (showLogs, effort, allowedOrigins)
// fail against values they never set. That looks like several unrelated product
// bugs, so fail loudly here instead.
const E2E_CONFIG = path.resolve(__dirname, 'argus.json');
const HEALTH = 'http://localhost:3001/health';

export default async function globalSetup(): Promise<void> {
  // The server may not be up yet (Playwright starts webServer around globalSetup,
  // and the order is version-dependent). A server Playwright starts itself always
  // gets the right env, so "not reachable" is fine - only a live mismatch is fatal.
  let info: { configPath?: string; pid?: number } | undefined;
  try {
    const res = await fetch(HEALTH, { signal: AbortSignal.timeout(2000) });
    if (res.ok) info = await res.json();
  } catch {
    return;
  }
  if (!info?.configPath) return;

  // Windows reports the drive letter in either case (`d:\` vs `D:\`) depending on
  // how the process was launched, so compare case-insensitively there.
  const same = (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

  if (!same(path.resolve(info.configPath), E2E_CONFIG)) {
    throw new Error(
      `The dev server on :3001 (pid ${info.pid}) is using ${info.configPath}, not ${E2E_CONFIG}.\n` +
        'It was started without ARGUS_CONFIG, so the e2e run would read and overwrite your real settings.\n' +
        'Stop it (yarn dev:stop) and let Playwright start its own, or restart it with ARGUS_CONFIG set.',
    );
  }
}
