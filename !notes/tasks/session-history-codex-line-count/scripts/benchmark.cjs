require('tsx/cjs');
const { records } = require('../../../../src/backend/providers/store.ts');
const { codexSessionLineCount } = require('../../../../src/backend/sessions.ts');

const sessions = records().filter(record => record.selection.providerId === 'codex');
for (const pass of ['cold', 'warm']) {
  const started = performance.now();
  const counts = sessions.map(record => codexSessionLineCount(record.id));
  console.log(JSON.stringify({ pass, sessions: sessions.length, positive: counts.filter(count => count > 0).length, ms: Math.round(performance.now() - started) }));
}
