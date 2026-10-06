import { getCliLaunchCount, resetCliLaunchCount } from './providers/claudeExecution';
import { runtime, providerForSession, restoreSelection, selectionMessage } from './providers/registry';
import { selectionFor, records } from './providers/store';
import { handleProviderRequest } from './providers/requests';
import { abortPendingStop } from './providers/claudeExecution';
import type { TurnInput } from './providers/types';
import * as fs from 'fs';
import * as path from 'path';
import type { WebSocket } from 'ws';

import { killProc, killAllClaude, plural, classifyError, API_ERROR_RE } from './cli';
import { readConfig, writeConfig, DEFAULT_CONFIG, type ArgusConfig } from './config';
import { readFilePreview } from './filePreview';
import { grantMedia } from './media';
// No fetchUsage here on purpose: usagePoller.ts is the only caller of the usage API,
// so the per-process rate floor cannot be bypassed by a client-triggered handler.
import { collectUsageInsights } from './usageInsights';
import { getUsageSnapshot, noteUsageActivity, requestUsageRefresh } from './usagePoller';
import { createWatchdog } from './watchdog';
import { createErrorRetry, parseErrorRetryPatterns } from './errorRetry';
import { createLoginHandler } from './login';
import { type SessionState } from './sessionState';
import { type Channel, listActiveSessions, listOwnedProcs } from './channel';
import { listCliProcesses, killCliProcess, cpuCoreCount } from './processes';
import { type ClientInfo, type CloseClientResult } from './clients';
import { readAuth, setPassword, clearPassword, dropAllSessions, sessionCount, MIN_PASSWORD_LENGTH } from './auth';
import { broadcastBgTasks } from './cliHandler';
import { listWorkspaces, listAllSessions, listDir, sessionFilePath, readToolImage, codexSessionLineCount } from './sessions';
import { readServerVersion } from './version';
import { buildWorkspaceInfo } from './workspaceInfo';
import { searchFiles, type FileSearchResult } from './fileSearch';

export { getCliLaunchCount } from './providers/claudeExecution';

interface AskQuestionDef {
  question: string;
  options?: Array<{ label: string; description?: string }>;
}

// Builds the follow-up prompt that carries the user's AskUserQuestion answers back to the
// model, naming each selected option by index and description so it proceeds on the exact
// choices rather than on whatever it assumed while the dialog was open.
//
// Exported and pure because it is the only thing in this path that reads the model's own
// tool input, which is **not** schema-guaranteed: the CLI can deliver `questions` as a JSON
// string rather than the declared array, and not rarely - both AskUserQuestion calls
// recorded on this machine were strings, zero were arrays. The webview has parsed that
// since ask-dialog-string-input.spec.ts, the
// server never did, so `questions.find` threw straight out of the WS message handler - and
// with no uncaughtException net in the daemon that killed the shared server process and
// every client connected to it, from one Submit click.
// See !notes/tasks/ask-submit-kills-daemon/notes.md.
export function buildAskFollowUp(rawQuestions: unknown, answers: Record<string, string>): string {
  const parsed = typeof rawQuestions === 'string'
    ? (() => { try { return JSON.parse(rawQuestions); } catch { return []; } })()
    : rawQuestions;
  const questions: AskQuestionDef[] = Array.isArray(parsed) ? parsed : [];
  const answerLines = Object.entries(answers).map(([q, a]) => {
    const qDef = questions.find(qd => qd?.question === q);
    // `options` is the same untrusted shape one level down, so it gets the same treatment.
    const options = Array.isArray(qDef?.options) ? qDef!.options! : [];
    const optIdx = options.findIndex(o => o?.label === a);
    const optDesc = options[optIdx]?.description;
    let line = `Question: "${q}"\nSelected: "${a}"`;
    if (optIdx >= 0) line += ` (option ${optIdx + 1} of ${options.length})`;
    if (optDesc) line += `\nDescription: ${optDesc}`;
    return line;
  }).join('\n\n');
  return `The user has now answered your earlier questions. Disregard any assumptions or defaults you adopted while the questions were unanswered (do not act as if "no questionnaire" was the outcome), and proceed using exactly these choices:\n\n${answerLines}`;
}

export interface ConnectionHooks {
  onSettingsChange?: () => void;
  getClientCount?: () => number;
  /** One row per connection the count above describes - see clients.ts. */
  getClients?: () => ClientInfo[];
  /** Disconnect one of those connections, this one included. */
  closeClient?: (id: number) => CloseClientResult;
  /** Credentials changed: drop remote sockets whose session no longer exists. */
  onAuthChange?: () => void;
  getServerPort?: () => number;
  onRestartRequest?: () => void;
  /** Shut the server down for good (daemon only); absent on a server that can't exit itself. */
  onStopRequest?: () => void;
  /** If true, create a fresh isolated session entry for this client (used for browser tabs). */
  fresh?: boolean;
  /** Deep link (?session=): attach to this session's live entry at connect, or replay it from disk. */
  sessionId?: string;
  /** Stable per-panel id (?panel=): binds this client to its own session entry across reconnects. */
  panelId?: string;
}

// Initialises per-session state: logging, stale-timer, watchdog, synthetic-send
// mechanism (watchdog retry + AskUserQuestion follow-ups), and the follow-up flush.
// Called once per SessionEntry (on first client join or on moveToNewSession).
function initChannelSession(s: SessionState, model: string): void {
  s.serverDefaultModel = model;

  const broadcast = s.broadcast;
  s.errorRetry = createErrorRetry({
    broadcast,
    getLastMessage: () => s.lastMessage,
    retry: input => handleSend(s, input),
    log: message => s.sendLog('warn', message),
  });
  s.broadcast = s.errorRetry.broadcast;

  s.sendLog = (level, text) => {
    s.broadcast(JSON.stringify({ type: 'log', level, text, timestamp: new Date().toISOString() }));
  };

  s.resetStaleTimer = () => {
    if (s.staleTimer) clearTimeout(s.staleTimer);
    s.staleTimer = null;
  };

  s.startStaleTimer = () => {
    s.resetStaleTimer();
    s.staleTimer = setTimeout(() => {
      if (s.cliDone) return;
      if (s.textAccum && API_ERROR_RE.test(s.textAccum)) {
        s.cliDone = true;
        const errText = s.textAccum.trim();
        s.textAccum = '';
        const { errorKind } = classifyError(errText, 1);
        s.broadcast(JSON.stringify({ type: 'error', text: errText, errorKind }));
        s.broadcast(JSON.stringify({ type: 'done' }));
      }
    }, 3000);
  };

  s.emitSyntheticSend = (msgStr: string) => {
    try {
      const msg = JSON.parse(msgStr);
      if (msg.type === 'send') handleSend(s, msg);
    } catch {}
  };

  s.flushAskFollowUp = () => {
    if (!s.pendingFollowUp) return;
    const { answers, toolId, mode } = s.pendingFollowUp;
    s.pendingFollowUp = undefined;
    const tc = s.toolMap.get(toolId);
    const followUp = buildAskFollowUp((tc?.input as Record<string, unknown> | undefined)?.questions, answers);
    setTimeout(() => {
      s.suppressCliOutput = false;
      s.emitSyntheticSend(JSON.stringify({ type: 'send', text: followUp, mode, _silent: true, _askResume: true }));
    }, 200);
  };

  const watchdog = createWatchdog({
    broadcast: s.broadcast,
    getProc: () => s.currentProc,
    getCliDone: () => s.selection.providerId !== 'claude' || s.cliDone,
    setCliDone: (v) => { s.cliDone = v; s.resetStaleTimer(); },
    getPendingAskCount: () => s.pendingAskTools.size,
    getLastMessage: () => s.lastMessage,
    sendLog: s.sendLog,
    emitSyntheticSend: (msg) => s.emitSyntheticSend(msg),
    checkApiError: () => {
      const errContent = s.textAccum.trim() || s.stderrOutput.trim();
      return errContent && API_ERROR_RE.test(errContent) ? errContent : undefined;
    },
  });
  s.watchdog = watchdog;
}

// Attaches per-client WebSocket handlers to a channel. The client is added to the
// most recently active session entry (or a new one if the channel is fresh). When
// the client sends newSession it moves to a brand-new isolated entry; the previous
// entry's CLI process keeps running for any remaining clients.
export function attachClientHandlers(
  ws: WebSocket,
  channel: Channel,
  model: string,
  hooks: ConnectionHooks = {},
): void {
  const attached = channel.addClient(ws, hooks.fresh, hooks.sessionId, hooks.panelId);
  // A panel rejoin reports the same "attached, replay deferred" signal as a deep link,
  // but only the deep-link branch keys off hooks.sessionId - separate them here.
  const liveAttach = attached && !!hooks.sessionId;
  const panelRejoin = attached && !hooks.sessionId;
  const s0 = channel.getClientState(ws);
  if (!s0.sendLog) initChannelSession(s0, model);
  // Deep link to a session that is not live in memory: point this entry at it so
  // the next send spawns with --resume (the transcript replays on webviewReady).
  // Guarded on an idle entry so a mid-turn resume pointer is never clobbered.
  if (hooks.sessionId && !liveAttach && !s0.currentProc) restoreSelection(s0, hooks.sessionId);

  // login is per-client: loginUrl/loginResult only go to the requesting client's ws.
  const login = createLoginHandler(ws, s0.sendLog);

  ws.on('close', () => {
    login.kill();
    // channel.removeClient handles per-entry cleanup (watchdog stop, grace timer).
    // The entry's CLI proc is NOT killed here; it runs to natural completion so other
    // clients watching the same entry are unaffected.
    channel.removeClient(ws);
  });

  let mutations = Promise.resolve();
  const ordered = new Set(['send', 'stop', 'newSession', 'resumeSession', 'switchProvider', 'switchModel', 'switchEffort', 'switchThinking', 'saveProviderDefault', 'providerResponse', 'toolAnswer']);
  ws.on('message', (data: Buffer) => {
    const handle = async () => {
    // Resolve the session state fresh on every message so that after moveToNewSession
    // we automatically use the new entry's state without re-registering handlers.
    const s = channel.getClientState(ws);

    let msg: {
      type: string;
      text?: string;
      images?: Array<{ data: string; mediaType: string; name?: string }>;
      mode?: 'plan' | 'edit' | 'full-access';
      _silent?: boolean;
      _askResume?: boolean;
      path?: string;
      force?: boolean;
      id?: string;
      toolUseId?: string;
      title?: string;
      query?: string;
    };
    try { msg = JSON.parse(data.toString()); } catch {
      s.sendLog('warn', `Malformed WS message: ${data.toString().slice(0, 200)}`);
      return;
    }

    if (await handleProviderRequest(ws, channel, msg, st => { if (!st.sendLog) initChannelSession(st, model); })) return;

    if (msg.type === 'webviewReady') {
      ws.send(JSON.stringify(selectionMessage(s)));
      // Deep link (?session=): replay is deferred to here so it is sent after React
      // mounts and registers its message listener. addClient uses skipReplay=true for
      // live-attaches precisely so this handler owns the first replay.
      if (hooks.sessionId) {
        try { ws.send(JSON.stringify({ type: 'workspaceInfo', path: s.workspaceDir })); } catch { return; }
        // For a live-attach (liveAttach=true), joinEntry skipped its replay; we must
        // replay here. For a non-live attach, check whether the session is currently
        // running in this entry (e.g. CLI started between upgrade and webviewReady).
        // A live entry can still have nothing in memory - reloading the page of a
        // finished session re-attaches to the entry the first load created, whose
        // history was never streamed (it came from disk). replayHistory reports that,
        // and we read the transcript instead of leaving the page blank.
        const isLive = liveAttach || ((s.runtime?.active || !!s.currentProc && !s.cliDone) && s.sessionId === hooks.sessionId);
        if (!isLive || !channel.replayHistory(ws)) {
          const messages = await providerForSession(hooks.sessionId).load(hooks.sessionId, s.workspaceDir);
          s.sendLog('info', `Deep link replay of ${hooks.sessionId} (${plural(messages.length, 'message')})`);
          try { ws.send(JSON.stringify({ type: 'sessionLoaded', id: hooks.sessionId, messages })); } catch {}
        }
      } else if (panelRejoin) {
        // Reconnecting panel (?panel= matched an existing entry): addClient skipped the
        // replay for the same mount-timing reason, so restore its conversation here.
        // Same disk fallback as the deep link: the entry may be bound to a session it
        // never streamed itself (it was resumed from history before the reconnect).
        if (!channel.replayHistory(ws) && s.sessionId) {
          const messages = await providerForSession(s.sessionId).load(s.sessionId, s.workspaceDir);
          try { ws.send(JSON.stringify({ type: 'sessionLoaded', id: s.sessionId, messages })); } catch {}
        }
      }
    } else if (msg.type === 'send' && msg.text?.trim() === '/clear') {
      channel.setBrowsing(ws, false);
      s.errorRetry?.cancel(false);
      s.runtime?.dispose(); s.runtime = undefined;
      s.sessionId = undefined;
      abortPendingStop(s, '/clear during a pending stop: killing the CLI');
      if (s.currentProc) {
        const proc = s.currentProc;
        s.currentProc = undefined;
        s.currentProcKey = undefined;
        killProc(proc);
      }
      s.pendingBgTasks.clear();
      broadcastBgTasks(s);
      s.broadcast(JSON.stringify({ type: 'clear' }));
    } else if (msg.type === 'send' && (msg.text || msg.images?.length)) {
      // A send from a client that navigated to another session belongs to THAT session.
      // handleSend only sees the entry state, so left in this entry the text would take
      // the mid-turn-inject branch and be written into the stdin of the turn the client
      // walked away from - visible to everyone watching that session, and not to the
      // sender. Detaching first gives the client its own entry bound to what it is
      // viewing, so the send spawns a normal turn with --resume on that session.
      const detached = channel.detachToBrowsedSession(ws);
      if (detached) {
        if (!detached.sendLog) initChannelSession(detached, model);
        handleSend(detached, msg);
      } else {
        channel.setBrowsing(ws, false);
        handleSend(s, msg);
      }
    } else if (msg.type === 'getSettings') {
      ws.send(JSON.stringify({ type: 'settings', settings: readConfig() }));
    } else if (msg.type === 'restartDaemon') {
      hooks.onRestartRequest?.();
    } else if (msg.type === 'stopDaemon') {
      // The daemon broadcasts daemonStopping to everyone on its way out. A server
      // that cannot stop itself (the dev server) answers only the requester, so the
      // UI reports "not a daemon" instead of waiting for a reply that never comes.
      if (hooks.onStopRequest) hooks.onStopRequest();
      else ws.send(JSON.stringify({ type: 'daemonStopping', stopped: false }));
    } else if (msg.type === 'killAllClaude') {
      const result = killAllClaude();
      // This action only kills Claude processes, so it resets only the Claude
      // subtotal. Codex launches remain in the combined CLI launch count.
      if (result.count > 0) resetCliLaunchCount();
      ws.send(JSON.stringify({ type: 'killAllClaudeResult', ...result }));
    } else if (msg.type === 'listCliProcesses') {
      // Runs where the server runs, like killAllClaude: the processes worth listing are
      // the ones on the machine the CLI is spawned on, which over a remote connection is
      // not the machine the panel is on.
      listCliProcesses({ owned: listOwnedProcs(), current: s.runtime?.pid ?? s.currentProc?.pid }).then(({ processes, error }) => {
        ws.send(JSON.stringify({ type: 'cliProcessList', processes, error, cores: cpuCoreCount() }));
      }).catch((err) => {
        ws.send(JSON.stringify({ type: 'cliProcessList', processes: [], error: (err as Error)?.message ?? String(err), cores: cpuCoreCount() }));
      });
    } else if (msg.type === 'killCliProcess') {
      // The pid is validated against the live listing inside killCliProcess - a client
      // must not be able to name an arbitrary process for the server to terminate.
      const raw = (msg as { pid?: number }).pid;
      const pid = typeof raw === 'number' ? raw : -1;
      killCliProcess(pid).then((result) => {
        ws.send(JSON.stringify({ type: 'cliProcessKilled', ...result }));
      }).catch((err) => {
        ws.send(JSON.stringify({ type: 'cliProcessKilled', pid, killed: false, error: (err as Error)?.message ?? String(err) }));
      });
    } else if (msg.type === 'getClientCount') {
      ws.send(JSON.stringify({ type: 'clientCount', count: hooks.getClientCount?.() ?? 0 }));
    } else if (msg.type === 'getAuthStatus') {
      const record = readAuth();
      ws.send(JSON.stringify({
        type: 'authStatus',
        configured: !!record,
        user: record?.user ?? '',
        sessions: sessionCount(),
        minLength: MIN_PASSWORD_LENGTH,
      }));
    } else if (msg.type === 'setAuthPassword') {
      // The current password is required whenever one exists (enforced inside
      // setPassword), so a hijacked session cannot lock the owner out.
      const m = msg as { user?: string; password?: string; currentPassword?: string };
      const result = setPassword(String(m.user ?? ''), String(m.password ?? ''), m.currentPassword);
      // Every issued token was minted against the old password; drop the sockets that
      // are still riding one, exactly as a settings change drops disallowed origins.
      if (result.ok) hooks.onAuthChange?.();
      ws.send(JSON.stringify({ type: 'authResult', action: 'set', ...result }));
    } else if (msg.type === 'clearAuthPassword') {
      const result = clearPassword(String((msg as { currentPassword?: string }).currentPassword ?? ''));
      if (result.ok) hooks.onAuthChange?.();
      ws.send(JSON.stringify({ type: 'authResult', action: 'clear', ...result }));
    } else if (msg.type === 'signOutAll') {
      const dropped = dropAllSessions();
      hooks.onAuthChange?.();
      ws.send(JSON.stringify({ type: 'authResult', action: 'signOut', ok: true, dropped }));
    } else if (msg.type === 'listClients') {
      // Answers even when the hook is absent, with the reason: an empty list would
      // claim zero connections while this very request proves there is at least one.
      ws.send(hooks.getClients
        ? JSON.stringify({ type: 'clientList', clients: hooks.getClients() })
        : JSON.stringify({ type: 'clientList', clients: [], error: 'this server cannot list its connections' }));
    } else if (msg.type === 'closeClient') {
      // The id is validated against the live socket set inside closeClient - a client
      // must not be able to name an arbitrary connection for the server to drop.
      const raw = (msg as { id?: number }).id;
      const id = typeof raw === 'number' ? raw : -1;
      const result = hooks.closeClient?.(id) ?? { id, closed: false, error: 'this server cannot close connections' };
      // Answered before the socket dies, so the requester learns the outcome even when
      // it just disconnected itself.
      ws.send(JSON.stringify({ type: 'clientClosed', ...result }));
    } else if (msg.type === 'getServerInfo') {
      // sessionId is undefined until the CLI reports one (a brand-new chat before its
      // first turn); sessionPath is null until the transcript exists on disk.
      const currentSessionId = channel.getViewingSessionId(ws) ?? s.sessionId;
      ws.send(JSON.stringify({
        type: 'serverInfo',
        port: hooks.getServerPort?.() ?? 0,
        cliLaunchCount: getCliLaunchCount(),
        sessionId: currentSessionId,
        sessionPath: currentSessionId ? sessionFilePath(currentSessionId, s.workspaceDir) : null,
        // Version of the build serving this connection. The extension and the daemon
        // are separate installs that find each other through one machine-global
        // discovery file, so a panel can be talking to an older daemon left running by
        // another install - which silently lacks whatever the panel expects.
        serverVersion: readServerVersion(),
      }));
    } else if (msg.type === 'updateSettings') {
      const patch = (msg as { settings?: Partial<ArgusConfig> }).settings;
      if (patch) {
        if ('errorRetryPatterns' in patch) {
          const validation = parseErrorRetryPatterns(patch.errorRetryPatterns);
          if (validation.error) {
            ws.send(JSON.stringify({ type: 'providerNotice', error: true, message: validation.error }));
            return;
          }
        }
        const filtered: Partial<ArgusConfig> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (k in DEFAULT_CONFIG && k !== 'providerDefaults' && k !== 'defaultProvider') (filtered as Record<string, unknown>)[k] = v;
        }
        const config = { ...readConfig(), ...filtered };
        writeConfig(config);
        ws.send(JSON.stringify({ type: 'settings', settings: config }));
        hooks.onSettingsChange?.();
      }
    } else if (msg.type === 'getInfo') {
      let version = '';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
        version = pkg.version ?? '';
      } catch {}
      ws.send(JSON.stringify(buildWorkspaceInfo(s.workspaceDir, version, s.serverDefaultModel, channel.getViewingSessionId(ws) ? selectionFor(channel.getViewingSessionId(ws)!, s.workspaceDir) : s.selection)));
    } else if (msg.type === 'retry') {
      if (s.lastMessage) {
        s.sendLog('info', 'Retrying last message');
        s.broadcast(JSON.stringify({ type: 'retry_clean' }));
        handleSend(s, { type: 'send', text: s.lastMessage.text, images: s.lastMessage.images, mode: s.lastMessage.mode, _silent: true });
      }
    } else if (msg.type === 'forceError') {
      if (s.currentProc) killProc(s.currentProc);
      s.broadcast(JSON.stringify({ type: 'error', text: 'Forced error (kill button)' }));
    } else if (msg.type === 'login') {
      login.start(s.workspaceDir);
    } else if (msg.type === 'loginCode' && msg.text) {
      login.submitCode(msg.text);
    } else if (msg.type === 'toolAnswer') {
      runtime(s).respond(msg.id || '', (msg as { answers?: unknown }).answers);
    } else if (msg.type === 'readFilePreview' && msg.path) {
      const result = readFilePreview(msg.path, s.workspaceDir);
      ws.send(JSON.stringify({ type: 'filePreview', ...result }));
    } else if (msg.type === 'mediaUrl' && msg.path) {
      // Exchange a path for a playback token. The path is validated by the very same
      // call a preview makes - same resolution, same containment rule - so /media can
      // never serve a file that could not already have been previewed. This is the only
      // place a media path is accepted, which is what keeps the HTTP route path-free.
      //
      // Unlike readFilePreview this is NOT routed to the extension host: the process
      // that mints the token has to be the one that serves it, and in the extension the
      // preview is read locally while the media endpoint lives on the daemon.
      const result = readFilePreview(String(msg.path), s.workspaceDir);
      const reply = result.media
        ? {
            path: result.path,
            ...result.media,
            token: grantMedia(result.path, result.media.kind, result.media.mediaType, result.media.size),
            // The client builds the origin (only it knows the host it reached us on -
            // `localhost` would be wrong for every remote viewer), so it needs the port.
            port: hooks.getServerPort?.() ?? 0,
          }
        : { path: result.path, error: result.content || 'not a playable media file' };
      ws.send(JSON.stringify({ type: 'mediaGrant', ...reply }));
    } else if (msg.type === 'readToolImage' && msg.toolUseId) {
      // The image a tool returned, on demand. Preferring the transcript over the file
      // is the point: it holds the bytes the model actually saw, so a preview still
      // opens after the file was renamed, packaged or deleted. The disk read is the
      // fallback for a transcript that has no image for this call - an old session, or
      // a tool whose result line the CLI has not flushed yet.
      const viewing = channel.getViewingSessionId(ws) ?? s.sessionId;
      const img = viewing ? readToolImage(viewing, s.workspaceDir, String(msg.toolUseId)) : null;
      const reply = img
        ? { path: String(msg.path ?? ''), content: `data:${img.mediaType};base64,${img.data}` }
        : msg.path
          ? readFilePreview(String(msg.path), s.workspaceDir)
          : { path: '', content: 'Error: no image recorded for this tool call' };
      ws.send(JSON.stringify({ type: 'toolImage', toolUseId: msg.toolUseId, ...reply }));
    } else if (msg.type === 'getUsageInsights') {
      collectUsageInsights(msg.force).then((insights) => {
        ws.send(JSON.stringify({ type: 'usageInsights', day: insights.day, week: insights.week }));
      }).catch((err) => {
        ws.send(JSON.stringify({ type: 'usageInsights', error: (err as Error).message ?? String(err) }));
      });
    } else if (msg.type === 'stop') {
      if (!s.errorRetry?.cancel(true)) await runtime(s).stop();
    } else if (msg.type === 'newSession') {
      // Create a fresh isolated session entry for this client only.
      // The previous entry's CLI process keeps running for any other clients still in it.
      const previousSelection = { ...s.selection };
      const newState = channel.moveToNewSession(ws);
      newState.selection = previousSelection;
      if (!newState.sendLog) initChannelSession(newState, model);
      newState.sessionId = undefined;
      newState.lastMessage = null;
      newState.pendingBgTasks.clear();
      // broadcast() on the new entry goes only to this client (the entry is fresh).
      broadcastBgTasks(newState);
      newState.broadcast(JSON.stringify({ type: 'clear' }));
      newState.broadcast(JSON.stringify(selectionMessage(newState)));
    } else if (msg.type === 'resumeSession' && msg.id) {
      await handleResumeSession(s, ws, channel, msg.id);
    } else if (msg.type === 'listWorkspaces') {
      const currentPath = s.workspaceDir;
      listWorkspaces().then(workspaces => {
        for (const r of records().filter(r => r.selection.providerId !== 'claude')) {
          const existing = workspaces.find(w => w.path === r.cwd);
          if (existing) { existing.sessions++; existing.updatedAt = Math.max(existing.updatedAt, r.updatedAt); }
          else workspaces.push({ path: r.cwd, name: path.basename(r.cwd), sessions: 1, updatedAt: r.updatedAt });
        }
        try { ws.send(JSON.stringify({ type: 'workspaceList', workspaces, currentPath })); } catch {}
      }).catch(() => {});
    } else if (msg.type === 'listAllSessions') {
      const currentId = s.sessionId;
      listAllSessions().then(sessions => {
        sessions.push(...records().filter(r => r.selection.providerId !== 'claude').map(r => ({ id: r.id, title: r.title, lastPrompt: '', updatedAt: r.updatedAt, lines: codexSessionLineCount(r.id), workspacePath: r.cwd, workspaceName: path.basename(r.cwd) })));
        sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        try { ws.send(JSON.stringify({ type: 'allSessionList', sessions, currentId })); } catch {}
      }).catch(() => {});
    } else if (msg.type === 'getActiveSessions') {
      // Initial sync for a client that just connected; later changes arrive as
      // `activeSessions` pushes from notifyActiveSessions().
      ws.send(JSON.stringify({ type: 'activeSessions', sessions: listActiveSessions() }));
    } else if (msg.type === 'getBgTasks') {
      // Same shape: the count is pushed only when it changes, so a client that joined
      // mid-watch (page reload, daemon restart) has to ask for the current one.
      ws.send(JSON.stringify({ type: 'bgTasks', count: s.pendingBgTasks.size }));
    } else if (msg.type === 'getUsageLimits') {
      // Initial sync for a client that just connected; later refreshes arrive as
      // `usageLimits` pushes from the daemon's poller.
      const snap = getUsageSnapshot();
      if (snap.windows.length > 0) {
        ws.send(JSON.stringify({ type: 'usageLimits', windows: snap.windows, fetchedAt: snap.fetchedAt }));
      } else {
        // Nothing cached yet (a fresh process, or every attempt so far has failed). Ask
        // the server to refresh, which is rate-floored and shared - a client connecting
        // cannot turn into an API call of its own. Always answer, empty windows included:
        // one request gets exactly one reply, so a client can tell "unavailable" from
        // "still loading".
        requestUsageRefresh().then((s2) => {
          try { ws.send(JSON.stringify({ type: 'usageLimits', windows: s2.windows, error: s2.error, fetchedAt: s2.fetchedAt || Date.now() })); } catch {}
        }).catch((err) => {
          try { ws.send(JSON.stringify({ type: 'usageLimits', windows: [], error: String(err), fetchedAt: Date.now() })); } catch {}
        });
      }
    } else if (msg.type === 'listDir') {
      ws.send(JSON.stringify({ type: 'dirList', ...listDir(typeof msg.path === 'string' ? msg.path : undefined) }));
    } else if (msg.type === 'searchFiles') {
      // Per-client (ws.send, not broadcast): one person's "@" typing is not an event for
      // every panel on the channel. Scoped to this entry's workspace, so a relative
      // mention resolves against the same cwd the CLI is spawned with.
      const query = typeof msg.query === 'string' ? msg.query : '';
      let result: FileSearchResult;
      try {
        result = searchFiles(s.workspaceDir, query);
      } catch (e) {
        // Always answer: the picker cannot tell "still walking" from "no reply" and would
        // sit on a spinner forever - the invariant getAccountUsage had to learn the hard way.
        result = { query, hits: [], truncated: false, mode: 'browse', base: '', parent: null };
        s.sendLog('warn', `searchFiles failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      ws.send(JSON.stringify({ type: 'fileList', ...result }));
    }
    };
    let type = '';
    try { type = JSON.parse(data.toString()).type; } catch {}
    const operation = ordered.has(type) ? mutations.then(handle) : handle();
    const settled = operation.catch(error => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'providerNotice', error: true, message: error instanceof Error ? error.message : 'Request failed' }));
    });
    if (ordered.has(type)) mutations = settled;
  });
}

function handleSend(s: SessionState, msg: TurnInput): void {
  if (!msg._silent) s.errorRetry?.cancel(true);
  s.errorRetry?.beginTurn();
  void runtime(s).send(msg).catch(error => s.broadcast(JSON.stringify({ type: 'providerNotice', error: true, message: error instanceof Error ? error.message : 'Provider failed' })));
}

async function handleResumeSession(s: SessionState, ws: WebSocket, channel: Channel, id: string) {
  // If this session is mid-turn in another entry (another panel, or the entry this client
  // detached from on a browsed send), join it instead of reading the transcript. The file
  // on disk stops at the last committed turn, so loading it would drop the turn in flight
  // and leave the client with no progress indicator and no further output.
  const live = channel.attachToLiveSession(ws, id);
  if (live) {
    ws.send(JSON.stringify(selectionMessage(live)));
    live.sendLog('info', `Joined session ${id}, turn already in progress`);
    // The snapshot replay restores the blocks but not the counters behind the timer.
    const outputTokens = live.completedOutputTokens + Math.ceil(live.liveOutputChars / 4);
    try { ws.send(JSON.stringify({ type: 'token_update', inputTokens: live.liveInputTokens, outputTokens })); } catch {}
    return;
  }
  // Don't kill currentProc - the active CLI turn belongs to the whole entry, not this client.
  const procRunning = s.runtime?.active || !!s.currentProc && !s.cliDone;
  // isBrowsing: proc is active AND the user is viewing a session other than the one being streamed.
  // If the proc is idle, any resumeSession is a direct switch (live mode) - no conflict possible.
  const isBrowsing = procRunning && id !== s.sessionId;
  // Only update the session pointer when the proc is idle or the user is returning to the live session.
  // Updating it while browsing a different session would corrupt the --resume arg for the next spawn.
  if (!isBrowsing) restoreSelection(s, id);
  // Record what this client now has on screen. The entry keeps pointing at the streaming
  // session, so without this a send from here has no way back to the session the user is
  // actually looking at, and lands in the running turn instead.
  channel.setBrowsing(ws, isBrowsing, isBrowsing ? id : undefined);
  const messages = await providerForSession(id).load(id, s.workspaceDir);
  if ((channel.getViewingSessionId(ws) || channel.getClientState(ws).sessionId) !== id) return;
  ws.send(JSON.stringify({ type: 'providerSelection', ...selectionFor(id, s.workspaceDir) }));
  s.sendLog('info', `Resuming session ${id} (${plural(messages.length, 'message')})`);
  ws.send(JSON.stringify({ type: 'sessionLoaded', id, messages }));
  if (!isBrowsing) {
    channel.replaySnapshot(ws);
    // Restore live token counts lost when sessionLoaded cleared the streaming state.
    // Always send the update when returning to a live session - the frontend needs to
    // know the current counts (even if zero) to correctly render the "in / out" timer.
    // This fixes a regression where browsing away and back would lose the input count.
    const outputTokens = s.completedOutputTokens + Math.ceil(s.liveOutputChars / 4);
    ws.send(JSON.stringify({ type: 'token_update', inputTokens: s.liveInputTokens, outputTokens }));
  }
}
