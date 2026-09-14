import React, { useEffect, useRef, useState } from 'react';
import { postMessage } from '../vscode';
import { Modal } from './shared/Modal';
import { RefreshButton } from './shared/RefreshButton';
import { formatSize } from './shared/FolderList';
import { formatTime, formatUptime, relativeTime } from '../utils/time';
import { plural } from '../utils/text';
import table from './shared/dataTable.module.css';
import styles from './CliProcessesModal.module.css';

export interface ProcessOwner {
  pid: number;
  name: string;
  label?: string;
  chain: string;
}

export interface CliProcessInfo {
  pid: number;
  ppid: number;
  startedAt: number;
  cpuSeconds: number;
  cpuPercent: number | null;
  memBytes: number;
  sessionId?: string;
  model?: string;
  command: string;
  ours: boolean;
  current: boolean;
  lastActivityAt?: number;
  sessionRunning: boolean | null;
  parentCliPid?: number;
  owner?: ProcessOwner;
}

interface Group {
  key: string;
  owner?: ProcessOwner;
  roots: CliProcessInfo[];
  // Every CLI under this owner, nested ones included, was spawned by this server - so the
  // "this server" badge describes the group and moves up to its header.
  allOurs: boolean;
}

// Groups the CLIs under the process that started them, and nests a CLI that was itself
// started by another CLI (an agent shelling out to `claude`) under its parent. Ordered
// by each group's oldest process so the list does not reshuffle between polls.
export function groupByOwner(processes: CliProcessInfo[]): { groups: Group[]; childrenOf: Map<number, CliProcessInfo[]> } {
  const present = new Set(processes.map(p => p.pid));
  const childrenOf = new Map<number, CliProcessInfo[]>();
  const groups = new Map<string, Group>();

  for (const p of processes) {
    // A parent that is no longer running cannot nest anything, so its child is a root.
    if (p.parentCliPid != null && present.has(p.parentCliPid)) {
      const siblings = childrenOf.get(p.parentCliPid) ?? [];
      siblings.push(p);
      childrenOf.set(p.parentCliPid, siblings);
      continue;
    }
    const key = p.owner ? String(p.owner.pid) : 'unknown';
    const group = groups.get(key) ?? { key, owner: p.owner, roots: [], allOurs: false };
    group.roots.push(p);
    groups.set(key, group);
  }

  // Only once childrenOf is complete: a group is ours when its whole tree is, and the
  // nested CLIs (a sub-agent shelling out to `claude`) are exactly the ones that are not.
  for (const group of groups.values()) group.allOurs = everyOurs(group.roots, childrenOf);

  return { groups: [...groups.values()], childrenOf };
}

function everyOurs(roots: CliProcessInfo[], kids: Map<number, CliProcessInfo[]>): boolean {
  return roots.every(p => p.ours && everyOurs(kids.get(p.pid) ?? [], kids));
}

export function ownerTitle(owner?: ProcessOwner): string {
  if (!owner) return 'Started by a process that is no longer running';
  return `${owner.name} (${owner.pid})${owner.label ? ` - ${owner.label}` : ''}`;
}

function countTree(roots: CliProcessInfo[], kids: Map<number, CliProcessInfo[]>): number {
  return roots.reduce((n, p) => n + 1 + countTree(kids.get(p.pid) ?? [], kids), 0);
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

interface Props {
  onClose: () => void;
}

// How often the list is re-read from the OS. The server needs two samples before it can
// report a CPU percentage at all, so this is also how long the CPU % column stays empty
// after the modal opens.
const REFRESH_MS = 3_000;
// A daemon older than this message answers nothing at all, so silence has to time out
// into an explanation rather than an indefinite "Loading...".
const REPLY_TIMEOUT_MS = 10_000;
// Above this share of one core a process is doing real work rather than waiting.
const CPU_BUSY_PCT = 50;

export function CliProcessesModal({ onClose }: Props) {
  const [processes, setProcesses] = useState<CliProcessInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cores, setCores] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [timedOut, setTimedOut] = useState(false);
  // Grouped by the process that started each CLI. Flat is kept because it is the only
  // view ordered purely by age across the whole machine.
  const [tree, setTree] = useState(true);
  // Pids whose kill is in flight - the row is already gone from the table, so this only
  // stops a double click on a re-appearing row from firing twice.
  const [killing, setKilling] = useState<Set<number>>(new Set());
  const [killError, setKillError] = useState<string | null>(null);
  // Uptime counts up from a start the server reported once, so it ticks locally
  // instead of costing a process listing per second.
  const [, setTick] = useState(0);
  const answered = useRef(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'cliProcessKilled') {
        setKilling(prev => { const next = new Set(prev); next.delete(msg.pid); return next; });
        // A refusal has to be visible: the row was already removed optimistically, so
        // silence here would read as a successful kill until the next poll restored it.
        if (!msg.killed) setKillError(`Could not stop ${msg.pid}: ${msg.error ?? 'unknown error'}`);
        postMessage({ type: 'listCliProcesses' });
        return;
      }
      if (!msg || msg.type !== 'cliProcessList') return;
      answered.current = true;
      setTimedOut(false);
      setRefreshing(false);
      setProcesses(Array.isArray(msg.processes) ? msg.processes : []);
      setError(typeof msg.error === 'string' ? msg.error : null);
      if (typeof msg.cores === 'number') setCores(msg.cores);
    };
    window.addEventListener('message', onMessage);

    postMessage({ type: 'listCliProcesses' });
    const poll = setInterval(() => postMessage({ type: 'listCliProcesses' }), REFRESH_MS);
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
    postMessage({ type: 'listCliProcesses' });
  }

  function kill(pid: number): void {
    // Drop the row immediately, like Session History's delete. The next poll is the
    // authority: if the process somehow survived it comes back, and the reply says why.
    setKilling(prev => new Set(prev).add(pid));
    setProcesses(prev => prev?.filter(p => p.pid !== pid) ?? prev);
    setKillError(null);
    postMessage({ type: 'killCliProcess', pid });
  }

  const now = Date.now();
  const totalMem = processes?.reduce((sum, p) => sum + p.memBytes, 0) ?? 0;
  const ownedCount = processes?.filter(p => p.ours).length ?? 0;
  const { groups, childrenOf } = groupByOwner(processes ?? []);

  // `ownedByGroup` suppresses the per-row "this server" badge because the group header
  // above already carries it for every row beneath. "this panel" is never suppressed -
  // it names one process out of the group, which a header badge could not say.
  function row(p: CliProcessInfo, depth: number, ownedByGroup = false): React.ReactElement {
    return (
      <tr
        key={p.pid}
        className={p.current ? table.rowCurrent : undefined}
        data-testid="cli-process-row"
        data-pid={p.pid}
        data-depth={depth}
        title={[p.command, p.owner && `Started by ${p.owner.chain}`].filter(Boolean).join('\n\n') || undefined}
      >
        <td className={table.num}>{p.pid}</td>
        <td className={styles.session} style={depth ? { paddingLeft: 8 + depth * 14 } : undefined}>
          {depth > 0 && <span className={styles.branch} aria-hidden="true">└</span>}
          <span className={styles.sessionId} title={p.sessionId ? `${p.sessionId}${p.model ? ` · ${p.model}` : ''}` : p.model}>
            {p.sessionId ? p.sessionId.slice(0, 8) : '-'}
          </span>
          {p.current
            ? <span className={[table.badge, table.badgeCurrent].join(' ')} title="The process running this panel's own session">this panel</span>
            : p.ours && !ownedByGroup
              ? <span className={table.badge} title="Spawned by the server this panel is connected to">this server</span>
              : null}
        </td>
        <td className={table.run} data-testid="cli-process-running" data-running={String(p.sessionRunning)}>
          {p.sessionRunning === null
            ? <span className={table.unknown} title="Started by another server or a terminal, so this server cannot tell">-</span>
            : p.sessionRunning
              ? <span className={table.runYes}><span className={table.runDot} aria-hidden="true" />yes</span>
              : <span className={table.unknown}>no</span>}
        </td>
        <td className={styles.started} title={new Date(p.startedAt).toLocaleString()}>{formatTime(p.startedAt)}</td>
        <td className={table.num} title={p.lastActivityAt ? new Date(p.lastActivityAt).toLocaleString() : 'No transcript on disk for this session yet'}>
          {p.lastActivityAt ? relativeTime(p.lastActivityAt) : '-'}
        </td>
        <td className={table.num}>{formatUptime(now - p.startedAt)}</td>
        <td className={table.num}>{formatUptime(p.cpuSeconds * 1000)}</td>
        <td
          className={[table.num, p.cpuPercent != null && p.cpuPercent >= CPU_BUSY_PCT ? styles.busy : ''].filter(Boolean).join(' ')}
          data-testid="cli-process-cpu"
        >
          {p.cpuPercent == null ? '-' : `${p.cpuPercent.toFixed(p.cpuPercent < 10 ? 1 : 0)}%`}
        </td>
        <td className={table.num}>{formatSize(p.memBytes)}</td>
        <td className={table.actions}>
          <button
            className={table.rowBtn}
            onClick={() => kill(p.pid)}
            disabled={killing.has(p.pid)}
            data-testid="cli-process-kill"
            aria-label={`Terminate process ${p.pid}`}
            title={p.current
              ? 'Terminate this process - it is running THIS panel\'s session, so the current turn ends'
              : `Terminate process ${p.pid}${p.ours ? ' - it belongs to this server, so its turn ends' : ''}`}
          >
            <TrashIcon />
          </button>
        </td>
      </tr>
    );
  }

  function renderTree(p: CliProcessInfo, kids: Map<number, CliProcessInfo[]>, depth: number, ownedByGroup = false): React.ReactElement[] {
    return [row(p, depth, ownedByGroup), ...(kids.get(p.pid) ?? []).flatMap(c => renderTree(c, kids, depth + 1, ownedByGroup))];
  }

  return (
    <Modal
      title="Claude CLI processes"
      ariaLabel="Claude CLI processes"
      onClose={onClose}
      width={780}
      persistKey="cliProcesses"
      elevated
      headerActions={
        <>
          <button
            className={styles.viewToggle}
            onClick={() => setTree(t => !t)}
            data-testid="cli-processes-view"
            title={tree ? 'Grouped by the process that started each CLI - click for a flat list ordered by age' : 'Flat list ordered by age - click to group by the process that started each CLI'}
          >
            {tree ? 'Tree' : 'Flat'}
          </button>
          <RefreshButton spinning={refreshing} onClick={refresh} label="Refresh process list" title="Re-read the process list" />
        </>
      }
    >
      <div className={table.body} data-testid="cli-processes-body">
        {timedOut && (
          <div className={table.error} data-testid="cli-processes-error">
            No answer from the server. The daemon serving this panel may be older than this feature - restart it and try again.
          </div>
        )}
        {error && <div className={table.error} data-testid="cli-processes-error">Could not list processes: {error}</div>}
        {killError && <div className={table.error} data-testid="cli-process-kill-error">{killError}</div>}
        {processes === null && !timedOut && !error && <div className={table.placeholder}>Loading...</div>}
        {processes !== null && processes.length === 0 && !error && (
          <div className={table.placeholder}>No Claude CLI processes are running.</div>
        )}
        {processes !== null && processes.length > 0 && (
          <table className={table.table}>
            <thead>
              <tr>
                <th className={table.num}>PID</th>
                <th>Session</th>
                <th
                  className={table.run}
                  title="Whether that session is mid-turn right now. Only the server this panel talks to can tell - a process started by another server or a terminal shows '-', because nothing observable from outside separates a CLI waiting for input from one working."
                >Running</th>
                <th>Started</th>
                <th
                  className={table.num}
                  title="When this session's transcript was last written. Not a liveness signal: the CLI writes at message boundaries, so a session that is busy can sit unwritten for tens of seconds."
                >Last activity</th>
                <th className={table.num}>Uptime</th>
                <th className={table.num} title="Total CPU time this process has consumed since it started">CPU time</th>
                <th className={table.num} title={`Share of one CPU core since the previous refresh - 100% is one core fully busy${cores ? ` (this machine has ${cores})` : ''}. Empty until two samples exist.`}>CPU %</th>
                <th className={table.num} title="Resident memory (working set)">Memory</th>
                <th className={table.actions} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {tree
                ? groups.map(g => (
                  <React.Fragment key={g.key}>
                    <tr className={styles.groupRow} data-testid="cli-process-group" data-owner-pid={g.owner?.pid ?? ''}>
                      <td className={styles.groupCell} colSpan={10} title={g.owner ? `Full chain: ${g.owner.chain}` : undefined}>
                        <div className={styles.groupInner}>
                          <span className={styles.groupName}>{ownerTitle(g.owner)}</span>
                          <span className={styles.groupCount}>{plural(countTree(g.roots, childrenOf), 'CLI')}</span>
                          {g.allOurs && (
                            <span
                              className={table.badge}
                              data-testid="cli-process-group-badge"
                              title="Every CLI in this group was spawned by the server this panel is connected to"
                            >this server</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {g.roots.flatMap(p => renderTree(p, childrenOf, 0, g.allOurs))}
                  </React.Fragment>
                ))
                : processes.map(p => row(p, 0))}
            </tbody>
          </table>
        )}
      </div>
      <div className={table.footer}>
        {processes && processes.length > 0 && (
          <span data-testid="cli-processes-summary">
            {plural(processes.length, 'process', 'processes')} · {formatSize(totalMem)} total ·{' '}
            {/* Stated even when it is zero: a reader looking for their own processes
                otherwise has to infer the answer from a group header that isn't there. */}
            {ownedCount === 0 ? 'none from this server' : `${ownedCount} from this server`}
          </span>
        )}
      </div>
    </Modal>
  );
}
