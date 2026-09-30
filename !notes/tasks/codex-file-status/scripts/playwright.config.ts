import { defineConfig } from '@playwright/test';
import * as path from 'path';

const root = path.resolve(__dirname, '../../../..');
export default defineConfig({
  testDir: path.join(root, 'e2e'),
  testMatch: /codex-file-(status|diff)\.spec\.ts$/,
  timeout: 30_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5182',
    browserName: 'chromium',
    launchOptions: { args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'] },
  },
  webServer: {
    command: `node ${path.join(__dirname, 'start-test-server.js')}`,
    url: 'http://localhost:5182',
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
