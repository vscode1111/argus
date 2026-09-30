const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const threadId = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(threadId || '')) throw new Error('Pass a thread id');
const projectRoot = process.argv[3] || path.resolve(__dirname, '../../../..');
const { replayThread } = require(path.join(projectRoot, 'out/backend/providers/codex'));
const root = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
const candidates = fs.readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => path.join(root, entry.name, 'codex.exe'))
  .filter(file => fs.existsSync(file))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
if (!candidates.length) throw new Error('Provider executable not found');
const proc = spawn(candidates[0], ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buffer = '';
const timeout = setTimeout(() => { console.error('Provider probe timed out'); proc.kill(); process.exitCode = 1; }, 30000);
function send(message) { proc.stdin.write(JSON.stringify(message) + '\n'); }
proc.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1 && message.error) {
      clearTimeout(timeout); console.error(message.error.message); proc.kill(); process.exitCode = 1;
    }
    if (message.id === 1 && message.result) {
      send({ method: 'initialized' });
      send({ id: 2, method: 'thread/read', params: { threadId, includeTurns: true } });
    }
    if (message.id === 2) {
      clearTimeout(timeout);
      if (message.error) { console.error(message.error.message); process.exitCode = 1; }
      else {
        const turns = message.result?.thread?.turns || [];
        const matches = [];
        turns.forEach((turn, turnIndex) => (turn.items || []).forEach((item, itemIndex) => {
          const value = JSON.stringify(item);
          if (value.includes('Уточни, пожалуйста: исправить все замечания') || item.questions || item.delivery) {
            matches.push({ turnIndex, itemIndex, type: item.type, keys: Object.keys(item),
              id: item.id, delivery: item.delivery, questionCount: item.questions?.length || 0,
              questionKeys: item.questions?.map(question => Object.keys(question)),
              optionCounts: item.questions?.map(question => question.options?.length || 0),
              contentTypes: Array.isArray(item.content) ? item.content.map(block => block.type) : undefined });
          }
        }));
        const replay = replayThread(message.result.thread);
        let latestUnansweredQuestionId = null;
        for (const item of replay) {
          if (item.role === 'user') latestUnansweredQuestionId = null;
          else if (item.interaction?.async) latestUnansweredQuestionId = item.interaction.id;
        }
        console.log(JSON.stringify({ turns: turns.length, matches,
          mappedQuestionIds: replay.filter(item => item.interaction?.async).map(item => item.interaction.id), latestUnansweredQuestionId }, null, 2));
      }
      proc.kill();
    }
  }
});
proc.stderr.resume();
proc.on('error', error => { clearTimeout(timeout); console.error(error.message); process.exitCode = 1; });
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'argus', version: '0.0.104' } } });
