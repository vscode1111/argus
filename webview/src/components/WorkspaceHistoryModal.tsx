import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { postMessage } from '../vscode';
import { WorkspaceSummary, DirListing } from '../types';
import { plural } from '../utils/text';
import styles from './WorkspaceHistoryModal.module.css';

interface Props {
  currentPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

type Tab = 'recent' | 'browse';

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

function FolderIcon() {
  return (
    <svg className={styles.folderIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// Workspace switcher dialog, modelled on the Session History modal. Two tabs:
// "Recent" lists projects the CLI has been run in (recovered from
// ~/.claude/projects); "Browse" is a folder explorer over the whole machine.
// Either way, picking a folder reconnects the panel to that workspace in place.
export function WorkspaceHistoryModal({ currentPath, onSelect, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('recent');

  // Recent tab state
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [current, setCurrent] = useState(currentPath);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Browse tab state
  const [dir, setDir] = useState<DirListing | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const browseLoaded = useRef(false);

  useEscapeKey(onClose);

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === 'workspaceList') {
        setWorkspaces(Array.isArray(e.data.workspaces) ? e.data.workspaces : []);
        if (typeof e.data.currentPath === 'string') setCurrent(e.data.currentPath);
        setLoading(false);
        setRefreshing(false);
      } else if (e.data?.type === 'dirList') {
        setDir({
          path: typeof e.data.path === 'string' ? e.data.path : '',
          parent: typeof e.data.parent === 'string' ? e.data.parent : null,
          entries: Array.isArray(e.data.entries) ? e.data.entries : [],
        });
        setDirLoading(false);
      }
    }
    window.addEventListener('message', handleMessage);
    postMessage({ type: 'listWorkspaces' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Re-scan recent workspaces from disk; spinner stops when workspaceList lands.
  function refresh() {
    setRefreshing(true);
    postMessage({ type: 'listWorkspaces' });
  }

  // Navigate the folder explorer. Omitting `path` opens the home directory; ''
  // lists the drive roots ("This PC"); any other string lists that directory.
  function browseTo(path?: string) {
    setDirLoading(true);
    postMessage(path === undefined ? { type: 'listDir' } : { type: 'listDir', path });
  }

  function openBrowse() {
    setTab('browse');
    if (!browseLoaded.current) {
      browseLoaded.current = true;
      browseTo(undefined); // start at home
    }
  }

  function pick(path: string) {
    if (path !== current) onSelect(path);
    onClose();
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? workspaces.filter(w => w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q))
    : workspaces;

  const atDrivesRoot = !!dir && dir.path === '';
  const dirLabel = atDrivesRoot ? 'This PC' : dir?.path ?? '';

  return createPortal(
    <>
      <div className={styles.overlay} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal} role="dialog" aria-label="Workspace History">
        <div className={styles.header}>
          <span className={styles.title}>Workspace History</span>
          <div className={styles.headerActions}>
            {tab === 'recent' && (
              <button
                className={[styles.refreshBtn, refreshing ? styles.refreshing : ''].filter(Boolean).join(' ')}
                onClick={refresh}
                disabled={refreshing}
                aria-label="Refresh workspaces"
                title="Refresh workspace list"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>
            )}
            <button className={styles.close} onClick={onClose} aria-label="Close">&times;</button>
          </div>
        </div>

        <div className={styles.tabs} role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'recent'}
            className={[styles.tab, tab === 'recent' ? styles.tabActive : ''].filter(Boolean).join(' ')}
            onClick={() => setTab('recent')}
          >
            Recent
          </button>
          <button
            role="tab"
            aria-selected={tab === 'browse'}
            className={[styles.tab, tab === 'browse' ? styles.tabActive : ''].filter(Boolean).join(' ')}
            onClick={openBrowse}
          >
            Browse
          </button>
        </div>

        {tab === 'recent' ? (
          <>
            <div className={styles.searchRow}>
              <input
                className={styles.search}
                type="text"
                placeholder="Search workspaces..."
                value={query}
                onChange={e => setQuery(e.target.value)}
                aria-label="Search workspaces"
              />
            </div>

            <div className={styles.body}>
              {loading ? (
                <div className={styles.placeholder}>Loading...</div>
              ) : filtered.length === 0 ? (
                <div className={styles.placeholder}>
                  {workspaces.length === 0 ? 'No recent workspaces.' : 'No matching workspaces.'}
                </div>
              ) : (
                filtered.map(w => (
                  <div
                    key={w.path}
                    className={[styles.row, w.path === current ? styles.rowCurrent : ''].filter(Boolean).join(' ')}
                    onClick={() => pick(w.path)}
                    title={w.path}
                  >
                    <div className={styles.rowMain}>
                      <span className={styles.rowTitle}>{w.name}</span>
                      <span className={styles.rowPath}>{w.path}</span>
                    </div>
                    <span className={styles.rowCount} title={plural(w.sessions, 'session')}>{w.sessions}</span>
                    <span className={styles.rowTime}>{relativeTime(w.updatedAt)}</span>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <div className={styles.browsePath} title={dirLabel}>{dirLabel || 'Loading...'}</div>

            <div className={styles.body}>
              {dir && dir.parent !== null && (
                <div className={styles.browseRow} onClick={() => browseTo(dir.parent ?? undefined)}>
                  <span className={styles.upIcon} aria-hidden="true">..</span>
                  <span className={styles.browseName}>Up</span>
                </div>
              )}
              {dirLoading && !dir ? (
                <div className={styles.placeholder}>Loading...</div>
              ) : dir && dir.entries.length === 0 ? (
                <div className={styles.placeholder}>No sub-folders here.</div>
              ) : (
                dir?.entries.map(entry => (
                  <div
                    key={entry.path}
                    className={[styles.browseRow, entry.path === current ? styles.rowCurrent : ''].filter(Boolean).join(' ')}
                    onClick={() => browseTo(entry.path)}
                    title={entry.path}
                  >
                    <FolderIcon />
                    <span className={styles.browseName}>{entry.name}</span>
                  </div>
                ))
              )}
            </div>

            <div className={styles.browseFooter}>
              <button
                className={styles.openBtn}
                onClick={() => dir?.path && pick(dir.path)}
                disabled={!dir || atDrivesRoot}
                title={atDrivesRoot ? 'Pick a folder first' : `Open ${dirLabel}`}
              >
                Open this folder
              </button>
            </div>
          </>
        )}
      </div>
    </>,
    document.body
  );
}
