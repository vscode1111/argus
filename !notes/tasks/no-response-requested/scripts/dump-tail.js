// Dump the tail of a CLI transcript: timestamp, type, role, uuid/parent, short content.
const fs = require('fs');

const file = process.argv[2];
const count = Number(process.argv[3] || 40);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const start = Math.max(0, lines.length - count);

const short = (s, n = 220) => {
  s = String(s).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + `…(${s.length})` : s;
};

for (let i = start; i < lines.length; i++) {
  let o;
  try { o = JSON.parse(lines[i]); } catch { console.log(`${i + 1}\t<unparseable ${lines[i].length}b>`); continue; }
  const parts = [];
  parts.push(String(i + 1).padStart(5));
  parts.push(o.timestamp || '');
  parts.push(o.type || '');
  if (o.isSidechain) parts.push('SIDECHAIN');
  if (o.isMeta) parts.push('META');
  if (o.isCompactSummary) parts.push('COMPACT');
  if (o.subtype) parts.push('sub=' + o.subtype);
  if (o.userType) parts.push('userType=' + o.userType);
  if (o.uuid) parts.push('uuid=' + o.uuid.slice(0, 8));
  if (o.parentUuid) parts.push('parent=' + o.parentUuid.slice(0, 8));

  const msg = o.message;
  let body = '';
  if (msg) {
    if (msg.model) parts.push('model=' + msg.model);
    if (msg.usage) parts.push(`usage=in:${msg.usage.input_tokens} cr:${msg.usage.cache_read_input_tokens} cc:${msg.usage.cache_creation_input_tokens} out:${msg.usage.output_tokens}`);
    if (msg.stop_reason) parts.push('stop=' + msg.stop_reason);
    const c = msg.content;
    if (typeof c === 'string') body = 'TEXT: ' + short(c);
    else if (Array.isArray(c)) {
      body = c.map(b => {
        if (b.type === 'text') return 'text[' + short(b.text) + ']';
        if (b.type === 'thinking') return 'thinking[' + short(b.thinking, 80) + ']';
        if (b.type === 'tool_use') return `tool_use(${b.name} id=${(b.id || '').slice(-8)})[${short(JSON.stringify(b.input), 120)}]`;
        if (b.type === 'tool_result') return `tool_result(id=${(b.tool_use_id || '').slice(-8)})[${short(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 120)}]`;
        if (b.type === 'image') return 'image[' + (b.source && b.source.media_type) + ']';
        return b.type;
      }).join(' | ');
    }
  }
  if (o.type === 'summary') body = 'SUMMARY: ' + short(o.summary);
  if (o.toolUseResult && !body) body = 'toolUseResult';
  console.log(parts.join(' ') + (body ? '\n        ' + body : ''));
}
