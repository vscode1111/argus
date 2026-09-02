// Did the CLI transcript ever record the image for the failing test's Read?
// Scans every project folder (the test may run in its own workspace) and skips this
// conversation's own transcript, which merely mentions the filename in prose.
const fs = require('fs'); const path = require('path'); const os = require('os');
const NAME = process.argv[2] || 'scub-tool-image-1788373054036.png';
const SELF = '9066c44f-2387-41aa-8cff-50e80c35eca8';
const root = path.join(os.homedir(), '.claude', 'projects');

let found = 0;
for (const proj of fs.readdirSync(root)) {
  const pdir = path.join(root, proj);
  let files; try { files = fs.readdirSync(pdir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
  for (const f of files) {
    if (f.startsWith(SELF)) continue;
    const p = path.join(pdir, f);
    let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (!txt.includes(NAME)) continue;
    found++;
    console.log('project :', proj);
    console.log('session :', f, ' mtime:', new Date(fs.statSync(p).mtimeMs).toISOString());
    let toolUseId = null, sawImage = false, resultLine = null;
    for (const line of txt.split('\n')) {
      if (line.includes(NAME)) {
        const idm = line.match(/"(toolu_[A-Za-z0-9]+)"/);
        if (idm && !toolUseId) toolUseId = idm[1];
      }
      if (toolUseId && line.includes(toolUseId)) {
        if (/"type"\s*:\s*"tool_result"/.test(line)) resultLine = line.length;
        if (/"type"\s*:\s*"image"/.test(line) && /"data"\s*:\s*"[A-Za-z0-9+/]{200,}/.test(line)) sawImage = true;
      }
    }
    console.log('tool_use_id:', toolUseId);
    console.log('tool_result line present:', resultLine ? `yes (${resultLine} chars)` : 'NO');
    console.log('base64 image block in transcript:', sawImage ? 'YES' : 'NO');
    console.log('');
  }
}
if (!found) console.log('no test transcript mentions', NAME, '- the session was never written');
