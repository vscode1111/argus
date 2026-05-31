import React, { useEffect, useReducer, useRef, useCallback } from 'react';
import { MessageList, MessageListHandle } from './components/MessageList';
import { InputArea } from './components/InputArea';
import { LogPanel } from './components/LogPanel';
import { SettingsProvider, useSettings } from './contexts/SettingsContext';
import { postMessage } from './vscode';
import { reducer, initialState, type AppAction } from './reducer';

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

function AppInner() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { showLogs, setShowLogs, soundOnComplete, notifyOnComplete } = useSettings();
  const messageListRef = useRef<MessageListHandle>(null);
  const wasStreaming = React.useRef(false);
  const hadPendingAsk = React.useRef(false);
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
      'loginStart', 'loginUrl', 'loginSubmitting', 'loginResult', 'contextUsage', 'retry_status', 'retry_clean', 'ws_status',
    ]);
    function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (data && typeof data.type === 'string' && VALID_TYPES.has(data.type)) {
        dispatch(data as AppAction);
      }
    }
    window.addEventListener('message', handleMessage);
    postMessage({ type: 'webviewReady' });
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

  const hasPendingAsk = !!state.streaming?.askPausedAt;
  useEffect(() => {
    if (hasPendingAsk && !hadPendingAsk.current) {
      if (soundOnComplete) playCompletionSound();
      if (notifyOnComplete && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const projectName = state.workspacePath.replace(/\\/g, '/').split('/').filter(Boolean).pop();
        const title = projectName ? `Argus/${projectName}` : 'Argus';
        const n = new Notification(title, { body: 'Waiting for your answer' });
        n.onclick = () => {
          postMessage({ type: 'focusPanel' });
          window.focus();
          n.close();
        };
      }
    }
    hadPendingAsk.current = hasPendingAsk;
  }, [hasPendingAsk, soundOnComplete, notifyOnComplete]);

  useEffect(() => {
    if (state.isStreaming) {
      postMessage({ type: 'streamingState', active: true });
    } else {
      const last = [...state.messages].reverse().find(m => m.role === 'assistant');
      postMessage({ type: 'streamingState', active: false, outcome: last?.outcome });
    }
  }, [state.isStreaming]);

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
          <InputArea isStreaming={state.isStreaming} prefill={state.prefill} workspacePath={state.workspacePath} version={state.version} contextUsage={state.contextUsage} wsConnected={state.wsConnected} onSend={scrollToBottom} onStop={() => dispatch({ type: 'stop' })} />
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
