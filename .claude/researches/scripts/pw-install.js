// Manual Playwright browser install for Windows, bypassing the yauzl extractor
// deadlock documented in ../playwright-install-hang.md (Defender locks DLLs
// mid-write). Downloads each component zip with curl, extracts with PowerShell
// Expand-Archive (which does not deadlock), verifies the exe, then writes the
// INSTALLATION_COMPLETE marker so Playwright treats the browser as installed.
//
// Component dirs/URLs are read live from the Playwright registry so nothing is
// hardcoded to a version. Run: node .claude/researches/scripts/pw-install.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const registry = require('../../../node_modules/playwright-core/lib/server/registry').registry;
const TEMP = process.env.TEMP || process.env.TMP || '.';

const components = ['chromium', 'chromium-headless-shell', 'ffmpeg', 'winldd'].map((name) => {
  const e = registry.findExecutable(name);
  return { name, dir: e.directory, exe: e.executablePath(), url: e.downloadURLs[e.downloadURLs.length - 1] };
});

function sh(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

for (const c of components) {
  const marker = path.join(c.dir, 'INSTALLATION_COMPLETE');
  if (fs.existsSync(marker) && fs.existsSync(c.exe)) {
    console.log(`[skip] ${c.name} already installed`);
    continue;
  }
  const zip = path.join(TEMP, `pw-${c.name}.zip`);
  console.log(`[download] ${c.name} <- ${c.url}`);
  sh('curl.exe', ['-L', '-f', '--retry', '3', '-o', zip, c.url]);
  console.log(`[extract] ${c.name} -> ${c.dir}`);
  fs.mkdirSync(c.dir, { recursive: true });
  sh('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${c.dir}' -Force`]);
  if (!fs.existsSync(c.exe)) {
    console.error(`[FAIL] ${c.name}: expected exe missing after extract: ${c.exe}`);
    process.exit(1);
  }
  fs.writeFileSync(marker, '');
  fs.rmSync(zip, { force: true });
  console.log(`[ok] ${c.name}`);
}
console.log('All components installed.');
