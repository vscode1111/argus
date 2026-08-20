// Mock-only Playwright config: the root config minus the e2e/global-setup guard
// and minus the integration project. Escape hatch, not the normal path - see
// !notes/common/e2e-testing.md, "Running mock specs without stopping the user's
// dev server" for when it is safe and what it costs.
//
//   node node_modules/@playwright/test/cli.js test \
//     --config "!notes/common/scripts/playwright.mock-only.ts" \
//     e2e/code-copy-button.spec.ts
//
// Do NOT point this at *-integration.spec.ts: those really do write settings
// through the UI, which is exactly what the guard protects. The project filter
// below drops them, so an explicit path to one simply matches nothing.
//
// Mock specs are safe here only because none of them writes server settings -
// re-check that before relying on it, since "mock" still talks to a real backend:
//   grep -L integration e2e/*.spec.ts | xargs grep -l "updateSettings\|switchModel\|switchEffort\|switchThinking\|restartDaemon\|killAllClaude"
// (as of 2026-08-21 only kill-all-claude.spec.ts matches, and it deliberately
// never clicks the confirm step).
import { defineConfig } from '@playwright/test';
import * as path from 'path';
import base from '../../../playwright.config';

// Paths in a Playwright config resolve against the config file's own directory,
// so every inherited relative path has to be re-anchored at the repo root.
const repoRoot = path.resolve(__dirname, '..', '..', '..');

export default defineConfig({
  ...base,
  globalSetup: undefined,
  testDir: path.join(repoRoot, 'e2e'),
  outputDir: path.join(repoRoot, 'test-results'),
  // channel: 'chrome' runs the locally installed Google Chrome instead of the
  // bundled chromium build, so this also survives the revision drift described
  // in e2e-testing.md. Drop it once `node scripts/install-browsers-manual.js`
  // has restored the bundled browser.
  projects: (base.projects ?? [])
    .filter(p => p.name === 'mock')
    .map(p => ({ ...p, use: { ...p.use, channel: 'chrome' as const } })),
  webServer: { ...(base.webServer as object), cwd: repoRoot } as typeof base.webServer,
});
