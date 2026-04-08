import React, { useEffect, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { postMessage } from '../vscode';
import { Markdown } from '../utils/markdown';

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
  copyText?: string;
  onClose: () => void;
}

export function FileViewerModal({ path, content, copyText, onClose }: Props) {
  // Default to dark unless VS Code explicitly marks the theme as light.
  const isDark = !document.body.classList.contains('vscode-light');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const language = detectLanguage(path);
  const code = stripLineNumbers(content);
  const filename = path.split(/[\\/]/).pop() ?? path;

  function openInEditor(e: React.MouseEvent) {
    e.stopPropagation();
    postMessage({ type: 'openFile', path });
  }

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    if (!copyText) return;
    navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="fv-overlay" onClick={onClose} aria-hidden="true">
      <div
        className="fv-modal"
        role="dialog"
        aria-label={`File viewer: ${filename}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="fv-header">
          <div className="fv-title-row">
            <span className="fv-title" title={path}>{path}</span>
            {copyText && (
              <button className="fv-btn-icon" onClick={handleCopy} title="Copy command to clipboard" aria-label="Copy command">
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
          <div className="fv-actions">
            <button className="fv-btn-open" onClick={openInEditor} title="Open in VS Code editor">
              Open in editor
            </button>
            <button className="fv-close" aria-label="Close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="fv-body">
          {language === 'markdown' ? (
            <div className="fv-md-body">
              <Markdown breaks>{code}</Markdown>
            </div>
          ) : (
            <SyntaxHighlighter
              language={language}
              style={isDark ? vscDarkPlus : vs}
              showLineNumbers
              wrapLongLines={false}
              customStyle={{
                margin: 0,
                borderRadius: 0,
                flex: 1,
                overflow: 'auto',
                fontSize: '13px',
                lineHeight: '1.5',
                background: 'var(--tool-bg)',
                height: '100%',
              }}
              codeTagProps={{ style: { fontFamily: 'var(--font-mono)' } }}
            >
              {code}
            </SyntaxHighlighter>
          )}
        </div>
      </div>
    </div>
  );
}
