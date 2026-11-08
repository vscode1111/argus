import type { ProviderDescriptor, ProviderModel, ProviderSelection, ProviderInteraction } from '../../shared/provider';
import type { ReplayMessage, SessionSummary } from '../sessions';
import type { AccountInfo, RateLimitInfo } from '../accountUsage';
import type { SessionState } from '../sessionState';

export interface TurnInput {
  type?: string;
  text?: string;
  images?: Array<{ data: string; mediaType: string; name?: string }>;
  mode?: string;
  _silent?: boolean;
  _askResume?: boolean;
}

export interface DeferredConfigurationRequest {
  operationId: string;
  expectedTurnId: string;
  selection: ProviderSelection;
  continuation: string;
}

export interface DeferredConfigurationStatus {
  operationId: string;
  sourceTurnId: string;
  status: 'queued' | 'applied' | 'started' | 'cancelled' | 'failed';
  selection: ProviderSelection;
  reason?: string;
}

export interface SessionControl {
  activeTurnId?: string;
  activeSelection?: ProviderSelection;
  configuration?: DeferredConfigurationStatus;
}

export type AgentEvent =
  | { type: 'thinking_start' }
  | { type: 'text_chunk' | 'thinking_chunk'; text: string }
  | { type: 'tool_start' | 'tool_end'; call: { id: string; name: string; input: Record<string, unknown>; result?: string; error?: boolean; kind?: string } }
  | { type: 'sessionId'; id: string }
  | { type: 'done'; interrupted?: boolean }
  | { type: 'error'; text: string; errorKind?: string }
  | { type: 'token_update'; inputTokens: number; outputTokens: number }
  | { type: 'contextUsage'; percent: number; inputTokens: number; outputTokens: number; contextWindow: number }
  | { type: 'interaction'; request: ProviderInteraction | null }
  | { type: 'user_inject'; text: string; images?: TurnInput['images'] };

export interface AgentSession {
  readonly active: boolean;
  readonly activeTurnId?: string;
  readonly pid?: number;
  readonly reconnectNeeded?: boolean;
  getSessionControl?(): SessionControl;
  queueConfiguration?(request: DeferredConfigurationRequest, isCurrent: () => boolean): Promise<DeferredConfigurationStatus>;
  cancelConfiguration?(reason: string): void;
  send(input: TurnInput): Promise<void>;
  stop(): Promise<void>;
  respond(id: string, response: unknown): void;
  dispose(): void;
}

export interface ProviderHistoryPage {
  messages: ReplayMessage[];
  cursor?: unknown;
  turnId?: string;
  previousTurnCursor?: unknown;
}

export interface AgentProvider {
  readonly descriptor: ProviderDescriptor;
  createSession(state: SessionState): AgentSession;
  models(): Promise<{ models: ProviderModel[]; error?: string; runtimeDefaultModel?: string }>;
  account(): Promise<{ account: AccountInfo; rateLimits: RateLimitInfo[]; usageError?: string }>;
  skills(cwd: string): Promise<Array<{ name: string; scope: string; kind?: string; description?: string; path?: string }>>;
  list(cwd: string): Promise<SessionSummary[]>;
  load(id: string, cwd: string): Promise<ReplayMessage[]>;
  loadPage?(id: string, cwd: string, cursor?: unknown): Promise<ProviderHistoryPage>;
  withHistoryReader?<T>(id: string, cwd: string, action: (read: (cursor?: unknown) => Promise<ProviderHistoryPage>) => Promise<T>): Promise<T>;
  loadSubagents?(id: string, cwd: string): Promise<Array<{ id: string; path: string; active: boolean }>>;
  loadSubagent?(parentId: string, childId: string, cwd: string): Promise<ReplayMessage[]>;
  rename(id: string, cwd: string, title: string): Promise<void>;
  remove(id: string, cwd: string): Promise<void>;
  validate(selection: ProviderSelection): Promise<void>;
}
