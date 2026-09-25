import { useEffect, useRef } from 'react';
import { usePreview } from '../contexts/PreviewContext';

/**
 * Opens a preview for the file passed via the `?file=` launch param (context-menu
 * "Open file in Argus").
 *
 * It delegates to PreviewProvider rather than fetching and rendering a modal itself.
 * It used to do both, as a third copy of the readFilePreview/filePreview round trip -
 * which meant every kind the provider learned to resolve was missing here: a video
 * arrived as an empty `content` and rendered one blank line, because only the provider
 * knows that a media path is exchanged for a streaming grant instead. Anything that
 * resolves a path now goes through the one implementation, and this component is just
 * the launch param's way in.
 */
export function AutoFileViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const { open } = usePreview();
  // StrictMode double-invokes effects in development, which would open two identical
  // modals stacked on each other.
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    open({ kind: 'path', path });
    // The provider owns the frame from here - including closing it - so the launch
    // param is cleared at once rather than shadowing a modal this no longer renders.
    onClose();
  }, [path, open, onClose]);

  return null;
}
