import { execFile, execFileSync } from 'child_process';
import * as os from 'os';
import { CLAUDE_IMAGE_WIN, CLAUDE_PROC_POSIX, IS_WIN } from './cli';
import { readDaemonInfo } from './daemonInfo';
import { sessionLastActivity } from './sessions';

export interface CliProcessInfo {
  pid: number;
  ppid: number;
  /** Unix ms the process was created; the UI ticks its own uptime from this. */
  startedAt: number;
  /** Total CPU time the process has consumed since it started, in seconds. */
  cpuSeconds: number;
  /**
   * Share of ONE core over the interval between the last two samples, in percent
   * (100 = one core fully busy). Null on the first sample of a pid and whenever the
   * two samples are too close together to divide by - there is no honest number to
   * report yet, and "0" would read as an idle process.
   */
  cpuPercent: number | null;
  /** Resident memory (working set on Windows, RSS on POSIX), in bytes. */
  memBytes: number;
  /** Conversation the process was resumed into, from its --resume argument. */
  sessionId?: string;
  /** Model from --model, when the process carries one. */
  model?: string;
  /** Truncated command line, for telling an unfamiliar process apart. */
  command: string;
  /** When this session's transcript was last written; absent when it has none yet. */
  lastActivityAt?: number;
  /**
   * Whether the session is mid-turn. Only this server can answer it for its own
   * processes; `null` means "not ours, so unknowable" and must not be shown as "no" -
   * nothing observable from outside distinguishes a CLI waiting for input from one
   * working (its transcript is written at message boundaries, and CPU does not separate
   * the two either).
   */
  sessionRunning: boolean | null;
  /** Nearest ancestor that is itself a Claude CLI - an agent that spawned another CLI. */
  parentCliPid?: number;
  /** The process that owns this CLI's tree, with shell wrappers skipped. */
  owner?: ProcessOwner;
  /** Spawned by this server process (directly, or through the Windows cmd.exe shell). */
  ours: boolean;
  /** The process running the requesting panel's own session right now. */
  current: boolean;
}

export interface ProcessOwner {
  pid: number;
  name: string;
  /** "Argus daemon", "this Argus server", … when the pid can be recognised. */
  label?: string;
  /** Full ancestor chain, nearest first, as `name (pid)` - shown on hover. */
  chain: string;
}

export interface CliProcessList {
  processes: CliProcessInfo[];
  /** Short reason the listing could not be produced; processes is empty then. */
  error?: string;
}

export interface OwnedProc {
  sessionId: string;
  running: boolean;
}

export interface OwnedProcs {
  /**
   * Pids this server spawned, mapped to the session each is serving and whether that
   * session is mid-turn. On Windows these are the cmd.exe shells, not the CLI itself.
   */
  owned: Map<number, OwnedProc>;
  /** The requesting panel's own spawn, a key of `owned`. */
  current?: number;
}

const PS_TIMEOUT_MS = 10_000;
const MAX_COMMAND_CHARS = 200;
// Two samples closer together than this divide a rounding error by a rounding error.
const MIN_SAMPLE_GAP_MS = 500;
// A burst of clients (several panels polling out of phase) shares one sample rather
// than each paying for its own process listing.
const CACHE_MS = 1_000;
// Windows reports CPU time in 100-nanosecond units.
const FILETIME_PER_SECOND = 1e7;

// Deliberately unfiltered: resolving "which process started this CLI" needs the
// ancestors, and WMI cannot walk a parent chain itself. Measured on a 556-process
// machine at 685ms / 275KB against 461ms / 6.6KB for the claude.exe-only filter - the
// extra quarter second buys the tree, and only the handful of ancestors that sit on a
// CLI's chain are kept, so what crosses the WebSocket stays small.
const WIN_PS = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress';

// Shells Argus (and yarn, and npm) insert between a real parent and the process it
// meant to start - `spawn(..., { shell: IS_WIN })` is why every CLI here has a cmd.exe
// parent. They own nothing and have no stats worth a row, so the owner search walks
// through them. An interactive powershell/WindowsTerminal is NOT in this list: a CLI
// started by hand in a terminal really is owned by that terminal.
const SHELL_WRAPPERS = new Set(['cmd.exe', 'sh.exe', 'bash.exe', 'conhost.exe']);
// Depth cap for the ancestor walk. Windows recycles pids, so a stale ppid can point at
// a descendant and close a loop; the `seen` set catches that, this catches the rest.
const MAX_ANCESTRY_DEPTH = 24;

interface Sample {
  cpuSeconds: number;
  at: number;
  /** Guards against a recycled pid being read as a huge CPU delta. */
  startedAt: number;
}
const lastSample = new Map<number, Sample>();

export interface RawProc {
  pid: number;
  ppid: number;
  /** Lower-cased image name, the only thing that identifies a process by kind. */
  name: string;
  startedAt: number;
  cpuSeconds: number;
  /** Filled in by measureCpu once per sample, never per consumer - see sample(). */
  cpuPercent: number | null;
  memBytes: number;
  command: string;
}

/** Every process on the machine, plus the CLIs picked out of it. */
interface Snapshot {
  all: Map<number, RawProc>;
  clis: RawProc[];
}

let inFlight: Promise<Snapshot | string> | null = null;
let cached: { at: number; value: Snapshot | string } | null = null;

const CLI_NAME = IS_WIN ? CLAUDE_IMAGE_WIN : CLAUDE_PROC_POSIX;

function execText(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: PS_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// `[[dd-]hh:]mm:ss[.ff]`, the format ps uses for both etime and cputime.
export function parseClockSeconds(text: string): number {
  const m = text.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  const [, days, hours, minutes, seconds] = m;
  return (+(days ?? 0)) * 86400 + (+(hours ?? 0)) * 3600 + (+minutes) * 60 + parseFloat(seconds);
}

// PowerShell serializes a CIM date as `/Date(1789025800720)/`.
export function parseCimDate(value: unknown): number {
  const m = String(value ?? '').match(/\d+/);
  return m ? +m[0] : 0;
}

function parseWindows(stdout: string, now: number): RawProc[] {
  // No matching process at all prints nothing, and exactly one prints a bare object
  // rather than a one-element array.
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  const rows: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map(row => {
    const startedAt = parseCimDate(row.CreationDate);
    const kernel = Number(row.KernelModeTime) || 0;
    const user = Number(row.UserModeTime) || 0;
    return {
      pid: Number(row.ProcessId) || 0,
      ppid: Number(row.ParentProcessId) || 0,
      name: String(row.Name ?? '').toLowerCase(),
      startedAt: startedAt || now,
      cpuSeconds: (kernel + user) / FILETIME_PER_SECOND,
      cpuPercent: null,
      memBytes: Number(row.WorkingSetSize) || 0,
      command: String(row.CommandLine ?? ''),
    };
  }).filter(p => p.pid > 0);
}

function parsePosix(stdout: string, now: number): RawProc[] {
  const out: RawProc[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const [, pid, ppid, etime, cputime, rssKb, comm, args] = m;
    out.push({
      pid: +pid,
      ppid: +ppid,
      name: (comm.split('/').pop() ?? comm).toLowerCase(),
      startedAt: now - parseClockSeconds(etime) * 1000,
      cpuSeconds: parseClockSeconds(cputime),
      cpuPercent: null,
      memBytes: +rssKb * 1024,
      command: args || comm,
    });
  }
  return out;
}

// Resolves to the machine's processes, or to a short reason string when the OS refused
// to list them. Never rejects: the caller has to answer its client either way.
async function collect(): Promise<Snapshot | string> {
  const now = Date.now();
  try {
    const procs = IS_WIN
      ? parseWindows(await execText('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS]), now)
      : parsePosix(await execText('ps', ['-eo', 'pid=,ppid=,etime=,time=,rss=,comm=,args=']), now);
    return { all: new Map(procs.map(p => [p.pid, p])), clis: procs.filter(p => p.name === CLI_NAME) };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// One OS read, shared by every client that asks inside the cache window. The CPU
// measurement belongs HERE and not in listCliProcesses: it advances a per-pid baseline,
// so running it once per caller would let the first client consume the whole delta and
// leave a second panel reading `-` on every row forever.
function sample(): Promise<Snapshot | string> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.value);
  if (inFlight) return inFlight;
  inFlight = collect().then(value => {
    // Only the CLIs, not all ~556 processes: nothing else is ever shown, and a baseline
    // per machine process would be a map that grows with every build and shell that runs.
    if (typeof value !== 'string') measureCpu(value.clis, Date.now());
    cached = { at: Date.now(), value };
    return value;
  }).finally(() => { inFlight = null; });
  return inFlight;
}

// Turns each process's total-CPU-since-start into a reading over the interval since the
// previous sample, and forgets the pids that have gone.
function measureCpu(procs: RawProc[], now: number): void {
  for (const p of procs) {
    const prev = lastSample.get(p.pid);
    lastSample.set(p.pid, { cpuSeconds: p.cpuSeconds, at: now, startedAt: p.startedAt });
    // A pid the OS has since handed to a different process would otherwise report the
    // difference between two unrelated processes' CPU time.
    if (!prev || prev.startedAt !== p.startedAt) continue;
    const elapsedMs = now - prev.at;
    const used = p.cpuSeconds - prev.cpuSeconds;
    if (elapsedMs < MIN_SAMPLE_GAP_MS || used < 0) continue;
    p.cpuPercent = (used / (elapsedMs / 1000)) * 100;
  }
  const live = new Set(procs.map(p => p.pid));
  for (const pid of lastSample.keys()) if (!live.has(pid)) lastSample.delete(pid);
}

// Walks up from a CLI to the process that meaningfully owns it, reporting the first
// Claude CLI it meets on the way (an agent that spawned another CLI) and skipping the
// shell wrappers in between. The full chain travels along as text, so the collapsing is
// visible on hover rather than hidden.
export function resolveAncestry(proc: RawProc, all: Map<number, RawProc>, labelFor: (p: RawProc) => string | undefined = () => undefined): { parentCliPid?: number; owner?: ProcessOwner } {
  const chain: string[] = [];
  const seen = new Set<number>([proc.pid]);
  let parentCliPid: number | undefined;
  let cur = all.get(proc.ppid);
  let depth = 0;

  while (cur && !seen.has(cur.pid) && depth++ < MAX_ANCESTRY_DEPTH) {
    seen.add(cur.pid);
    chain.push(`${cur.name} (${cur.pid})`);
    if (cur.name === CLI_NAME) {
      // A CLI under a CLI is real nesting worth drawing; stop here and let the parent
      // row own it, rather than hoisting both to the same top-level owner.
      return { parentCliPid: cur.pid, owner: { pid: cur.pid, name: cur.name, label: labelFor(cur), chain: chain.join(' <- ') } };
    }
    if (!SHELL_WRAPPERS.has(cur.name)) {
      return { parentCliPid, owner: { pid: cur.pid, name: cur.name, label: labelFor(cur), chain: chain.join(' <- ') } };
    }
    cur = all.get(cur.ppid);
  }
  // Nothing above it is still alive - a CLI whose launcher has already exited.
  return { owner: chain.length ? { pid: proc.ppid, name: chain[chain.length - 1], chain: chain.join(' <- ') } : undefined };
}

// Names the processes a reader would otherwise have to identify by pid alone. The
// daemon is the common owner here and looks like a plain Code.exe without this.
function makeLabeller(): (p: RawProc) => string | undefined {
  const daemonPid = readDaemonInfo()?.pid;
  return (p: RawProc) => {
    if (p.pid === process.pid) return 'this Argus server';
    if (daemonPid && p.pid === daemonPid) return 'Argus daemon';
    if (/scripts[\\/]dev\.js|server[\\/]index\.ts/.test(p.command)) return 'Argus dev server';
    if (/backend[\\/]daemon\.js|backend[\\/]daemon\.ts/.test(p.command)) return 'Argus daemon';
    return undefined;
  };
}

// Every Claude CLI process on this machine, with the timing and memory counters the
// OS keeps for it - the same scope as killAllClaude, so the Settings panel's process
// list and its "Stop all Claude CLI processes" button describe the same set.
export async function listCliProcesses(owned: OwnedProcs): Promise<CliProcessList> {
  const snap = await sample();
  if (typeof snap === 'string') return { processes: [], error: snap };

  const raw = snap.clis;
  const labelFor = makeLabeller();
  const processes = raw.map(p => {
    // On Windows the CLI is spawned through a cmd.exe shell, so what this server holds
    // is the shell's pid and the CLI is its child; on POSIX it holds the CLI directly.
    const ours = owned.owned.has(p.pid) || owned.owned.has(p.ppid);
    const resume = p.command.match(/--resume\s+(\S+)/);
    const model = p.command.match(/--model\s+(\S+)/);
    // A process this server spawned for a *new* conversation carries no --resume, so
    // its own command line cannot name the session; the server's registry can.
    const mine = owned.owned.get(p.pid) ?? owned.owned.get(p.ppid);
    const ownedSession = mine?.sessionId;
    const sessionId = resume?.[1] ?? (ownedSession || undefined);
    return {
      pid: p.pid,
      ppid: p.ppid,
      startedAt: p.startedAt,
      cpuSeconds: p.cpuSeconds,
      cpuPercent: p.cpuPercent,
      memBytes: p.memBytes,
      sessionId,
      lastActivityAt: sessionId ? (sessionLastActivity(sessionId) ?? undefined) : undefined,
      // Ours: the registry knows. Not ours: nothing here can tell, so say so.
      sessionRunning: mine ? mine.running : null,
      model: model?.[1],
      command: p.command.slice(0, MAX_COMMAND_CHARS),
      ours,
      current: owned.current != null && (owned.current === p.pid || owned.current === p.ppid),
      ...resolveAncestry(p, snap.all, labelFor),
    };
  }).sort((a, b) => a.startedAt - b.startedAt);

  return { processes };
}

export interface KillProcessResult {
  pid: number;
  killed: boolean;
  error?: string;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Terminates ONE Claude CLI process. The pid arrives from a client, so it is never
// passed to the OS on trust: it must appear in the current listing as a CLI, and on
// Windows the kill itself carries an image-name filter so that even if the pid died and
// was recycled in the moment between the two, the OS refuses to kill the stranger that
// inherited it (verified against a node.exe decoy - taskkill declined and it survived).
export async function killCliProcess(pid: number): Promise<KillProcessResult> {
  if (!Number.isInteger(pid) || pid <= 0) return { pid, killed: false, error: 'invalid pid' };

  const snap = await sample();
  if (typeof snap === 'string') return { pid, killed: false, error: snap };
  if (!snap.clis.some(p => p.pid === pid)) return { pid, killed: false, error: 'not a running Claude CLI process' };

  try {
    if (IS_WIN) {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid), '/FI', `IMAGENAME eq ${CLAUDE_IMAGE_WIN}`], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (err) {
    return { pid, killed: false, error: err instanceof Error ? err.message : String(err) };
  }

  // taskkill reports "no matching process" on stdout in the OS display language and
  // still exits 0, so its own output cannot say whether anything died - only the pid can.
  cached = null; // the listing just became wrong
  return { pid, killed: !isAlive(pid) };
}

export function cpuCoreCount(): number {
  return os.cpus()?.length || 1;
}

// Test seam: the sample cache and the CPU baselines are module state, so a second
// test would otherwise read the first one's numbers.
export function resetProcessSamples(): void {
  lastSample.clear();
  cached = null;
}
