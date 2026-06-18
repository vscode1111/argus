import React from 'react';
import { RefreshIcon } from './icons';
import shell from './centeredModal.module.css';

interface Props {
  spinning: boolean;
  onClick: () => void;
  label: string;   // aria-label
  title?: string;
  size?: number;
}

// Re-fetch button shared by the centered modals. Spins while `spinning` and is
// disabled to prevent overlapping requests; the spin stops when the reply lands
// and the parent clears `spinning`.
export function RefreshButton({ spinning, onClick, label, title, size }: Props) {
  return (
    <button
      className={[shell.refreshBtn, spinning ? shell.refreshing : ''].filter(Boolean).join(' ')}
      onClick={onClick}
      disabled={spinning}
      aria-label={label}
      title={title ?? label}
    >
      <RefreshIcon size={size} />
    </button>
  );
}
