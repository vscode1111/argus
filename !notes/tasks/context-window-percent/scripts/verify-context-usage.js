// Verifies the contextUsage WS frame end-to-end against a real Claude CLI turn.
//
//   node !notes/tasks/context-window-percent/scripts/verify-context-usage.js [model]
//
// Spins up its own server on a private port with a throwaway copy of argus.json
// (so the running daemon and the user's real config are untouched), runs one turn
// in a temp cwd, and prints every contextUsage frame with the resolved window.
// Needs `yarn compile` first.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL = process.argv[2] || 'claude-opus-5';
const PORT = 3099;

const realConfig = path.join(os.homedir(), '.claude', 'argus.json');
const tmpConfig = path.join(os.tmpdir(), `argus-verify-${process.pid}.json`);
fs.writeFileSync(tmpConfig, JSON.stringify({ ...JSON.parse(fs.readFileSync(realConfig, 'utf-8')), model: MODEL }, null, 2));
process.env.ARGUS_CONFIG = tmpConfig;

const repo = path.resolve(__dirname, '../../../..');
const { startServer } = require(path.join(repo, 'out/backend/index.js'));
const { contextWindowFor } = require(path.join(repo, 'out/backend/modelData.js'));
const WebSocket = require(path.join(repo, 'node_modules/ws'));

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ctx-'));

function cleanup() {
  for (const f of [tmpConfig]) { try { fs.unlinkSync(f); } catch {} }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

async function main() {
  console.log(`model: ${MODEL}`);
  console.log(`window from cache: ${contextWindowFor(MODEL).toLocaleString()}`);

  const server = await startServer({ port: PORT, model: MODEL });
  const ws = new WebSocket(`ws://localhost:${PORT}/agent?nonce=${server.nonce}&dir=${encodeURIComponent(cwd)}`);
  const frames = [];

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out after 120s')), 120_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'send', text: 'say ok' })));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'contextUsage') frames.push(msg);
      if (msg.type === 'done') { clearTimeout(timer); resolve(); }
      if (msg.type === 'error') console.log('error frame:', msg.text);
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  console.log(`\ncontextUsage frames: ${frames.length}`);
  for (const f of frames) {
    const expected = Math.min(100, Math.round(f.inputTokens / f.contextWindow * 100));
    console.log(
      `  ${f.percent}%  input=${f.inputTokens.toLocaleString()}  output=${f.outputTokens.toLocaleString()}  ` +
      `window=${(f.contextWindow ?? 0).toLocaleString()}  ${f.percent === expected ? 'OK' : `MISMATCH (expected ${expected}%)`}`
    );
  }

  ws.close();
  await server.close();
}

main().then(() => { cleanup(); process.exit(0); }).catch((e) => { console.error('FAILED:', e.message); cleanup(); process.exit(1); });
