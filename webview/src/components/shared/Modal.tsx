import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useDraggable } from '../../hooks/useDraggable';
import shell from './centeredModal.module.css';

interface Props {
  title: React.ReactNode;
  ariaLabel: string;
  onClose: () => void;
  width?: number;
  fullHeight?: boolean;
  // Extra controls rendered in the header before the close button (e.g. a
  // RefreshButton). The close button is always appended.
  headerActions?: React.ReactNode;
  // Escape handler override. Defaults to onClose; modals with inline editing
  // pass a guarded version (cancel edit first, then close).
  onEscape?: () => void;
  children: React.ReactNode;
}

// Centered, draggable portal shell shared by the Account/Session/Workspace
// modals: overlay, draggable header (title + actions + close) and a flex body.
// Each modal supplies only its own content below the header.
export function Modal({ title, ariaLabel, onClose, width, fullHeight, headerActions, onEscape, children }: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  const drag = useDraggable(modalRef);

  useEscapeKey(onEscape ?? onClose);

  const style: React.CSSProperties = {
    ...(width ? { width } : null),
    ...(fullHeight ? { height: 'calc(100vh - 64px)' } : null),
    ...drag.style,
  };

  return createPortal(
    <>
      <div className={shell.overlay} onClick={onClose} aria-hidden="true" />
      <div className={shell.modal} role="dialog" aria-label={ariaLabel} ref={modalRef} style={style}>
        <div className={shell.header} onPointerDown={drag.onPointerDown}>
          <span className={shell.title} title={typeof title === 'string' ? title : undefined}>{title}</span>
          <div className={shell.headerActions}>
            {headerActions}
            <button className={shell.close} onClick={onClose} aria-label="Close">&times;</button>
          </div>
        </div>
        {children}
      </div>
    </>,
    document.body,
  );
}
