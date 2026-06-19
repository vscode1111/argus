import React, { useEffect, useRef, useCallback } from 'react';
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
import { postMessage } from '../vscode';
import { Markdown } from '../utils/markdown';
import { EncodingSelect } from './shared/EncodingSelect';
import { CopyIcon, CheckIcon } from './shared/icons';
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
  onClose: () => void;
}

const isDataUrl = (s: string) => s.startsWith('data:image/');

export function FileViewerModal({ path, content, line, copyText, onClose }: Props) {
  // Default to dark unless VS Code explicitly marks the theme as light.
  const isDark = !document.body.classList.contains('vscode-light');
  const { copied, copy } = useCopyFeedback();

  useEscapeKey(onClose);

  const isImage = isDataUrl(content);
  const language = isImage ? 'text' : detectLanguage(path);
  const rawCode = isImage ? '' : stripLineNumbers(content);
  const { encoding, setEncoding, decoded: code } = useEncoding(rawCode);
  const filename = path.split(/[\\/]/).pop() ?? path;

  const bodyRef = useRef<HTMLDivElement>(null);

  const scrollToLine = useCallback(() => {
    if (!line || !bodyRef.current) return;
    const row = bodyRef.current.querySelector(`[data-line="${line}"]`) as HTMLElement | null;
    if (row) {
      row.scrollIntoView({ block: 'center' });
    }
  }, [line]);

  useEffect(() => {
    if (!line) return;
    // Delay to let SyntaxHighlighter render line elements
    const timer = setTimeout(scrollToLine, 50);
    return () => clearTimeout(timer);
  }, [line, code, scrollToLine]);

  function openInEditor(e: React.MouseEvent) {
    e.stopPropagation();
    postMessage({ type: 'openFile', path, line });
  }

  function handleCopyPath(e: React.MouseEvent) {
    e.stopPropagation();
    copy(path, 'path');
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
            <span className={modal.title} title={path}>{path}</span>
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
            {!isImage && <EncodingSelect value={encoding} onChange={setEncoding} />}
            <button className={modal.btnOpen} onClick={openInEditor} title="Open in VS Code editor">
              Open in editor
            </button>
            <button className={modal.close} aria-label="Close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className={`${modal.body} fileViewerBody`} ref={bodyRef}>
          {isImage ? (
            <div className={styles.imageBody}>
              <img src={content} alt={filename} />
            </div>
          ) : language === 'markdown' ? (
            <div className={styles.mdBody}>
              <Markdown breaks>{code}</Markdown>
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
