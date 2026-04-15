import React, { useEffect, useReducer } from 'react';
import { UIMessage, StreamingState, ToolCallData, LogLevel, LogEntry } from './types';
import { MessageList } from './components/MessageList';
import { InputArea } from './components/InputArea';
import { LogPanel } from './components/LogPanel';
import { SettingsProvider, useSettings } from './contexts/SettingsContext';
import { postMessage } from './vscode';

type AppState = {
  messages: UIMessage[];
  streaming: StreamingState | null;
  isStreaming: boolean;
  prefill: string;
  workspacePath: string;
  logs: LogEntry[];
};

type AppAction =
  | { type: 'message'; message: UIMessage }
  | { type: 'thinking_start' }
  | { type: 'thinking_chunk'; text: string }
  | { type: 'text_chunk'; text: string }
  | { type: 'tool_start'; call: ToolCallData }
  | { type: 'tool_end'; call: ToolCallData }
  | { type: 'done' }
  | { type: 'error'; text: string }
  | { type: 'clear' }
  | { type: 'prefill'; text: string }
  | { type: 'workspaceInfo'; path: string }
  | { type: 'log'; level: LogLevel; text: string; timestamp: string }
  | { type: 'clearLogs' };

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'message':
      return { ...state, messages: [...state.messages, action.message] };

    case 'thinking_start':
      return {
        ...state,
        isStreaming: true,
        streaming: { thinking: '', text: '', toolCalls: [], startTime: Date.now(), lastEventTime: Date.now() },
      };

    case 'thinking_chunk':
      if (!state.streaming) return state;
      return {
        ...state,
        streaming: { ...state.streaming, thinking: state.streaming.thinking + action.text, lastEventTime: Date.now() },
      };

    case 'text_chunk':
      if (!state.streaming) return state;
      return {
        ...state,
        streaming: { ...state.streaming, text: state.streaming.text + action.text, lastEventTime: Date.now() },
      };

    case 'tool_start':
      if (!state.streaming) return state;
      return {
        ...state,
        streaming: {
          ...state.streaming,
          toolCalls: [...state.streaming.toolCalls, action.call],
          lastEventTime: Date.now(),
        },
      };

    case 'tool_end':
      if (!state.streaming) return state;
      return {
        ...state,
        streaming: {
          ...state.streaming,
          toolCalls: state.streaming.toolCalls.map(tc =>
            tc.id === action.call.id
              ? { ...tc, result: action.call.result, error: action.call.error }
              : tc
          ),
          lastEventTime: Date.now(),
        },
      };

    case 'done': {
      if (!state.streaming) return { ...state, isStreaming: false };
      const responseTime = Date.now() - state.streaming.startTime;
      const msg: UIMessage = {
        id: String(Date.now()),
        role: 'assistant',
        content: state.streaming.text,
        thinking: state.streaming.thinking || undefined,
        toolCalls: state.streaming.toolCalls.length > 0 ? state.streaming.toolCalls : undefined,
        responseTime,
      };
      return {
        ...state,
        messages: [...state.messages, msg],
        streaming: null,
        isStreaming: false,
      };
    }

    case 'error': {
      const errorMsg: UIMessage = { id: String(Date.now()), role: 'error', content: action.text };
      return {
        ...state,
        messages: [...state.messages, errorMsg],
        streaming: null,
        isStreaming: false,
      };
    }

    case 'clear':
      return { ...state, messages: [], streaming: null, isStreaming: false, logs: [] };

    case 'prefill':
      return { ...state, prefill: action.text };

    case 'workspaceInfo':
      return { ...state, workspacePath: action.path };

    case 'log':
      return { ...state, logs: [...state.logs, { level: action.level, text: action.text, timestamp: action.timestamp }] };

    case 'clearLogs':
      return { ...state, logs: [] };

    default:
      return state;
  }
}

const initialState: AppState = {
  messages: [],
  streaming: null,
  isStreaming: false,
  prefill: '',
  workspacePath: '',
  logs: [],
};

function AppInner() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { showLogs } = useSettings();
  const [logWidth, setLogWidth] = React.useState(320);
  const dragging = React.useRef(false);
  const dragStartX = React.useRef(0);
  const dragStartW = React.useRef(0);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      dispatch(event.data as AppAction);
    }
    window.addEventListener('message', handleMessage);
    postMessage({ type: 'getInfo' });
    return () => window.removeEventListener('message', handleMessage);
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

  return (
    <div className="app">
      <div className="content">
        <div className="chatPane">
          <MessageList messages={state.messages} streaming={state.streaming} />
          <InputArea isStreaming={state.isStreaming} prefill={state.prefill} workspacePath={state.workspacePath} />
        </div>
        {showLogs && (
          <>
            <div className="logDivider" onMouseDown={onDividerMouseDown} />
            <div className="logPane" style={{ width: logWidth }}>
              <LogPanel logs={state.logs} onClear={() => dispatch({ type: 'clearLogs' })} />
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
