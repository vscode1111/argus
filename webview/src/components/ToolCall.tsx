import React, { useState } from 'react';
import { ToolCallData } from '../types';
import { postMessage } from '../vscode';
import { useSettings } from '../contexts/SettingsContext';
import { FileViewerModal } from './FileViewerModal';

function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read': {
      const path = (input.file_path as string) || '';
      const offset = input.offset as number | undefined;
      const limit = input.limit as number | undefined;
      if (offset !== undefined && limit !== undefined) return `${path}:${offset}-${offset + limit}`;
      if (offset !== undefined) return `${path}:${offset}`;
      if (limit !== undefined) return `${path}:1-${limit}`;
      return path;
    }
    case 'Write':
    case 'Edit':
      return (input.file_path as string) || '';
    case 'Bash':
      return (input.description as string) || (input.command as string) || '';
    case 'Glob':
    case 'Grep':
      return (input.pattern as string) || '';
    case 'WebSearch':
      return (input.query as string) || '';
    case 'WebFetch':
      return (input.url as string) || '';
    case 'Task':
      return (input.description as string) || '';
    default: {
      const first = Object.values(input).find(v => typeof v === 'string' && (v as string).length > 0);
      return (first as string) || '';
    }
  }
}

interface Props {
  call: ToolCallData;
}

export function ToolCall({ call }: Props) {
  const { verboseTools, showOutput } = useSettings();
  const { name, input, result, error } = call;
  const isFile = ['Read', 'Write', 'Edit'].includes(name);
  const summary = toolSummary(name, input);
  const limit = name === 'Bash' ? 600 : 200;
  const preview = result ? result.slice(0, limit) + (result.length > limit ? '...' : '') : undefined;
  const [viewerOpen, setViewerOpen] = useState(false);
  const bashCommand = name === 'Bash' ? (input.command as string) || '' : '';

  // For Read: open inline viewer. For Write/Edit: open in VS Code.
  function handleFileClick(e: React.MouseEvent, path: string) {
    e.preventDefault();
    if (name === 'Read' && result) {
      setViewerOpen(true);
    } else {
      postMessage({ type: 'openFile', path });
    }
  }

  return (
    <>
      <div className={`tool-call${error ? ' error' : ''}`}>
        {verboseTools ? (
          <pre className="tool-input">
            <span className="tool-name">{name}</span>
            {'\n'}{JSON.stringify(input, null, 2)}
          </pre>
        ) : (
          <div className="tool-header">
            <span className="tool-name">{name}</span>
            {summary && (
              isFile ? (
                <a
                  className="tool-summary tool-file-link"
                  href="#"
                  onClick={e => handleFileClick(e, summary)}
                >
                  {summary}
                </a>
              ) : (
                <span className="tool-summary">{summary}</span>
              )
            )}
            {name === 'Bash' && result && (
              <a
                className="tool-out-link"
                href="#"
                onClick={e => { e.preventDefault(); setViewerOpen(true); }}
              >
                Out
              </a>
            )}
          </div>
        )}
        {!verboseTools && name === 'Bash' && bashCommand && summary !== bashCommand && (
          <div className="tool-command">{bashCommand}</div>
        )}
        {showOutput && preview !== undefined && (
          <div className="tool-result">{preview}</div>
        )}
      </div>
      {viewerOpen && result && (
        <FileViewerModal
          path={name === 'Bash'
            ? (summary !== bashCommand && summary ? `${summary}: ${bashCommand}` : bashCommand || summary)
            : ((input.file_path as string) || summary)}
          content={result}
          copyText={name === 'Bash' ? bashCommand || undefined : undefined}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}
