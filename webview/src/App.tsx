import React, { useEffect, useReducer, useRef, useCallback } from 'react';
import { MessageList, MessageListHandle } from './components/MessageList';
import { InputArea } from './components/InputArea';
import { LogPanel } from './components/LogPanel';
import { SessionHistoryModal } from './components/SessionHistoryModal';
import { SettingsProvider, useSettings } from './contexts/SettingsContext';
import { postMessage } from './vscode';
import { reducer, initialState, type AppAction } from './reducer';
import { SessionSummary } from './types';

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
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [sessionTitle, setSessionTitle] = React.useState('');
  const [showSessionBar, setShowSessionBar] = React.useState(() => {
    try { return localStorage.getItem('argus.showSessionBar') !== 'false'; } catch { return true; }
  });
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
      'tool_start', 'tool_end', 'done', 'error', 'clear', 'user_inject', 'sessionLoaded',
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

  // Header session name: derive from sessionList replies (which carry currentId +
  // titles). The same machinery as the history modal, so no backend change needed.
  // Re-fetch when a session is resumed (sessionLoaded) and reset on a fresh chat
  // (clear), since neither is a streaming transition.
  useEffect(() => {
    function onSessionMsg(e: MessageEvent) {
      const t = e.data?.type;
      if (t === 'sessionList' && Array.isArray(e.data.sessions)) {
        const cur = (e.data.sessions as SessionSummary[]).find(s => s.id === e.data.currentId);
        setSessionTitle(cur?.title ?? '');
      } else if (t === 'sessionLoaded') {
        postMessage({ type: 'listSessions' });
      } else if (t === 'clear') {
        setSessionTitle('');
      }
    }
    window.addEventListener('message', onSessionMsg);
    return () => window.removeEventListener('message', onSessionMsg);
  }, []);

  // Refresh the header title on mount and whenever a turn finishes (the CLI may
  // have just generated or updated the session's ai-title).
  useEffect(() => {
    if (!state.isStreaming) postMessage({ type: 'listSessions' });
  }, [state.isStreaming]);

  useEffect(() => {
    try { localStorage.setItem('argus.showSessionBar', String(showSessionBar)); } catch {}
  }, [showSessionBar]);

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

  const topRightActions = (
    <div className={showSessionBar ? 'topRightActions topRightActionsFull' : 'topRightActions'}>
      {showSessionBar && (
        <>
          {sessionTitle && <span className="sessionName" title={sessionTitle}>{sessionTitle}</span>}
          <button
            className="btn-icon"
            title="Session history"
            aria-label="Session history"
            onClick={() => setHistoryOpen(true)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l4 2" />
            </svg>
          </button>
          <button
            className="btn-icon"
            title="New chat"
            aria-label="New chat"
            onClick={() => postMessage({ type: 'newSession' })}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              <line x1="12" y1="8" x2="12" y2="14" />
              <line x1="9" y1="11" x2="15" y2="11" />
            </svg>
          </button>
        </>
      )}
      <button
        className="btn-icon"
        title={showSessionBar ? 'Hide session bar' : 'Show session bar'}
        aria-label={showSessionBar ? 'Hide session bar' : 'Show session bar'}
        onClick={() => setShowSessionBar(v => !v)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {showSessionBar ? <polyline points="13 17 18 12 13 7" /> : <polyline points="11 17 6 12 11 7" />}
          {showSessionBar ? <polyline points="6 17 11 12 6 7" /> : <polyline points="18 17 13 12 18 7" />}
        </svg>
      </button>
    </div>
  );

  return (
    <div className="app">
      {historyOpen && <SessionHistoryModal onClose={() => setHistoryOpen(false)} />}
      <div className="content">
        {showLogs && isNarrow && (
          <>
            <div className="logPaneTop" style={{ height: logHeight }}>{logPanel}</div>
            <div className="logDividerH" onMouseDown={onTopDividerMouseDown} />
          </>
        )}
        <div className={showSessionBar ? 'chatPane sessionBarExpanded' : 'chatPane'}>
          {topRightActions}
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
