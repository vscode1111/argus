import React, { useEffect } from 'react';

interface Props {
  workspacePath: string;
  onClose: () => void;
}

export function InfoModal({ workspacePath, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="info-overlay" onClick={onClose} aria-hidden="true">
      <div className="info-modal" role="dialog" aria-label="Info" onClick={e => e.stopPropagation()}>
        <div className="info-modal-header">
          <span className="info-modal-title">Workspace Info</span>
          <button className="info-modal-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="info-modal-body">
          <div className="info-row">
            <span className="info-label">Path</span>
            <span className="info-value">{workspacePath || '(no workspace)'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
