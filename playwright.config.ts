import { defineConfig } from '@playwright/test';
import * as path from 'path';

const e2eConfig = path.resolve(__dirname, 'e2e', 'argus.json');

const chromiumOptions = {
  browserName: 'chromium' as const,
  launchOptions: {
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
  },
};

export default defineConfig({
  testDir: './e2e',
  // Tiered timeouts: mock tests are fast and never touch the real CLI, so a
  // short global timeout makes them fail fast. Integration tests drive the real
  // Claude CLI and get a single, bounded per-project override below.
  timeout: 30_000,
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
      // One bounded timeout for every integration test (no per-test overrides).
      // 90s comfortably covers real multi-turn CLI runs while capping a hang at
      // 90s instead of the old 2x120s; retries off so a hang isn't paid twice.
      name: 'integration',
      testMatch: /-integration\.spec/,
      use: chromiumOptions,
      dependencies: ['mock'],
      timeout: 90_000,
      retries: 0,
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
    env: { ARGUS_CONFIG: e2eConfig },
  },
});
