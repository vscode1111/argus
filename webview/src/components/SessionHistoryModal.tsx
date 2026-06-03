import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { postMessage } from '../vscode';
import { SessionSummary } from '../types';
import styles from './SessionHistoryModal.module.css';

interface Props {
  onClose: () => void;
}

// Compact relative age, e.g. "now", "5m", "3h 12m", "2d 4h".
function relativeTime(updatedAt: number): string {
  const diff = Date.now() - updatedAt;
  if (diff < 60_000) return 'now';
  const totalMin = Math.floor(diff / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const min = totalMin % 60;
    return min ? `${totalHr}h ${min}m` : `${totalHr}h`;
  }
  const days = Math.floor(totalHr / 24);
  const hr = totalHr % 24;
  return hr ? `${days}d ${hr}h` : `${days}d`;
}

export function SessionHistoryModal({ onClose }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Escape closes the modal, except while inline-renaming (handled per-input).
  useEscapeKey(() => {
    if (editingId) return;
    onClose();
  });

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type !== 'sessionList') return;
      setSessions(Array.isArray(e.data.sessions) ? e.data.sessions : []);
      setCurrentId(typeof e.data.currentId === 'string' ? e.data.currentId : undefined);
      setLoading(false);
      setRefreshing(false);
    }
    window.addEventListener('message', handleMessage);
    postMessage({ type: 'listSessions' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Re-fetch the list from disk; the spinner stops when the sessionList reply lands.
  function refresh() {
    setRefreshing(true);
    postMessage({ type: 'listSessions' });
  }

  function resume(id: string) {
    postMessage({ type: 'resumeSession', id });
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

  return createPortal(
    <>
      <div className={styles.overlay} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal} role="dialog" aria-label="Session History">
        <div className={styles.header}>
          <span className={styles.title}>Session History</span>
          <div className={styles.headerActions}>
            <button
              className={[styles.refreshBtn, refreshing ? styles.refreshing : ''].filter(Boolean).join(' ')}
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh sessions"
              title="Refresh session list"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            <button className={styles.close} onClick={onClose} aria-label="Close">&times;</button>
          </div>
        </div>

        <div className={styles.searchRow}>
          <input
            className={styles.search}
            type="text"
            placeholder="Search sessions..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search sessions"
          />
        </div>

        <div className={styles.body}>
          {loading ? (
            <div className={styles.placeholder}>Loading...</div>
          ) : filtered.length === 0 ? (
            <div className={styles.placeholder}>
              {sessions.length === 0 ? 'No sessions yet.' : 'No matching sessions.'}
            </div>
          ) : (
            filtered.map(s => (
              <div
                key={s.id}
                className={[styles.row, s.id === currentId ? styles.rowCurrent : '', editingId === s.id ? styles.rowEditing : ''].filter(Boolean).join(' ')}
                onClick={() => editingId === s.id ? undefined : resume(s.id)}
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
      </div>
    </>,
    document.body
  );
}
