import React from 'react';
import ReactMarkdown from 'react-markdown';

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={{
        pre({ children }) {
          return (
            <pre style={{ background: 'var(--tool-bg)', borderRadius: 4, padding: '8px 10px', overflowX: 'auto', margin: '6px 0' }}>
              {children}
            </pre>
          );
        },
        code({ children, className }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code style={{ background: 'var(--tool-bg)', padding: '1px 4px', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: '0.9em' }}>
                {children}
              </code>
            );
          }
          return (
            <code style={{ background: 'none', padding: 0, fontSize: '0.9em', fontFamily: 'var(--font-mono)' }}>
              {children}
            </code>
          );
        },
        a({ href, children }) {
          return <a href={href} style={{ color: 'var(--vscode-textLink-foreground)' }}>{children}</a>;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
