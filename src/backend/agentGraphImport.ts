import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AgentGraph, type GraphNode, type ScopeDocument } from './agentGraph';
import { name, record, scopeDocument, configuration, worker } from './agentGraphValidation';
import { providerForSession } from './providers/registry';

interface ImportOptions { root: string; company: string; goal: string }
interface Candidate { options: ImportOptions; company: string; goal: string; receipt: string; data: ScopeDocument; nodes: GraphNode[] }
const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function readBounded(file: string, limit: number): Buffer {
  const descriptor = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(descriptor); if (!stat.isFile() || stat.size > limit) throw Error('graph_import_limit');
    const buffer = Buffer.alloc(limit + 1); let length = 0, read: number;
    do { read = fs.readSync(descriptor, buffer, length, buffer.length - length, null); length += read; } while (read && length < buffer.length);
    if (length > limit || length !== stat.size || fs.fstatSync(descriptor).mtimeMs !== stat.mtimeMs) throw Error('graph_import_source_changed');
    return buffer.subarray(0, length);
  } finally { fs.closeSync(descriptor); }
}

// Explicit snapshot reader only. No legacy files are moved, rewritten or watched.
export function readAgentImport(options: ImportOptions): Candidate {
  const company = name(options.company), goal = name(options.goal), root = path.resolve(options.root);
  if (root.length > 1024 || fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()) throw Error('graph_import_root');
  const canonical = fs.realpathSync(root); const facts: unknown[] = []; const records: { file: string; data: Record<string, unknown> }[] = [];
  let total = 0, count = 0; const locks: { file: string; nested: boolean }[] = [];
  const scan = (dir: string, nested: boolean) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++count > 1000) throw Error('graph_import_limit');
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink() && entry.name === goal) throw Error('graph_import_containment');
      if (entry.isDirectory()) { if (!nested && entry.name === goal) scan(file, true); continue; }
      const metadata = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json$/.test(entry.name);
      // Exact auxiliary JSON names are ambiguous, not evidence of an empty scope.
      // Do not read possible credentials or silently claim incomplete ownership.
      if (/^(auth|argus-auth|credentials|tokens?|nonce|secrets?|daemon|prompt|response|log|transcript)\.json$/i.test(entry.name)) throw Error('graph_import_ambiguous_file');
      const lock = entry.name.endsWith('.turn.lock'); if (!metadata && !lock) continue;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || !fs.realpathSync(file).startsWith(canonical + path.sep)) throw Error('graph_import_containment');
      if (stat.size > (lock ? 4096 : 65536) || (total += stat.size) > 2 * 1024 * 1024) throw Error('graph_import_limit');
      if (lock) {
        locks.push({ file, nested }); continue;
      }
      const bytes = readBounded(file, 65536); const data = record(JSON.parse(bytes.toString('utf8')));
      if (typeof data.company !== 'string' || typeof data.goal !== 'string') throw Error('graph_import_mapping_required');
      facts.push([path.relative(root, file), digest(bytes), stat.size, stat.mtimeMs]);
      if (data.company === company && data.goal === goal) records.push({ file: entry.name, data });
    }
  };
  scan(root, false);
  const keys = new Set(records.filter(r => !r.file.endsWith('.goal.json')).map(r => name(r.data.key)));
  for (const lock of locks) if (lock.nested || keys.has(path.basename(lock.file, '.turn.lock').replace(/\.json$/, ''))) {
    let pid: number;
    try { pid = record(JSON.parse(readBounded(lock.file, 4096).toString('utf8'))).pid as number; } catch { throw Error('graph_import_lock'); }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('graph_import_lock');
    try { process.kill(pid, 0); throw Error('graph_import_lock_live'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw Error('graph_import_lock_unverifiable'); }
    facts.push([path.relative(root, lock.file), pid, fs.statSync(lock.file).mtimeMs, 'dead-lock']);
  }
  let goalData: Record<string, unknown> | undefined; const workers: Record<string, unknown> = Object.create(null);
  for (const item of records) {
    if (item.file.endsWith('.goal.json')) {
      const clean = { ...pick(item.data, ['title', 'status', 'profile', 'profileRevision', 'createdAt', 'updatedAt']),
        reviewCycles: item.data.reviewCycles ?? [], ...(item.data.coordinatorConfiguration === undefined ? {} : {
          coordinatorConfiguration: configuration(pick(record(item.data.coordinatorConfiguration), ['operationId', 'sourceTurnId', 'activeTurnId', 'sessionId', 'status', 'selection', 'sourceSelection', 'profileRevision', 'verifiedAt', 'reason'])) }) };
      if (goalData && JSON.stringify(goalData) !== JSON.stringify(clean)) throw Error('graph_import_conflict'); goalData = clean;
    } else {
      const key = name(item.data.key);
      if (item.file !== key + '.json') throw Error('graph_import_key_conflict');
      const clean = pick(item.data, ['role', 'providerId', 'workspace', 'title', 'profile', 'model', 'effort', 'sessionId']);
      clean.sessionId ??= null; if (clean.providerId === undefined && typeof clean.sessionId === 'string') clean.providerId = providerForSession(clean.sessionId).descriptor.id;
      const binding = worker(clean);
      if (workers[key] && JSON.stringify(workers[key]) !== JSON.stringify(binding)) throw Error('graph_import_conflict'); workers[key] = binding;
    }
  }
  if (!goalData) throw Error('graph_import_goal_mapping_required');
  const { reviewCycles, coordinatorConfiguration, ...goalValue } = goalData;
  const data = scopeDocument({ version: 1, goal: goalValue, reviewCycles, workers, ...(coordinatorConfiguration === undefined ? {} : { coordinatorConfiguration }) });
  const nodes: GraphNode[] = Object.values(data.workers).filter(w => w.sessionId).map(w => ({ id: w.sessionId!, providerId: w.providerId, role: w.role,
    workspace: w.workspace, title: w.title, company, goal, createdAt: data.goal.createdAt, updatedAt: data.goal.updatedAt }));
  // A coordinator checkpoint alone supplies no verified workspace/parent grant.
  // Keep it as historical metadata; do not invent supervisory edges.
  return { options: { root, company, goal }, company, goal, data, nodes, receipt: digest(JSON.stringify([canonical, company, goal, facts])) };
}
export function commitAgentImport(graph: AgentGraph, candidate: Candidate, isActive: (id: string) => boolean) {
  if (!/^[a-f0-9]{64}$/.test(candidate.receipt)) throw Error('invalid_graph_receipt');
  const previous = graph.readScope(candidate.company, candidate.goal);
  if (previous) { if (previous.receipt === candidate.receipt) return { alreadyImported: true }; throw Error('graph_scope_owned'); }
  const fresh = readAgentImport(candidate.options);
  if (fresh.receipt !== candidate.receipt) throw Error('graph_import_source_changed');
  return graph.importSnapshot(fresh, () => {
    const ids = [...fresh.nodes.map(n => n.id), fresh.data.coordinatorConfiguration?.sessionId].filter((id): id is string => typeof id === 'string');
    if (ids.some(isActive)) throw Error('graph_import_target_active');
    if (readAgentImport(fresh.options).receipt !== fresh.receipt) throw Error('graph_import_source_changed');
  });
}
