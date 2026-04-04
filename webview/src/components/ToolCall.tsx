import React from 'react';
import { ToolCallData } from '../types';
import { postMessage } from '../vscode';
import { useSettings } from '../contexts/SettingsContext';

function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
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
  const { verboseTools } = useSettings();
  const { name, input, result, error } = call;
  const isFile = ['Read', 'Write', 'Edit'].includes(name);
  const summary = toolSummary(name, input);
  const preview = result ? result.slice(0, 200) + (result.length > 200 ? '...' : '') : undefined;

  function handleFileClick(e: React.MouseEvent, path: string) {
    e.preventDefault();
    postMessage({ type: 'openFile', path });
  }

  return (
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
        </div>
      )}
      {preview !== undefined && (
        <div className="tool-result">{preview}</div>
      )}
    </div>
  );
}
