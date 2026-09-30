import { defineConfig } from '@playwright/test';
import * as path from 'path';

const root = path.resolve(__dirname, '../../../..');
process.env.ARGUS_CONFIG = path.join(root, 'e2e', 'argus.json');
process.env.ARGUS_AUTH_FILE = path.join(root, 'e2e', 'argus-auth.e2e.json');
export default defineConfig({ testDir: path.join(root, 'e2e'), workers: 1, retries: 0, timeout: 10000,
  projects: [{ name: 'mock', testMatch: /\.spec\.ts$/, testIgnore: /-integration\.spec/ }],
  use: { baseURL: 'http://localhost:5173' } });
