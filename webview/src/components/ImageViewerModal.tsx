import React, { useEffect } from 'react';

interface Props {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageViewerModal({ src, alt, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="iv-overlay" onClick={onClose}>
      <div className="iv-container" onClick={e => e.stopPropagation()}>
        <button className="iv-close" aria-label="Close" onClick={onClose}>×</button>
        <img src={src} alt={alt ?? 'Image'} className="iv-image" />
      </div>
    </div>
  );
}
