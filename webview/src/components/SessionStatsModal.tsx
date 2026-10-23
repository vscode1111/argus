import React, { useState } from 'react';
import { postMessage } from '../vscode';
import type { RequestStat } from '../types';
import { useWebviewMessage } from '../hooks/useWebviewMessage';
import { formatDuration } from '../utils/time';
import { Modal } from './shared/Modal';
import { RefreshButton } from './shared/RefreshButton';
import shell from './shared/centeredModal.module.css';
import styles from './SessionStatsModal.module.css';

interface Props {
  sessionId: string;
  title: string;
  onTaskKeyChange: (taskKey: string | null) => void;
  onClose: () => void;
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : formatDuration(ms);
}

function tokens(value: number | null): string {
  return value === null ? '-' : value.toLocaleString();
}

export function SessionStatsModal({ sessionId, title, onTaskKeyChange, onClose }: Props) {
  const [requests, setRequests] = useState<RequestStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [taskKey, setTaskKey] = useState('');
  const [taskError, setTaskError] = useState('');
  useWebviewMessage(e => {
    if (e.data?.id !== sessionId) return;
    if (e.data.type === 'sessionStats') {
      setRequests(Array.isArray(e.data.requests) ? e.data.requests : []);
      setTaskKey(typeof e.data.taskKey === 'string' ? e.data.taskKey : '');
      setLoading(false);
    } else if (e.data.type === 'sessionTaskKey') {
      if (e.data.error) setTaskError(String(e.data.error));
      else {
        const key = typeof e.data.taskKey === 'string' ? e.data.taskKey : null;
        setTaskKey(key ?? '');
        setTaskError('');
        onTaskKeyChange(key);
      }
    }
  }, () => postMessage({ type: 'getSessionStats', id: sessionId }));

  function refresh() {
    setLoading(true);
    postMessage({ type: 'getSessionStats', id: sessionId });
  }

  const totalInput = requests.length && requests.every(request => request.inputTokens !== null)
    ? requests.reduce((sum, request) => sum + (request.inputTokens ?? 0), 0) : null;
  const totalOutput = requests.length && requests.every(request => request.outputTokens !== null)
    ? requests.reduce((sum, request) => sum + (request.outputTokens ?? 0), 0) : null;
  const totalDuration = requests.reduce((sum, request) => sum + request.durationMs, 0);
  const latest = requests[requests.length - 1];

  return (
    <Modal title={`Statistics: ${title}`} ariaLabel="Session statistics" onClose={onClose} elevated width={600} fullHeight
      headerActions={<RefreshButton spinning={loading} onClick={refresh} label="Refresh statistics" title="Refresh statistics" />}>
      <form className={styles.taskRow} onSubmit={event => { event.preventDefault(); postMessage({ type: 'setSessionTaskKey', id: sessionId, taskKey }); }}>
        <label htmlFor="session-task-key">Issue key</label>
        <input id="session-task-key" aria-label="Issue key" value={taskKey} placeholder="SCSOL-29"
          onChange={event => { setTaskKey(event.target.value); setTaskError(''); }} />
        <button type="submit">Save</button>
        {taskError && <span role="alert">{taskError}</span>}
      </form>
      <div className={styles.summary}>
        <div><strong>{requests.length.toLocaleString()}</strong><span>Completed requests</span></div>
        <div><strong>{duration(totalDuration)}</strong><span>Total duration</span></div>
        <div><strong>{tokens(totalInput)}</strong><span>Input tokens</span></div>
        <div><strong>{tokens(totalOutput)}</strong><span>Output tokens</span></div>
      </div>
      {latest && <div className={styles.meta}>
        <span>{latest.providerId}{latest.model ? ` · ${latest.model}` : ''}</span>
        <span title={latest.workspacePath}>{latest.workspacePath}</span>
      </div>}
      <div className={shell.body} aria-live="polite">
        {loading && !requests.length ? <div className={shell.placeholder}>Loading...</div>
          : !requests.length ? <div className={shell.placeholder}>No completed requests have been recorded for this session yet. Statistics start with new requests.</div>
            : <table className={styles.table}>
              <thead><tr><th scope="col">Started</th><th scope="col">Duration</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Outcome</th></tr></thead>
              <tbody>{[...requests].reverse().map(request => <tr key={request.id}>
                <td title={new Date(request.startedAt).toLocaleString()}>{new Date(request.startedAt).toLocaleString()}</td>
                <td>{duration(request.durationMs)}</td>
                <td>{tokens(request.inputTokens)}</td>
                <td>{tokens(request.outputTokens)}</td>
                <td>{request.outcome}</td>
              </tr>)}</tbody>
            </table>}
      </div>
    </Modal>
  );
}
