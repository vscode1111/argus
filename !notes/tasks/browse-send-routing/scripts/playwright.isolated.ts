import { defineConfig } from '@playwright/test';

// Ad-hoc runner for verifying browse-send-routing-integration.spec.ts against a
// throwaway backend on a private port, so the shared :3001 dev server (and whatever
// panels are connected to it) is left alone.
//
// Deliberately omits the root config's globalSetup: that guard exists to catch a
// reused :3001 running the wrong config, and this run does not touch :3001 at all.
// There is no webServer either - start the backend yourself first:
//
//   ARGUS_CONFIG=<repo>/e2e/argus.json ARGUS_SERVER_PORT=3099 npx tsx server/index.ts
//   ARGUS_E2E_PORT=3099 npx playwright test \
//     --config "!notes/tasks/browse-send-routing/scripts/playwright.isolated.ts"
//
// Relative paths resolve against this file's directory, hence the ../../../.. hops.
export default defineConfig({
  testDir: '../../../../e2e',
  outputDir: '../../../../test-results',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  // baseURL is only used by the browser-driven specs. Those cannot be redirected to a
  // private port (the dev shim in webview/index.html hardcodes :3001), so running one
  // here means running it against whatever dev stack is already up - acceptable only for
  // a spec that asserts nothing about model/effort/settings, since the config may be the
  // user's real ~/.claude/argus.json rather than e2e/argus.json.
  use: { channel: 'chrome', baseURL: 'http://localhost:5173' },
});
