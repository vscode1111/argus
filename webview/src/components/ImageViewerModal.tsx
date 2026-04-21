import React from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey';
import styles from './ImageViewerModal.module.css';

interface Props {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageViewerModal({ src, alt, onClose }: Props) {
  useEscapeKey(onClose);

  return createPortal(
    <div className={styles.imageOverlay} onClick={onClose}>
      <div className={styles.container} role="dialog" aria-modal="true" aria-label="Image viewer" onClick={e => e.stopPropagation()}>
        <button className={styles.close} aria-label="Close" autoFocus onClick={onClose}>×</button>
        <img src={src} alt={alt ?? 'Image'} className={styles.image} />
      </div>
    </div>,
    document.body,
  );
}
