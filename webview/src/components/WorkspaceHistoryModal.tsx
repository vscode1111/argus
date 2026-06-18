import React, { useState, useRef } from 'react';
import { postMessage } from '../vscode';
import { WorkspaceSummary, DirListing } from '../types';
import { plural } from '../utils/text';
import { relativeTime } from '../utils/time';
import { Modal } from './shared/Modal';
import { RefreshButton } from './shared/RefreshButton';
import { useWebviewMessage } from '../hooks/useWebviewMessage';
import shell from './shared/centeredModal.module.css';
import styles from './WorkspaceHistoryModal.module.css';

interface Props {
  currentPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

type Tab = 'recent' | 'browse';

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
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const browseLoaded = useRef(false);

  useWebviewMessage(
    (e: MessageEvent) => {
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
        setEditingPath(false);
      }
    },
    () => postMessage({ type: 'listWorkspaces' }),
  );

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

  // Begin editing the breadcrumb so a path can be typed or pasted in directly.
  function startPathEdit() {
    setPathDraft(atDrivesRoot ? '' : dir?.path ?? '');
    setEditingPath(true);
  }

  // Navigate to the typed/pasted path on Enter (dirList handler clears the edit state).
  function commitPathEdit() {
    const p = pathDraft.trim();
    if (p && p !== dir?.path) browseTo(p);
    else setEditingPath(false);
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

  return (
    <Modal
      title="Workspace History"
      ariaLabel="Workspace History"
      onClose={onClose}
      width={460}
      fullHeight
      // Escape cancels an in-progress path edit before it closes the modal.
      onEscape={() => { if (editingPath) setEditingPath(false); else onClose(); }}
      headerActions={tab === 'recent'
        ? <RefreshButton spinning={refreshing} onClick={refresh} label="Refresh workspaces" title="Refresh workspace list" />
        : undefined}
    >
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
          <div className={shell.searchRow}>
            <input
              className={shell.search}
              type="text"
              placeholder="Search workspaces..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Search workspaces"
            />
          </div>

          <div className={shell.body}>
            {loading ? (
              <div className={shell.placeholder}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div className={shell.placeholder}>
                {workspaces.length === 0 ? 'No recent workspaces.' : 'No matching workspaces.'}
              </div>
            ) : (
              filtered.map(w => (
                <div
                  key={w.path}
                  className={[shell.row, w.path === current ? shell.rowCurrent : ''].filter(Boolean).join(' ')}
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
          {editingPath ? (
            <input
              className={styles.browsePathInput}
              value={pathDraft}
              autoFocus
              spellCheck={false}
              placeholder="Paste or type a folder path, then press Enter"
              aria-label="Folder path"
              onChange={e => setPathDraft(e.target.value)}
              onBlur={() => setEditingPath(false)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitPathEdit(); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditingPath(false); }
              }}
            />
          ) : (
            <div
              className={styles.browsePath}
              title={`${dirLabel} (click to edit)`}
              onClick={startPathEdit}
            >
              {dirLabel || 'Loading...'}
            </div>
          )}

          <div className={shell.body}>
            {dir && dir.parent !== null && (
              <div className={styles.browseRow} onClick={() => browseTo(dir.parent ?? undefined)}>
                <svg className={styles.upIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
                <span className={styles.browseName}>Up</span>
              </div>
            )}
            {dirLoading && !dir ? (
              <div className={shell.placeholder}>Loading...</div>
            ) : dir && dir.entries.length === 0 ? (
              <div className={shell.placeholder}>No sub-folders here.</div>
            ) : (
              dir?.entries.map(entry => (
                <div
                  key={entry.path}
                  className={[styles.browseRow, entry.path === current ? shell.rowCurrent : ''].filter(Boolean).join(' ')}
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
    </Modal>
  );
}
