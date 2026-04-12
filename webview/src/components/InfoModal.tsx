import React, { useEffect } from 'react';
import styles from './InfoModal.module.css';

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
    <div className={styles.overlay} onClick={onClose} aria-hidden="true">
      <div className={styles.modal} role="dialog" aria-label="Info" onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>Workspace Info</span>
          <button className={styles.close} aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className={styles.body}>
          <div className={styles.row}>
            <span className={styles.label}>Path</span>
            <span className={styles.value}>{workspacePath || '(no workspace)'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
