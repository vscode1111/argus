import React, { useEffect, useReducer, useRef, useCallback } from 'react';
import { MessageList, MessageListHandle } from './components/MessageList';
import { InputArea } from './components/InputArea';
import { LogPanel } from './components/LogPanel';
import { SessionHistoryModal } from './components/SessionHistoryModal';
import { AccountUsageModal } from './components/AccountUsageModal';
import { WorkspaceMenu } from './components/WorkspaceMenu';
import { AutoFileViewer } from './components/AutoFileViewer';
import { SettingsProvider, useSettings } from './contexts/SettingsContext';
import { postMessage, isVsCode } from './vscode';
import { reducer, initialState, type AppAction } from './reducer';
import { SessionSummary } from './types';
import { basename } from './utils/path';
import { fmtLineCount } from './utils/text';

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

function notifTitle(workspacePath: string): string {
  const projectName = basename(workspacePath);
  return projectName ? `Argus/${projectName}` : 'Argus';
}

function fireNotification(title: string, body: string): void {
  // VS Code webviews can't surface web Notifications to the OS, so route to the
  // extension host, which shows a native VS Code notification instead. In the
  // browser dev/app window the Notification API works directly.
  if (isVsCode) {
    postMessage({ type: 'notify', title, body });
    return;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body });
  n.onclick = () => {
    postMessage({ type: 'focusPanel' });
    window.focus();
    n.close();
  };
}

function AppInner() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { showLogs, setShowLogs, soundOnComplete, notifyOnComplete } = useSettings();
  const messageListRef = useRef<MessageListHandle>(null);
  const wasStreaming = React.useRef(false);
  const hadPendingAsk = React.useRef(false);
  const [isNarrow, setIsNarrow] = React.useState(window.innerWidth < 650);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [accountUsageOpen, setAccountUsageOpen] = React.useState(false);
  const [initialFile, setInitialFile] = React.useState<string | null>(null);
  // Spinner overlay shown while a session resume or workspace switch is in flight
  // (a big transcript replay or a WS reconnect can take a few seconds).
  const [loadingSession, setLoadingSession] = React.useState(false);
  // Known content size (line count) of the session being resumed, shown beside the
  // spinner (e.g. "Loading… 17k lines"); 0 when unknown (a plain workspace switch).
  const [loadSize, setLoadSize] = React.useState(0);
  const loadTimer = React.useRef<number | null>(null);
  const [sessionTitle, setSessionTitle] = React.useState('');
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  // Line count of the current session, kept in sync from sessionList replies so the
  // header "Refresh current session" button can label its loading spinner.
  const [sessionLines, setSessionLines] = React.useState(0);
  const [editingName, setEditingName] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState('');
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
    const params = new URLSearchParams(window.location.search);
    const dir = params.get('dir');
    if (dir) {
      console.log('[Argus] Invoked from directory:', dir);
      dispatch({ type: 'workspaceInfo', path: dir });
    }
    const file = params.get('file');
    if (file) {
      console.log('[Argus] Invoked to open file:', file);
      setInitialFile(file);
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
      if (notifyOnComplete && !wasStopped) {
        const lastUserMsg = [...state.messages].reverse().find(m => m.role === 'user');
        const body = lastUserMsg ? lastUserMsg.content.slice(0, 120) : 'Task complete';
        fireNotification(notifTitle(state.workspacePath), body);
      }
    }
    wasStreaming.current = state.isStreaming;
  }, [state.isStreaming, soundOnComplete, notifyOnComplete]);

  const hasPendingAsk = !!state.streaming?.askPausedAt;
  useEffect(() => {
    if (hasPendingAsk && !hadPendingAsk.current) {
      if (soundOnComplete) playCompletionSound();
      if (notifyOnComplete) {
        fireNotification(notifTitle(state.workspacePath), 'Waiting for your answer');
      }
    }
    hadPendingAsk.current = hasPendingAsk;
  }, [hasPendingAsk, soundOnComplete, notifyOnComplete]);

  // Dev harness hooks: fire the completion sound / notification directly so they
  // can be tested without running a full turn (bypasses the toggle gating).
  useEffect(() => {
    const onTestSound = () => playCompletionSound();
    const onTestNotify = () => {
      const title = notifTitle(state.workspacePath);
      if (isVsCode) { fireNotification(title, 'Test notification'); return; }
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') fireNotification(title, 'Test notification');
      else Notification.requestPermission().then(p => { if (p === 'granted') fireNotification(title, 'Test notification'); });
    };
    window.addEventListener('argus:test-sound', onTestSound);
    window.addEventListener('argus:test-notify', onTestNotify);
    return () => {
      window.removeEventListener('argus:test-sound', onTestSound);
      window.removeEventListener('argus:test-notify', onTestNotify);
    };
  }, [state.workspacePath]);

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
        setSessionId(e.data.currentId ?? null);
        setSessionLines(cur?.lines ?? 0);
        endSessionLoad(); // a fresh list means a workspace reconnect finished
      } else if (t === 'sessionLoaded') {
        postMessage({ type: 'listSessions' });
        endSessionLoad(); // the resumed transcript has been replayed
      } else if (t === 'clear') {
        setSessionTitle('');
        setSessionId(null);
        setSessionLines(0);
        setEditingName(false);
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
    const name = basename(state.workspacePath);
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

  function startNameEdit() {
    if (!sessionId) return;
    setNameDraft(sessionTitle);
    setEditingName(true);
  }
  function commitNameEdit() {
    const title = nameDraft.trim();
    if (title && sessionId && title !== sessionTitle) {
      postMessage({ type: 'renameSession', id: sessionId, title });
      setSessionTitle(title); // optimistic; server also replies with a fresh sessionList
    }
    setEditingName(false);
  }

  // Show the spinner overlay until the resumed transcript / new workspace lands.
  // `size` is the session's known line count (0 = unknown, e.g. a workspace switch),
  // shown as a label beside the spinner. A safety timeout clears it so the spinner
  // can never get permanently stuck.
  function beginSessionLoad(size = 0) {
    setLoadingSession(true);
    setLoadSize(size);
    if (loadTimer.current) window.clearTimeout(loadTimer.current);
    loadTimer.current = window.setTimeout(() => setLoadingSession(false), 30_000);
  }
  function endSessionLoad() {
    setLoadingSession(false);
    if (loadTimer.current) { window.clearTimeout(loadTimer.current); loadTimer.current = null; }
  }

  // Reconnect the panel to a different workspace in place: reset the UI to a clean
  // slate, point the header at the new path, then have the WS bridge tear down the
  // socket and reopen it with the new ?dir= (a fresh server-side session).
  function switchWorkspace(path: string) {
    beginSessionLoad();
    dispatch({ type: 'clear' });
    dispatch({ type: 'workspaceInfo', path });
    setSessionTitle('');
    setSessionId(null);
    setEditingName(false);
    postMessage({ type: 'switchWorkspace', dir: path });
    postMessage({ type: 'listSessions' }); // queued, flushed after reconnect for the new ws
  }

  // Resume a session that may live in another workspace (from the Session History
  // "All workspaces" tab). When it belongs to the current workspace, resume in place;
  // otherwise switch the panel to that workspace first - the reconnect queue
  // flushes `resumeSession` to the new connection, whose workspaceDir matches the
  // session, so the transcript replays and the next send spawns with `--resume`.
  function resumeWorkspaceSession(path: string, id: string, lines = 0) {
    beginSessionLoad(lines);
    if (path === state.workspacePath) {
      postMessage({ type: 'resumeSession', id });
      return;
    }
    dispatch({ type: 'clear' });
    dispatch({ type: 'workspaceInfo', path });
    setSessionTitle('');
    setSessionId(null);
    setEditingName(false);
    postMessage({ type: 'switchWorkspace', dir: path });
    postMessage({ type: 'resumeSession', id }); // queued, flushed after reconnect for the new ws
  }

  const logPanel = <LogPanel logs={state.logs} onClear={() => dispatch({ type: 'clearLogs' })} onClose={() => setShowLogs(false)} />;

  const workspaceName = basename(state.workspacePath);

  const topRightActions = (
    <div className={showSessionBar ? 'topRightActions topRightActionsFull' : 'topRightActions'}>
      {showSessionBar && (
        <>
          <div className="headerLeft">
            {editingName ? (
            <input
              className="sessionName sessionNameInput"
              value={nameDraft}
              autoFocus
              maxLength={200}
              onChange={e => setNameDraft(e.target.value)}
              onBlur={commitNameEdit}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitNameEdit(); }
                else if (e.key === 'Escape') { e.preventDefault(); setEditingName(false); }
              }}
            />
          ) : sessionId ? (
            <button
              className="sessionName sessionNameBtn"
              title="Rename session"
              onClick={startNameEdit}
            >
              {sessionTitle || 'Untitled'}
            </button>
          ) : sessionTitle ? (
            <span className="sessionName" title={sessionTitle}>{sessionTitle}</span>
          ) : null}
          </div>
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
          <button
            className="btn-icon"
            title="Refresh current session"
            aria-label="Refresh current session"
            disabled={!sessionId}
            onClick={() => { if (sessionId) { beginSessionLoad(sessionLines); postMessage({ type: 'resumeSession', id: sessionId }); } }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l4 2" />
            </svg>
          </button>
          <button
            className="btn-icon"
            title="Session history"
            aria-label="Session history"
            onClick={() => setHistoryOpen(true)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
          {workspaceName && (
            <WorkspaceMenu currentPath={state.workspacePath} name={workspaceName} onSelect={switchWorkspace} />
          )}
          <button
            className="btn-icon"
            title="Account & usage"
            aria-label="Account & usage"
            onClick={() => setAccountUsageOpen(true)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
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
      {historyOpen && <SessionHistoryModal currentPath={state.workspacePath} onResumeWorkspaceSession={resumeWorkspaceSession} onClose={() => setHistoryOpen(false)} />}
      {accountUsageOpen && <AccountUsageModal onClose={() => setAccountUsageOpen(false)} />}
      {initialFile && <AutoFileViewer path={initialFile} onClose={() => setInitialFile(null)} />}
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
          {loadingSession && (
            <div className="sessionLoader" role="status" aria-live="polite" aria-busy="true" aria-label="Loading session">
              <div className="sessionSpinner" />
              {loadSize > 0 && (
                <div className="sessionLoaderText">Loading… {fmtLineCount(loadSize)} lines</div>
              )}
            </div>
          )}
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
