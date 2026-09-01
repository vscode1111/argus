import React, { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useEncoding } from '../hooks/useEncoding';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';

SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('scss', scss);
SyntaxHighlighter.registerLanguage('html', markup);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('xml', markup);
SyntaxHighlighter.registerLanguage('toml', toml);
SyntaxHighlighter.registerLanguage('c', c);
SyntaxHighlighter.registerLanguage('cpp', cpp);
SyntaxHighlighter.registerLanguage('csharp', csharp);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('ruby', ruby);
SyntaxHighlighter.registerLanguage('php', php);
SyntaxHighlighter.registerLanguage('swift', swift);
SyntaxHighlighter.registerLanguage('kotlin', kotlin);
import { postMessage, isVsCode } from '../vscode';
import { Markdown } from '../utils/markdown';
import { PreviewNavContext } from '../contexts/PreviewNavContext';
import { EncodingSelect } from './shared/EncodingSelect';
import { CopyIcon, CheckIcon, BackIcon } from './shared/icons';
import { useCopyFeedback } from '../hooks/useCopyFeedback';
import modal from './shared/modal.module.css';
import styles from './FileViewerModal.module.css';

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  json: 'json', py: 'python', go: 'go', rs: 'rust',
  css: 'css', scss: 'scss', html: 'html', htm: 'html',
  md: 'markdown', yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash', sql: 'sql', xml: 'xml',
  toml: 'toml', c: 'c', cpp: 'cpp', cs: 'csharp',
  java: 'java', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
};

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? 'text';
}

// Strip "     N→" or "     N\t" line-number prefix inserted by the Read tool.
// The system prompt shows → visually but the actual separator is a tab character.
function stripLineNumbers(content: string): string {
  return content
    .replace(/\r\n/g, '\n')               // normalize Windows line endings
    .replace(/^\s*\d+[→\t]/gm, '');       // strip "     N→" or "     N\t"
}

interface Props {
  path: string;
  content: string;
  line?: number;
  copyText?: string;
  /** Opened before its content exists: hold a spinner until the host answers. */
  loading?: boolean;
  onClose: () => void;
}

const isDataUrl = (s: string) => s.startsWith('data:image/');

const HTML_RE = /\.html?$/i;

/**
 * A stylesheet that repaints a previewed document in the panel's own colours.
 *
 * It is appended **after** the file's markup rather than injected into its head: a style
 * before the doctype would put the document into quirks mode, and coming last it wins
 * every specificity tie against the document's own rules. `!important` covers the rest -
 * a markdown export ships VS Code's markdown.css, which paints its own backgrounds.
 *
 * Colours are read from the live panel, not hardcoded, so the preview follows whatever
 * theme is in use; the values have to be resolved here because a sandboxed srcdoc frame
 * cannot see the parent's custom properties.
 */
function darkThemeStyle(): string {
  const css = getComputedStyle(document.body);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const bg = v('--bg', '#1e1e1e');
  const fg = v('--fg', '#cccccc');
  const border = v('--border', '#454545');
  const code = v('--tool-bg', '#242526');
  const link = v('--vscode-textLink-foreground', '#4daafc');
  const dim = v('--thinking-fg', '#8c8c8c');
  return `<style id="argus-theme">
:root { color-scheme: dark; }
html, body { background: ${bg} !important; color: ${fg} !important; }
a { color: ${link} !important; }
hr { border-color: ${border} !important; }
table, th, td { border-color: ${border} !important; }
code, kbd, samp, pre { background: ${code} !important; color: ${fg} !important; }
blockquote { border-left: 3px solid ${border} !important; color: ${dim} !important; }
</style>`;
}

const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

/**
 * Resolves a relative markdown link against the directory of the file it appears
 * in, so the previewer can follow it. Keeps the separator style of the base path
 * (backslashes on Windows) and understands "./" and "../" segments.
 */
export function resolveRelative(basePath: string, href: string): string {
  const sep = basePath.includes('\\') ? '\\' : '/';
  const clean = href.split(/[?#]/)[0].replace(/\\/g, '/');
  const segments = dirOf(basePath).split(/[\\/]/);
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join(sep);
}

interface Frame {
  path: string;
  content: string;
  line?: number;
}

export function FileViewerModal({ path, content, line, copyText, loading, onClose }: Props) {
  // Default to dark unless VS Code explicitly marks the theme as light.
  const isDark = !document.body.classList.contains('vscode-light');
  const { copied, copy } = useCopyFeedback();

  // Documents opened by following links inside the preview. The prop is the root
  // frame, so an empty stack means we are showing what the caller asked for.
  const [stack, setStack] = useState<Frame[]>([]);
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const current: Frame = stack.length ? stack[stack.length - 1] : { path, content, line };

  useEscapeKey(onClose);

  // A new root document (the caller clicked another path) drops the trail.
  useEffect(() => {
    setStack([]);
    setPendingPath(null);
  }, [path]);

  const navigate = useCallback((href: string) => {
    const target = resolveRelative(current.path, href);
    setPendingPath(target);
    postMessage({ type: 'readFilePreview', path: target });
  }, [current.path]);

  useEffect(() => {
    if (!pendingPath) return;
    function onMessage(e: MessageEvent) {
      if (e.data?.type !== 'filePreview') return;
      const got: string = e.data.path ?? '';
      if (got !== pendingPath && !got.endsWith(pendingPath!)) return;
      setStack(prev => [...prev, { path: got || pendingPath!, content: e.data.content }]);
      setPendingPath(null);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pendingPath]);

  const isImage = isDataUrl(current.content);
  const language = isImage ? 'text' : detectLanguage(current.path);
  const rawCode = isImage ? '' : stripLineNumbers(current.content);
  const { encoding, setEncoding, decoded: code } = useEncoding(rawCode);
  const filename = current.path.split(/[\\/]/).pop() ?? current.path;

  // An .html file is a document, not source, so it always opens rendered - the same
  // call markdown already makes. An offset does NOT switch this to source: the read the
  // user clicks is usually a slice (`file.html:359-499`), a browser renders a fragment
  // perfectly well, and defaulting those to source meant the whole feature looked like
  // it had not shipped. The line is still reachable - Source scrolls to it.
  const isHtml = HTML_RE.test(current.path) && !isImage;
  const [showSource, setShowSource] = useState(false);
  useEffect(() => { setShowSource(false); }, [current.path]);
  const renderHtml = isHtml && !showSource;
  // The document follows the panel's theme: a white page inside a dark panel is what
  // the plain render looked like, and it is the one thing every preview here shares.
  const htmlDoc = useMemo(
    () => (renderHtml ? code + (isDark ? darkThemeStyle() : '') : ''),
    [renderHtml, code, isDark],
  );

  const bodyRef = useRef<HTMLDivElement>(null);
  const currentLine = current.line;

  const scrollToLine = useCallback(() => {
    if (!currentLine || !bodyRef.current) return;
    const row = bodyRef.current.querySelector(`[data-line="${currentLine}"]`) as HTMLElement | null;
    if (row) {
      row.scrollIntoView({ block: 'center' });
    }
  }, [currentLine]);

  useEffect(() => {
    if (!currentLine || renderHtml) return;
    // Delay to let SyntaxHighlighter render line elements. `renderHtml` is a dependency
    // because an html file opens rendered: the line elements only exist once the user
    // switches to Source, and without it that switch landed at the top of the file.
    const timer = setTimeout(scrollToLine, 50);
    return () => clearTimeout(timer);
  }, [currentLine, code, scrollToLine, renderHtml]);

  // A followed document starts at the top, not where the previous one was.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [current.path]);

  function openInEditor(e: React.MouseEvent) {
    e.stopPropagation();
    postMessage({ type: 'openFile', path: current.path, line: current.line });
  }

  function goBack(e: React.MouseEvent) {
    e.stopPropagation();
    setStack(prev => prev.slice(0, -1));
  }

  function handleCopyPath(e: React.MouseEvent) {
    e.stopPropagation();
    copy(current.path, 'path');
  }

  function handleCopyCmd(e: React.MouseEvent) {
    e.stopPropagation();
    if (!copyText) return;
    copy(copyText, 'cmd');
  }

  return createPortal(
    <div className={modal.overlay} onClick={onClose} aria-hidden="true">
      <div
        className={modal.modal}
        role="dialog"
        aria-label={`File viewer: ${filename}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={modal.header}>
          <div className={modal.titleRow}>
            {stack.length > 0 && (
              <button className={modal.btnIcon} onClick={goBack} title="Back" aria-label="Back">
                <BackIcon />
              </button>
            )}
            <span className={modal.title} title={current.path}>{current.path}</span>
            <button className={modal.btnIcon} onClick={handleCopyPath} title="Copy path to clipboard" aria-label="Copy path">
              {copied === 'path' ? <CheckIcon /> : <CopyIcon />}
            </button>
            {copyText && (
              <button className={modal.btnIcon} onClick={handleCopyCmd} title="Copy command to clipboard" aria-label="Copy command">
                {copied === 'cmd' ? <CheckIcon /> : <CopyIcon />}
              </button>
            )}
          </div>
          <div className={modal.actions}>
            {isHtml && !loading && (
              <button
                className={modal.btnOpen}
                onClick={e => { e.stopPropagation(); setShowSource(v => !v); }}
                title={showSource ? 'Render the HTML' : 'Show the HTML source'}
              >
                {showSource ? 'Preview' : 'Source'}
              </button>
            )}
            {!isImage && !renderHtml && !loading && <EncodingSelect value={encoding} onChange={setEncoding} />}
            {/* No editor to open in outside VS Code - the button was a silent no-op there. */}
            {isVsCode && (
              <button className={modal.btnOpen} onClick={openInEditor} title="Open in VS Code editor">
                Open in editor
              </button>
            )}
            <button className={modal.close} aria-label="Close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className={`${modal.body} fileViewerBody`} ref={bodyRef}>
          {loading ? (
            <div
              className={styles.loadingBody}
              role="status"
              aria-live="polite"
              aria-busy="true"
              aria-label="Loading preview"
              data-testid="preview-loading"
            >
              <div className="previewSpinner" />
            </div>
          ) : isImage ? (
            <div className={styles.imageBody}>
              <img src={content} alt={filename} />
            </div>
          ) : renderHtml ? (
            // srcdoc in a fully restricted sandbox: no scripts, no forms, no access to
            // this page's origin. The file was written by whatever the agent was doing
            // and is not trusted content - an inline `onerror=` would run in the app's
            // own origin otherwise, next to the live WS. A document that needs its
            // script (an unpkg mermaid export, say) shows its static text instead.
            <iframe
              className={styles.htmlFrame}
              srcDoc={htmlDoc}
              sandbox=""
              title={`HTML preview: ${filename}`}
              data-testid="html-preview"
            />
          ) : language === 'markdown' ? (
            <div className={styles.mdBody}>
              <PreviewNavContext.Provider value={navigate}>
                <Markdown breaks>{code}</Markdown>
              </PreviewNavContext.Provider>
            </div>
          ) : (
            <SyntaxHighlighter
              language={language}
              style={isDark ? vscDarkPlus : vs}
              showLineNumbers
              wrapLines
              wrapLongLines={false}
              lineProps={(lineNumber: number) =>
                line && lineNumber === line
                  ? { 'data-line': lineNumber, className: 'highlighted-line' }
                  : { 'data-line': lineNumber }
              }
              customStyle={{
                margin: 0,
                borderRadius: 0,
                flex: 1,
                overflow: 'auto',
                fontSize: '13px',
                lineHeight: '1.5',
                background: 'transparent',
                height: '100%',
              }}
              codeTagProps={{ style: { fontFamily: 'var(--font-mono)', background: 'transparent' } }}
            >
              {code}
            </SyntaxHighlighter>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
