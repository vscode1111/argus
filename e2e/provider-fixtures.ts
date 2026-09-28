import { test as base } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export * from '@playwright/test';

// Windows can briefly deny a write while the backend reads the shared config.
// Retry only that filesystem operation, never the test or a provider request.
export async function writeTestConfig(file: string, content: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { fs.writeFileSync(file, content); return; }
    catch (error) {
      if (attempt >= 20 || !['EBUSY', 'EPERM', 'UNKNOWN'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

// Integration is serial: each case selects defaults before its first connection.
// Native-format tests explicitly opt into Claude; network access is a separate tag.
export const test = base.extend<{ providerDefaults: void }>({
  providerDefaults: [async ({}, use, info) => {
    if (info.project.name !== 'integration') { await use(); return; }
    base.skip(info.tags.includes('@claude-live') && process.env.ARGUS_TEST_CLAUDE !== '1',
      'Claude network access unavailable. Set ARGUS_TEST_CLAUDE=1 to include @claude-live.');
    const file = path.join(__dirname, 'argus.json');
    const original = fs.readFileSync(file, 'utf8');
    const config = JSON.parse(original);
    config.defaultProvider = info.tags.includes('@claude') ? 'claude'
      : info.tags.includes('@codex') ? 'codex' : (process.env.ARGUS_TEST_PROVIDER || 'codex');
    config.providerDefaults = {};
    await writeTestConfig(file, JSON.stringify(config, null, 2) + '\n');
    try { await use(); } finally { await writeTestConfig(file, original); }
  }, { auto: true }],
});
