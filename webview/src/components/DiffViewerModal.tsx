import React, { useEffect } from 'react';
import modal from './shared/modal.module.css';
import styles from './DiffViewerModal.module.css';
import tc from './ToolCall.module.css';

interface Props {
  path: string;
  oldString: string;
  newString: string;
  onClose: () => void;
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
  const rows = Math.max(oldLines.length, newLines.length);

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
              <span className={tc.statsAdded}>+{newLines.length}</span>
              <span className={tc.statsRemoved}>-{oldLines.length}</span>
            </span>
          </div>
          <div className={modal.actions}>
            <button className={modal.close} aria-label="Close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className={[modal.body, styles.body].join(' ')}>
          <div className={styles.table}>
{Array.from({ length: rows }).map((_, i) => (
              <React.Fragment key={i}>
                {oldLines[i] !== undefined
                  ? <div className={[styles.line, styles.lineRemoved].join(' ')}>{oldLines[i]}</div>
                  : <div className={[styles.line, styles.lineEmpty, styles.lineEmptyOld].join(' ')} />}
                {newLines[i] !== undefined
                  ? <div className={[styles.line, styles.lineAdded].join(' ')}>{newLines[i]}</div>
                  : <div className={[styles.line, styles.lineEmpty].join(' ')} />}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
