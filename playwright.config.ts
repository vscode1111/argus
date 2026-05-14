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
  timeout: 60_000,
  outputDir: './test-results',
  fullyParallel: true,
  workers: 4,
  retries: 1,
  projects: [
    {
      name: 'mock',
      testMatch: /background-tasks|retry-clean|retry-indicator|file-path-links/,
      use: chromiumOptions,
    },
    {
      name: 'integration',
      testMatch: /chat|ask-dialog|image-recognize/,
      use: chromiumOptions,
      dependencies: ['mock'],
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
