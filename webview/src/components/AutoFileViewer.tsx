import React, { useState, useEffect } from 'react';
import { postMessage } from '../vscode';
import { FileViewerModal } from './FileViewerModal';

/**
 * Opens a FileViewerModal for a file passed via the `?file=` launch param
 * (context-menu "Open file in Argus"). Self-fetches the content over the
 * readFilePreview/filePreview message pair, mirroring FilePathLink.
 */
export function AutoFileViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [resolvedPath, setResolvedPath] = useState(path);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === 'filePreview' && (e.data.path === path || e.data.path?.endsWith(path))) {
        setResolvedPath(e.data.path);
        setContent(e.data.content);
      }
    }
    window.addEventListener('message', onMessage);
    postMessage({ type: 'readFilePreview', path });
    return () => window.removeEventListener('message', onMessage);
  }, [path]);

  if (content === null) return null;
  return <FileViewerModal path={resolvedPath} content={content} onClose={onClose} />;
}
