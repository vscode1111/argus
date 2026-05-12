import { defineConfig } from '@playwright/test';
import * as path from 'path';

const e2eConfig = path.resolve(__dirname, 'e2e', 'argus.json');

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  outputDir: './test-results',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
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
