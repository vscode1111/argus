import React, { useEffect, useRef, useState } from 'react';
import { postMessage } from '../vscode';
import { Modal } from './shared/Modal';
import { RefreshButton } from './shared/RefreshButton';
import { formatTime, formatUptime } from '../utils/time';
import { basename } from '../utils/path';
import { plural } from '../utils/text';
import table from './shared/dataTable.module.css';
import styles from './ClientsModal.module.css';

export interface ClientInfo {
  id: number;
  current: boolean;
  connectedAt: number;
  address: string;
  local: boolean;
  origin: string;
  kind: 'vscode' | 'browser' | 'unknown';
  device?: string;
  userAgent?: string;
  workspacePath?: string;
  sessionId?: string;
  viewingSessionId?: string;
  running: boolean;
}

interface Props {
  onClose: () => void;
}

// "Log out" arrow: the connection is shown the door, not deleted. A trash can (the CLI
// panel's terminate icon) would claim something is destroyed - the session, its CLI and
// its transcript all outlive this.
function DisconnectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

// Connections open and close on their own, and nothing about a row (its session, whether
// it is mid-turn) is pushed - so the list is re-read on a timer while it is open. The
// server also pushes clientCount on every connect/disconnect, which we use as an
// immediate trigger so the two events a reader is watching for never wait out the poll.
const REFRESH_MS = 3_000;
// A daemon older than this message answers nothing at all, so silence has to time out
// into an explanation rather than an indefinite "Loading...".
const REPLY_TIMEOUT_MS = 10_000;

const KIND_LABEL: Record<ClientInfo['kind'], string> = {
  vscode: 'VS Code',
  browser: 'Browser',
  unknown: 'Unknown',
};

export function ClientsModal({ onClose }: Props) {
  const [clients, setClients] = useState<ClientInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [timedOut, setTimedOut] = useState(false);
  // Ids whose close is in flight - the row is already gone from the table, so this only
  // stops a double click on a re-appearing row from firing twice.
  const [closing, setClosing] = useState<Set<number>>(new Set());
  const [closeError, setCloseError] = useState<string | null>(null);
  // Connected-for counts up from a timestamp the server reported once, so it ticks
  // locally instead of costing a round trip per second.
  const [, setTick] = useState(0);
  const answered = useRef(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'clientClosed') {
        setClosing(prev => { const next = new Set(prev); next.delete(msg.id); return next; });
        // A refusal has to be visible: the row was already removed optimistically, so
        // silence here would read as a successful disconnect until the next poll
        // brought it back.
        if (!msg.closed) setCloseError(`Could not disconnect #${msg.id}: ${msg.error ?? 'unknown error'}`);
        postMessage({ type: 'listClients' });
        return;
      }
      // A connection opened or closed somewhere: the list this modal shows just changed,
      // and the count that triggered this is the very number it was opened from.
      if (msg?.type === 'clientCount') { postMessage({ type: 'listClients' }); return; }
      if (!msg || msg.type !== 'clientList') return;
      answered.current = true;
      setTimedOut(false);
      setRefreshing(false);
      setClients(Array.isArray(msg.clients) ? msg.clients : []);
      setError(typeof msg.error === 'string' ? msg.error : null);
    };
    window.addEventListener('message', onMessage);

    postMessage({ type: 'listClients' });
    const poll = setInterval(() => postMessage({ type: 'listClients' }), REFRESH_MS);
    const ticker = setInterval(() => setTick(t => t + 1), 1000);
    const deadline = setTimeout(() => { if (!answered.current) { setRefreshing(false); setTimedOut(true); } }, REPLY_TIMEOUT_MS);

    return () => {
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      clearInterval(ticker);
      clearTimeout(deadline);
    };
  }, []);

  function refresh(): void {
    setRefreshing(true);
    postMessage({ type: 'listClients' });
  }

  function disconnect(id: number): void {
    // Drop the row immediately, like the process list's terminate. The next poll is the
    // authority: if the client is somehow still there it comes back, and the reply says
    // why. Closing our own connection is allowed - the page then shows a Reconnect dot -
    // so this deliberately does not special-case `current`.
    setClosing(prev => new Set(prev).add(id));
    setClients(prev => prev?.filter(c => c.id !== id) ?? prev);
    setCloseError(null);
    postMessage({ type: 'closeClient', id });
  }

  const now = Date.now();
  const remote = clients?.filter(c => !c.local).length ?? 0;

  function row(c: ClientInfo): React.ReactElement {
    const browsing = !!c.viewingSessionId && c.viewingSessionId !== c.sessionId;
    return (
      <tr
        key={c.id}
        className={c.current ? table.rowCurrent : undefined}
        data-testid="client-row"
        data-client-id={c.id}
        title={[c.origin && `Origin: ${c.origin}`, c.userAgent && `User agent: ${c.userAgent}`, c.workspacePath].filter(Boolean).join('\n\n') || undefined}
      >
        <td>
          <span className={styles.cellInner}>
            <span>{KIND_LABEL[c.kind] ?? KIND_LABEL.unknown}</span>
            {c.device && <span className={styles.device}>{c.device}</span>}
            {c.current && (
              <span
                className={[table.badge, table.badgeCurrent].join(' ')}
                data-testid="client-current-badge"
                title="The connection this panel is using"
              >this panel</span>
            )}
          </span>
        </td>
        <td className={styles.addr} data-testid="client-address">
          <span className={styles.cellInner}>
            <span>{c.address || '-'}</span>
            {!c.local && (
              <span
                className={[table.badge, styles.remote].join(' ')}
                data-testid="client-remote-badge"
                title="Connected from another device over the network"
              >remote</span>
            )}
          </span>
        </td>
        <td className={[table.mono, styles.workspace].join(' ')} title={c.workspacePath}>
          {c.workspacePath ? basename(c.workspacePath) : '-'}
        </td>
        <td className={table.mono}>
          <span className={styles.cellInner}>
            <span title={c.sessionId}>{c.sessionId ? c.sessionId.slice(0, 8) : '-'}</span>
            {browsing && (
              <span
                className={table.badge}
                data-testid="client-browsing-badge"
                title={`Reading another transcript: ${c.viewingSessionId}`}
              >browsing</span>
            )}
          </span>
        </td>
        <td className={table.run} data-testid="client-running" data-running={String(c.running)}>
          {c.running
            ? <span className={table.runYes}><span className={table.runDot} aria-hidden="true" />yes</span>
            : <span className={table.unknown}>no</span>}
        </td>
        <td className={table.mono} title={c.connectedAt ? new Date(c.connectedAt).toLocaleString() : undefined}>
          {c.connectedAt ? formatTime(c.connectedAt) : '-'}
        </td>
        <td className={table.num}>{c.connectedAt ? formatUptime(now - c.connectedAt) : '-'}</td>
        <td className={table.actions}>
          <button
            className={table.rowBtn}
            onClick={() => disconnect(c.id)}
            disabled={closing.has(c.id)}
            data-testid="client-disconnect"
            aria-label={`Disconnect connection ${c.id}`}
            title={c.current
              ? 'Disconnect this panel\'s own connection - the page stays open and offers a Reconnect'
              : `Disconnect this client${c.running ? ' - it is watching a turn, which keeps running without it' : ''}`}
          >
            <DisconnectIcon />
          </button>
        </td>
      </tr>
    );
  }

  return (
    <Modal
      title="Connected clients"
      ariaLabel="Connected clients"
      onClose={onClose}
      /* Wide enough for the row this panel exists to explain: an address from another
         device carries a "remote" badge beside it, and at 640 that pushed the last
         column out of the modal behind a horizontal scrollbar (measured, LAN client). */
      width={740}
      persistKey="clients"
      elevated
      headerActions={<RefreshButton spinning={refreshing} onClick={refresh} label="Refresh client list" title="Re-read the connection list" />}
    >
      <div className={table.body} data-testid="clients-body">
        {timedOut && (
          <div className={table.error} data-testid="clients-error">
            No answer from the server. The daemon serving this panel may be older than this feature - restart it and try again.
          </div>
        )}
        {error && <div className={table.error} data-testid="clients-error">Could not list connections: {error}</div>}
        {closeError && <div className={table.error} data-testid="client-disconnect-error">{closeError}</div>}
        {clients === null && !timedOut && !error && <div className={table.placeholder}>Loading...</div>}
        {clients !== null && clients.length === 0 && !error && (
          <div className={table.placeholder}>No clients are connected.</div>
        )}
        {clients !== null && clients.length > 0 && (
          <table className={table.table}>
            <thead>
              <tr>
                <th title="Which host the connection is: a VS Code webview panel or a browser tab, plus the platform its User-Agent names">Client</th>
                <th title="Address the connection came from. 127.0.0.1 is this machine; anything else reached the server over the network.">Address</th>
                <th title="Workspace folder this connection is working in">Workspace</th>
                <th title="Conversation the connection is attached to. A client reading a past transcript is marked 'browsing' - its send would go to the one it is reading.">Session</th>
                <th className={table.run} title="Whether that session is mid-turn right now">Running</th>
                <th>Connected</th>
                <th className={table.num}>For</th>
                <th className={table.actions} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>{clients.map(row)}</tbody>
          </table>
        )}
      </div>
      <div className={table.footer}>
        {clients && clients.length > 0 && (
          <span data-testid="clients-summary">
            {plural(clients.length, 'connection')} ·{' '}
            {/* Stated even at zero: "are any of these not mine" is the question this
                panel exists to answer, and an absent badge cannot answer it. */}
            {remote === 0 ? 'all from this machine' : `${remote} from another device`}
          </span>
        )}
      </div>
    </Modal>
  );
}
