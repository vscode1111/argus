// Session titles for transcripts without an `ai-title`. The CLI Argus spawns (`sdk-cli`)
// never writes one, so the fallback is what the header shows for nearly every session.
// It must not move with each prompt: the name changes only through `custom-title`
// (rename-self, which /orchestrate uses).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// projectsRoot() is ~/.claude/projects, resolved per call, so a throwaway home keeps
// every real transcript out of reach.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-session-title-'));
const prior = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = home;
process.env.HOME = home;
const sessions = require('../out/backend/sessions');

const workspace = path.join(home, 'workspace');
const projectDir = path.join(home, '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
let n = 0;
function transcript(lines) {
  const id = `6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a${String(++n).padStart(2, '0')}`;
  fs.writeFileSync(path.join(projectDir, id + '.jsonl'), lines.map((l) => JSON.stringify({ sessionId: id, ...l })).join('\n') + '\n');
  return id;
}
const prompt = (text) => [{ type: 'user', message: { role: 'user', content: text } }, { type: 'last-prompt', lastPrompt: text }];
const titleOf = (id) => sessions.listSessions(workspace).find((s) => s.id === id);

before(() => { fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(projectDir, { recursive: true }); });
after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

test('without ai-title the name is the first prompt and does not follow later prompts', () => {
  const id = transcript([...prompt('Plan the release checklist'), ...prompt('Also add a rollback step')]);
  const s = titleOf(id);
  assert.equal(s.title, 'Plan the release checklist');
  // The subtitle keeps showing the latest prompt; only the name stays put.
  assert.equal(s.lastPrompt, 'Also add a rollback step');
});

test('a custom-title (rename-self, /orchestrate) wins and survives later prompts', () => {
  const id = transcript([...prompt('Plan the release checklist'), { type: 'custom-title', customTitle: 'Release checklist' }, ...prompt('One more question')]);
  assert.equal(titleOf(id).title, 'Release checklist');
});

test('an ai-title still wins over the first prompt, a custom-title over both', () => {
  const ai = transcript([...prompt('Plan the release checklist'), { type: 'ai-title', aiTitle: 'Release planning' }, ...prompt('Next')]);
  assert.equal(titleOf(ai).title, 'Release planning');
  const both = transcript([...prompt('Plan'), { type: 'ai-title', aiTitle: 'Release planning' }, { type: 'custom-title', customTitle: 'Release checklist' }]);
  assert.equal(titleOf(both).title, 'Release checklist');
});

test('the title-only reader used for linked sessions applies the same rule', async () => {
  const id = transcript([...prompt('Plan the release checklist'), ...prompt('Also add a rollback step')]);
  const [row] = await sessions.readSessionTitles(workspace, [id]);
  assert.equal(row.title, 'Plan the release checklist');
});
