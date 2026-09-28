import { randomUUID } from 'crypto';
import type { AgentProvider, AgentSession, AgentEvent, TurnInput } from './types';
import type { SessionState } from '../sessionState';
import type { ReplayMessage } from '../sessions';
import type { RateLimitInfo } from '../accountUsage';
import { AppServerRpc, object, array, string, type JsonObject } from './rpc';
import { records, sessionRecord, saveSession, forgetSession, sameWorkspace } from './store';
import type { ProviderModel, ProviderSelection } from '../../shared/provider';
import { readConfig } from '../config';

function nativeId(id: string): string {
  if (!/^codex:[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid conversation id');
  return id.slice(6);
}

async function withRpc<T>(action: (rpc: AppServerRpc) => Promise<T>): Promise<T> {
  const rpc = new AppServerRpc();
  rpc.onMessage = (_method, _params, id) => { if (id !== undefined) rpc.reject(id); };
  try { await rpc.start(); return await action(rpc); }
  finally { rpc.dispose(); }
}

let catalog: { models: ProviderModel[]; runtimeDefaultModel?: string } | undefined;
let catalogAt = 0;
let catalogPending: Promise<NonNullable<typeof catalog>> | undefined;
async function models(): Promise<NonNullable<typeof catalog>> {
  if (catalog && Date.now() - catalogAt < 60_000) return catalog;
  if (catalogPending) return catalogPending;
  catalogPending = withRpc(async rpc => {
    const list: ProviderModel[] = [];
    let cursor: string | undefined;
    do {
      const result = await rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const value of array(result.data)) {
        const m = object(value);
        if (!string(m.model || m.id)) continue;
        list.push({ id: string(m.model || m.id), displayName: string(m.displayName || m.id), description: string(m.description),
          efforts: array(m.supportedReasoningEfforts).map(e => string(object(e).reasoningEffort)).filter(Boolean),
          inputKinds: array(m.inputModalities).map(string), isDefault: m.isDefault === true });
      }
      cursor = string(result.nextCursor) || undefined;
    } while (cursor && list.length < 1000);
    catalog = { models: list, runtimeDefaultModel: list.find(m => m.isDefault)?.id };
    catalogAt = Date.now();
    return catalog;
  }).finally(() => { catalogPending = undefined; });
  return catalogPending;
}

export function rateLimits(result: JsonObject): RateLimitInfo[] {
  const buckets = Object.values(object(result.rateLimitsByLimitId));
  if (!buckets.length && result.rateLimits) buckets.push(result.rateLimits);
  return buckets.flatMap(value => {
    const bucket = object(value);
    return ['primary', 'secondary'].flatMap(key => {
      const w = object(bucket[key]);
      if (typeof w.usedPercent !== 'number') return [];
      return [{ rateLimitType: `${string(bucket.limitId) || 'codex'}_${key}`,
        utilization: Math.max(0, Math.min(1, w.usedPercent / 100)),
        resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : undefined,
        label: `${string(bucket.limitName) || 'Codex'} ${typeof w.windowDurationMins === 'number' ? `${w.windowDurationMins / 60}h` : key}` }];
    });
  });
}

let accountPending: ReturnType<AgentProvider['account']> | undefined;
let accountCache: Awaited<ReturnType<AgentProvider['account']>> | undefined;
let accountAt = 0;
async function account(): ReturnType<AgentProvider['account']> {
  if (accountCache && Date.now() - accountAt < 60_000) return accountCache;
  if (accountPending) return accountPending;
  accountPending = withRpc(async rpc => {
    const result = await rpc.request('account/read', { refreshToken: false });
    const a = object(result.account);
    const snapshot = { account: { loggedIn: !!result.account, authMethod: string(a.type), email: string(a.email), subscriptionType: string(a.planType) },
      rateLimits: [] as RateLimitInfo[], usageError: undefined as string | undefined };
    if (result.account) {
      try { snapshot.rateLimits = rateLimits(await rpc.request('account/rateLimits/read')); }
      catch (error) { snapshot.usageError = (error as Error).message; }
    }
    accountCache = snapshot; accountAt = Date.now();
    return snapshot;
  }).finally(() => { accountPending = undefined; });
  return accountPending;
}

function toolResult(value: unknown): string {
  return JSON.stringify(value, (_key, part) => {
    if (part && typeof part === 'object' && part.type === 'image' && typeof part.data === 'string')
      return { type: 'image', mimeType: part.mimeType, content: '[image omitted]' };
    return part;
  });
}

function tool(item: JsonObject) {
  const type = string(item.type);
  const kind = type === 'commandExecution' ? 'command' : type === 'fileChange' ? 'fileChange' : 'generic';
  const input: JsonObject = type === 'commandExecution' ? { command: item.command, cwd: item.cwd }
    : type === 'fileChange' ? { changes: item.changes } : { ...object(item.arguments), detail: item.query || item.name || type };
  return { id: string(item.id), name: string(item.tool) || type, kind, input,
    result: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput
      : item.result !== undefined ? toolResult(item.result) : type === 'fileChange' ? JSON.stringify(item.changes, null, 2) : string(item.status),
    error: item.status === 'failed' || item.status === 'declined' };
}

export function replayThread(thread: JsonObject): ReplayMessage[] {
  const messages: ReplayMessage[] = [];
  for (const rawTurn of array(thread.turns)) {
    const turn = object(rawTurn);
    let assistant: ReplayMessage | undefined;
    for (const rawItem of array(turn.items)) {
      const item = object(rawItem);
      if (item.type === 'userMessage') {
        assistant = undefined;
        const content = array(item.content).map(c => string(object(c).text)).filter(Boolean).join('\n');
        const images = array(item.content).flatMap(value => {
          const c = object(value);
          const match = c.type === 'image' ? /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(string(c.url)) : null;
          return match ? [{ mediaType: match[1], data: match[2] }] : [];
        });
        messages.push({ id: string(item.id), role: 'user', content, ...(images.length ? { images } : {}) });
      } else {
        if (!assistant) {
          assistant = { id: `reply-${string(turn.id)}-${messages.length}`, role: 'assistant', content: '', blocks: [] };
          messages.push(assistant);
        }
        if (item.type === 'agentMessage') {
          assistant.content += string(item.text);
          assistant.blocks!.push({ type: 'text', text: string(item.text) });
        } else if (item.type === 'reasoning') {
          assistant.thinking = array(item.summary).map(v => typeof v === 'string' ? v : string(object(v).text)).join('\n');
        } else if (item.type !== 'contextCompaction') assistant.blocks!.push({ type: 'tool', call: tool(item) });
      }
    }
  }
  return messages;
}

export class CodexSession implements AgentSession {
  private threadId?: string;
  private turnId?: string;
  private closed = false;
  private busy = false;
  private stopping?: Promise<void>;
  private startPending?: Promise<void>;
  private interruptSettled?: () => void;
  private deltas = new Set<string>();
  private interactions = new Map<string, { rpcId: string | number; method: string; params: JsonObject }>();
  private pendingInteractionIds: string[] = [];
  private idleTimer?: NodeJS.Timeout;
  get active(): boolean { return this.busy; }
  get pid(): number | undefined { return this.rpc.pid; }
  get reconnectNeeded(): boolean { return this.closed; }

  constructor(private readonly state: SessionState, private readonly rpc = new AppServerRpc(), private readonly validate = codexProvider.validate) {
    this.rpc.onMessage = (method, params, id) => this.receive(method, params, id);
    this.rpc.onFailure = error => { if (!this.closed) { if (this.busy) this.fail(error); else this.dispose(); } };
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const config = readConfig();
    if (!this.busy || this.interactions.size || !config.watchdogEnabled) return;
    this.idleTimer = setTimeout(() => {
      this.fail(new Error('Provider stopped reporting progress. Its process was terminated; inspect the workspace before retrying.'));
    }, Math.max(30, config.watchdogTimeout) * 1000);
    this.idleTimer.unref();
  }

  private emit(event: AgentEvent): void {
    if (event.type === 'interaction') this.state.interaction = event.request;
    if (!this.closed) this.state.broadcast(JSON.stringify(event));
  }

  async send(input: TurnInput): Promise<void> {
    const selection = { ...this.state.selection };
    if (this.closed) throw new Error('Reopen the conversation to reconnect the provider');
    if (this.stopping) await this.stopping;
    if (this.startPending) await this.startPending;
    const content: JsonObject[] = [];
    if (input.text) content.push({ type: 'text', text: input.text });
    for (const image of input.images ?? []) {
      if (image.mediaType.startsWith('text/')) content.push({ type: 'text', text: `[${image.name || 'attachment'}]\n${Buffer.from(image.data, 'base64').toString('utf8')}` });
      else if (/^image\/(png|jpeg|gif|webp)$/.test(image.mediaType)) content.push({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` });
      else throw new Error('This provider accepts text and images. Convert this attachment to text before sending.');
    }
    if (this.busy) {
      if (!this.turnId || this.interactions.size) throw new Error('Answer the pending question or wait for the turn to start');
      await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: content });
      this.emit({ type: 'user_inject', text: input.text || '' });
      return;
    }
    this.busy = true; this.state.cliDone = false; this.deltas.clear();
    this.state.liveInputTokens = 0; this.state.completedOutputTokens = 0; this.state.liveOutputChars = 0;
    this.state.lastMessage = { text: input.text || '', images: input.images, mode: input.mode };
    if (!input._silent) this.state.broadcast(JSON.stringify({ type: 'message', message: { id: randomUUID(), role: 'user', content: input.text || '', images: input.images } }));
    this.emit({ type: 'thinking_start' });
    this.armIdleTimer();
    this.startPending = this.startTurn(input, content, selection);
    try { await this.startPending; }
    catch (error) { this.fail(error as Error); }
    finally { this.startPending = undefined; }
  }

  private async startTurn(input: TurnInput, content: JsonObject[], selection: ProviderSelection): Promise<void> {
    await this.rpc.start();
    await this.validate(selection);
    const fullAccess = input.mode === 'full-access';
    const approvalPolicy = fullAccess ? 'never' : 'on-request';
    const sandbox = fullAccess ? 'danger-full-access' : input.mode === 'plan' ? 'read-only' : 'workspace-write';
    const sandboxPolicy = fullAccess ? { type: 'dangerFullAccess' } : input.mode === 'plan'
      ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [this.state.workspaceDir], networkAccess: false };
    const skillMatch = /^\/([^\s]+)(?:\s|$)/.exec(input.text || '');
    if (skillMatch) {
      const result = await this.rpc.request('skills/list', { cwds: [this.state.workspaceDir] });
      const skill = array(result.data).flatMap(d => array(object(d).skills)).map(object)
        .find(s => s.name === skillMatch[1] && s.enabled !== false && typeof s.path === 'string');
      if (skill) {
        const text = content.find(c => c.type === 'text');
        if (text) text.text = '$' + (input.text || '').slice(1);
        content.push({ type: 'skill', name: skill.name, path: skill.path });
      }
    }
    if (!this.threadId) {
      const existing = this.state.sessionId;
      if (existing && !sessionRecord(existing, this.state.workspaceDir)) throw new Error('Conversation does not belong to this workspace');
      const result = await this.rpc.request(existing ? 'thread/resume' : 'thread/start', {
        ...(existing ? { threadId: nativeId(existing) } : {}), cwd: this.state.workspaceDir,
        approvalPolicy, sandbox,
        ...(selection.model ? { model: selection.model } : {}),
      });
      this.threadId = string(object(result.thread).id);
      if (!this.threadId) throw new Error('Provider returned no conversation id');
      this.state.sessionId = `codex:${this.threadId}`;
      this.emit({ type: 'sessionId', id: this.state.sessionId });
    }
    const old = sessionRecord(this.state.sessionId!);
    saveSession({ id: this.state.sessionId!, cwd: this.state.workspaceDir, selection: { ...this.state.selection },
      title: old?.title || (input.text || 'New conversation').slice(0, 100), updatedAt: Date.now() });
    const response = await this.rpc.request('turn/start', { threadId: this.threadId, input: content,
      ...(selection.model ? { model: selection.model } : {}), ...(selection.effort ? { effort: selection.effort } : {}),
      approvalPolicy, sandboxPolicy,
    });
    if (this.busy) this.turnId = string(object(response.turn).id) || this.turnId;
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.startPending) await this.startPending.catch(() => {});
      if (!this.busy || !this.turnId) return;
      const completed = new Promise<void>(resolve => { this.interruptSettled = resolve; });
      const timer = setTimeout(() => { this.fail(new Error('Stop was not acknowledged; the owned provider process was terminated')); this.dispose(); }, 5000);
      try {
        while (this.busy && !this.closed) {
          try {
            await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
            break;
          } catch (error) {
            if (!this.busy || this.closed) break;
            // turn/start can reply before the native turn becomes interruptible.
            if (!/no active turn to interrupt/i.test((error as Error).message)) throw error;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        await completed;
      } catch (error) {
        this.fail(error as Error);
      } finally { clearTimeout(timer); this.interruptSettled = undefined; }
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  respond(id: string, response: unknown): void {
    const pending = this.interactions.get(id);
    if (!pending || id !== this.pendingInteractionIds[0]) throw new Error('This request is no longer pending');
    const answer = object(response);
    let result: JsonObject;
    if (pending.method === 'item/tool/requestUserInput') {
      const answers: JsonObject = {};
      for (const value of array(pending.params.questions)) {
        const question = object(value); const key = string(question.id);
        const text = string(object(answer.answers)[key]);
        if (!text.trim()) throw new Error('Answer every question');
        answers[key] = { answers: [text] };
      }
      result = { answers };
    } else {
      const decision = answer.decision === 'accept' ? 'accept' : 'decline';
      const offered = array(pending.params.availableDecisions);
      if (offered.length && !offered.includes(decision)) throw new Error('This decision is not offered by the provider');
      result = { decision };
    }
    this.rpc.respond(pending.rpcId, result);
    this.resolveInteraction(id);
  }

  private resolveInteraction(id: string): void {
    this.interactions.delete(id);
    this.pendingInteractionIds = this.pendingInteractionIds.filter(key => key !== id);
    this.showInteraction();
  }

  private showInteraction(): void {
    this.armIdleTimer();
    const id = this.pendingInteractionIds[0]; const entry = this.interactions.get(id);
    if (!entry) { this.emit({ type: 'interaction', request: null }); return; }
    const { params, method } = entry;
    this.emit({ type: 'interaction', request: { id,
      kind: method === 'item/tool/requestUserInput' ? 'question' : 'approval',
      title: method === 'item/tool/requestUserInput' ? 'Your input is needed' : 'Approve this operation?',
      detail: [string(params.reason), string(params.command), string(params.cwd)].filter(Boolean).join('\n'),
      options: array(params.availableDecisions).length ? array(params.availableDecisions).filter(v => v === 'accept' || v === 'decline').map(string) : ['accept', 'decline'],
      questions: array(params.questions).map(v => { const q = object(v); return { id: string(q.id), question: string(q.question), options: array(q.options).map(o => string(object(o).label)) }; }),
    } });
  }

  private receive(method: string, params: JsonObject, requestId?: string | number): void {
    if (this.closed) return;
    this.state.sendLog?.('debug', `Provider event: ${method}`);
    if (requestId !== undefined) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'].includes(method)
        && params.threadId === this.threadId && this.busy && (!params.turnId || !this.turnId || params.turnId === this.turnId)) {
        const id = randomUUID(); this.interactions.set(id, { rpcId: requestId, method, params });
        this.pendingInteractionIds.push(id); this.showInteraction();
      } else this.rpc.reject(requestId);
      return;
    }
    if (params.threadId !== this.threadId) return;
    if (method === 'serverRequest/resolved') {
      for (const [id, entry] of this.interactions) if (entry.rpcId === params.requestId) this.resolveInteraction(id);
      return;
    }
    if (!this.busy) return;
    this.armIdleTimer();
    if (method === 'turn/started') { this.turnId = string(object(params.turn).id); return; }
    if (params.turnId && this.turnId && params.turnId !== this.turnId) return;
    if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta') {
      this.deltas.add(`${method}:${string(params.itemId)}`);
      this.emit({ type: method === 'item/agentMessage/delta' ? 'text_chunk' : 'thinking_chunk', text: string(params.delta) });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item); const done = method === 'item/completed';
      if (item.type === 'agentMessage') {
        if (done && !this.deltas.has(`item/agentMessage/delta:${string(item.id)}`)) this.emit({ type: 'text_chunk', text: string(item.text) });
      } else if (!['userMessage', 'reasoning', 'contextCompaction'].includes(string(item.type))) {
        this.emit({ type: done ? 'tool_end' : 'tool_start', call: tool(item) });
      }
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = object(params.tokenUsage); const last = object(usage.last);
      const inputTokens = Number(last.inputTokens) || 0; const outputTokens = Number(last.outputTokens) || 0;
      this.state.liveInputTokens = inputTokens; this.state.completedOutputTokens = outputTokens;
      this.emit({ type: 'token_update', inputTokens, outputTokens });
      if (typeof usage.modelContextWindow === 'number' && usage.modelContextWindow > 0)
        this.emit({ type: 'contextUsage', percent: Math.min(100, inputTokens / usage.modelContextWindow * 100), inputTokens, outputTokens, contextWindow: usage.modelContextWindow });
    } else if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (this.turnId && turn.id !== this.turnId) return;
      if (turn.error) this.emit({ type: 'error', text: string(object(turn.error).message) || 'Provider turn failed' });
      this.finish(turn.status === 'interrupted');
    }
  }

  private finish(interrupted = false): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.busy = false; this.state.cliDone = true; this.turnId = undefined;
    this.interactions.clear(); this.pendingInteractionIds = [];
    this.emit({ type: 'interaction', request: null });
    this.emit({ type: 'done', interrupted });
    this.interruptSettled?.();
  }

  private fail(error: Error): void {
    this.emit({ type: 'error', text: error.message });
    if (this.busy) this.finish();
    this.dispose();
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.closed = true; this.busy = false; this.state.cliDone = true;
    this.interruptSettled?.(); this.interactions.clear(); this.rpc.dispose();
  }
}

export const codexProvider: AgentProvider = {
  descriptor: { id: 'codex', label: 'Codex', thinkingToggle: false, efforts: [], inputKinds: ['text', 'image'] },
  createSession: state => new CodexSession(state), models, account,
  async validate(selection) {
    const list = (await models()).models;
    const model = selection.model ? list.find(m => m.id === selection.model) : list.find(m => m.isDefault);
    if (!model) throw new Error('The selected model is unavailable for this account');
    if (selection.effort && !model.efforts?.includes(selection.effort)) throw new Error('This reasoning effort is not supported by the selected model');
  },
  async skills(cwd) {
    return withRpc(async rpc => {
      const result = await rpc.request('skills/list', { cwds: [cwd] });
      return array(result.data).flatMap(d => array(object(d).skills)).map(value => {
        const s = object(value); return { name: string(s.name), description: string(s.description), path: string(s.path), kind: 'skill', scope: 'provider' };
      });
    });
  },
  async list(cwd) {
    return records().filter(r => r.selection.providerId === 'codex' && sameWorkspace(r.cwd, cwd))
      .map(r => ({ id: r.id, title: r.title, lastPrompt: '', updatedAt: r.updatedAt, lines: 0, providerId: 'codex' }));
  },
  async load(id, cwd) {
    if (!sessionRecord(id, cwd)) throw new Error('Conversation does not belong to this workspace');
    return withRpc(async rpc => replayThread(object((await rpc.request('thread/read', { threadId: nativeId(id), includeTurns: true })).thread)));
  },
  async rename(id, cwd, title) {
    const record = sessionRecord(id, cwd); if (!record) throw new Error('Conversation not found');
    const name = title.trim().slice(0, 200); if (!name) throw new Error('Title is required');
    await withRpc(rpc => rpc.request('thread/name/set', { threadId: nativeId(id), name }));
    saveSession({ ...record, title: name });
  },
  async remove(id, cwd) {
    if (!sessionRecord(id, cwd)) throw new Error('Conversation not found');
    await withRpc(rpc => rpc.request('thread/archive', { threadId: nativeId(id) }));
    forgetSession(id);
  },
};
