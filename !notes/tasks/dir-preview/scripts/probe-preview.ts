// Directory vs file vs error, straight from the shared reader both hosts use.
// Run: npx tsx !notes/tasks/dir-preview/scripts/probe-preview.ts
import { readFilePreview } from '../../../../src/backend/filePreview';

const WS = 'd:/_Projects/scub111g/argus';

function show(label: string, p: string, workspace = WS) {
  const r = readFilePreview(p, workspace);
  if (r.entries) {
    const head = r.entries.slice(0, 6).map(e => `${e.isDir ? '[D]' : '   '} ${e.name}${e.size !== undefined ? ` (${e.size}B)` : ''}`);
    console.log(`${label}\n  path=${r.path}\n  parent=${r.parent}\n  entries=${r.entries.length} truncated=${r.truncated}\n${head.map(h => '    ' + h).join('\n')}\n`);
  } else {
    console.log(`${label}\n  path=${r.path}\n  content=${JSON.stringify(r.content.slice(0, 70))}\n`);
  }
}

show('DIR (the reported link)', 'C:\\Users\\Admin\\.claude');
show('DIR (the folder actually meant)', 'C:\\Users\\Admin\\.claude\\skills\\git-remarks\\scripts');
show('DIR (trailing separator)', 'C:\\Users\\Admin\\.claude\\skills\\');
show('DIR (forward slashes)', 'C:/Users/Admin/.claude/skills');
show('DIR (drive root - no parent)', 'C:\\');
show('DIR (relative, inside workspace)', 'src/backend');
show('FILE (control)', 'package.json');
show('MISSING (control)', 'C:\\nope\\nothing-here.txt');
show('OUTSIDE WORKSPACE (control)', '../../../Windows');
