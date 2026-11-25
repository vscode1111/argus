import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { graphNode, scopeDocument, sessionId, name, integer, kinds, choice, workspaceIdentity, record, fields, bounded, type GraphNode, type ScopeDocument, type EdgeKind } from './agentGraphValidation';
export type { GraphNode, ScopeDocument, EdgeKind } from './agentGraphValidation';
type SQL = string | number | null;
interface Database { exec(sql: string): void; close(): void; prepare(sql: string): { run(...args: SQL[]): unknown; get(...args: SQL[]): unknown; all(...args: SQL[]): unknown[] } }
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => Database };
export interface EdgePush { questions: boolean; errors: boolean; turnEnd: boolean; milestones: 'tool-failure'[] }
export interface Exchange { summary: string; time: number; awaitingReply: boolean; questionId?: string }
export const DEFAULT_EDGE_PUSH: EdgePush = { questions: true, errors: true, turnEnd: true, milestones: [] };
export function edgePush(value: unknown = DEFAULT_EDGE_PUSH): EdgePush {
  const v = record(value); fields(v, ['questions', 'errors', 'turnEnd', 'milestones']);
  for (const key of ['questions', 'errors', 'turnEnd']) if (typeof v[key] !== 'boolean') throw Error('invalid_graph_push');
  if (!Array.isArray(v.milestones) || v.milestones.length > 1 || v.milestones.some(m => m !== 'tool-failure')) throw Error('invalid_graph_push');
  return { questions: v.questions as boolean, errors: v.errors as boolean, turnEnd: v.turnEnd as boolean, milestones: [...v.milestones] };
}
export interface GraphEdge { id: string; from: string; to: string; kind: EdgeKind; createdAt: number; push?: EdgePush; forward: Exchange | null; reverse: Exchange | null }
export interface GraphScope { company: string; goal: string; owned: true; revision: number; receipt: string | null; data: ScopeDocument | null }
export interface StoredGraph { storeId: string; storeRevision: number; nodes: GraphNode[]; edges: GraphEdge[]; scopes: GraphScope[] }
const decode = <T>(rows: unknown[]) => rows.map(row => JSON.parse((row as { payload: string }).payload) as T);
export class AgentGraph {
  private listeners = new Set<() => void>();
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.database(db => {
      db.exec(`CREATE TABLE IF NOT EXISTS graph_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL, store_id TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS graph_nodes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS graph_edges (id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE, target TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS graph_scopes (company TEXT NOT NULL, goal TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(company, goal));`);
      db.prepare('INSERT OR IGNORE INTO graph_meta VALUES (1, 1, ?, 0)').run(randomUUID());
      if ((db.prepare('SELECT schema_version FROM graph_meta').get() as { schema_version: number }).schema_version !== 1) throw Error('graph_schema_unsupported');
    }); fs.chmodSync(file, 0o600);
  }
  private database<T>(run: (db: Database) => T): T {
    const db = new DatabaseSync(this.file); try { db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'); return run(db); } finally { db.close(); }
  }
  private read(db: Database): StoredGraph {
    const meta = db.prepare('SELECT store_id, revision FROM graph_meta').get() as { store_id: string; revision: number };
    return { storeId: meta.store_id, storeRevision: meta.revision, nodes: decode<GraphNode>(db.prepare('SELECT payload FROM graph_nodes ORDER BY id').all()),
      edges: decode<GraphEdge>(db.prepare('SELECT payload FROM graph_edges ORDER BY id').all()).map(e => ({ ...e, push: edgePush(e.push) })), scopes: decode<GraphScope>(db.prepare('SELECT payload FROM graph_scopes ORDER BY company,goal').all()) };
  }
  snapshot(): StoredGraph { return this.database(db => { db.exec('BEGIN'); try { const value = this.read(db); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } }); }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private write<T>(run: (graph: StoredGraph) => T, beforeCommit?: () => void): T {
    let changed = false;
    const value = this.database(db => {
      db.exec('BEGIN IMMEDIATE'); try {
        const graph = this.read(db), before = JSON.stringify(graph); const result = run(graph);
        if (graph.nodes.length > 1000 || graph.edges.length > 4000 || graph.scopes.length > 128 || Buffer.byteLength(JSON.stringify(graph)) > 2 * 1024 * 1024) throw Error('graph_limit');
        changed = before !== JSON.stringify(graph); beforeCommit?.();
        if (changed) {
          db.exec('DELETE FROM graph_edges; DELETE FROM graph_nodes; DELETE FROM graph_scopes;');
          for (const node of graph.nodes) db.prepare('INSERT INTO graph_nodes VALUES (?,?)').run(node.id, JSON.stringify(node));
          for (const edge of graph.edges) db.prepare('INSERT INTO graph_edges VALUES (?,?,?,?)').run(edge.id, edge.from, edge.to, JSON.stringify(edge));
          for (const scope of graph.scopes) db.prepare('INSERT INTO graph_scopes VALUES (?,?,?)').run(scope.company, scope.goal, JSON.stringify(scope));
          db.exec('UPDATE graph_meta SET revision=revision+1');
        }
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    if (changed) for (const listener of this.listeners) listener(); return value;
  }
  private nodes(graph: StoredGraph, values: unknown[]) {
    if (values.length > 1000) throw Error('graph_limit');
    for (const value of values) {
      const node = graphNode(value), existing = graph.nodes.find(n => n.id === node.id);
      if (existing) {
        if (['providerId', 'role', 'company', 'goal'].some(key => existing[key as keyof GraphNode] !== node[key as keyof GraphNode]) || workspaceIdentity(existing.workspace) !== workspaceIdentity(node.workspace)) throw Error('graph_node_conflict');
        // Native titles stay provider-owned; link repeats do not rename metadata.
      } else graph.nodes.push(node);
    }
  }
  putNodes(nodes: unknown[]): void { this.write(graph => this.nodes(graph, nodes)); }
  setUserStopped(id: string, stopped: boolean): void {
    sessionId(id); if (typeof stopped !== 'boolean') throw Error('invalid_graph_stop');
    this.write(graph => { const node = graph.nodes.find(n => n.id === id); if (node && !!node.userStopped !== stopped) node.userStopped = stopped; });
  }
  configurePush(from: string, to: string, kind: EdgeKind, value: unknown, expected: number): void {
    sessionId(from); sessionId(to); choice(kind, kinds); integer(expected); const push = edgePush(value);
    if (kind === 'peer') throw Error('graph_peer_subscription');
    this.write(graph => {
      if (graph.storeRevision !== expected) throw Error('graph_revision_conflict');
      const edge = graph.edges.find(e => e.from === from && e.to === to && e.kind === kind);
      if (!edge) throw Error('graph_edge_missing'); edge.push = push;
    });
  }
  recordReverse(ids: string[], summary: string, questionId?: string): void {
    if (summary.length > 200 || ids.length > 4000 || questionId && questionId.length > 160) throw Error('graph_exchange_limit');
    this.write(graph => { for (const edge of graph.edges) if (ids.includes(edge.id)) edge.reverse = {
      summary, time: Date.now(), awaitingReply: !!questionId, ...(questionId ? { questionId } : {}) }; });
  }
  resolveReverse(child: string, questionId: string): void {
    this.write(graph => { for (const edge of graph.edges) if (edge.to === child && edge.reverse?.questionId === questionId) edge.reverse = { ...edge.reverse, awaitingReply: false }; });
  }
  private edge(graph: StoredGraph, from: string, to: string, kind: EdgeKind): GraphEdge {
    sessionId(from); sessionId(to); choice(kind, kinds); if (from === to) throw Error('graph_self_edge');
    if (!graph.nodes.some(n => n.id === from) || !graph.nodes.some(n => n.id === to)) throw Error('graph_node_missing');
    if (kind === 'peer' && from > to) [from, to] = [to, from]; const id = JSON.stringify([kind, from, to]);
    const existing = graph.edges.find(e => e.id === id); if (existing) return existing;
    if (kind !== 'peer') {
      const pending = [to], seen = new Set<string>();
      while (pending.length) { const next = pending.pop()!; if (next === from) throw Error('graph_cycle'); if (seen.has(next)) continue; seen.add(next);
        for (const edge of graph.edges) if (edge.kind !== 'peer' && edge.from === next) pending.push(edge.to);
      }
    }
    const edge: GraphEdge = { id, from, to, kind, createdAt: Date.now(), forward: null, reverse: null }; graph.edges.push(edge); return edge;
  }
  link(from: string, to: string, kind: EdgeKind, nodes: unknown[] = [], role?: string): GraphEdge {
    return this.write(graph => { this.nodes(graph, nodes); if (role !== undefined && graph.nodes.find(n => n.id === to)?.role !== role) throw Error('graph_role_conflict'); return this.edge(graph, from, to, kind); });
  }
  unlink(from: string, to: string, kind: EdgeKind): void {
    sessionId(from); sessionId(to); choice(kind, kinds); if (kind === 'peer' && from > to) [from, to] = [to, from];
    this.write(graph => { graph.edges = graph.edges.filter(e => !(e.from === from && e.to === to && e.kind === kind)); });
  }
  removeNode(id: string): void {
    sessionId(id); this.write(graph => {
      if (graph.scopes.some(s => s.data && (Object.values(s.data.workers).some(w => w.sessionId === id) || s.data.coordinatorConfiguration?.sessionId === id))) throw Error('graph_node_referenced');
      graph.nodes = graph.nodes.filter(n => n.id !== id); graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);
    });
  }
  readScope(company: string, goal: string): GraphScope | undefined { name(company); name(goal); return this.snapshot().scopes.find(s => s.company === company && s.goal === goal); }
  bindWorker(company: string, goal: string, key: string, parent: GraphNode, child: GraphNode, expected: number): GraphScope {
    return this.write(graph => {
      const scope = graph.scopes.find(s => s.company === company && s.goal === goal);
      const binding = scope?.data?.workers[key];
      if (!binding || binding.sessionId || graph.nodes.some(n => n.id === child.id)) throw Error('graph_assignment_conflict');
      if (binding.providerId !== child.providerId || binding.role !== child.role || workspaceIdentity(binding.workspace) !== workspaceIdentity(child.workspace)) throw Error('graph_assignment_conflict');
      // Validate the parent's identity without passing server-owned stop state as node input.
      const { userStopped: _userStopped, ...parentIdentity } = parent;
      this.nodes(graph, [parentIdentity, child]);
      this.edge(graph, parent.id, child.id, child.role === 'review' ? 'reviews' : 'delegates');
      const data = { ...scope!.data!, workers: { ...scope!.data!.workers, [key]: { ...binding, sessionId: child.id } } };
      return this.scope(graph, company, goal, data, expected);
    });
  }
  recordForward(parent: string, child: string, summary: string): void {
    this.write(graph => { for (const edge of graph.edges) if (edge.from === parent && edge.to === child && edge.kind !== 'peer') edge.forward = { summary: bounded(summary, 200), time: Date.now(), awaitingReply: true }; });
  }
  resolveForward(child: string): void {
    this.write(graph => { for (const edge of graph.edges) if (edge.to === child && edge.forward?.awaitingReply) edge.forward = { ...edge.forward, awaitingReply: false }; });
  }
  private scope(graph: StoredGraph, company: string, goal: string, value: unknown, expected: number, receipt?: string): GraphScope {
    name(company); name(goal); integer(expected); const previous = graph.scopes.find(s => s.company === company && s.goal === goal);
    if ((previous?.revision ?? 0) !== expected) throw Error('graph_revision_conflict'); const data = value === null ? null : scopeDocument(value);
    if (previous?.data && data) {
      if (data.goal.profileRevision !== previous.data.goal.profileRevision + Number(data.goal.profile !== previous.data.goal.profile)) throw Error('graph_profile_revision_conflict');
      for (const [key, worker] of Object.entries(data.workers)) {
        const old = previous.data.workers[key]; if (old && (old.role !== worker.role || old.providerId !== worker.providerId || workspaceIdentity(old.workspace) !== workspaceIdentity(worker.workspace) || old.sessionId && old.sessionId !== worker.sessionId)) throw Error('graph_worker_conflict');
      }
    }
    if (data) for (const worker of Object.values(data.workers)) if (worker.sessionId) {
      const node = graph.nodes.find(n => n.id === worker.sessionId);
      if (!node || node.providerId !== worker.providerId || workspaceIdentity(node.workspace) !== workspaceIdentity(worker.workspace)) throw Error('graph_worker_reference');
    }
    const scope: GraphScope = { company, goal, owned: true, revision: expected + 1, receipt: receipt ?? previous?.receipt ?? null, data };
    graph.scopes = graph.scopes.filter(s => s !== previous); graph.scopes.push(scope); return scope;
  }
  updateScope(company: string, goal: string, value: unknown, expectedRevision: number): GraphScope {
    return this.write(graph => this.scope(graph, company, goal, value, expectedRevision));
  }
  importSnapshot(input: { company: string; goal: string; data: ScopeDocument; nodes: GraphNode[]; receipt: string }, check: () => void) {
    if (!/^[a-f0-9]{64}$/.test(input.receipt)) throw Error('invalid_graph_receipt');
    return this.write(graph => {
      const existing = graph.scopes.find(s => s.company === input.company && s.goal === input.goal);
      if (existing) { if (existing.receipt === input.receipt) return { alreadyImported: true }; throw Error('graph_scope_owned'); }
      this.nodes(graph, input.nodes); this.scope(graph, input.company, input.goal, input.data, 0, input.receipt); check(); return { alreadyImported: false };
    });
  }
}
