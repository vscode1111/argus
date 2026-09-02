import React, { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { withLinkedPaths } from './filePath';
import { openExternal } from './url';
import { usePreviewNav } from '../contexts/PreviewNavContext';

// Escape backslashes in Windows file paths so the markdown parser preserves them.
// Without this, `D:\_Projects` becomes `D:_Projects` (backslash consumed as escape).
// Covers drive-letter paths and relative backslash paths; "!" is allowed in
// directory segments (the !notes convention) - without it the escape stopped at
// the bang and markdown ate the preceding backslash (`CCS\!notes` -> `CCS!notes`).
// The filename suffix must accept the same class as FILE_PATH_RE in filePath.tsx (see
// the note there): a hyphenated dotfile (`\credentials\.corp-account`) matched neither,
// so in prose markdown ate the backslashes around it and it rendered as
// `C:\Users\Admin.claude\...\credentials.corp-account`.
// A trailing extension is likewise not required any more, for the same reason it is not
// there: a directory is a path too, and one that ends in `\` or in a dotless segment has
// to survive the parser intact or the linkifier never sees it whole.
// This escapes deliberately MORE than FILE_PATH_RE links, and the asymmetry is the point:
// the two regexes answer different questions. Escaping asks "would markdown eat this
// backslash", which is true of `C:\` and of the elision `C:\...` (both rendered as `C:`
// and `C:...` before this, in prose); linking asks "is this a path worth opening", which
// neither is. Over-escaping only makes a backslash visible, which is right either way -
// under-escaping silently corrupts the text.
const WIN_PATH_RE = /(?<![a-zA-Z`])(?:[A-Za-z]:\\|(?:[\w.\-@!]+\\)+)(?:[\w.\-!]+[\\\/])*(?:[\w.\-!]*[\w\-!])?[\\\/]?(?::\d+(?:-\d+)?)?/g;
// Code spans and fences keep backslashes literal, so escaping inside them would
// double them (`CCS\!notes` -> `CCS\\!notes`). Split them out and leave them alone.
const CODE_SPAN_RE = /(`+)[\s\S]*?\1/g;
function protectPathBackslashes(text: unknown): string {
  if (typeof text !== 'string') return String(text ?? '');
  let out = '';
  let lastIndex = 0;
  CODE_SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_SPAN_RE.exec(text)) !== null) {
    out += escapeWinPaths(text.slice(lastIndex, m.index)) + m[0];
    lastIndex = m.index + m[0].length;
  }
  return out + escapeWinPaths(text.slice(lastIndex));
}

function escapeWinPaths(text: string): string {
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
        // Opaque, matching the block: the button now sits over code that scrolls
        // beneath it, so a transparent background would overlap the text.
        background: 'var(--tool-bg)',
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

const EXTERNAL_HREF_RE = /^https?:\/\/|^#|^mailto:/i;

// Inside the file previewer, a relative link points at a sibling document, so it
// navigates the previewer. Outside it there is nothing to navigate, and the href
// is dropped as before (only external schemes are kept).
function MarkdownLink({ href, children }: { href?: string; children: React.ReactNode }) {
  const navigate = usePreviewNav();
  const isExternal = !!href && EXTERNAL_HREF_RE.test(href);
  const canNavigate = !!href && !isExternal && !!navigate;

  if (canNavigate) {
    return (
      <a
        href="#"
        className="file-path-link"
        title={`Open ${href}`}
        onClick={e => { e.preventDefault(); e.stopPropagation(); navigate(href!); }}
      >
        {children}
      </a>
    );
  }
  // http(s) is opened through the host rather than followed: in browser mode a bare
  // href navigates the Argus page itself away, losing the conversation view. `#` and
  // `mailto:` keep their default behaviour.
  const isHttp = !!href && /^https?:\/\//i.test(href);
  return (
    <a
      href={isExternal ? href : undefined}
      style={{ color: 'var(--vscode-textLink-foreground)' }}
      onClick={isHttp ? e => { e.preventDefault(); e.stopPropagation(); openExternal(href!); } : undefined}
    >
      {children}
    </a>
  );
}

export function Markdown({ children, breaks }: { children: string; breaks?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
      components={{
        pre({ children }) {
          const text = extractText(children).replace(/\n$/, '');
          // The copy button is anchored to this wrapper, not to the <pre>: an
          // absolutely positioned child of a scroll container is laid out against
          // the padding box at scroll origin and then scrolls away with the
          // content, so `right: 4` only held while scrollLeft was 0 and the
          // button drifted left across the block (and out of view) as soon as a
          // long line was scrolled. The wrapper does not scroll.
          return (
            <div className="code-block-wrapper" style={{ position: 'relative', margin: '6px 0', width: 'fit-content', maxWidth: '100%' }}>
              <pre style={{ background: 'var(--tool-bg)', borderRadius: 4, padding: '8px 10px', overflowX: 'auto', margin: 0 }}>
                {children}
              </pre>
              <CopyButton text={text} />
            </div>
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
          return <MarkdownLink href={href}>{children}</MarkdownLink>;
        },
      }}
    >
      {protectPathBackslashes(children)}
    </ReactMarkdown>
  );
}
