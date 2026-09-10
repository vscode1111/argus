import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WebSocket } from 'ws';

import { IS_WIN, resolveClaudeBin, killProc, interruptProc, killAllClaude, plural, classifyError, API_ERROR_RE } from './cli';
import { readConfig, writeConfig, DEFAULT_CONFIG, type ArgusConfig } from './config';
import { getSkills } from './skills';
import { readFilePreview } from './filePreview';
// No fetchUsage here on purpose: usagePoller.ts is the only caller of the usage API,
// so the per-process rate floor cannot be bypassed by a client-triggered handler.
import { fetchAccountInfo, fetchModels } from './accountUsage';
import { collectUsageInsights } from './usageInsights';
import { getUsageSnapshot, noteUsageActivity, requestUsageRefresh } from './usagePoller';
import { createWatchdog } from './watchdog';
import { createLoginHandler } from './login';
import { type SessionState } from './sessionState';
import { type Channel, broadcastToAllChannels, listActiveSessions, listOwnedProcs } from './channel';
import { listCliProcesses, killCliProcess, cpuCoreCount } from './processes';
import { describeModel } from './modelData';
import { attachProcHandlers, broadcastBgTasks } from './cliHandler';
import { listSessions, loadSession, deleteSession, renameSession, listWorkspaces, listAllSessions, listDir, sessionFilePath, readToolImage } from './sessions';
import { readServerVersion } from './version';
import { buildWorkspaceInfo } from './workspaceInfo';
import { searchFiles, type FileSearchResult } from './fileSearch';

const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];
const PLAN_BLOCKED_TOOLS = ['Write', 'Edit', 'AskUserQuestion'];

// How long a stop waits for the interrupted turn's `result` before killing the CLI instead.
// Measured against a real CLI the acknowledgement takes single-digit milliseconds; this is
// sized for a wedged process, not for a slow one.
const STOP_INTERRUPT_TIMEOUT_MS = 5_000;

let cliLaunchCount = 0;
export function getCliLaunchCount(): number { return cliLaunchCount; }

export interface ConnectionHooks {
  onSettingsChange?: () => void;
  getClientCount?: () => number;
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
    const questions = (tc?.input as Record<string, unknown>)?.questions as Array<{
      question: string;
      options?: Array<{ label: string; description?: string }>;
    }> | undefined;
    const answerLines = Object.entries(answers).map(([q, a]) => {
      const qDef = questions?.find(qd => qd.question === q);
      const optIdx = qDef?.options?.findIndex(o => o.label === a);
      const optDesc = qDef?.options?.find(o => o.label === a)?.description;
      let line = `Question: "${q}"\nSelected: "${a}"`;
      if (optIdx !== undefined && optIdx >= 0) line += ` (option ${optIdx + 1} of ${qDef!.options!.length})`;
      if (optDesc) line += `\nDescription: ${optDesc}`;
      return line;
    }).join('\n\n');
    const followUp = `The user has now answered your earlier questions. Disregard any assumptions or defaults you adopted while the questions were unanswered (do not act as if "no questionnaire" was the outcome), and proceed using exactly these choices:\n\n${answerLines}`;
    setTimeout(() => {
      s.suppressCliOutput = false;
      s.emitSyntheticSend(JSON.stringify({ type: 'send', text: followUp, mode, _silent: true, _askResume: true }));
    }, 200);
  };

  const watchdog = createWatchdog({
    broadcast: s.broadcast,
    getProc: () => s.currentProc,
    getCliDone: () => s.cliDone,
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
  if (hooks.sessionId && !liveAttach && !s0.currentProc) s0.sessionId = hooks.sessionId;

  // login is per-client: loginUrl/loginResult only go to the requesting client's ws.
  const login = createLoginHandler(ws, s0.sendLog);

  ws.on('close', () => {
    login.kill();
    // channel.removeClient handles per-entry cleanup (watchdog stop, grace timer).
    // The entry's CLI proc is NOT killed here; it runs to natural completion so other
    // clients watching the same entry are unaffected.
    channel.removeClient(ws);
  });

  ws.on('message', (data: Buffer) => {
    // Resolve the session state fresh on every message so that after moveToNewSession
    // we automatically use the new entry's state without re-registering handlers.
    const s = channel.getClientState(ws);

    let msg: {
      type: string;
      text?: string;
      images?: Array<{ data: string; mediaType: string; name?: string }>;
      mode?: 'plan' | 'edit';
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

    if (msg.type === 'webviewReady') {
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
        const isLive = liveAttach || (!!s.currentProc && !s.cliDone && s.sessionId === hooks.sessionId);
        if (!isLive || !channel.replayHistory(ws)) {
          const messages = loadSession(hooks.sessionId, s.workspaceDir);
          s.sendLog('info', `Deep link replay of ${hooks.sessionId} (${plural(messages.length, 'message')})`);
          try { ws.send(JSON.stringify({ type: 'sessionLoaded', id: hooks.sessionId, messages })); } catch {}
        }
      } else if (panelRejoin) {
        // Reconnecting panel (?panel= matched an existing entry): addClient skipped the
        // replay for the same mount-timing reason, so restore its conversation here.
        // Same disk fallback as the deep link: the entry may be bound to a session it
        // never streamed itself (it was resumed from history before the reconnect).
        if (!channel.replayHistory(ws) && s.sessionId) {
          const messages = loadSession(s.sessionId, s.workspaceDir);
          try { ws.send(JSON.stringify({ type: 'sessionLoaded', id: s.sessionId, messages })); } catch {}
        }
      }
    } else if (msg.type === 'send' && msg.text?.trim() === '/clear') {
      channel.setBrowsing(ws, false);
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
      // The counter only ever increments on spawn, so a kill alone never moves it -
      // reset it here (only when something was actually killed) so the Info tab's
      // "CLI launches" visibly reflects the action instead of looking like a no-op.
      if (result.count > 0) cliLaunchCount = 0;
      ws.send(JSON.stringify({ type: 'killAllClaudeResult', ...result }));
    } else if (msg.type === 'listCliProcesses') {
      // Runs where the server runs, like killAllClaude: the processes worth listing are
      // the ones on the machine the CLI is spawned on, which over a remote connection is
      // not the machine the panel is on.
      listCliProcesses({ owned: listOwnedProcs(), current: s.currentProc?.pid }).then(({ processes, error }) => {
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
    } else if (msg.type === 'getServerInfo') {
      // sessionId is undefined until the CLI reports one (a brand-new chat before its
      // first turn); sessionPath is null until the transcript folder exists on disk.
      ws.send(JSON.stringify({
        type: 'serverInfo',
        port: hooks.getServerPort?.() ?? 0,
        cliLaunchCount,
        sessionId: s.sessionId,
        sessionPath: s.sessionId ? sessionFilePath(s.sessionId, s.workspaceDir) : null,
        // Version of the build serving this connection. The extension and the daemon
        // are separate installs that find each other through one machine-global
        // discovery file, so a panel can be talking to an older daemon left running by
        // another install - which silently lacks whatever the panel expects.
        serverVersion: readServerVersion(),
      }));
    } else if (msg.type === 'updateSettings') {
      const patch = (msg as { settings?: Partial<ArgusConfig> }).settings;
      if (patch) {
        const filtered: Partial<ArgusConfig> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (k in DEFAULT_CONFIG) (filtered as Record<string, unknown>)[k] = v;
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
      ws.send(JSON.stringify(buildWorkspaceInfo(s.workspaceDir, version, s.serverDefaultModel)));
    } else if (msg.type === 'switchModel') {
      const newModel = typeof (msg as { model?: string }).model === 'string' ? (msg as { model?: string }).model! : '';
      writeConfig({ ...readConfig(), model: newModel });
      // Global settings notify every client on every workspace channel; a per-channel
      // broadcast left other workspaces' panels highlighting the old model.
      broadcastToAllChannels(JSON.stringify({ type: 'modelChanged', model: newModel }));
    } else if (msg.type === 'switchEffort') {
      const newEffort = typeof (msg as { effort?: string }).effort === 'string' ? (msg as { effort?: string }).effort! : 'high';
      writeConfig({ ...readConfig(), effort: newEffort });
      broadcastToAllChannels(JSON.stringify({ type: 'effortChanged', effort: newEffort }));
    } else if (msg.type === 'switchThinking') {
      const newThinking = (msg as { thinking?: boolean }).thinking !== false;
      writeConfig({ ...readConfig(), thinking: newThinking });
      broadcastToAllChannels(JSON.stringify({ type: 'thinkingChanged', thinking: newThinking }));
    } else if (msg.type === 'retry') {
      if (s.lastMessage) {
        s.sendLog('info', 'Retrying last message');
        s.broadcast(JSON.stringify({ type: 'retry_clean' }));
        handleSend(s, { type: 'send', text: s.lastMessage.text, images: s.lastMessage.images, mode: s.lastMessage.mode, _silent: true });
      }
    } else if (msg.type === 'forceError') {
      if (s.currentProc) killProc(s.currentProc);
      s.broadcast(JSON.stringify({ type: 'error', text: 'Forced error (kill button)' }));
    } else if (msg.type === 'getSkills') {
      ws.send(JSON.stringify({ type: 'skills', skills: getSkills(s.workspaceDir) }));
    } else if (msg.type === 'login') {
      login.start(s.workspaceDir);
    } else if (msg.type === 'loginCode' && msg.text) {
      login.submitCode(msg.text);
    } else if (msg.type === 'toolAnswer') {
      handleToolAnswer(s, msg as { type: string; id?: string; answers?: unknown; mode?: string });
    } else if (msg.type === 'readFilePreview' && msg.path) {
      const result = readFilePreview(msg.path, s.workspaceDir);
      ws.send(JSON.stringify({ type: 'filePreview', ...result }));
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
    } else if (msg.type === 'getAccountUsage') {
      // An explicit refresh means the user is at the machine looking at the numbers,
      // so it reopens the poller's activity window; merely opening the modal does not.
      if (msg.force) noteUsageActivity();
      const accountP = fetchAccountInfo();
      // Never a per-client fetch: the server refreshes at most once per
      // USAGE_MIN_REFRESH_MS however many panels ask, and broadcasts what it gets, so
      // opening this modal also updates every other client's header indicator.
      const usageP = requestUsageRefresh();
      accountP.then((account) => {
        ws.send(JSON.stringify({ type: 'accountUsage', account, usagePending: true }));
      }).catch(() => {});
      Promise.all([accountP, usageP]).then(([account, usage]) => {
        const rateLimits = usage.windows.length > 0 ? usage.windows : Array.from(s.rateLimits.values());
        const usageError = rateLimits.length === 0 ? usage.error : undefined;
        ws.send(JSON.stringify({ type: 'accountUsage', account, rateLimits, usageError, usagePending: false }));
      }).catch((err) => {
        // One request, one reply - the invariant getUsageLimits and getUsageInsights
        // already hold. Swallowing here meant a failure sent nothing at all, so the
        // modal spun on "Loading..." with no reason on screen and a waiting client had
        // no frame to wake on.
        ws.send(JSON.stringify({
          type: 'accountUsage',
          account: { loggedIn: false },
          rateLimits: [],
          usageError: (err as Error)?.message ?? String(err),
          usagePending: false,
        }));
      });
    } else if (msg.type === 'getUsageInsights') {
      collectUsageInsights(msg.force).then((insights) => {
        ws.send(JSON.stringify({ type: 'usageInsights', day: insights.day, week: insights.week }));
      }).catch((err) => {
        ws.send(JSON.stringify({ type: 'usageInsights', error: (err as Error).message ?? String(err) }));
      });
    } else if (msg.type === 'getModels') {
      fetchModels().then(({ models, error }) => {
        const cfg = readConfig();
        let list = models;
        if (list.length > 0) {
          // Persist the last good list so the picker still shows real entries when
          // a later fetch fails (offline, expired token) or on the next fresh start.
          if (JSON.stringify(list) !== JSON.stringify(cfg.modelListCache)) {
            writeConfig({ ...cfg, modelListCache: list });
          }
        } else if (cfg.modelListCache.length > 0) {
          list = cfg.modelListCache;
        }
        const withDescriptions = list.map(m => ({ ...m, description: describeModel(m.id, cfg.modelFamilyDescriptions) }));
        ws.send(JSON.stringify({ type: 'modelList', models: withDescriptions, error, runtimeDefaultModel: cfg.runtimeDefaultModel || '' }));
      }).catch(() => {});
    } else if (msg.type === 'stop') {
      handleStop(s);
    } else if (msg.type === 'newSession') {
      // Create a fresh isolated session entry for this client only.
      // The previous entry's CLI process keeps running for any other clients still in it.
      const newState = channel.moveToNewSession(ws);
      if (!newState.sendLog) initChannelSession(newState, model);
      newState.sessionId = undefined;
      newState.lastMessage = null;
      newState.pendingBgTasks.clear();
      // broadcast() on the new entry goes only to this client (the entry is fresh).
      broadcastBgTasks(newState);
      newState.broadcast(JSON.stringify({ type: 'clear' }));
    } else if (msg.type === 'listSessions') {
      ws.send(JSON.stringify({ type: 'sessionList', sessions: listSessions(s.workspaceDir), currentId: s.sessionId }));
    } else if (msg.type === 'resumeSession' && msg.id) {
      handleResumeSession(s, ws, channel, msg.id);
    } else if (msg.type === 'deleteSession' && msg.id) {
      deleteSession(msg.id, s.workspaceDir);
      if (s.sessionId === msg.id) s.sessionId = undefined;
      ws.send(JSON.stringify({ type: 'sessionList', sessions: listSessions(s.workspaceDir), currentId: s.sessionId }));
    } else if (msg.type === 'renameSession' && msg.id && typeof msg.title === 'string') {
      renameSession(msg.id, s.workspaceDir, msg.title);
      ws.send(JSON.stringify({ type: 'sessionList', sessions: listSessions(s.workspaceDir), currentId: s.sessionId }));
    } else if (msg.type === 'listWorkspaces') {
      const currentPath = s.workspaceDir;
      listWorkspaces().then(workspaces => {
        try { ws.send(JSON.stringify({ type: 'workspaceList', workspaces, currentPath })); } catch {}
      }).catch(() => {});
    } else if (msg.type === 'listAllSessions') {
      const currentId = s.sessionId;
      listAllSessions().then(sessions => {
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
  });
}

function handleSend(s: SessionState, msg: { type?: string; text?: string; images?: Array<{ data: string; mediaType: string; name?: string }>; mode?: string; _silent?: boolean; _askResume?: boolean }) {
  const text = msg.text ?? '';
  const images = msg.images;
  // Any send spends tokens, including a mid-turn inject and a silent retry, so it is
  // what keeps the usage poller awake (and wakes it after a paused hour).
  noteUsageActivity();

  if (s.currentProc?.stdin?.writable && !s.cliDone && !msg._silent && !msg._askResume) {
    s.lastMessage = { text, images, mode: msg.mode };
    const contentBlocks: Array<Record<string, unknown>> = [];
    if (images && images.length > 0) {
      for (const img of images) {
        if (img.mediaType.startsWith('text/')) {
          contentBlocks.push({ type: 'text', text: `[Attached file: ${img.name ?? 'file.txt'}]\n${Buffer.from(img.data, 'base64').toString('utf-8')}` });
        } else if (img.mediaType === 'application/pdf') {
          contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
        } else {
          contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
        }
      }
    }
    if (text) contentBlocks.push({ type: 'text', text });
    const stdinMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: contentBlocks } });
    s.sendLog('info', `Mid-turn inject: ${stdinMsg.length} bytes to stdin`);
    s.currentProc.stdin.write(stdinMsg + '\n');
    // The turn stops being the CLI's own the moment the user speaks into it: they are now
    // waiting on this answer, so it must ring on completion. This branch returns before the
    // reset block below that normally clears the flag.
    s.autonomousTurn = false;
    s.broadcast(JSON.stringify({ type: 'user_inject', text }));
    return;
  }

  if (!msg._silent) {
    s.broadcast(JSON.stringify({ type: 'message', message: { id: String(Date.now()), role: 'user', content: text, images } }));
  }

  const isPlan = msg.mode === 'plan';
  const tools = isPlan ? ALLOWED_TOOLS.filter(t => !PLAN_BLOCKED_TOOLS.includes(t)) : ALLOWED_TOOLS;
  const baseArgs = [
    '--print', '--verbose',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--tools', tools.join(','),
    '--allowedTools', tools.join(','),
  ];
  // Derived from the config at spawn time (see getInfo): the latest switchModel /
  // switchEffort / switchThinking always wins, whichever channel or process it came from.
  const cfg = readConfig();
  const model = cfg.model || s.serverDefaultModel;
  if (model) baseArgs.push('--model', model);
  if (!cfg.thinking) {
    baseArgs.push('--effort', 'low');
  } else if (cfg.effort) {
    baseArgs.push('--effort', cfg.effort);
  }
  if (cfg.appendSystemPrompt) baseArgs.push('--append-system-prompt', cfg.appendSystemPrompt);
  if (isPlan) {
    baseArgs.push('--permission-mode', 'plan', '--disallowedTools', PLAN_BLOCKED_TOOLS.join(','));
  }
  const procKey = baseArgs.join(' ');
  const args = [...baseArgs];
  if (s.sessionId && (!s.currentProc || s.currentProcKey !== procKey)) {
    args.push('--resume', s.sessionId);
  }

  if (!msg._silent) {
    s.lastMessage = { text, images, mode: msg.mode };
    s.watchdog.state.autoRetryCount = 0;
  }

  s.buffer = '';
  s.stderrOutput = '';
  s.textAccum = '';
  s.resetStaleTimer();
  s.watchdog.state.active = false;
  s.receivedDeltas = false;
  s.receivedThinkingDeltas = false;
  s.liveOutputChars = 0;
  s.completedOutputTokens = 0;
  s.liveInputTokens = 0;
  s.suppressCliOutput = false;
  s.cliDone = false;
  s.autonomousTurn = false;
  s.toolMap.clear();
  s.answeredTools.clear();
  s.pendingAskTools.clear();
  s.pendingFollowUp = undefined;

  // A stop that has not settled yet (the interrupted turn still owes its `result`) must not
  // hand its process to this turn: that pending result would be read as *this* turn's and
  // end it a few milliseconds in, which is the empty-1s-turn failure in another costume.
  // Measured, the acknowledgement takes single-digit ms, so this only trips when a send
  // lands in that window - it falls back to the old kill-and-respawn, never to a wrong turn.
  if (s.stopping) abortPendingStop(s, 'Send arrived before the stopped turn settled; respawning');

  const canReuse = s.currentProc?.stdin?.writable === true && s.currentProcKey === procKey;
  let proc: ReturnType<typeof spawn>;
  if (canReuse) {
    proc = s.currentProc!;
    s.sendLog('info', 'Reusing claude process');
  } else {
    if (s.currentProc) {
      s.sendLog('info', 'Args changed, respawning claude');
      killProc(s.currentProc);
    }
    const claudeBin = resolveClaudeBin();
    const spawnCmd = IS_WIN && /\s/.test(claudeBin) ? `"${claudeBin}"` : claudeBin;
    s.sendLog('info', `Spawning claude: ${args.join(' ')}`);
    // spawn() throws synchronously when the OS refuses a new process (e.g. resource
    // exhaustion -> "spawn UNKNOWN"). That must stay a per-turn error: uncaught it
    // kills the server process and every other client's connection with it.
    try {
      proc = spawn(spawnCmd, args, { cwd: s.workspaceDir, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      s.currentProc = undefined;
      s.currentProcKey = undefined;
      s.cliDone = true;
      s.sendLog('error', `spawn failed: ${message}`);
      s.broadcast(JSON.stringify({ type: 'error', text: `Failed to start Claude CLI: ${message}` }));
      s.broadcast(JSON.stringify({ type: 'done' }));
      return;
    }
    cliLaunchCount++;
    s.currentProc = proc;
    s.currentProcKey = procKey;
    attachProcHandlers(s, proc);
  }

  // Reaped when a *new* process is spawned, not on every send. An orphan is created by a
  // process dying (hard kill, kill-all, daemon respawn - see
  // !notes/tasks/empty-1s-turn/notes.md), and the replacement cannot deliver the
  // notifications its predecessor's tasks owed, so that set is worthless to it; a reused
  // process still owns its tasks and will report them. Clearing on every send instead
  // dropped tasks that were genuinely still running - tolerable while the count was a
  // footnote on one message, wrong now that it is a live indicator, because typing
  // anything mid-watch zeroed it and nothing could restore it (`task_started` is emitted
  // once per task and never re-emitted, measured in
  // !notes/tasks/bg-task-indicators/scripts/probe-task-started.js).
  if (!canReuse && s.pendingBgTasks.size > 0) {
    s.pendingBgTasks.clear();
    broadcastBgTasks(s);
  }
  if (!msg._askResume) {
    s.broadcast(JSON.stringify({ type: 'thinking_start', reused: canReuse }));
  }
  s.watchdog.state.lastEventTime = Date.now();
  s.watchdog.state.active = true;

  const contentBlocks: Array<Record<string, unknown>> = [];
  if (images && images.length > 0) {
    for (const img of images) {
      if (img.mediaType.startsWith('text/')) {
        contentBlocks.push({ type: 'text', text: `[Attached file: ${img.name ?? 'file.txt'}]\n${Buffer.from(img.data, 'base64').toString('utf-8')}` });
      } else if (img.mediaType === 'application/pdf') {
        contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      } else {
        contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      }
    }
    s.sendLog('debug', `Attaching ${plural(images.length, 'attachment')}`);
  }
  if (text) contentBlocks.push({ type: 'text', text });
  const stdinMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: contentBlocks } });
  s.sendLog('debug', `stdin: ${stdinMsg.length} bytes`);
  proc.stdin!.write(stdinMsg + '\n');
}

function handleToolAnswer(s: SessionState, msg: { type: string; id?: string; answers?: unknown; mode?: string }) {
  const answerId = msg.id ?? '';
  const answers = msg.answers as Record<string, string> | undefined;
  const content = JSON.stringify({ answers });
  const tc = s.toolMap.get(answerId);

  s.pendingAskTools.delete(answerId);
  s.answeredTools.add(answerId);

  s.broadcast(JSON.stringify({ type: 'tool_end', call: { id: answerId, name: tc?.name ?? 'AskUserQuestion', input: tc?.input ?? {}, result: content } }));
  s.sendLog('info', `Tool answer for ${answerId}: ${content.slice(0, 100)}`);

  if (s.pendingAskTools.size === 0 && s.sessionId && answers && Object.keys(answers).length > 0) {
    s.pendingFollowUp = { answers, toolId: answerId, mode: msg.mode };
    if (s.cliDone) s.flushAskFollowUp();
  } else {
    if (s.pendingAskTools.size === 0) s.suppressCliOutput = false;
    if (s.currentProc?.stdin?.writable) s.currentProc.stdin.end();
    if (s.pendingAskTools.size === 0 && s.cliDone) {
      setTimeout(() => s.broadcast(JSON.stringify({ type: 'done' })), 100);
    }
  }
}

function handleResumeSession(s: SessionState, ws: WebSocket, channel: Channel, id: string) {
  // If this session is mid-turn in another entry (another panel, or the entry this client
  // detached from on a browsed send), join it instead of reading the transcript. The file
  // on disk stops at the last committed turn, so loading it would drop the turn in flight
  // and leave the client with no progress indicator and no further output.
  const live = channel.attachToLiveSession(ws, id);
  if (live) {
    live.sendLog('info', `Joined session ${id}, turn already in progress`);
    // The snapshot replay restores the blocks but not the counters behind the timer.
    const outputTokens = live.completedOutputTokens + Math.ceil(live.liveOutputChars / 4);
    try { ws.send(JSON.stringify({ type: 'token_update', inputTokens: live.liveInputTokens, outputTokens })); } catch {}
    return;
  }
  // Don't kill currentProc - the active CLI turn belongs to the whole entry, not this client.
  const procRunning = !!s.currentProc && !s.cliDone;
  // isBrowsing: proc is active AND the user is viewing a session other than the one being streamed.
  // If the proc is idle, any resumeSession is a direct switch (live mode) - no conflict possible.
  const isBrowsing = procRunning && id !== s.sessionId;
  // Only update the session pointer when the proc is idle or the user is returning to the live session.
  // Updating it while browsing a different session would corrupt the --resume arg for the next spawn.
  if (!isBrowsing) s.sessionId = id;
  // Record what this client now has on screen. The entry keeps pointing at the streaming
  // session, so without this a send from here has no way back to the session the user is
  // actually looking at, and lands in the running turn instead.
  channel.setBrowsing(ws, isBrowsing, isBrowsing ? id : undefined);
  const messages = loadSession(id, s.workspaceDir);
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

// Gives up on an in-flight interrupt and falls back to the old kill-and-detach. Used
// wherever a stopped turn's process must not survive into whatever comes next: a send that
// beat the interrupt's acknowledgement, and the /clear reset. (newSession is deliberately
// not one of them - it moves this client to a fresh entry and leaves the old one, process
// and pending stop included, to whichever clients are still in it.)
function abortPendingStop(s: SessionState, reason: string) {
  if (!s.stopping) return;
  s.stopping = false;
  if (s.stopKillTimer) { clearTimeout(s.stopKillTimer); s.stopKillTimer = null; }
  if (!s.currentProc) return;
  const stale = s.currentProc;
  s.currentProc = undefined;
  s.currentProcKey = undefined;
  s.sendLog('info', reason);
  killProc(stale);
}

function handleStop(s: SessionState) {
  s.watchdog.state.active = false;
  if (s.watchdog.state.retryTimer) {
    clearTimeout(s.watchdog.state.retryTimer);
    s.watchdog.state.retryTimer = null;
  }
  s.watchdog.state.retrying = false;
  for (const toolId of s.pendingAskTools) {
    const tc = s.toolMap.get(toolId);
    s.broadcast(JSON.stringify({ type: 'tool_end', call: { id: toolId, name: tc?.name ?? 'AskUserQuestion', input: tc?.input ?? {}, result: JSON.stringify({ cancelled: true }) } }));
  }
  s.pendingAskTools.clear();
  // Interrupt a live turn rather than killing the process. A killed CLI leaves its
  // transcript ending on a user message nobody answered, and the CLI repairs that on the
  // next `--resume` by splicing a synthetic "No response requested." assistant turn into
  // the conversation - which it then sends to the model on every later turn (measured, see
  // !notes/tasks/no-response-requested/notes.md), until the model starts answering real
  // questions with those four words. The repair only fires when the *last* message is a
  // user message, so keeping the process alive is what fixes it: the next send reuses it
  // with no `--resume`, that answer lands after the abandoned message, and the abandoned
  // message is no longer last.
  const proc = s.currentProc;
  if (proc && !s.cliDone && interruptProc(proc)) {
    s.stopping = true;
    s.sendLog('info', 'Stop: interrupting the turn, keeping the CLI for reuse');
    s.stopKillTimer = setTimeout(() => {
      // The interrupt was written but never acknowledged with a `result`. Fall back to the
      // old behaviour rather than leave a stopped turn generating where nobody can see it.
      if (!s.stopping) return;
      s.stopping = false;
      s.stopKillTimer = null;
      s.sendLog('warn', 'Stop: interrupt not acknowledged, killing the CLI');
      if (s.currentProc === proc) { s.currentProc = undefined; s.currentProcKey = undefined; }
      killProc(proc);
    }, STOP_INTERRUPT_TIMEOUT_MS);
  } else if (proc) {
    // No live turn to interrupt, or the pipe is already gone. Detach before killing,
    // exactly like the /clear handler: `close` arrives a beat after killProc, and until it
    // does the dying proc still has a writable stdin - so a send issued right after a stop
    // was taken for a mid-turn inject (or reused the proc outright), wrote into a pipe
    // nobody reads, and the pending close then ended the fresh turn with a bare `done`.
    // Detached, it can be neither reused nor injected into, and its close is a no-op.
    s.currentProc = undefined;
    s.currentProcKey = undefined;
    killProc(proc);
  }
  s.cliDone = true;
  s.broadcast(JSON.stringify({ type: 'done' }));
}
