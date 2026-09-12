import React, { useMemo, useState, useEffect } from 'react';
import { ToolCallData } from '../types';
import { postMessage } from '../vscode';
import { useSettings } from '../contexts/SettingsContext';
import { plural } from '../utils/text';
import { usePreview, type PreviewRequest } from '../contexts/PreviewContext';
import styles from './ToolCall.module.css';

// The CLI can deliver AskUserQuestion's `questions` as a JSON string rather than the
// declared array, so every reader has to parse it - a throw here unmounts the whole React
// tree, and a silent miss (indexing a string) yields its first character, not a question.
function parseAskQuestions(raw: unknown): unknown[] {
  const parsed = typeof raw === 'string'
    ? (() => { try { return JSON.parse(raw); } catch { return []; } })()
    : raw;
  return Array.isArray(parsed) ? parsed : [];
}

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
      const qs = parseAskQuestions(input.questions) as Array<{ header?: string }>;
      return qs[0]?.header || '';
    }
    default: {
      const first = Object.values(input).find(v => typeof v === 'string' && (v as string).length > 0);
      return (first as string) || '';
    }
  }
}

interface Props {
  call: ToolCallData;
  sessionDone?: boolean;
}

export function ToolCall({ call, sessionDone }: Props) {
  const { verboseTools, showOutput } = useSettings();
  const { name, input, result, error } = call;
  const isFile = ['Read', 'Write', 'Edit'].includes(name);
  const summary = toolSummary(name, input);
  const limit = name === 'Bash' ? 600 : 200;
  const preview = result ? result.slice(0, limit) + (result.length > limit ? '...' : '') : undefined;
  const previewer = usePreview();
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string | string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState(0);
  const bashCommand = name === 'Bash' ? (input.command as string) || '' : '';
  // True when the row shows two summaries: Bash's own description, then the command it ran.
  const bashDesc = name === 'Bash' && !!bashCommand && summary !== bashCommand;
  const agentType = name === 'Agent' ? (input.subagent_type as string) || '' : '';
  const resultLineCount = useMemo(
    () => result ? result.trim().split('\n').filter(Boolean).length : 0,
    [result]
  );
  // A resultless tool is only genuinely "working" while its turn is live. Once the turn
  // is over the tool never will come back, so it must not keep pulsing: `done` rewrites
  // such blocks via finalizeBlocks(), but only inside `state.streaming` - a transcript
  // replayed from disk never passed through it and would otherwise pulse forever.
  const pending = !result && !error && !sessionDone;
  const hasDiff = name === 'Edit' && !!(input.old_string || input.new_string);
  const oldLines = hasDiff ? String(input.old_string || '').split('\n') : [];
  const newLines = hasDiff ? String(input.new_string || '').split('\n') : [];

  const IMAGE_EXTS = /\.(jpe?g|png|gif|bmp|webp|ico|tiff?)$/i;
  const filePath = (input.file_path as string) || summary;
  const isImageFile = IMAGE_EXTS.test(filePath);

  const fileViewerContent =
    name === 'Read' ? result :
    name === 'Write' ? (input.content as string) || undefined :
    name === 'Edit' ? (input.new_string as string) || undefined :
    undefined;

  // What this tool's file/output preview shows. An image has no content here - the
  // bytes are stripped before the result crosses the wire, so the host fetches them
  // from the transcript by tool call id (falling back to reading the file).
  function fileRequest(): PreviewRequest | null {
    if (isImageFile) return { kind: 'toolImage', key: `${call.id}:file`, path: filePath, toolUseId: call.id };
    const content = fileViewerContent ?? result;
    if (content === undefined) return null;
    return {
      kind: 'file',
      key: `${call.id}:file`,
      path: name === 'Bash'
        ? (summary !== bashCommand && summary ? `${summary}: ${bashCommand}` : bashCommand || summary)
        : ((input.file_path as string) || summary),
      content,
      line: name === 'Read' && input.offset != null ? (input.offset as number) : undefined,
      copyText: name === 'Bash' ? bashCommand || undefined : undefined,
    };
  }

  function openFilePreview(): void {
    const req = fileRequest();
    if (req) previewer.open(req);
  }

  function openDiff(): void {
    previewer.open({
      kind: 'diff',
      key: `${call.id}:diff`,
      path: (input.file_path as string) || summary,
      oldString: String(input.old_string || ''),
      newString: String(input.new_string || ''),
    });
  }

  // A background Bash task reports its output long after the modal was opened, so
  // push the new result into the open preview instead of leaving a stale snapshot.
  useEffect(() => {
    const req = fileRequest();
    if (req && req.kind === 'file') previewer.refresh(req);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  function handleFileClick(e: React.MouseEvent) {
    e.preventDefault();
    if (isImageFile || fileViewerContent) {
      openFilePreview();
    } else {
      postMessage({ type: 'openFile', path: summary });
    }
  }

  if (name === 'AskUserQuestion') {
    type AskQuestion = {
      question: string;
      header: string;
      multiSelect?: boolean;
      options: Array<{ label: string; description?: string }>;
    };
    const questions = parseAskQuestions(input.questions) as AskQuestion[];

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

    const rawQ = questions[activeTab] || questions[0];
    // Auto-inject "Other" option if not already present
    const q = rawQ && !rawQ.options.some(o => o.label === 'Other')
      ? { ...rawQ, options: [...rawQ.options, { label: 'Other' }] }
      : rawQ;
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
          </div>
        )}
        {isCancelled && (
          <div className={styles.askCancelled}>Session ended</div>
        )}
        {!isPending && !isCancelled && Object.keys(answeredMap).length > 0 && (
          <div className={styles.askResultSummary}>
            User has answered your questions: {Object.entries(answeredMap).map(([q, a]) => `"${q}"="${a}"`).join(', ')}
          </div>
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
            {isFile && fileViewerContent ? (
              <a className={[styles.toolName, styles.toolFileLink, pending && styles.toolNamePending].filter(Boolean).join(' ')} href="#" onClick={handleFileClick}>{name}</a>
            ) : (
              <span className={[styles.toolName, pending && styles.toolNamePending].filter(Boolean).join(' ')}>{name}</span>
            )}
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
                  title={summary}
                >
                  {summary}
                </a>
              ) : (
                <span className={[styles.toolSummary, name === 'Bash' && summary === bashCommand && styles.toolSummaryBash, bashDesc && styles.toolSummaryDesc].filter(Boolean).join(' ')} title={summary}>{summary}</span>
              )
            )}
            {bashDesc && (
              <span className={[styles.toolSummary, styles.toolSummaryBash].join(' ')} title={bashCommand}>{bashCommand}</span>
            )}
            {name === 'Bash' && result && (
              <a
                className={[styles.toolOutLink, !sessionDone && result.startsWith('Command running in background') && styles.toolOutLinkRunning].filter(Boolean).join(' ')}
                href="#"
                onClick={e => { e.preventDefault(); openFilePreview(); }}
              >
                Out
              </a>
            )}
            {(name === 'Glob' || name === 'Grep') && result && (
              /^No (?:files|matches) found/i.test(result.trim()) ? (
                <span className={styles.toolResultEmpty}>{result!.trim()}</span>
              ) : resultLineCount <= 1 ? (
                <span className={styles.toolResultInline}>{result!.trim()}</span>
              ) : (
                <a
                  className={styles.toolResultCount}
                  href="#"
                  onClick={e => { e.preventDefault(); openFilePreview(); }}
                >
                  {plural(resultLineCount, name === 'Glob' ? 'file' : 'line of output', name === 'Glob' ? 'files' : 'lines of output')}
                </a>
              )
            )}
            {hasDiff && (
              <>
                <span className={styles.statsAdded}>+{newLines.length}</span>
                <span className={styles.statsRemoved}>-{oldLines.length}</span>
                <a
                  className={styles.toolOutLink}
                  href="#"
                  onClick={e => { e.preventDefault(); openDiff(); }}
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
    </>
  );
}
