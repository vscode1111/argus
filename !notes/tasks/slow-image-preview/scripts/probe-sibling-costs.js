// Measures the two sibling functions that share readToolImage's pre-fix pattern
// (fs.readFileSync(file, 'utf8') then content.split(/\r?\n/)) against the SAME real
// 336 MB transcript, to report real numbers rather than speculation about whether
// they are worth fixing too.
const path = require('path');
const { listSessions, loadSession } = require(path.resolve('out/backend/sessions.js'));

const WORKSPACE_DIR = 'd:\\_Projects\\scub111g\\estate-agent';
const SESSION_ID = '8dbb366b-44d5-4b07-bae1-ba0ae03589d8';

function ms(start) { return Number(process.hrtime.bigint() - start) / 1e6; }

let t = process.hrtime.bigint();
const sessions = listSessions(WORKSPACE_DIR);
console.log('listSessions() for this workspace:', ms(t).toFixed(0), 'ms ->', sessions.length, 'sessions (each reads its own transcript for metadata)');

t = process.hrtime.bigint();
const msgs = loadSession(SESSION_ID, WORKSPACE_DIR);
console.log('loadSession() for the reported session:', ms(t).toFixed(0), 'ms ->', msgs.length, 'messages');
