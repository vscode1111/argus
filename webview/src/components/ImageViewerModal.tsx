import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { postMessage } from '../vscode';
import styles from './ImageViewerModal.module.css';

interface Props {
  src: string;
  alt?: string;
  onClose: () => void;
}

async function copyImageBrowser(src: string) {
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

function copyImageExtension(src: string): Promise<boolean> {
  return new Promise(resolve => {
    function handler(e: MessageEvent) {
      if (e.data?.type === 'copyImageResult') {
        window.removeEventListener('message', handler);
        resolve(!!e.data.success);
      }
    }
    window.addEventListener('message', handler);
    setTimeout(() => { window.removeEventListener('message', handler); resolve(false); }, 5000);
    const match = src.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) { resolve(false); return; }
    postMessage({ type: 'copyImage', mediaType: match[1], data: match[2] });
  });
}

export function ImageViewerModal({ src, alt, onClose }: Props) {
  useEscapeKey(onClose);
  const [toast, setToast] = useState<string | null>(null);

  const handleCopy = useCallback(async () => {
    let ok = false;
    if (window.location.protocol === 'vscode-webview:') {
      ok = await copyImageExtension(src);
    } else {
      try { await copyImageBrowser(src); ok = true; } catch {}
    }
    setToast(ok ? 'Copied to clipboard' : 'Failed to copy image');
    setTimeout(() => setToast(null), 2000);
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
        <div className={styles.toolbar}>
          <button className={styles.copyBtn} onClick={handleCopy} title="Copy image (Ctrl+C)">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect x="5" y="1" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M5 4H3.5A1.5 1.5 0 0 0 2 5.5v8A1.5 1.5 0 0 0 3.5 15h7A1.5 1.5 0 0 0 12 13.5V12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
          <button className={styles.close} aria-label="Close" autoFocus onClick={onClose}>×</button>
        </div>
        <img src={src} alt={alt ?? 'Image'} className={styles.image} />
        {toast && <div className={styles.toast}>{toast}</div>}
      </div>
    </div>,
    document.body,
  );
}
