import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Local session history: enumerate, replay, and delete the Claude CLI transcripts
// that the CLI persists per project directory under
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
//
// Types here intentionally duplicate the webview UIMessage/ContentBlock shapes
// (structurally) rather than importing them, because the frontend and backend
// live in separate tsconfig boundaries. The values are sent over the wire as
// plain JSON, so the duplication is only for local typing.

export interface SessionSummary {
  id: string;
  title: string;
  lastPrompt: string;
  updatedAt: number; // mtime in ms
}

export interface WorkspaceSummary {
  path: string;    // real absolute cwd recovered from transcripts
  name: string;    // basename for display
  sessions: number;
  updatedAt: number; // latest transcript mtime in ms
}

interface ReplayTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  error?: boolean;
}

type ReplayBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ReplayTool };

export interface ReplayMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: Array<{ data: string; mediaType: string; name?: string }>;
  thinking?: string;
  blocks?: ReplayBlock[];
  outcome?: 'success';
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

// The CLI encodes the absolute cwd into a folder name by replacing every
// non-alphanumeric character with '-' (e.g. "d:\_Projects\argus" ->
// "d---Projects-argus"). Consecutive separators are NOT collapsed.
function encodeDir(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

// Resolve the project transcript folder for a workspace, tolerating drive-letter
// case differences (process.cwd() may report "D:" while the CLI wrote "d---...").
function resolveProjectDir(workspaceDir: string): string | null {
  const root = projectsRoot();
  const want = encodeDir(workspaceDir);
  const exact = path.join(root, want);
  if (fs.existsSync(exact)) return exact;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const hit = entries.find(e => e.isDirectory() && e.name.toLowerCase() === want.toLowerCase());
    if (hit) return path.join(root, hit.name);
  } catch {}
  return null;
}

// Reads a transcript only for its metadata: the latest title and user prompt.
// A user-set `custom-title` (written by the official client when you rename a
// session) takes precedence over the AI-generated `ai-title`. All event types
// may appear multiple times; the last of each wins.
function readSessionMeta(file: string): { title: string; lastPrompt: string } {
  let aiTitle = '';
  let customTitle = '';
  let lastPrompt = '';
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return { title: '', lastPrompt }; }
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    let o: { type?: string; aiTitle?: unknown; customTitle?: unknown; lastPrompt?: unknown };
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') customTitle = o.customTitle;
    else if (o.type === 'ai-title' && typeof o.aiTitle === 'string') aiTitle = o.aiTitle;
    else if (o.type === 'last-prompt' && typeof o.lastPrompt === 'string') lastPrompt = o.lastPrompt;
  }
  return { title: customTitle || aiTitle, lastPrompt };
}

export function listSessions(workspaceDir: string): SessionSummary[] {
  const dir = resolveProjectDir(workspaceDir);
  if (!dir) return [];
  let files: string[];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
  const out: SessionSummary[] = [];
  for (const f of files) {
    const id = f.slice(0, -'.jsonl'.length);
    if (!UUID_RE.test(id)) continue;
    const full = path.join(dir, f);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile() || stat.size === 0) continue;
    const meta = readSessionMeta(full);
    out.push({
      id,
      title: meta.title || meta.lastPrompt || 'Untitled',
      lastPrompt: meta.lastPrompt,
      updatedAt: stat.mtimeMs,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// Enumerate the workspaces the CLI has been run in. The per-project folder name
// is a lossy encoding of the cwd (encodeDir collapses ':' '\' '_' all to '-'),
// so the real path can't be decoded from it; instead we recover the exact cwd
// from the `cwd` field stored inside the transcript records. Folders are ordered
// by their most recent transcript mtime; workspaces whose path no longer exists
// on disk are dropped.
export function listWorkspaces(): WorkspaceSummary[] {
  const root = projectsRoot();
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out: WorkspaceSummary[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    let files: Array<{ full: string; mtime: number }> = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        try {
          const st = fs.statSync(full);
          if (st.isFile() && st.size > 0) files.push({ full, mtime: st.mtimeMs });
        } catch {}
      }
    } catch { continue; }
    if (!files.length) continue;
    files.sort((a, b) => b.mtime - a.mtime);
    const cwd = readCwd(files);
    if (!cwd || !fs.existsSync(cwd)) continue;
    out.push({ path: cwd, name: path.basename(cwd) || cwd, sessions: files.length, updatedAt: files[0].mtime });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;          // resolved directory; '' is the synthetic "This PC" level
  parent: string | null; // null at the synthetic root (no further up)
  entries: DirEntry[];   // sub-directories only
}

// Synthetic top level for the folder explorer: '' represents "This PC" - the list
// of drive roots on Windows (or '/' on POSIX). Lets the user walk up past a drive
// root to switch drives.
const DRIVES_ROOT = '';

function listDrives(): DirEntry[] {
  if (process.platform === 'win32') {
    const out: DirEntry[] = [];
    for (let c = 65; c <= 90; c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      try { if (fs.existsSync(root)) out.push({ name: root, path: root }); } catch {}
    }
    return out;
  }
  return [{ name: '/', path: '/' }];
}

// Parent of a path within the explorer model: a filesystem root (e.g. 'C:\' or
// '/') reports the synthetic drives root as its parent; the drives root has none.
function parentOf(p: string): string | null {
  if (p === DRIVES_ROOT) return null;
  const par = path.dirname(p);
  return par === p ? DRIVES_ROOT : par;
}

// List the immediate sub-directories of `target` for the Workspace History
// "Browse" tab. undefined target opens at the user's home directory; DRIVES_ROOT
// ('') yields the drive list. Directory-only, sorted case-insensitively; tolerates
// unreadable entries (permissions, removed media) by returning an empty list that
// is still navigable upward.
export function listDir(target?: string): DirListing {
  if (target === DRIVES_ROOT) {
    return { path: DRIVES_ROOT, parent: null, entries: listDrives() };
  }
  const dir = target && target.length ? path.resolve(target) : os.homedir();
  const entries: DirEntry[] = [];
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      let isDir = d.isDirectory();
      if (!isDir && d.isSymbolicLink()) {
        try { isDir = fs.statSync(path.join(dir, d.name)).isDirectory(); } catch { isDir = false; }
      }
      if (isDir) entries.push({ name: d.name, path: path.join(dir, d.name) });
    }
  } catch {
    // Unreadable directory: empty listing, still navigable up via `parent`.
  }
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { path: dir, parent: parentOf(dir), entries };
}

// Recover the real cwd by scanning transcripts newest-first for the first record
// that carries a `cwd` string.
function readCwd(files: Array<{ full: string; mtime: number }>): string | null {
  for (const { full } of files) {
    let content: string;
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      let o: { cwd?: unknown };
      try { o = JSON.parse(line); } catch { continue; }
      if (typeof o.cwd === 'string' && o.cwd) return o.cwd;
    }
  }
  return null;
}

// A tool_result's content can be a string or an array of content blocks; flatten
// it to a single string for display.
function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(b => (typeof b === 'string' ? b : (b && (b as { type?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : JSON.stringify(b))))
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

// Validate that a sessionId maps to a transcript file directly inside the project
// dir (no traversal), returning the resolved path or null.
function resolveSessionFile(sessionId: string, workspaceDir: string): string | null {
  if (!UUID_RE.test(sessionId)) return null;
  const dir = resolveProjectDir(workspaceDir);
  if (!dir) return null;
  const base = path.resolve(dir);
  const file = path.resolve(path.join(dir, sessionId + '.jsonl'));
  if (path.dirname(file) !== base) return null;
  return file;
}

// Parse a transcript into rendered messages, mapping nested content blocks
// (text/thinking/tool_use/tool_result/image) onto the webview's message shape.
// Consecutive assistant lines (which share a turn) merge into one message until
// the next real user input; tool_result blocks attach to their tool_use by id.
export function loadSession(sessionId: string, workspaceDir: string): ReplayMessage[] {
  const file = resolveSessionFile(sessionId, workspaceDir);
  if (!file || !fs.existsSync(file)) return [];
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }

  const messages: ReplayMessage[] = [];
  const toolById = new Map<string, ReplayTool>();
  let current: ReplayMessage | null = null;
  let counter = 0;
  const newId = () => `replay-${++counter}`;

  const finalize = () => {
    if (!current) return;
    current.content = (current.blocks ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');
    if (!current.thinking) delete current.thinking;
    if (!current.blocks || current.blocks.length === 0) delete current.blocks;
    messages.push(current);
    current = null;
  };

  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    let o: { type?: string; message?: { id?: string; content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }

    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (typeof c === 'string') {
        if (c.trim()) { finalize(); messages.push({ id: newId(), role: 'user', content: c }); }
        continue;
      }
      if (!Array.isArray(c)) continue;
      const texts: string[] = [];
      const images: Array<{ data: string; mediaType: string }> = [];
      for (const b of c as Array<Record<string, unknown>>) {
        if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        } else if (b.type === 'image' && (b.source as { type?: string })?.type === 'base64') {
          const src = b.source as { data: string; media_type: string };
          images.push({ data: src.data, mediaType: src.media_type });
        } else if (b.type === 'tool_result') {
          const call = toolById.get(b.tool_use_id as string);
          if (call) {
            call.result = stringifyResult(b.content);
            if (b.is_error) call.error = true;
          }
        }
      }
      // Only text/image blocks are real user input; a pure tool_result line is the
      // synthetic results message and must not create a user bubble.
      if (texts.length || images.length) {
        finalize();
        messages.push({ id: newId(), role: 'user', content: texts.join('\n'), images: images.length ? images : undefined });
      }
    } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      if (!current) current = { id: o.message!.id || newId(), role: 'assistant', content: '', thinking: '', blocks: [], outcome: 'success' };
      for (const b of o.message!.content as Array<Record<string, unknown>>) {
        if (b.type === 'thinking' && typeof b.thinking === 'string') {
          current.thinking = (current.thinking ?? '') + b.thinking;
        } else if (b.type === 'text' && typeof b.text === 'string') {
          current.blocks!.push({ type: 'text', text: b.text });
        } else if (b.type === 'tool_use') {
          const call: ReplayTool = { id: b.id as string, name: b.name as string, input: (b.input as Record<string, unknown>) ?? {} };
          current.blocks!.push({ type: 'tool', call });
          toolById.set(call.id, call);
        }
      }
    }
  }
  finalize();
  return messages;
}

// Rename a session by appending a fresh `custom-title` line to its transcript.
// This matches the official client's manual-rename format, so the new name shows
// up there too; readSessionMeta() keeps the last `custom-title` (which outranks
// `ai-title`), so the appended line wins on the next listSessions() without
// rewriting the (potentially large) file. Returns whether the title was written.
export function renameSession(sessionId: string, workspaceDir: string, rawTitle: string): boolean {
  const file = resolveSessionFile(sessionId, workspaceDir);
  if (!file || !fs.existsSync(file)) return false;
  // Single-line JSON record: strip newlines and cap length.
  const title = rawTitle.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  if (!title) return false;
  const record = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId });
  try {
    fs.appendFileSync(file, '\n' + record);
    return true;
  } catch {
    return false;
  }
}

// Delete a session transcript and its sibling data folder (if present). Returns
// whether the .jsonl was removed.
export function deleteSession(sessionId: string, workspaceDir: string): boolean {
  const file = resolveSessionFile(sessionId, workspaceDir);
  if (!file) return false;
  const base = path.dirname(file);
  let removed = false;
  try { if (fs.existsSync(file)) { fs.rmSync(file); removed = true; } } catch {}
  const sub = path.resolve(path.join(base, sessionId));
  if (path.dirname(sub) === base) {
    try { if (fs.existsSync(sub)) fs.rmSync(sub, { recursive: true, force: true }); } catch {}
  }
  return removed;
}
