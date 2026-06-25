import React, { useState, useRef, useEffect } from 'react';
import { postMessage } from '../vscode';
import { getDialogState, patchDialogState } from '../utils/dialogState';
import { SessionSummary, GlobalSessionSummary } from '../types';
import { Modal } from './shared/Modal';
import { RefreshButton } from './shared/RefreshButton';
import { useWebviewMessage } from '../hooks/useWebviewMessage';
import { relativeTime } from '../utils/time';
import { fmtLineCount } from '../utils/text';
import shell from './shared/centeredModal.module.css';
import styles from './SessionHistoryModal.module.css';

interface Props {
  currentPath: string;
  // Resume a session that may belong to another workspace ("All workspaces" tab):
  // App switches the panel to that workspace first (if needed), then resumes.
  // `lines` (the session's content size) is forwarded so the loading overlay can
  // label the spinner, e.g. "Loading… 17k lines".
  onResumeWorkspaceSession: (workspacePath: string, sessionId: string, lines?: number) => void;
  onClose: () => void;
}

type Tab = 'workspace' | 'all';

export function SessionHistoryModal({ currentPath, onResumeWorkspaceSession, onClose }: Props) {
  // Remember the selected tab in-memory (reset on page refresh).
  const [tab, setTabState] = useState<Tab>(() => (getDialogState('sessionHistory')?.tab as Tab) || 'workspace');
  const setTab = (t: Tab) => { setTabState(t); patchDialogState('sessionHistory', { tab: t }); };

  // This-workspace tab state
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // All-workspaces tab state (global, lazy-loaded on first open)
  const [allSessions, setAllSessions] = useState<GlobalSessionSummary[]>([]);
  const [allCurrentId, setAllCurrentId] = useState<string | undefined>(undefined);
  const [allLoading, setAllLoading] = useState(true);
  const [allQuery, setAllQuery] = useState('');
  const [allRefreshing, setAllRefreshing] = useState(false);
  const allLoaded = useRef(false);

  useWebviewMessage(
    (e: MessageEvent) => {
      if (e.data?.type === 'sessionList') {
        setSessions(Array.isArray(e.data.sessions) ? e.data.sessions : []);
        setCurrentId(typeof e.data.currentId === 'string' ? e.data.currentId : undefined);
        setLoading(false);
        setRefreshing(false);
      } else if (e.data?.type === 'allSessionList') {
        setAllSessions(Array.isArray(e.data.sessions) ? e.data.sessions : []);
        setAllCurrentId(typeof e.data.currentId === 'string' ? e.data.currentId : undefined);
        setAllLoading(false);
        setAllRefreshing(false);
      }
    },
    () => postMessage({ type: 'listSessions' }),
  );

  // If the restored tab is "All workspaces", lazy-load its list on mount.
  useEffect(() => {
    if (tab === 'all' && !allLoaded.current) {
      allLoaded.current = true;
      postMessage({ type: 'listAllSessions' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch the list from disk; the spinner stops when the sessionList reply lands.
  function refresh() {
    setRefreshing(true);
    postMessage({ type: 'listSessions' });
  }

  // Open the global "All workspaces" tab; load lazily on first visit.
  function openAll() {
    setTab('all');
    if (!allLoaded.current) {
      allLoaded.current = true;
      postMessage({ type: 'listAllSessions' });
    }
  }

  function refreshAll() {
    setAllRefreshing(true);
    postMessage({ type: 'listAllSessions' });
  }

  function resume(id: string, lines: number) {
    // Route through the same App handler as the "All workspaces" tab so the
    // loading spinner is shown; for a same-workspace id it just posts resumeSession.
    onResumeWorkspaceSession(currentPath, id, lines);
    onClose();
  }

  // Resume a global session: switch to its workspace first when it differs.
  function resumeGlobal(s: GlobalSessionSummary) {
    onResumeWorkspaceSession(s.workspacePath, s.id, s.lines);
    onClose();
  }

  function remove(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    postMessage({ type: 'deleteSession', id });
    // Optimistic removal; the server also replies with a fresh sessionList.
    setSessions(prev => prev.filter(s => s.id !== id));
  }

  function startEdit(e: React.MouseEvent, s: SessionSummary) {
    e.stopPropagation();
    setEditingId(s.id);
    setEditValue(s.title);
  }

  function commitEdit(id: string) {
    const title = editValue.trim();
    if (title) {
      postMessage({ type: 'renameSession', id, title });
      // Optimistic update; the server also replies with a fresh sessionList.
      setSessions(prev => prev.map(s => (s.id === id ? { ...s, title } : s)));
    }
    setEditingId(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter(s => s.title.toLowerCase().includes(q) || s.lastPrompt.toLowerCase().includes(q))
    : sessions;

  const aq = allQuery.trim().toLowerCase();
  const filteredAll = aq
    ? allSessions.filter(s =>
        s.title.toLowerCase().includes(aq) ||
        s.lastPrompt.toLowerCase().includes(aq) ||
        s.workspaceName.toLowerCase().includes(aq) ||
        s.workspacePath.toLowerCase().includes(aq))
    : allSessions;

  return (
    <Modal
      title="Session History"
      ariaLabel="Session History"
      onClose={onClose}
      width={440}
      fullHeight
      persistKey="sessionHistory"
      // Escape closes the modal, except while inline-renaming (handled per-input).
      onEscape={() => { if (!editingId) onClose(); }}
      headerActions={tab === 'workspace'
        ? <RefreshButton spinning={refreshing} onClick={refresh} label="Refresh sessions" title="Refresh session list" />
        : <RefreshButton spinning={allRefreshing} onClick={refreshAll} label="Refresh all sessions" title="Refresh global session list" />}
    >
      <div className={shell.tabs} role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'workspace'}
          className={[shell.tab, tab === 'workspace' ? shell.tabActive : ''].filter(Boolean).join(' ')}
          onClick={() => setTab('workspace')}
        >
          This workspace
        </button>
        <button
          role="tab"
          aria-selected={tab === 'all'}
          className={[shell.tab, tab === 'all' ? shell.tabActive : ''].filter(Boolean).join(' ')}
          onClick={openAll}
        >
          All workspaces
        </button>
      </div>

      {tab === 'workspace' ? (
        <>
          <div className={shell.searchRow}>
            <input
              className={shell.search}
              type="text"
              placeholder="Search sessions..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Search sessions"
            />
          </div>

          <div className={shell.body}>
            {loading ? (
              <div className={shell.placeholder}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div className={shell.placeholder}>
                {sessions.length === 0 ? 'No sessions yet.' : 'No matching sessions.'}
              </div>
            ) : (
              filtered.map(s => (
                <div
                  key={s.id}
                  className={[styles.row, s.id === currentId ? shell.rowCurrent : '', editingId === s.id ? styles.rowEditing : ''].filter(Boolean).join(' ')}
                  onClick={() => editingId === s.id ? undefined : resume(s.id, s.lines)}
                  title={s.lastPrompt || s.title}
                >
                  <div className={styles.rowMain}>
                    {editingId === s.id ? (
                      <input
                        className={styles.renameInput}
                        type="text"
                        value={editValue}
                        autoFocus
                        onClick={e => e.stopPropagation()}
                        onChange={e => setEditValue(e.target.value)}
                        onBlur={() => commitEdit(s.id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitEdit(s.id); }
                          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
                        }}
                        aria-label="Rename session"
                      />
                    ) : (
                      <span className={styles.rowTitle}>{s.title}</span>
                    )}
                  </div>
                  {editingId !== s.id && (
                    <>
                      <span className={styles.rowCount}>{s.lines > 0 ? fmtLineCount(s.lines) : ''}</span>
                      <span className={styles.rowTime}>{relativeTime(s.updatedAt)}</span>
                      <button
                        className={styles.editBtn}
                        onClick={e => startEdit(e, s)}
                        aria-label="Rename session"
                        title="Rename session"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                        </svg>
                      </button>
                      <button
                        className={styles.deleteBtn}
                        onClick={e => remove(e, s.id)}
                        aria-label="Delete session"
                        title="Delete session"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <div className={shell.searchRow}>
            <input
              className={shell.search}
              type="text"
              placeholder="Search all sessions..."
              value={allQuery}
              onChange={e => setAllQuery(e.target.value)}
              aria-label="Search all sessions"
            />
          </div>

          <div className={shell.body}>
            {allLoading ? (
              <div className={shell.placeholder}>Loading...</div>
            ) : filteredAll.length === 0 ? (
              <div className={shell.placeholder}>
                {allSessions.length === 0 ? 'No recent sessions.' : 'No matching sessions.'}
              </div>
            ) : (
              filteredAll.map(s => (
                <div
                  key={s.id}
                  className={[styles.row, s.id === allCurrentId ? shell.rowCurrent : ''].filter(Boolean).join(' ')}
                  onClick={() => resumeGlobal(s)}
                  title={`${s.title}\n${s.workspacePath}`}
                >
                  <div className={styles.allRowMain}>
                    <span className={styles.rowTitle}>{s.title}</span>
                    <span className={styles.rowSub}>{s.workspaceName}</span>
                  </div>
                  <span className={styles.rowCount}>{s.lines > 0 ? fmtLineCount(s.lines) : ''}</span>
                  <span className={styles.rowTimeStatic}>{relativeTime(s.updatedAt)}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
