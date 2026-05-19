import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  endLine?: number;
  copyText?: string;
  onClose: () => void;
}

const isDataUrl = (s: string) => s.startsWith('data:image/');

export function FileViewerModal({ path, content, line, endLine, copyText, onClose }: Props) {
  // Default to dark unless VS Code explicitly marks the theme as light.
  const isDark = !document.body.classList.contains('vscode-light');
  const [copied, setCopied] = useState(false);

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

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    if (!copyText) return;
    navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
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
            {copyText && (
              <button className={modal.btnIcon} onClick={handleCopy} title="Copy command to clipboard" aria-label="Copy command">
                {copied ? (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M2 8L6 12L14 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <rect x="5" y="1" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                    <path d="M5 4H3.5A1.5 1.5 0 0 0 2 5.5v8A1.5 1.5 0 0 0 3.5 15h7A1.5 1.5 0 0 0 12 13.5V12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                )}
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
        <div className={modal.body} ref={bodyRef}>
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
              lineProps={(lineNumber: number) => {
                const props: Record<string, unknown> = { 'data-line': lineNumber };
                const lo = line ?? 0;
                const hi = endLine ?? lo;
                if (lo && lineNumber >= lo && lineNumber <= hi) {
                  props.style = { background: 'var(--diff-added-bg, rgba(55, 148, 255, 0.15))' };
                  props.className = 'highlighted-line';
                }
                return props;
              }}
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
              codeTagProps={{ style: { fontFamily: 'var(--font-mono)' } }}
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
