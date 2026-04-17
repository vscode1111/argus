import React, { useMemo, useState } from 'react';
import { ToolCallData } from '../types';
import { postMessage } from '../vscode';
import { useSettings } from '../contexts/SettingsContext';
import { FileViewerModal } from './FileViewerModal';
import { DiffViewerModal } from './DiffViewerModal';
import styles from './ToolCall.module.css';

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
    case 'Agent':
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
  const [diffOpen, setDiffOpen] = useState(false);
  const bashCommand = name === 'Bash' ? (input.command as string) || '' : '';
  const agentType = name === 'Agent' ? (input.subagent_type as string) || '' : '';
  const resultLineCount = useMemo(
    () => result ? result.trim().split('\n').filter(Boolean).length : 0,
    [result]
  );
  const hasDiff = name === 'Edit' && !!(input.old_string || input.new_string);
  const oldLines = hasDiff ? String(input.old_string || '').split('\n') : [];
  const newLines = hasDiff ? String(input.new_string || '').split('\n') : [];

  const fileViewerContent =
    name === 'Read' ? result :
    name === 'Write' ? (input.content as string) || undefined :
    name === 'Edit' ? (input.new_string as string) || undefined :
    undefined;

  function handleFileClick(e: React.MouseEvent) {
    e.preventDefault();
    if (fileViewerContent) {
      setViewerOpen(true);
    } else {
      postMessage({ type: 'openFile', path: summary });
    }
  }

  return (
    <>
      <div className={[styles.toolCall, error && styles.error].filter(Boolean).join(' ')}>
        {verboseTools ? (
          <pre className={styles.toolInput}>
            <span className={styles.toolName}>{name}</span>
            {'\n'}{JSON.stringify(input, null, 2)}
          </pre>
        ) : (
          <div className={styles.toolHeader}>
            <span className={styles.toolName}>{name}</span>
            {summary && (
              isFile ? (
                <a
                  className={[styles.toolSummary, styles.toolFileLink].join(' ')}
                  href="#"
                  onClick={handleFileClick}
                >
                  {summary}
                </a>
              ) : (
                <span className={[styles.toolSummary, name === 'Bash' && summary === bashCommand && styles.toolSummaryBash].filter(Boolean).join(' ')}>{summary}</span>
              )
            )}
            {name === 'Agent' && agentType && (
              <span className={styles.toolAgentType}>{agentType}</span>
            )}
            {name === 'Bash' && bashCommand && summary !== bashCommand && (
              <span className={[styles.toolSummary, styles.toolSummaryBash].join(' ')}>{bashCommand}</span>
            )}
            {name === 'Bash' && result && (
              <a
                className={styles.toolOutLink}
                href="#"
                onClick={e => { e.preventDefault(); setViewerOpen(true); }}
              >
                Out
              </a>
            )}
            {(name === 'Glob' || name === 'Grep') && result && (
              <a
                className={styles.toolResultCount}
                href="#"
                onClick={e => { e.preventDefault(); setViewerOpen(true); }}
              >
                {resultLineCount} {name === 'Glob' ? 'files' : 'lines of output'}
              </a>
            )}
            {hasDiff && (
              <>
                <span className={styles.statsAdded}>+{newLines.length}</span>
                <span className={styles.statsRemoved}>-{oldLines.length}</span>
                <a
                  className={styles.toolOutLink}
                  href="#"
                  onClick={e => { e.preventDefault(); setDiffOpen(true); }}
                >
                  Diff
                </a>
              </>
            )}
          </div>
        )}
        {showOutput && preview !== undefined && (
          <div className={styles.toolResult}>{preview}</div>
        )}
      </div>
      {viewerOpen && (result || fileViewerContent) && (
        <FileViewerModal
          path={name === 'Bash'
            ? (summary !== bashCommand && summary ? `${summary}: ${bashCommand}` : bashCommand || summary)
            : ((input.file_path as string) || summary)}
          content={(fileViewerContent ?? result)!}
          copyText={name === 'Bash' ? bashCommand || undefined : undefined}
          onClose={() => setViewerOpen(false)}
        />
      )}
      {diffOpen && hasDiff && (
        <DiffViewerModal
          path={(input.file_path as string) || summary}
          oldString={String(input.old_string || '')}
          newString={String(input.new_string || '')}
          onClose={() => setDiffOpen(false)}
        />
      )}
    </>
  );
}
