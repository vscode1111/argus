// Screenshot the Settings > Info tab (both danger buttons) against a throwaway
// daemon on a private port, so the user's own daemon on :3017 is never touched.
// Usage: node "!notes/tasks/stop-daemon-button/scripts/screenshot-info-tab.js"
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PORT = 3922;
const file = path.join(os.tmpdir(), `argus-daemon-shot-${Date.now()}.json`);
const cfg = path.join(os.tmpdir(), `argus-cfg-shot-${Date.now()}.json`);
const out = path.join(__dirname, '..', 'info-tab.png');

(async () => {
  const proc = spawn(process.execPath, [path.join(ROOT, 'out', 'backend', 'daemon.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ARGUS_DAEMON_PORT: String(PORT),
      ARGUS_DAEMON_FILE: file,
      ARGUS_DAEMON_IDLE_MS: '600000',
      ARGUS_CONFIG: cfg,
      ARGUS_MODEL_REFRESH: '0',
    },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
    if (!fs.existsSync(file)) throw new Error('daemon did not start');

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('Ask Argus').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Info' }).click();
    await dialog.getByTestId('stop-daemon').waitFor();
    await page.waitForTimeout(400);
    await dialog.screenshot({ path: out });
    console.log('wrote', out);
    await browser.close();
  } finally {
    try { process.kill(proc.pid); } catch { /* gone */ }
    for (const f of [file, cfg]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
  }
})();
