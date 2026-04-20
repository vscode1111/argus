import React, { useState, useMemo } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { tryDecode } from '../utils/encoding';
import { EncodingSelect } from './shared/EncodingSelect';
import modal from './shared/modal.module.css';
import styles from './DiffViewerModal.module.css';
import tc from './ToolCall.module.css';

interface Props {
  path: string;
  oldString: string;
  newString: string;
  onClose: () => void;
}

type DiffRow =
  | { type: 'equal'; old: string; new: string }
  | { type: 'remove'; old: string }
  | { type: 'add'; new: string };

const MAX_LCS_LINES = 2000;

function computeDiff(oldLines: string[], newLines: string[]): DiffRow[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Fall back to simple sequential diff for very large files
  if (m > MAX_LCS_LINES || n > MAX_LCS_LINES) {
    return computeSimpleDiff(oldLines, newLines);
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to build diff rows
  const rows: DiffRow[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      rows.push({ type: 'equal', old: oldLines[i - 1], new: newLines[j - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rows.push({ type: 'add', new: newLines[j - 1] });
      j--;
    } else {
      rows.push({ type: 'remove', old: oldLines[i - 1] });
      i--;
    }
  }
  rows.reverse();
  return rows;
}

function computeSimpleDiff(oldLines: string[], newLines: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;
    if (oldLine === newLine && oldLine !== undefined) {
      rows.push({ type: 'equal', old: oldLine, new: newLine! });
    } else {
      if (oldLine !== undefined) rows.push({ type: 'remove', old: oldLine });
      if (newLine !== undefined) rows.push({ type: 'add', new: newLine });
    }
  }
  return rows;
}

export function DiffViewerModal({ path, oldString, newString, onClose }: Props) {
  useEscapeKey(onClose);

  const [encoding, setEncoding] = useState('');
  const decodedOld = useMemo(() => tryDecode(oldString, encoding), [oldString, encoding]);
  const decodedNew = useMemo(() => tryDecode(newString, encoding), [newString, encoding]);

  const oldLines = decodedOld.split('\n');
  const newLines = decodedNew.split('\n');
  const rows = useMemo(() => computeDiff(oldLines, newLines), [decodedOld, decodedNew]);

  const addedCount = rows.filter(r => r.type === 'add').length;
  const removedCount = rows.filter(r => r.type === 'remove').length;

  return (
    <div className={modal.overlay} onClick={onClose} aria-hidden="true">
      <div
        className={modal.modal}
        role="dialog"
        aria-label={`Diff: ${path}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={modal.header}>
          <div className={modal.titleRow}>
            <span className={modal.title} title={path}>{path}</span>
            <span className={styles.stats}>
              <span className={tc.statsAdded}>+{addedCount}</span>
              <span className={tc.statsRemoved}>-{removedCount}</span>
            </span>
          </div>
          <div className={modal.actions}>
            <EncodingSelect value={encoding} onChange={setEncoding} />
            <button className={modal.close} aria-label="Close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className={[modal.body, styles.body].join(' ')}>
          <div className={styles.table}>
            {rows.map((row, i) => (
              <React.Fragment key={i}>
                {row.type === 'equal' && (
                  <>
                    <div className={[styles.line, styles.lineUnchangedOld].join(' ')}>{row.old}</div>
                    <div className={styles.line}>{row.new}</div>
                  </>
                )}
                {row.type === 'remove' && (
                  <>
                    <div className={[styles.line, styles.lineRemoved].join(' ')}>{row.old}</div>
                    <div className={[styles.line, styles.lineEmpty].join(' ')} />
                  </>
                )}
                {row.type === 'add' && (
                  <>
                    <div className={[styles.line, styles.lineEmpty, styles.lineEmptyOld].join(' ')} />
                    <div className={[styles.line, styles.lineAdded].join(' ')}>{row.new}</div>
                  </>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
