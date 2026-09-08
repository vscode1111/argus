// Timeline of one transcript: real user sends, turn boundaries, background launches.
// Usage: node turn-timeline.js <transcript.jsonl> [fromISO] [toISO]
const fs = require('fs');

const file = process.argv[2];
const from = process.argv[3] ? Date.parse(process.argv[3]) : -Infinity;
const to = process.argv[4] ? Date.parse(process.argv[4]) : Infinity;

const recs = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t) continue;
  try { recs.push(JSON.parse(t)); } catch {}
}

const hhmm = ms => new Date(ms).toISOString().slice(11, 19);
const dur = ms => ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';

// A user record the CLI wrote itself (tool results, image notes, skill bodies).
const cliAuthored = r =>
  r.isMeta === true || r.isVisibleInTranscriptOnly === true ||
  (Array.isArray(r.message?.content) && r.message.content.every(b => b.type === 'tool_result'));

const events = [];
for (const r of recs) {
  const ts = Date.parse(r.timestamp || 0);
  if (!Number.isFinite(ts) || ts < from || ts > to) continue;
  if (r.type === 'user') {
    const c = r.message?.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
    const toolResults = Array.isArray(c) ? c.filter(b => b.type === 'tool_result') : [];
    events.push({ ts, kind: cliAuthored(r) ? 'cli-user' : 'user', text, toolResults, rec: r });
  } else if (r.type === 'assistant') {
    const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ');
    const tools = blocks.filter(b => b.type === 'tool_use').map(b => ({
      id: b.id, name: b.name, bg: b.input?.run_in_background === true,
      desc: b.input?.description || '', cmd: (b.input?.command || '').slice(0, 60),
    }));
    events.push({ ts, kind: 'assistant', text, tools, usage: r.message?.usage, rec: r });
  }
}
events.sort((a, b) => a.ts - b.ts);

// A "turn" = a run of assistant/cli-user records with no real user send between them.
// Its end is the last assistant record before the next real user send or a long gap.
let turn = null;
const turns = [];
const openBg = new Map(); // tool id -> {desc, at}

for (const e of events) {
  if (e.kind === 'user') {
    if (turn) { turns.push(turn); turn = null; }
    turns.push({ realSend: true, start: e.ts, end: e.ts, text: e.text.slice(0, 70), bgLaunched: [], bgDone: [] });
    continue;
  }
  if (!turn) turn = { start: e.ts, end: e.ts, bgLaunched: [], bgDone: [], text: '' };
  turn.end = e.ts;
  if (e.kind === 'assistant') {
    if (e.text.trim()) turn.text = e.text.trim().replace(/\s+/g, ' ').slice(0, 70);
    for (const t of e.tools) {
      if (t.bg) { turn.bgLaunched.push(t); openBg.set(t.id, { ...t, at: e.ts }); }
    }
    if (e.usage) turn.usage = e.usage;
  } else if (e.kind === 'cli-user') {
    for (const tr of e.toolResults) {
      const txt = typeof tr.content === 'string' ? tr.content
        : Array.isArray(tr.content) ? tr.content.map(b => b.text || '').join(' ') : '';
      if (/running in the background|Command running in background/i.test(txt)) continue;
      if (openBg.has(tr.tool_use_id)) { turn.bgDone.push(openBg.get(tr.tool_use_id)); openBg.delete(tr.tool_use_id); }
    }
  }
}
if (turn) turns.push(turn);

console.log('turn  start     end       dur     gap-before  bg-launched  bg-open-at-end  text');
let prevEnd = null;
let i = 0;
for (const t of turns) {
  i++;
  const gap = prevEnd == null ? 0 : t.start - prevEnd;
  // how many bg tasks were open when this turn ended
  const openAtEnd = [...openBg.values()].filter(b => b.at <= t.end).length;
  console.log(
    String(i).padStart(4) + '  ' +
    hhmm(t.start) + '  ' + hhmm(t.end) + '  ' +
    dur(t.end - t.start).padStart(7) + '  ' +
    (prevEnd == null ? '-' : dur(gap)).padStart(10) + '  ' +
    String(t.bgLaunched.length).padStart(11) + '  ' +
    String(openAtEnd).padStart(14) + '  ' +
    (t.realSend ? 'USER> ' : '') + (t.text || '')
  );
  prevEnd = t.end;
}

console.log('\ntotal turns:', turns.length,
  '| real user sends:', turns.filter(t => t.realSend).length,
  '| autonomous:', turns.filter(t => !t.realSend).length);
console.log('bg launches:', events.filter(e => e.kind === 'assistant').reduce((n, e) => n + e.tools.filter(t => t.bg).length, 0));
