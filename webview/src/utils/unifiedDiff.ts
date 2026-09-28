export type UnifiedDiffRow =
  | { type: 'equal'; old: string; new: string }
  | { type: 'remove'; old: string }
  | { type: 'add'; new: string }
  | { type: 'hunk'; label: string };

export function parseUnifiedDiff(diff: string): UnifiedDiffRow[] {
  const rows: UnifiedDiffRow[] = [];
  let inHunk = false;
  for (const line of diff.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')) {
    if (line.startsWith('@@')) {
      rows.push({ type: 'hunk', label: line });
      inHunk = true;
    } else if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('\\ No newline')) {
      continue;
    } else if (inHunk || /^[ +\-]/.test(line)) {
      if (line.startsWith('+')) rows.push({ type: 'add', new: line.slice(1) });
      else if (line.startsWith('-')) rows.push({ type: 'remove', old: line.slice(1) });
      else if (line.startsWith(' ')) rows.push({ type: 'equal', old: line.slice(1), new: line.slice(1) });
    }
  }
  return rows.length ? rows : [{ type: 'equal', old: diff, new: diff }];
}

export function countUnifiedDiff(diff: string): { added: number; removed: number } {
  const rows = parseUnifiedDiff(diff);
  return {
    added: rows.filter(row => row.type === 'add').length,
    removed: rows.filter(row => row.type === 'remove').length,
  };
}
