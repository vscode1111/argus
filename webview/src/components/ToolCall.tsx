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
    case 'TodoWrite':
      return '';
    case 'Agent':
    case 'Task':
      return (input.description as string) || '';
    case 'AskUserQuestion': {
      const qs = input.questions as Array<{ header: string }> | undefined;
      return qs?.[0]?.header || '';
    }
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
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string | string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState(0);
  const bashCommand = name === 'Bash' ? (input.command as string) || '' : '';
  const agentType = name === 'Agent' ? (input.subagent_type as string) || '' : '';
  const resultLineCount = useMemo(
    () => result ? result.trim().split('\n').filter(Boolean).length : 0,
    [result]
  );
  const pending = !result && !error;
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

  if (name === 'AskUserQuestion') {
    const questions = (input.questions as Array<{
      question: string;
      header: string;
      multiSelect?: boolean;
      options: Array<{ label: string; description?: string }>;
    }>) || [];

    const isPending = !result;

    let answeredMap: Record<string, string> = {};
    let isCancelled = false;
    if (result) {
      try {
        const parsed = JSON.parse(result);
        if (parsed.cancelled) isCancelled = true;
        if (parsed.answers) answeredMap = parsed.answers;
      } catch { /* not JSON */ }
    }

    const allAnswered = questions.every(q => {
      const val = selectedAnswers[q.question];
      if (q.multiSelect) {
        if (!Array.isArray(val) || val.length === 0) return false;
        if (val.includes('Other') && !otherText[q.question]?.trim()) return false;
        return true;
      }
      if (typeof val !== 'string' || val.length === 0) return false;
      if (val === 'Other' && !otherText[q.question]?.trim()) return false;
      return true;
    });

    function handleOptionClick(questionText: string, optionLabel: string, multiSelect?: boolean) {
      if (multiSelect) {
        setSelectedAnswers(prev => {
          const current = (prev[questionText] as string[]) || [];
          const next = current.includes(optionLabel)
            ? current.filter(l => l !== optionLabel)
            : [...current, optionLabel];
          return { ...prev, [questionText]: next };
        });
      } else {
        setSelectedAnswers(prev => ({ ...prev, [questionText]: optionLabel }));
      }
    }

    function handleSubmit() {
      const formatted: Record<string, string> = {};
      for (const q of questions) {
        const val = selectedAnswers[q.question];
        const other = otherText[q.question]?.trim() || '';
        if (q.multiSelect && Array.isArray(val)) {
          const resolved = val.map(v => v === 'Other' ? other : v);
          formatted[q.question] = resolved.join(', ');
        } else if (typeof val === 'string') {
          formatted[q.question] = val === 'Other' ? other : val;
        }
      }
      postMessage({ type: 'toolAnswer', id: call.id, answers: formatted });
    }

    function handleCancel() {
      postMessage({ type: 'toolAnswer', id: call.id, answers: {} });
    }

    const q = questions[activeTab] || questions[0];
    const selectedVal = isPending
      ? selectedAnswers[q?.question]
      : answeredMap[q?.question] || answeredMap[q?.header];

    // "Other" option support
    const knownLabels = q?.options.filter(o => o.label !== 'Other').map(o => o.label) ?? [];
    const isOtherActive = isPending
      ? (q?.multiSelect
          ? Array.isArray(selectedVal) && selectedVal.includes('Other')
          : selectedVal === 'Other')
      : (q?.multiSelect
          ? typeof selectedVal === 'string' && selectedVal.split(', ').some(v => !knownLabels.includes(v))
          : typeof selectedVal === 'string' && selectedVal !== '' && !knownLabels.includes(selectedVal));
    const completedOtherValue = !isPending && isOtherActive && typeof selectedVal === 'string'
      ? (q?.multiSelect
          ? selectedVal.split(', ').filter(v => !knownLabels.includes(v)).join(', ')
          : selectedVal)
      : '';

    return (
      <div className={styles.askDialog}>
        {/* Tab bar */}
        <div className={styles.askTabBar}>
          {questions.map((tab, i) => (
            <button
              key={i}
              className={[styles.askTab, activeTab === i && styles.askTabActive].filter(Boolean).join(' ')}
              onClick={() => setActiveTab(i)}
            >
              {tab.header}
            </button>
          ))}
          {isPending && (
            <button className={styles.askCloseBtn} onClick={handleCancel} aria-label="Cancel">✕</button>
          )}
        </div>

        {/* Active tab content */}
        {q && (
          <div className={styles.askTabContent}>
            <div className={styles.questionText}>{q.question}</div>
            <div className={styles.questionOptions}>
              {q.options.map((opt, j) => {
                const isMulti = q.multiSelect;
                const isOther = opt.label === 'Other';
                const isSelected = isOther
                  ? isOtherActive
                  : isMulti
                    ? (Array.isArray(selectedVal)
                        ? selectedVal.includes(opt.label)
                        : typeof selectedVal === 'string' && selectedVal.split(', ').includes(opt.label))
                    : selectedVal === opt.label;
                return (
                  <div
                    key={j}
                    className={[
                      styles.questionOption,
                      isSelected && styles.questionOptionSelected,
                      isPending && styles.questionOptionClickable,
                    ].filter(Boolean).join(' ')}
                    onClick={isPending ? () => handleOptionClick(q.question, opt.label, isMulti) : undefined}
                  >
                    {isMulti ? (
                      <span className={[styles.questionCheckbox, isSelected && styles.questionCheckboxChecked].filter(Boolean).join(' ')} aria-hidden="true" />
                    ) : (
                      <span className={[styles.questionOptionDot, isSelected && styles.questionOptionDotSelected].filter(Boolean).join(' ')} aria-hidden="true" />
                    )}
                    <div>
                      <div className={styles.questionOptionLabel}>{opt.label}</div>
                      {opt.description && <div className={styles.questionOptionDesc}>{opt.description}</div>}
                      {isOther && !isPending && isSelected && completedOtherValue && (
                        <div className={styles.questionOptionDesc}>{completedOtherValue}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {isPending && isOtherActive && (
              <div className={styles.otherInputWrap}>
                <input
                  className={styles.otherInput}
                  placeholder="Type your answer..."
                  value={otherText[q.question] || ''}
                  onChange={e => setOtherText(prev => ({ ...prev, [q.question]: e.target.value }))}
                  onClick={e => e.stopPropagation()}
                />
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        {isPending && (
          <div className={styles.askFooter}>
            <button className={styles.askSubmitBtn} onClick={handleSubmit} disabled={!allAnswered}>
              Submit answers
            </button>
            <span className={styles.askEscHint}>Esc to cancel</span>
          </div>
        )}
        {isCancelled && (
          <div className={styles.askCancelled}>Session ended</div>
        )}
      </div>
    );
  }

  if (name === 'TodoWrite') {
    const todos = (input.todos as Array<{ id: string; content: string; status: string }>) || [];
    return (
      <div className={styles.todoList}>
        <div className={styles.todoTitle}>
          <span className={styles.todoDot} />
          Update Todos
        </div>
        {todos.map(t => (
          <div
            key={t.id}
            className={[
              styles.todoItem,
              t.status === 'completed' && styles.todoCompleted,
              t.status === 'in_progress' && styles.todoInProgress,
              t.status === 'pending' && styles.todoPending,
            ].filter(Boolean).join(' ')}
          >
            <span className={styles.todoIcon}>
              {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '✱' : '☐'}
            </span>
            {t.content}
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className={[styles.toolCall, error && styles.error].filter(Boolean).join(' ')}>
        {verboseTools ? (
          <pre className={styles.toolInput}>
            <span className={[styles.toolName, pending && styles.toolNamePending].filter(Boolean).join(' ')}>{name}</span>
            {'\n'}{JSON.stringify(input, null, 2)}
          </pre>
        ) : (
          <div className={styles.toolHeader}>
            <span className={[styles.toolName, pending && styles.toolNamePending].filter(Boolean).join(' ')}>{name}</span>
            {name === 'Agent' && agentType && (
              <span className={styles.toolAgentType}>{agentType}</span>
            )}
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
