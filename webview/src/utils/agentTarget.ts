import type { ProviderInteraction, ProviderSelection } from '../../../src/shared/provider';
export interface AgentTarget { sessionId: string; workspace: string; providerId: string }
export interface AgentControl { sessionId: string; workspace: string; target: AgentTarget; selection: ProviderSelection; active: boolean; pendingInteraction?: ProviderInteraction }
export interface TargetHandle {
  inspect(): Promise<AgentControl>;
  effect(kind: 'answer' | 'async-answer' | 'steer' | 'stop', payload: object): Promise<unknown>;
  close(): void;
}
export interface WatchPage { ok: boolean; events?: Array<Record<string, unknown>>; next?: object; reset?: string; hasMore?: boolean; unavailable?: string; error?: { message: string; code: string } }
declare global { interface Window { argusAgents?: {
  open(target: AgentTarget, observe: (event: Record<string, unknown>) => void, closed: () => void, signal?: AbortSignal): Promise<TargetHandle>;
  watch(target: AgentTarget, since?: object, current?: () => boolean): Promise<WatchPage>;
} } }
export function sameTarget(control: AgentControl, target: AgentTarget) {
  return control.sessionId === target.sessionId && control.selection?.providerId === target.providerId && typeof control.workspace === 'string'
    && control.target?.sessionId === target.sessionId && control.target.workspace === target.workspace && control.target.providerId === target.providerId;
}
export function questionKey(request?: ProviderInteraction) { return JSON.stringify(request ?? null); }
