#!/usr/bin/env node
// Detects the default Claude CLI model by running a minimal turn and reading
// the `model` field from the assistant event. Writes the result to argus.json
// as `runtimeDefaultModel` so the Argus model picker can annotate the
// "Default (CLI)" entry with the real model name.
//
// Usage: node scripts/detect-default-model.js  (or: yarn detect-model)
//
// Requires: claude CLI installed and logged in.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = process.env.ARGUS_CONFIG || path.join(os.homedir(), '.claude', 'argus.json');

function resolveClaude() {
  if (process.platform !== 'win32') return 'claude';
  try {
    const out = execFileSync('where', ['claude.cmd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const hit = out.split(/\r?\n/).map(l => l.trim()).find(Boolean);
    if (hit && fs.existsSync(hit)) return hit;
  } catch {}
  const nvmHome = process.env.NVM_HOME;
  if (nvmHome) {
    try {
      const versions = fs.readdirSync(nvmHome).filter(d => /^v\d/.test(d)).sort().reverse();
      for (const v of versions) {
        const c = path.join(nvmHome, v, 'claude.cmd');
        if (fs.existsSync(c)) return c;
      }
    } catch {}
  }
  return 'claude';
}

function detectModel() {
  return new Promise((resolve, reject) => {
    const bin = resolveClaude();
    // Pass the prompt as a CLI argument - no stdin piping needed.
    const args = ['--print', '--output-format', 'stream-json', '--verbose', 'say: ok'];
    console.log('Running:', bin, args.join(' '));

    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    let model = null;
    let buf = '';
    let stderr = '';

    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant' && ev.message?.model) {
            model = ev.message.model;
            console.log('Found model in assistant event:', model);
          }
        } catch {}
      }
    });

    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0 && !model) {
        console.error('CLI exited with code', code);
        if (stderr) console.error('stderr:', stderr.slice(0, 500));
      }
      resolve(model);
    });
  });
}

async function main() {
  console.log('Detecting default Claude model...');

  let model;
  try {
    model = await detectModel();
  } catch (err) {
    console.error('Failed to run claude CLI:', err.message);
    process.exit(1);
  }

  if (!model) {
    console.error('Could not detect default model. Is claude CLI installed and logged in?');
    process.exit(1);
  }

  console.log('Detected:', model);

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {}

  config.runtimeDefaultModel = model;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log('Saved to', CONFIG_PATH);
}

main().catch(err => { console.error(err); process.exit(1); });
