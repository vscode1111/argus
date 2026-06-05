import React, { useState } from 'react';
import { WorkspaceHistoryModal } from './WorkspaceHistoryModal';
import styles from './WorkspaceMenu.module.css';

interface Props {
  currentPath: string;
  name: string;
  onSelect: (path: string) => void;
}

// Header workspace tile: a button that opens the Workspace History dialog, where
// the user can switch the panel to another recently used project.
export function WorkspaceMenu({ currentPath, name, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={styles.tile}
        title={currentPath}
        aria-label="Switch workspace"
        onClick={() => setOpen(true)}
      >
        <span className={styles.tileName}>{name}</span>
      </button>
      {open && (
        <WorkspaceHistoryModal
          currentPath={currentPath}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
