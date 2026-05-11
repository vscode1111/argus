import React, { useEffect, useReducer, useRef, useCallback } from 'react';
import { UIMessage, StreamingState, ToolCallData, ContentBlock, LogLevel, LogEntry, LoginState, RetryStatus } from './types';
import { MessageList, MessageListHandle } from './components/MessageList';
import { InputArea } from './components/InputArea';
import { LogPanel } from './components/LogPanel';
import { SettingsProvider, useSettings } from './contexts/SettingsContext';
import { postMessage } from './vscode';

type ContextUsage = { percent: number; inputTokens: number; outputTokens: number };

type AppState = {
  messages: UIMessage[];
  streaming: StreamingState | null;
  isStreaming: boolean;
  prefill: string;
  workspacePath: string;
  version: string;
  logs: LogEntry[];
  login: LoginState;
  contextUsage: ContextUsage | null;
};

type AppAction =
  | { type: 'message'; message: UIMessage }
  | { type: 'thinking_start'; reused?: boolean }
  | { type: 'thinking_chunk'; text: string }
  | { type: 'text_chunk'; text: string }
  | { type: 'tool_start'; call: ToolCallData }
  | { type: 'tool_end'; call: ToolCallData }
  | { type: 'done' }
  | { type: 'stop' }
  | { type: 'error'; text: string; errorKind?: string }
  | { type: 'clear' }
  | { type: 'prefill'; text: string }
  | { type: 'workspaceInfo'; path: string; version?: string }
  | { type: 'log'; level: LogLevel; text: string; timestamp: string }
  | { type: 'clearLogs' }
  | { type: 'loginStart' }
  | { type: 'loginUrl'; url: string }
  | { type: 'loginSubmitting' }
  | { type: 'loginResult'; success: boolean; message?: string }
  | { type: 'contextUsage'; percent: number; inputTokens: number; outputTokens: number }
  | { type: 'retry_status'; attempt: number; maxRetries: number; delayMs: number; autoRetry?: number; autoRetryMax?: number; timedOut?: boolean };

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'message':
      return { ...state, messages: [...state.messages, action.message] };

    case 'thinking_start':
      return {
        ...state,
        isStreaming: true,
        streaming: { thinking: '', blocks: [], startTime: Date.now(), lastEventTime: Date.now(), logsAtStart: state.logs.length, reused: action.reused ?? false, stopped: false, retryStatus: null, watchdogRetries: 0 },
      };

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

    case 'tool_start':
      if (!state.streaming) return state;
      return {
        ...state,
        streaming: {
          ...state.streaming,
          blocks: [...state.streaming.blocks, { type: 'tool', call: action.call }],
          lastEventTime: Date.now(),
          retryStatus: null,
        },
      };

    case 'tool_end': {
      if (state.streaming) {
        return {
          ...state,
          streaming: {
            ...state.streaming,
            blocks: state.streaming.blocks.map(b =>
              b.type === 'tool' && b.call.id === action.call.id
                ? { type: 'tool' as const, call: { ...b.call, result: action.call.result, error: action.call.error } }
                : b
            ),
            lastEventTime: Date.now(),
          },
        };
      }
      // Update tool block in completed messages (e.g. late AskUserQuestion answer)
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
      const finalBlocks = blocks.map(b =>
        b.type === 'tool' && !b.call.result && !b.call.error
          ? { type: 'tool' as const, call: { ...b.call, error: true } }
          : b
      );
      const content = finalBlocks
        .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
        .map(b => b.text)
        .join('');
      const outcome = stopped ? 'stopped' : watchdogRetries > 0 ? 'retried' : 'success';
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
      };
      return {
        ...state,
        messages: [...state.messages, msg],
        streaming: null,
        isStreaming: false,
      };
    }

    case 'error': {
      const msgs: UIMessage[] = [];
      let existingMessages = state.messages;
      // Preserve streaming blocks (mark pending tools as cancelled)
      if (state.streaming && state.streaming.blocks.length > 0) {
        const responseTime = Date.now() - state.streaming.startTime;
        const finalBlocks = state.streaming.blocks.map(b =>
          b.type === 'tool' && !b.call.result && !b.call.error
            ? { type: 'tool' as const, call: { ...b.call, error: true } }
            : b
        );
        const content = finalBlocks
          .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
          .map(b => b.text)
          .join('');
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
        // Error arrived after 'done' already committed the assistant message;
        // mark the last assistant message as error outcome
        const idx = existingMessages.findLastIndex(m => m.role === 'assistant');
        if (idx >= 0) {
          existingMessages = existingMessages.map((m, i) =>
            i === idx ? { ...m, outcome: 'error' as const } : m
          );
        }
      }
      msgs.push({ id: generateId(), role: 'error', content: action.text, errorKind: action.errorKind as UIMessage['errorKind'] });
      return {
        ...state,
        messages: [...existingMessages, ...msgs],
        streaming: null,
        isStreaming: false,
      };
    }

    case 'clear':
      return { ...state, messages: [], streaming: null, isStreaming: false, logs: [], contextUsage: null };

    case 'prefill':
      return { ...state, prefill: action.text };

    case 'workspaceInfo':
      return { ...state, workspacePath: action.path, version: action.version ?? '' };

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
      return {
        ...state,
        streaming: {
          ...state.streaming,
          retryStatus,
          lastEventTime: Date.now(),
          ...(isWatchdogRetry ? {
            thinking: '',
            blocks: [],
            watchdogRetries: state.streaming.watchdogRetries + 1,
          } : {}),
        },
      };
    }

    case 'log': {
      const logs = [...state.logs, { level: action.level, text: action.text, timestamp: action.timestamp }];
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
      return { ...state, contextUsage: { percent: action.percent, inputTokens: action.inputTokens, outputTokens: action.outputTokens } };

    default:
      return state;
  }
}

let nextMsgId = 0;
function generateId(): string { return `msg-${++nextMsgId}-${Date.now()}`; }

function playCompletionSound(): void {
  try {
    const ctx = new AudioContext();
    const play = () => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1047, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.2);
      osc.onended = () => ctx.close();
    };
    if (ctx.state === 'suspended') {
      ctx.resume().then(play);
    } else {
      play();
    }
  } catch {}
}

const initialState: AppState = {
  messages: [],
  streaming: null,
  isStreaming: false,
  prefill: '',
  workspacePath: '',
  version: '',
  logs: [],
  login: { phase: 'idle' },
  contextUsage: null,
};

function AppInner() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { showLogs, setShowLogs, soundOnComplete, notifyOnComplete } = useSettings();
  const messageListRef = useRef<MessageListHandle>(null);
  const wasStreaming = React.useRef(false);
  const [isNarrow, setIsNarrow] = React.useState(window.innerWidth < 650);
  const [logWidth, setLogWidth] = React.useState(320);
  const [logHeight, setLogHeight] = React.useState(180);
  const dragging = React.useRef(false);
  const dragStartX = React.useRef(0);
  const dragStartY = React.useRef(0);
  const dragStartW = React.useRef(0);
  const dragStartH = React.useRef(0);

  useEffect(() => {
    const dir = new URLSearchParams(window.location.search).get('dir');
    if (dir) {
      console.log('[Argus] Invoked from directory:', dir);
      dispatch({ type: 'workspaceInfo', path: dir });
    }
  }, []);

  useEffect(() => {
    const VALID_TYPES = new Set<AppAction['type']>([
      'message', 'thinking_start', 'thinking_chunk', 'text_chunk',
      'tool_start', 'tool_end', 'done', 'error', 'clear',
      'prefill', 'workspaceInfo', 'log', 'clearLogs',
      'loginStart', 'loginUrl', 'loginSubmitting', 'loginResult', 'contextUsage', 'retry_status',
    ]);
    function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (data && typeof data.type === 'string' && VALID_TYPES.has(data.type)) {
        dispatch(data as AppAction);
      }
    }
    window.addEventListener('message', handleMessage);
    postMessage({ type: 'getInfo' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (wasStreaming.current && !state.isStreaming) {
      const lastAssistant = [...state.messages].reverse().find(m => m.role === 'assistant');
      const wasStopped = lastAssistant?.outcome === 'stopped';
      if (soundOnComplete && !wasStopped) playCompletionSound();
      if (notifyOnComplete && !wasStopped && typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') {
          const projectName = state.workspacePath.replace(/\\/g, '/').split('/').filter(Boolean).pop();
          const title = projectName ? `Argus/${projectName}` : 'Argus';
          const lastUserMsg = [...state.messages].reverse().find(m => m.role === 'user');
          const body = lastUserMsg ? lastUserMsg.content.slice(0, 120) : 'Task complete';
          const n = new Notification(title, { body });
          n.onclick = () => {
            postMessage({ type: 'focusPanel' });
            window.focus();
            n.close();
          };
        }
      }
    }
    wasStreaming.current = state.isStreaming;
  }, [state.isStreaming, soundOnComplete, notifyOnComplete]);

  useEffect(() => {
    function onResize() { setIsNarrow(window.innerWidth < 650); }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!state.workspacePath) return;
    const name = state.workspacePath.replace(/\\/g, '/').split('/').filter(Boolean).pop();
    document.title = name ? `${name}` : 'Argus';
  }, [state.workspacePath]);

  function onDividerMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragStartW.current = logWidth;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    function onMouseMove(ev: MouseEvent) {
      if (!dragging.current) return;
      const delta = dragStartX.current - ev.clientX;
      setLogWidth(Math.max(160, Math.min(dragStartW.current + delta, window.innerWidth * 0.7)));
    }
    function onMouseUp() {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function onTopDividerMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragging.current = true;
    dragStartY.current = e.clientY;
    dragStartH.current = logHeight;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    function onMouseMove(ev: MouseEvent) {
      if (!dragging.current) return;
      const delta = ev.clientY - dragStartY.current;
      setLogHeight(Math.max(60, Math.min(dragStartH.current + delta, window.innerHeight * 0.7)));
    }
    function onMouseUp() {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  const scrollToBottom = useCallback(() => messageListRef.current?.scrollToBottom(), []);

  const logPanel = <LogPanel logs={state.logs} onClear={() => dispatch({ type: 'clearLogs' })} onClose={() => setShowLogs(false)} />;

  return (
    <div className="app">
      <div className="content">
        {showLogs && isNarrow && (
          <>
            <div className="logPaneTop" style={{ height: logHeight }}>{logPanel}</div>
            <div className="logDividerH" onMouseDown={onTopDividerMouseDown} />
          </>
        )}
        <div className="chatPane">
          <MessageList ref={messageListRef} messages={state.messages} streaming={state.streaming} login={state.login} logCount={state.logs.length} />
          <InputArea isStreaming={state.isStreaming} prefill={state.prefill} workspacePath={state.workspacePath} version={state.version} contextUsage={state.contextUsage} onSend={scrollToBottom} onStop={() => dispatch({ type: 'stop' })} />
        </div>
        {showLogs && !isNarrow && (
          <>
            <div className="logDivider" onMouseDown={onDividerMouseDown} />
            <div className="logPane" style={{ width: logWidth }}>
              {logPanel}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <AppInner />
    </SettingsProvider>
  );
}
