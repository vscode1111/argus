import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey';
import styles from './ImageViewerModal.module.css';

interface Props {
  src: string;
  alt?: string;
  onClose: () => void;
}

async function copyImage(src: string) {
  const res = await fetch(src);
  const blob = await res.blob();
  const pngBlob = blob.type === 'image/png' ? blob : await new Promise<Blob>(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      c.toBlob(b => resolve(b!), 'image/png');
    };
    img.src = src;
  });
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
}

export function ImageViewerModal({ src, alt, onClose }: Props) {
  useEscapeKey(onClose);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await copyImage(src);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, [src]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        handleCopy();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCopy]);

  return createPortal(
    <div className={styles.imageOverlay} onClick={onClose}>
      <div className={styles.container} role="dialog" aria-modal="true" aria-label="Image viewer" onClick={e => e.stopPropagation()}>
        <button className={styles.close} aria-label="Close" autoFocus onClick={onClose}>×</button>
        <img src={src} alt={alt ?? 'Image'} className={styles.image} />
        {copied && <div className={styles.toast}>Copied to clipboard</div>}
      </div>
    </div>,
    document.body,
  );
}
