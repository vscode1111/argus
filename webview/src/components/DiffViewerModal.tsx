import React, { useEffect } from 'react';

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
    <div className="fv-overlay" onClick={onClose} aria-hidden="true">
      <div
        className="fv-modal"
        role="dialog"
        aria-label={`Diff: ${path}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="fv-header">
          <div className="fv-title-row">
            <span className="fv-title" title={path}>{path}</span>
            <span className="dv-stats">
              <span className="tool-diff-stats-added">+{newLines.length}</span>
              <span className="tool-diff-stats-removed">-{oldLines.length}</span>
            </span>
          </div>
          <div className="fv-actions">
            <button className="fv-close" aria-label="Close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="fv-body dv-body">
          <div className="dv-table">
{Array.from({ length: rows }).map((_, i) => (
              <React.Fragment key={i}>
                {oldLines[i] !== undefined
                  ? <div className="dv-line dv-line-removed">{oldLines[i]}</div>
                  : <div className="dv-line dv-line-empty dv-line-empty-old" />}
                {newLines[i] !== undefined
                  ? <div className="dv-line dv-line-added">{newLines[i]}</div>
                  : <div className="dv-line dv-line-empty" />}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
