import { defineConfig } from '@playwright/test';
import * as path from 'path';

const root = path.resolve(__dirname, '../../../..');
export default defineConfig({
  testDir: path.join(root, 'e2e'),
  timeout: 30_000,
  workers: 1,
  projects: [{ name: 'mock', use: { browserName: 'chromium', baseURL: 'http://localhost:5181', launchOptions: { args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'] } } }],
  webServer: { command: `node ${path.join(__dirname, 'start-test-server.js')}`,
    url: 'http://localhost:5181', reuseExistingServer: false, timeout: 15_000 },
});
