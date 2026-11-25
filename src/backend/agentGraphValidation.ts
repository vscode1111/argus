import * as path from 'path';
import { provider, providerForSession } from './providers/registry';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_graph_record');
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw Error('invalid_graph_field');
}
export function bounded(value: unknown, max = 200, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b-\u001f]/.test(value)) throw Error('invalid_graph_string');
  return value;
}
export function name(value: unknown): string {
  const text = bounded(value, 80); if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(text) || text.includes('..')) throw Error('invalid_graph_name'); return text;
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw Error('invalid_graph_number'); return value as number;
}
export function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw Error('invalid_graph_choice'); return value as T;
}
export function sessionId(value: unknown): string {
  const id = bounded(value, 160); if (!/^[a-zA-Z0-9:_-]+$/.test(id)) throw Error('invalid_graph_id'); providerForSession(id); return id;
}
export function workspace(value: unknown): string {
  const text = bounded(value, 1024); if (!path.isAbsolute(text) && !/^[a-zA-Z]:[\\/]/.test(text)) throw Error('invalid_graph_workspace'); return text;
}
export function workspaceIdentity(value: string): string {
  return /^[a-zA-Z]:[\\/]|^\\\\/.test(value) ? path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase() : path.posix.normalize(value);
}
export const roles = ['super', 'coordinator', 'work', 'review', 'other'] as const;
export const kinds = ['delegates', 'reviews', 'peer'] as const;
export type EdgeKind = typeof kinds[number];
export interface GraphNode { id: string; providerId: string; role: typeof roles[number]; title: string; company: string; goal: string; workspace: string; createdAt: number; updatedAt: number; userStopped?: boolean }
export function graphNode(value: unknown): GraphNode {
  const v = record(value); fields(v, ['id', 'providerId', 'role', 'title', 'company', 'goal', 'workspace', 'createdAt', 'updatedAt']);
  const id = sessionId(v.id), providerId = bounded(v.providerId, 40);
  if (providerForSession(id).descriptor.id !== providerId) throw Error('invalid_graph_provider');
  return { id, providerId, role: choice(v.role, roles), title: bounded(v.title, 200, true), company: name(v.company), goal: name(v.goal),
    workspace: workspace(v.workspace), createdAt: integer(v.createdAt), updatedAt: integer(v.updatedAt) };
}
export function selection(value: unknown) {
  const v = record(value); fields(v, ['providerId', 'model', 'effort', 'thinking']);
  const providerId = bounded(v.providerId, 40); provider(providerId);
  if (v.thinking !== undefined && typeof v.thinking !== 'boolean') throw Error('invalid_graph_selection');
  return { providerId, model: bounded(v.model, 200, true), effort: bounded(v.effort, 40, true), ...(v.thinking !== undefined ? { thinking: v.thinking } : {}) };
}
export function configuration(value: unknown): Record<string, unknown> {
  const v = record(value); fields(v, ['operationId', 'sourceTurnId', 'activeTurnId', 'sessionId', 'status', 'selection', 'sourceSelection', 'profileRevision', 'verifiedAt', 'reason']);
  const result: Record<string, unknown> = {};
  for (const key of ['operationId', 'sourceTurnId', 'activeTurnId']) if (v[key] !== undefined) result[key] = bounded(v[key], 160);
  if (v.sessionId !== undefined) result.sessionId = sessionId(v.sessionId);
  if (v.status !== undefined) result.status = choice(v.status, ['queued', 'applied', 'started', 'cancelled', 'failed']);
  for (const key of ['selection', 'sourceSelection']) if (v[key] !== undefined) result[key] = selection(v[key]);
  for (const key of ['profileRevision', 'verifiedAt']) if (v[key] !== undefined) result[key] = integer(v[key]);
  if (v.reason !== undefined) result.reason = bounded(v.reason, 512, true);
  return result;
}
export interface ScopeDocument { version: 1; goal: { title: string; status: string; profile: string; profileRevision: number; createdAt: number; updatedAt: number }; reviewCycles: { deliverable: string; count: number }[]; coordinatorConfiguration?: Record<string, unknown>; workers: Record<string, WorkerBinding> }
export interface WorkerBinding { role: typeof roles[number]; providerId: string; workspace: string; title: string; profile: string; model: string; effort: string; sessionId: string | null; mode?: 'full-access' | 'edit' | 'plan' }
export function worker(value: unknown): WorkerBinding {
  const v = record(value); fields(v, ['role', 'providerId', 'workspace', 'title', 'profile', 'model', 'effort', 'sessionId', 'mode']);
  const providerId = bounded(v.providerId, 40); provider(providerId); const id = v.sessionId === null ? null : sessionId(v.sessionId);
  if (id && providerForSession(id).descriptor.id !== providerId) throw Error('invalid_graph_provider');
  return { role: choice(v.role, roles), providerId, workspace: workspace(v.workspace), title: bounded(v.title, 200, true),
    profile: choice(v.profile, ['normal', 'important']), model: bounded(v.model, 200, true), effort: bounded(v.effort, 40, true), sessionId: id,
    ...(v.mode === undefined ? {} : { mode: choice(v.mode, ['full-access', 'edit', 'plan'] as const) }) };
}
export function scopeDocument(value: unknown): ScopeDocument {
  const v = record(value); fields(v, ['version', 'goal', 'reviewCycles', 'coordinatorConfiguration', 'workers']);
  if (v.version !== 1) throw Error('invalid_graph_version'); const g = record(v.goal);
  fields(g, ['title', 'status', 'profile', 'profileRevision', 'createdAt', 'updatedAt']);
  const goal = { title: bounded(g.title, 150), status: choice(g.status, ['active', 'blocked', 'done']), profile: choice(g.profile, ['normal', 'important']),
    profileRevision: integer(g.profileRevision), createdAt: integer(g.createdAt), updatedAt: integer(g.updatedAt) };
  if (goal.profileRevision < 1 || !Array.isArray(v.reviewCycles) || v.reviewCycles.length > 128) throw Error('invalid_graph_scope');
  const seen = new Set<string>(); const reviewCycles = v.reviewCycles.map(value => {
    const r = record(value); fields(r, ['deliverable', 'count']); const deliverable = name(r.deliverable);
    if (seen.has(deliverable)) throw Error('invalid_graph_duplicate'); seen.add(deliverable); return { deliverable, count: integer(r.count, 3) };
  });
  const raw = record(v.workers); if (Object.keys(raw).length > 128) throw Error('invalid_graph_workers');
  const workers: Record<string, WorkerBinding> = Object.create(null); const sessions = new Set<string>();
  for (const key of Object.keys(raw).sort()) {
    name(key); const binding = worker(raw[key]); if (binding.sessionId && sessions.has(binding.sessionId)) throw Error('invalid_graph_duplicate_session');
    if (binding.sessionId) sessions.add(binding.sessionId); workers[key] = binding;
  }
  const result: ScopeDocument = { version: 1, goal, reviewCycles, workers, ...(v.coordinatorConfiguration === undefined ? {} : { coordinatorConfiguration: configuration(v.coordinatorConfiguration) }) };
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw Error('invalid_graph_scope_size'); return result;
}
