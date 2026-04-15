import React, { useEffect, useMemo } from 'react';
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

function computeDiff(oldLines: string[], newLines: string[]): DiffRow[] {
  const m = oldLines.length;
  const n = newLines.length;

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

export function DiffViewerModal({ path, oldString, newString, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');
  const rows = useMemo(() => computeDiff(oldLines, newLines), [oldString, newString]);

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
