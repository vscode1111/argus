import { UIMessage, StreamingState, ToolCallData, ContentBlock, LogLevel, LogEntry, LoginState, RetryStatus, TaskNotice } from './types';

export type ContextUsage = { percent: number; inputTokens: number; outputTokens: number; contextWindow?: number };

export type AppState = {
  messages: UIMessage[];
  streaming: StreamingState | null;
  isStreaming: boolean;
  prefill: string;
  workspacePath: string;
  version: string;
  logs: LogEntry[];
  login: LoginState;
  contextUsage: ContextUsage | null;
  /** Background tasks running right now, pushed by the server whenever the set changes.
   *  Session state like contextUsage, not per-message history. */
  bgTasks: number;
  /** A background task reported in before its turn had started. The prompt reaches the
   *  client while cliDone is still true, so there is no streaming state to hold the marker
   *  yet; thinking_start picks it up a moment later. */
  pendingNotice: TaskNotice | null;
  wsConnected: boolean;
  currentModel: string;
  currentEffort: string;
  thinkingEnabled: boolean;
  turnCompletions: number;
};

export type AppAction =
  | { type: 'message'; message: UIMessage }
  | { type: 'thinking_start'; reused?: boolean; startedAt?: number }
  | { type: 'thinking_chunk'; text: string }
  | { type: 'text_chunk'; text: string }
  | { type: 'tool_start'; call: ToolCallData }
  | { type: 'tool_end'; call: ToolCallData }
  | { type: 'done'; pendingBackgroundTasks?: number; backgroundTasksSince?: number; autonomous?: boolean }
  | { type: 'bgTasks'; count: number }
  | { type: 'bg_notice'; notice: TaskNotice }
  | { type: 'stop' }
  | { type: 'error'; text: string; errorKind?: string }
  | { type: 'clear' }
  | { type: 'prefill'; text: string }
  | { type: 'workspaceInfo'; path: string; version?: string; model?: string; effort?: string; thinking?: boolean }
  | { type: 'log'; level: LogLevel; text: string; timestamp: string }
  | { type: 'clearLogs' }
  | { type: 'loginStart' }
  | { type: 'loginUrl'; url: string }
  | { type: 'loginSubmitting' }
  | { type: 'loginResult'; success: boolean; message?: string }
  | { type: 'contextUsage'; percent: number; inputTokens: number; outputTokens: number; contextWindow?: number }
  | { type: 'retry_status'; attempt: number; maxRetries: number; delayMs: number; autoRetry?: number; autoRetryMax?: number; timedOut?: boolean }
  | { type: 'retry_clean' }
  | { type: 'user_inject'; text: string }
  | { type: 'sessionLoaded'; id: string; messages: UIMessage[] }
  | { type: 'modelChanged'; model: string }
  | { type: 'effortChanged'; effort: string }
  | { type: 'thinkingChanged'; thinking: boolean }
  | { type: 'ws_status'; connected: boolean }
  | { type: 'token_update'; inputTokens?: number; outputTokens?: number };

let nextMsgId = 0;
function generateId(): string { return `msg-${++nextMsgId}-${Date.now()}`; }

function finalizeBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map(b =>
    b.type === 'tool' && !b.call.result && !b.call.error
      ? { type: 'tool' as const, call: { ...b.call, error: true } }
      : b
  );
}

function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'message':
      // A message of the user's own supersedes a notice still waiting for a turn: the CLI
      // answers some notifications with an empty turn (the orphan replay on --resume), and
      // the marker must not end up opening the turn the user started.
      return { ...state, messages: [...state.messages, action.message], pendingNotice: action.message.role === 'user' ? null : state.pendingNotice };

    case 'thinking_start': {
      const prev = state.streaming;
      const blocks: ContentBlock[] = state.pendingNotice ? [{ type: 'bg_notice', notice: state.pendingNotice }] : [];
      return {
        ...state,
        pendingNotice: null,
        isStreaming: true,
        streaming: { thinking: '', blocks, startTime: prev ? prev.startTime : (action.startedAt ?? Date.now()), lastEventTime: Date.now(), logsAtStart: prev ? prev.logsAtStart : state.logs.length, reused: action.reused ?? false, stopped: false, retryStatus: prev ? prev.retryStatus : null, watchdogRetries: prev ? prev.watchdogRetries : 0 },
      };
    }

    // The turn may or may not have started yet: live the prompt arrives while cliDone is
    // still true (thinking_start comes with the first assistant event, a beat later), but a
    // task that finishes mid-turn reports in while one is already streaming.
    case 'bg_notice':
      if (!state.streaming) return { ...state, pendingNotice: action.notice };
      return { ...state, streaming: { ...state.streaming, blocks: [...state.streaming.blocks, { type: 'bg_notice', notice: action.notice }], lastEventTime: Date.now() } };

    case 'thinking_chunk':
      if (!state.streaming) return state;
      return {
        ...state,
        streaming: { ...state.streaming, thinking: state.streaming.thinking + action.text, lastEventTime: Date.now(), retryStatus: null },
      };

    case 'text_chunk': {
      if (!state.streaming) return state;
      const blocks = [...state.streaming.blocks];
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'text') {
        blocks[blocks.length - 1] = { type: 'text', text: last.text + action.text };
      } else {
        blocks.push({ type: 'text', text: action.text });
      }
      return { ...state, streaming: { ...state.streaming, blocks, lastEventTime: Date.now(), retryStatus: null } };
    }

    case 'user_inject':
      if (!state.streaming) return state;
      return { ...state, streaming: { ...state.streaming, blocks: [...state.streaming.blocks, { type: 'user_inject', text: action.text }], lastEventTime: Date.now() } };

    case 'tool_start':
      if (!state.streaming) return state;
      return {
        ...state,
        streaming: {
          ...state.streaming,
          blocks: [...state.streaming.blocks, { type: 'tool', call: action.call }],
          lastEventTime: Date.now(),
          retryStatus: null,
          askPausedAt: action.call.name === 'AskUserQuestion' ? Date.now() : state.streaming.askPausedAt,
        },
      };

    case 'tool_end': {
      const inStreaming = state.streaming?.blocks.some(b => b.type === 'tool' && b.call.id === action.call.id);
      if (state.streaming && inStreaming) {
        const updatedBlocks = state.streaming.blocks.map(b =>
          b.type === 'tool' && b.call.id === action.call.id
            ? { type: 'tool' as const, call: { ...b.call, result: action.call.result, error: action.call.error } }
            : b
        );
        const stillHasPendingAsk = updatedBlocks.some(
          b => b.type === 'tool' && b.call.name === 'AskUserQuestion' && !b.call.result && !b.call.error
        );
        return {
          ...state,
          streaming: {
            ...state.streaming,
            blocks: updatedBlocks,
            lastEventTime: Date.now(),
            askPausedAt: stillHasPendingAsk ? state.streaming.askPausedAt : undefined,
          },
        };
      }
      const updated = state.messages.map(msg => {
        if (!msg.blocks) return msg;
        const hasMatch = msg.blocks.some(b => b.type === 'tool' && b.call.id === action.call.id);
        if (!hasMatch) return msg;
        return {
          ...msg,
          blocks: msg.blocks.map(b =>
            b.type === 'tool' && b.call.id === action.call.id
              ? { type: 'tool' as const, call: { ...b.call, result: action.call.result, error: action.call.error } }
              : b
          ),
        };
      });
      return { ...state, messages: updated };
    }

    case 'stop':
      if (!state.streaming) return state;
      return { ...state, streaming: { ...state.streaming, stopped: true } };

    case 'done': {
      if (!state.streaming) return { ...state, isStreaming: false };
      const responseTime = Date.now() - state.streaming.startTime;
      const { blocks, stopped, watchdogRetries } = state.streaming;
      const finalBlocks = finalizeBlocks(blocks);
      const content = extractText(finalBlocks);
      const hasPendingBg = action.pendingBackgroundTasks != null && action.pendingBackgroundTasks > 0;
      const timedOut = state.streaming.retryStatus?.timedOut;
      const outcome = hasPendingBg ? 'background_waiting'
        : stopped ? 'stopped' : timedOut ? 'error' : watchdogRetries > 0 ? 'retried' : 'success';
      const msg: UIMessage = {
        id: generateId(),
        role: 'assistant',
        content,
        thinking: state.streaming.thinking || undefined,
        blocks: finalBlocks.length > 0 ? finalBlocks : undefined,
        responseTime,
        finishedAt: Date.now(),
        outcome,
        watchdogRetries: watchdogRetries > 0 ? watchdogRetries : undefined,
        bgTasksPending: hasPendingBg ? action.pendingBackgroundTasks : undefined,
        bgTasksSince: hasPendingBg ? action.backgroundTasksSince : undefined,
        autonomous: action.autonomous || undefined,
        finalTokens: state.streaming.liveTokens,
      };
      const resolvedMessages = state.messages.map(m =>
        m.outcome === 'background_waiting' ? { ...m, outcome: 'background_done' as const } : m
      );
      // A turn that leaves background tasks behind is still a finished turn. The CLI's own
      // protocol says so: a `run_in_background` tool returns immediately, the turn continues
      // and ends, and the task later announces itself through a task_notification turn of its
      // own. Argus used to keep a synthetic streaming state alive here instead, which claimed
      // the session was still working - so the completion sound and notification never fired,
      // Stop stayed armed, and a task that never ends (a browser launched for CDP, a watcher)
      // left the "Waiting N background tasks" spinner running forever with nothing able to
      // clear it. The still-pending tasks are recorded on the message instead, as a passive
      // note; `background_waiting` now means "finished, tasks outlived it", not "still busy".
      return {
        ...state,
        messages: [...resolvedMessages, msg],
        streaming: null,
        isStreaming: false,
        // Same number the live `bgTasks` pushes carry; taken here too so the indicator is
        // still right against a daemon old enough to predate those pushes (panel/daemon
        // version skew is routine). The field is omitted when the set is empty.
        bgTasks: action.pendingBackgroundTasks ?? 0,
        turnCompletions: state.turnCompletions + 1,
      };
    }

    case 'error': {
      const msgs: UIMessage[] = [];
      let existingMessages = state.messages;
      if (state.streaming && state.streaming.blocks.length > 0) {
        const responseTime = Date.now() - state.streaming.startTime;
        const finalBlocks = finalizeBlocks(state.streaming.blocks);
        const content = extractText(finalBlocks);
        msgs.push({
          id: generateId(),
          role: 'assistant',
          content,
          thinking: state.streaming.thinking || undefined,
          blocks: finalBlocks,
          responseTime,
          finishedAt: Date.now(),
          outcome: 'error',
        });
      } else {
        const idx = existingMessages.findLastIndex(m => m.role === 'assistant');
        if (idx >= 0) {
          existingMessages = existingMessages.map((m, i) =>
            i === idx ? { ...m, outcome: 'error' as const } : m
          );
        }
      }
      const lastAssistant = [...existingMessages, ...msgs].reverse().find(m => m.role === 'assistant');
      const hasWatchdogBlock = lastAssistant?.watchdogRetries != null && lastAssistant.watchdogRetries > 0;
      if (!hasWatchdogBlock) {
        msgs.push({ id: generateId(), role: 'error', content: action.text, errorKind: action.errorKind as UIMessage['errorKind'] });
      }
      return {
        ...state,
        messages: [...existingMessages, ...msgs],
        streaming: null,
        isStreaming: false,
        turnCompletions: state.turnCompletions + 1,
      };
    }

    case 'retry_clean': {
      const msgs = [...state.messages];
      while (msgs.length > 0) {
        const last = msgs[msgs.length - 1];
        if (last.role === 'error') {
          msgs.pop();
        } else if (last.role === 'assistant' && last.outcome === 'error') {
          msgs[msgs.length - 1] = { ...last, outcome: 'retried' };
          break;
        } else {
          break;
        }
      }
      return { ...state, messages: msgs };
    }

    case 'clear':
      return { ...state, messages: [], streaming: null, isStreaming: false, logs: [], contextUsage: null, bgTasks: 0, pendingNotice: null };

    case 'bgTasks':
      return { ...state, bgTasks: action.count };

    case 'sessionLoaded':
      // Replace the conversation with the replayed transcript and drop any
      // in-flight streaming/usage state from the previous session.
      return { ...state, messages: action.messages, streaming: null, isStreaming: false, contextUsage: null, bgTasks: 0, pendingNotice: null };

    case 'prefill':
      return { ...state, prefill: action.text + '\x00' + Date.now() };

    case 'workspaceInfo':
      return {
        ...state,
        workspacePath: action.path,
        version: action.version ?? '',
        ...(action.model !== undefined ? { currentModel: action.model } : {}),
        ...(action.effort !== undefined ? { currentEffort: action.effort } : {}),
        ...(action.thinking !== undefined ? { thinkingEnabled: action.thinking } : {}),
      };

    case 'modelChanged':
      return { ...state, currentModel: action.model };

    case 'effortChanged':
      return { ...state, currentEffort: action.effort };

    case 'thinkingChanged':
      return { ...state, thinkingEnabled: action.thinking };

    case 'retry_status': {
      if (!state.streaming) return state;
      const retryStatus: RetryStatus = {
        attempt: action.attempt,
        maxRetries: action.maxRetries,
        delayMs: action.delayMs,
        autoRetry: action.autoRetry,
        autoRetryMax: action.autoRetryMax,
        timedOut: action.timedOut,
      };
      const isWatchdogRetry = action.autoRetry != null && !action.timedOut;
      let messages = state.messages;
      if (isWatchdogRetry) {
        const finalBlocks = finalizeBlocks(state.streaming.blocks);
        const content = extractText(finalBlocks);
        const partial: UIMessage = {
          id: generateId(),
          role: 'assistant',
          content,
          thinking: state.streaming.thinking || undefined,
          blocks: finalBlocks.length > 0 ? finalBlocks : undefined,
          responseTime: Date.now() - state.streaming.startTime,
          finishedAt: Date.now(),
          outcome: 'retried',
          watchdogRetries: state.streaming.watchdogRetries + 1,
        };
        messages = [...messages, partial];
      }
      return {
        ...state,
        messages,
        streaming: {
          ...state.streaming,
          retryStatus,
          lastEventTime: Date.now(),
          ...(isWatchdogRetry ? {
            thinking: '',
            blocks: [],
            watchdogRetries: state.streaming.watchdogRetries + 1,
            liveTokens: undefined,
          } : {}),
        },
      };
    }

    case 'log': {
      const MAX_LOGS = 5000;
      let logs = [...state.logs, { level: action.level, text: action.text, timestamp: action.timestamp }];
      if (logs.length > MAX_LOGS) logs = logs.slice(logs.length - MAX_LOGS);
      if (state.streaming) {
        return { ...state, logs, streaming: { ...state.streaming, lastEventTime: Date.now() } };
      }
      return { ...state, logs };
    }

    case 'clearLogs':
      return { ...state, logs: [] };

    case 'loginStart':
      return { ...state, login: { phase: 'starting' } };

    case 'loginUrl':
      return { ...state, login: { phase: 'url', url: action.url } };

    case 'loginSubmitting':
      return { ...state, login: { phase: 'submitting' } };

    case 'loginResult':
      return { ...state, login: action.success ? { phase: 'success' } : { phase: 'error', message: action.message ?? 'Login failed' } };

    case 'contextUsage':
      return { ...state, contextUsage: { percent: action.percent, inputTokens: action.inputTokens, outputTokens: action.outputTokens, contextWindow: action.contextWindow } };

    case 'token_update': {
      if (!state.streaming) return state;
      const prev = state.streaming.liveTokens ?? { input: 0, output: 0 };
      return {
        ...state,
        streaming: {
          ...state.streaming,
          liveTokens: {
            input: action.inputTokens ?? prev.input,
            output: action.outputTokens ?? prev.output,
          },
        },
      };
    }

    case 'ws_status': {
      if (action.connected) return { ...state, wsConnected: true };
      if (!state.streaming) return { ...state, wsConnected: false };
      const responseTime = Date.now() - state.streaming.startTime;
      const finalBlocks = finalizeBlocks(state.streaming.blocks);
      const content = extractText(finalBlocks);
      const msg: UIMessage = {
        id: generateId(),
        role: 'assistant',
        content,
        thinking: state.streaming.thinking || undefined,
        blocks: finalBlocks.length > 0 ? finalBlocks : undefined,
        responseTime,
        finishedAt: Date.now(),
        outcome: 'error',
      };
      return {
        ...state,
        wsConnected: false,
        messages: [...state.messages, msg],
        streaming: null,
        isStreaming: false,
      };
    }

    default:
      return state;
  }
}

export const initialState: AppState = {
  messages: [],
  streaming: null,
  isStreaming: false,
  prefill: '',
  workspacePath: '',
  version: '',
  logs: [],
  login: { phase: 'idle' },
  contextUsage: null,
  bgTasks: 0,
  pendingNotice: null,
  wsConnected: true,
  currentModel: '',
  currentEffort: 'high',
  thinkingEnabled: true,
  turnCompletions: 0,
};
