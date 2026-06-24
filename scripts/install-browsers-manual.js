#!/usr/bin/env node
// Manually install the Playwright browser binaries on Windows, sidestepping the
// extraction deadlock that hangs `npx playwright install` on this machine.
//
// Background: the normal installer downloads each component zip fine (reaches
// 100%), then its bundled yauzl extractor deadlocks while unzipping - Windows
// Defender locks D3DCompiler_47.dll mid-write and the write-stream callback never
// returns. See .claude/researches/playwright-install-hang.md for the full analysis.
//
// This script does what the installer would, but extracts with PowerShell
// Expand-Archive (which does not deadlock): for each component it downloads the
// zip with curl, expands it into the component directory, verifies the executable
// landed, then writes the empty INSTALLATION_COMPLETE marker that makes Playwright
// treat the browser as already installed.
//
//   node scripts/install-browsers-manual.js          # chromium + its deps
//   node scripts/install-browsers-manual.js --all     # every browser
//   node scripts/install-browsers-manual.js --force    # re-extract even if present

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'win32') {
  console.error('This manual installer is Windows-only. On other platforms use `npx playwright install`.');
  process.exit(1);
}

let registry;
try {
  ({ registry } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core', 'lib', 'server', 'registry')));
} catch (err) {
  console.error('Could not load the Playwright registry. Run `yarn install` first.');
  console.error(err.message);
  process.exit(1);
}

const all = process.argv.includes('--all');
const force = process.argv.includes('--force');

// `install chromium` pulls these four components on Windows; `--all` installs
// whatever the registry lists.
const CHROMIUM_SET = new Set(['chromium', 'chromium-headless-shell', 'ffmpeg', 'winldd']);

const components = registry.executables().filter((e) => {
  if (!e.directory) return false;            // skip channel/system browsers (no managed dir)
  if (all) return true;
  return CHROMIUM_SET.has(e.name);
});

if (!components.length) {
  console.error('No installable components found in the registry.');
  process.exit(1);
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error };
}

function download(urls, dest) {
  for (const url of urls) {
    process.stdout.write(`    download ${url}\n`);
    const res = run('curl.exe', ['-L', '-f', '--retry', '3', '--retry-delay', '2', '-o', dest, url]);
    if (res.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
    process.stdout.write(`    (failed, trying next mirror)\n`);
  }
  return false;
}

function expand(zip, destDir) {
  // -Force overwrites; LiteralPath avoids glob interpretation of bracketed names.
  const res = run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destDir}' -Force`,
  ]);
  if (res.status !== 0) process.stdout.write(`    Expand-Archive: ${res.stderr.trim()}\n`);
  return res.status === 0;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-manual-'));
let installed = 0;
let failed = 0;

for (const e of components) {
  const dir = e.directory;
  const exe = e.executablePath();
  const marker = path.join(dir, 'INSTALLATION_COMPLETE');
  let urls = [];
  try { urls = e.downloadURLs || []; } catch {}

  console.log(`\n[${e.name}]`);
  if (!force && fs.existsSync(marker) && fs.existsSync(exe)) {
    console.log('    already installed, skipping');
    continue;
  }
  if (!urls.length) {
    console.log('    no download URL in registry, skipping');
    continue;
  }

  // A partial directory (no marker) is dangerous - Playwright may treat it as
  // present later. Clear it before a fresh extract.
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });

  const zip = path.join(tmp, `${e.name}.zip`);
  if (!download(urls, zip)) { console.log('    FAILED to download'); failed++; continue; }
  if (!expand(zip, dir)) { console.log('    FAILED to extract'); failed++; continue; }
  try { fs.rmSync(zip, { force: true }); } catch {}

  if (!fs.existsSync(exe)) {
    console.log(`    FAILED: executable missing after extract (${exe})`);
    failed++;
    continue;
  }
  fs.writeFileSync(marker, '');
  console.log(`    installed -> ${exe}`);
  installed++;
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\nDone. ${installed} installed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
