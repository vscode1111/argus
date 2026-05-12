import React, { useState, useEffect } from 'react';
import { postMessage } from '../vscode';
import { FileViewerModal } from '../components/FileViewerModal';

// Matches file paths with optional :line or :line-endLine suffix
// Windows absolute: D:\path\to\file.ext:123
// Unix absolute: /path/to/file.ext:123
// Relative: src/file.ext, webview/src/App.tsx (at least one dir separator + extension)
const FILE_PATH_RE = /((?:(?<![a-zA-Z])[A-Za-z]:[\\\/])[\w.\-\\\/]+\.\w+|\/(?:[\w.\-]+\/)+[\w.\-]+\.\w+|(?:[\w.\-@]+[\\\/])+[\w.\-]+\.\w+)(?::(\d+)(?:-(\d+))?)?/g;

function FilePathLink({ path: origPath, line, endLine, display }: { path: string; line?: number; endLine?: number; display: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [resolvedPath, setResolvedPath] = useState(origPath);

  useEffect(() => {
    if (!open) return;
    setContent(null);
    function onMessage(e: MessageEvent) {
      if (e.data?.type === 'filePreview' && (e.data.path === origPath || e.data.path?.endsWith(origPath.replace(/\//g, '\\')) || e.data.path?.endsWith(origPath))) {
        setResolvedPath(e.data.path);
        setContent(e.data.content);
      }
    }
    window.addEventListener('message', onMessage);
    postMessage({ type: 'readFilePreview', path: origPath });
    return () => window.removeEventListener('message', onMessage);
  }, [open, origPath]);

  return (
    <>
      <a
        className="file-path-link"
        href="#"
        title={`Open ${origPath}`}
        onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
      >
        {display}
      </a>
      {open && content !== null && (
        <FileViewerModal
          path={resolvedPath}
          content={content}
          line={line}
          endLine={endLine}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Takes a plain text string and returns React nodes with detected file paths
 * rendered as clickable links that open a FileViewerModal on click.
 */
export function linkifyPaths(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  FILE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const fullMatch = match[0];
    const filePath = match[1];
    const line = match[2] ? parseInt(match[2], 10) : undefined;
    const endLine = match[3] ? parseInt(match[3], 10) : undefined;

    parts.push(
      <FilePathLink key={match.index} path={filePath} line={line} endLine={endLine} display={fullMatch} />
    );

    lastIndex = match.index + fullMatch.length;
  }

  if (parts.length === 0) return text;

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}

/**
 * Recursively processes React children, linkifying file paths in string nodes.
 */
function isLinkElement(el: React.ReactElement): boolean {
  return el.type === 'a' || (el.props as Record<string, unknown>)?.href != null;
}

export function withLinkedPaths(children: React.ReactNode): React.ReactNode {
  if (typeof children === 'string') {
    return linkifyPaths(children);
  }
  if (Array.isArray(children)) {
    return children.map((child, i) =>
      typeof child === 'string'
        ? <React.Fragment key={i}>{linkifyPaths(child)}</React.Fragment>
        : React.isValidElement(child)
          ? (isLinkElement(child)
            ? child
            : React.cloneElement(child, { key: i } as Record<string, unknown>, withLinkedPaths((child.props as { children?: React.ReactNode }).children)))
          : child
    );
  }
  if (React.isValidElement(children)) {
    if (isLinkElement(children)) return children;
    return React.cloneElement(children, {} as Record<string, unknown>, withLinkedPaths((children.props as { children?: React.ReactNode }).children));
  }
  return children;
}
