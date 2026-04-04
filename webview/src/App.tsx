import React, { useEffect, useReducer } from 'react';
import { UIMessage, StreamingState, ToolCallData } from './types';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { InputArea } from './components/InputArea';

type AppState = {
  messages: UIMessage[];
  streaming: StreamingState | null;
  isStreaming: boolean;
  prefill: string;
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
  | { type: 'prefill'; text: string };

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
      return { ...state, messages: [], streaming: null, isStreaming: false };

    case 'prefill':
      return { ...state, prefill: action.text };

    default:
      return state;
  }
}

const initialState: AppState = {
  messages: [],
  streaming: null,
  isStreaming: false,
  prefill: '',
};

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      dispatch(event.data as AppAction);
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return (
    <div className="app">
      <Header />
      <MessageList messages={state.messages} streaming={state.streaming} />
      <InputArea isStreaming={state.isStreaming} prefill={state.prefill} />
    </div>
  );
}
