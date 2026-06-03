#!/usr/bin/env node
// Reinstall the Playwright browser binaries this project needs.
//
// Use this after the Playwright browser cache (~/AppData/Local/ms-playwright on
// Windows, ~/.cache/ms-playwright on Linux) was cleared, or on a fresh checkout.
// It installs Chromium pinned to the project's @playwright/test version, so the
// binary matches what playwright.config.ts expects.
//
//   node scripts/install-browsers.js
//   node scripts/install-browsers.js --all   # install every browser, not just Chromium

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const cli = path.join(__dirname, '..', 'node_modules', '@playwright', 'test', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error('Playwright CLI not found at', cli);
  console.error('Run `yarn install` first, then re-run this script.');
  process.exit(1);
}

// The e2e suite only launches Chromium (see playwright.config.ts). Pass --all to
// grab Firefox/WebKit too if you ever need them.
const all = process.argv.includes('--all');
const args = [cli, 'install', ...(all ? [] : ['chromium'])];

console.log(`Installing Playwright browser(s): ${all ? 'all' : 'chromium'} ...`);
const res = spawnSync(process.execPath, args, { stdio: 'inherit' });

if (res.error) {
  console.error('Failed to launch Playwright install:', res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 1);
