import { defineConfig } from '@playwright/test';
import * as path from 'path';

const e2eConfig = path.resolve(__dirname, 'e2e', 'argus.json');

// Propagate ARGUS_CONFIG to test worker processes. Workers inherit this from the
// main process, so integration tests that read/write the config file use the same
// path the dev server uses. Without this, file-poll assertions fail when the server
// was started by Playwright (which sets the env only for the webServer command, not
// for test workers).
process.env['ARGUS_CONFIG'] = e2eConfig;

const chromiumOptions = {
  browserName: 'chromium' as const,
  launchOptions: {
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
  },
};

export default defineConfig({
  testDir: './e2e',
  // One global per-test timeout for every project, mock and integration alike.
  // A real CLI turn in these tests takes a few seconds, so 30s is a generous cap
  // that still fails a hang fast instead of burning 90s on it.
  timeout: 30_000,
  globalSetup: require.resolve('./e2e/global-setup'),
  outputDir: './test-results',
  fullyParallel: true,
  workers: 4,
  retries: 1,
  projects: [
    {
      name: 'mock',
      testIgnore: /-integration\.spec/,
      use: chromiumOptions,
    },
    {
      // Integration tests inherit the global 30s timeout (no per-project and no
      // per-test overrides). Retries off so a hang isn't paid twice.
      name: 'integration',
      testMatch: /-integration\.spec/,
      use: chromiumOptions,
      dependencies: ['mock'],
      retries: 0,
      // Each integration test drives a real Claude CLI plus a Chromium instance against
      // the one shared :3001 backend. At the global 4 workers that exhausts memory/CPU:
      // the backend stops responding mid-run and every later test sees a mounted page
      // with no data, so one overload cascades into dozens of unrelated failures.
      workers: 1,
    },
  ],
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'yarn dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 15_000,
    // ARGUS_USAGE_POLL=0: the dev server runs the usage poller like the daemon, and a
    // suite that reconnects hundreds of times would keep calling the live usage API on
    // a timer - which is what rate-limits the account (HTTP 429) and then makes the
    // API-dependent specs skip.
    env: { ARGUS_CONFIG: e2eConfig, ARGUS_USAGE_POLL: '0' },
  },
});
