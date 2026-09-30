const fs = require('node:fs');
const path = require('node:path');

const notes = path.resolve(__dirname, '..');
const summaries = new Map([
  ['codex-watchdog-counts', 'Count Codex spawns, list foreign processes, show the reaper activity clock, and report successful idle reaps.'],
  ['codex-async-question-dialog', 'Structured async questions open a modal and survive turn completion and replay.'],
  ['codex-file-status', 'Hide zero counters and empty Diff links; show added paths in green and deleted paths in red with strike-through.'],
  ['browser-webview-density', 'Use Consolas in both browser hosts to match the Windows VS Code panel file-row spacing.'],
  ['browser-webview-colors', 'Supply the missing VS Code symbol color in both browser hosts so command text is blue rather than yellow.'],
  ['codex-config-duplicate-key', 'Remove a duplicate trusted-project table from local config.toml so the CLI loads again.'],
]);

for (const [relative, prefix] of [['tasks/INDEX.md', ''], ['INDEX.md', 'tasks/']]) {
  const file = path.join(notes, relative);
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split(/(?<=\n)/);
  for (const [slug, summary] of summaries) {
    const marker = `| [${slug}/](${prefix}${slug}/) |`;
    const matches = lines.map((line, index) => line.startsWith(marker) ? index : -1).filter(index => index >= 0);
    if (matches.length !== 1) throw new Error(`${relative}: expected one row for ${slug}, found ${matches.length}`);
    const cells = lines[matches[0]].split('|');
    if (cells.length !== 5) throw new Error(`${relative}: unexpected row shape for ${slug}`);
    cells[3] = ` ${summary} `;
    lines[matches[0]] = cells.join('|');
  }
  const updated = lines.join('');
  if (updated !== original) fs.writeFileSync(file, updated);
}
