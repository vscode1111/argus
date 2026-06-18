import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { postMessage, isVsCode } from '../vscode';
import { CopyIcon } from './shared/icons';
import styles from './ImageViewerModal.module.css';

interface Props {
  src: string;
  alt?: string;
  onClose: () => void;
}

function dataUrlToBlob(src: string): Blob | null {
  const match = src.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

async function toPngBlob(src: string): Promise<Blob> {
  return new Promise<Blob>(resolve => {
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
}

async function copyImageBrowser(src: string) {
  const blob = dataUrlToBlob(src);
  const pngBlob = blob?.type === 'image/png' ? blob : await toPngBlob(src);
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
    if (isVsCode) {
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
            <CopyIcon />
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
