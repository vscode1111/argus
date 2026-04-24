import React, { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { withLinkedPaths } from './filePath';

// Escape backslashes in Windows file paths so the markdown parser preserves them.
// Without this, `D:\_Projects` becomes `D:_Projects` (backslash consumed as escape).
const WIN_PATH_RE = /(?<![a-zA-Z`])([A-Za-z]:[\\])[\w.\-\\\/]+\.\w+(?::\d+(?:-\d+)?)?/g;
function protectPathBackslashes(text: string): string {
  return text.replace(WIN_PATH_RE, match => match.replace(/\\/g, '\\\\'));
}

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) return extractText(node.props.children);
  return '';
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
      style={{
        position: 'absolute',
        top: 4,
        right: 4,
        background: 'transparent',
        border: 'none',
        color: 'var(--fg)',
        cursor: 'pointer',
        opacity: copied ? 1 : 0,
        transition: 'opacity 0.15s',
        fontSize: 14,
        padding: '2px 4px',
        borderRadius: 3,
        lineHeight: 1,
      }}
      className="code-copy-btn"
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

export function Markdown({ children, breaks }: { children: string; breaks?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
      components={{
        pre({ children }) {
          const text = extractText(children).replace(/\n$/, '');
          return (
            <pre className="code-block-wrapper" style={{ position: 'relative', background: 'var(--tool-bg)', borderRadius: 4, padding: '8px 10px', overflowX: 'auto', margin: '6px 0', width: 'fit-content', maxWidth: '100%' }}>
              {children}
              <CopyButton text={text} />
            </pre>
          );
        },
        code({ children, className }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code style={{ background: 'var(--tool-bg)', padding: '1px 4px', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: '0.9em' }}>
                {withLinkedPaths(children)}
              </code>
            );
          }
          return (
            <code style={{ background: 'none', padding: 0, fontSize: '0.9em', fontFamily: 'var(--font-mono)' }}>
              {withLinkedPaths(children)}
            </code>
          );
        },
        p({ children }) {
          return <p>{withLinkedPaths(children)}</p>;
        },
        li({ children }) {
          return <li>{withLinkedPaths(children)}</li>;
        },
        td({ children }) {
          return <td>{withLinkedPaths(children)}</td>;
        },
        a({ href, children }) {
          return <a href={href} style={{ color: 'var(--vscode-textLink-foreground)' }}>{children}</a>;
        },
      }}
    >
      {protectPathBackslashes(children)}
    </ReactMarkdown>
  );
}
