import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WebSocket } from 'ws';

import { IS_WIN, resolveClaudeBin, killProc, plural, classifyError, API_ERROR_RE } from './cli';
import { readConfig, writeConfig, DEFAULT_CONFIG, type ArgusConfig } from './config';
import { getSkills } from './skills';
import { readFilePreview } from './filePreview';
import { fetchAccountInfo, fetchUsage, fetchModels } from './accountUsage';
import { createWatchdog } from './watchdog';
import { createLoginHandler } from './login';
import { type SessionState } from './sessionState';
import { type Channel } from './channel';
import { attachProcHandlers } from './cliHandler';
import { listSessions, loadSession, deleteSession, renameSession, listWorkspaces, listAllSessions, listDir } from './sessions';

const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];
const PLAN_BLOCKED_TOOLS = ['Write', 'Edit', 'AskUserQuestion'];

export interface ConnectionHooks {
  onSettingsChange?: () => void;
  getClientCount?: () => number;
  getServerPort?: () => number;
  onRestartRequest?: () => void;
}

// Initialises per-session state: logging, stale-timer, watchdog, synthetic-send
// mechanism (watchdog retry + AskUserQuestion follow-ups), and the follow-up flush.
// Called once per SessionEntry (on first client join or on moveToNewSession).
function initChannelSession(s: SessionState, model: string): void {
  const cfg = readConfig();
  s.model = cfg.model || model;
  s.effort = cfg.effort ?? 'high';
  s.thinking = cfg.thinking ?? true;

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
  channel.addClient(ws);
  const s0 = channel.getClientState(ws);
  if (!s0.sendLog) initChannelSession(s0, model);

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
      title?: string;
    };
    try { msg = JSON.parse(data.toString()); } catch {
      s.sendLog('warn', `Malformed WS message: ${data.toString().slice(0, 200)}`);
      return;
    }

    if (msg.type === 'send' && msg.text?.trim() === '/clear') {
      channel.setBrowsing(ws, false);
      s.sessionId = undefined;
      if (s.currentProc) {
        const proc = s.currentProc;
        s.currentProc = undefined;
        s.currentProcKey = undefined;
        killProc(proc);
      }
      s.pendingBgTasks.clear();
      s.totalBgTasks = 0;
      s.broadcast(JSON.stringify({ type: 'clear' }));
    } else if (msg.type === 'send' && (msg.text || msg.images?.length)) {
      channel.setBrowsing(ws, false);
      handleSend(s, msg);
    } else if (msg.type === 'getSettings') {
      ws.send(JSON.stringify({ type: 'settings', settings: readConfig() }));
    } else if (msg.type === 'restartDaemon') {
      hooks.onRestartRequest?.();
    } else if (msg.type === 'getClientCount') {
      ws.send(JSON.stringify({ type: 'clientCount', count: hooks.getClientCount?.() ?? 0 }));
    } else if (msg.type === 'getServerInfo') {
      ws.send(JSON.stringify({ type: 'serverInfo', port: hooks.getServerPort?.() ?? 0 }));
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
      ws.send(JSON.stringify({ type: 'workspaceInfo', path: s.workspaceDir, version, model: s.model, effort: s.effort, thinking: s.thinking }));
    } else if (msg.type === 'switchModel') {
      const newModel = typeof (msg as { model?: string }).model === 'string' ? (msg as { model?: string }).model! : '';
      writeConfig({ ...readConfig(), model: newModel });
      channel.forEachSession(ss => { ss.model = newModel; });
      channel.broadcastToAll(JSON.stringify({ type: 'modelChanged', model: newModel }));
    } else if (msg.type === 'switchEffort') {
      const newEffort = typeof (msg as { effort?: string }).effort === 'string' ? (msg as { effort?: string }).effort! : 'high';
      writeConfig({ ...readConfig(), effort: newEffort });
      channel.forEachSession(ss => { ss.effort = newEffort; });
      channel.broadcastToAll(JSON.stringify({ type: 'effortChanged', effort: newEffort }));
    } else if (msg.type === 'switchThinking') {
      const newThinking = (msg as { thinking?: boolean }).thinking !== false;
      writeConfig({ ...readConfig(), thinking: newThinking });
      channel.forEachSession(ss => { ss.thinking = newThinking; });
      channel.broadcastToAll(JSON.stringify({ type: 'thinkingChanged', thinking: newThinking }));
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
    } else if (msg.type === 'getAccountUsage') {
      const accountP = fetchAccountInfo();
      const usageP = fetchUsage(msg.force);
      accountP.then((account) => {
        ws.send(JSON.stringify({ type: 'accountUsage', account, usagePending: true }));
      });
      Promise.all([accountP, usageP]).then(([account, usage]) => {
        const rateLimits = usage.windows.length > 0 ? usage.windows : Array.from(s.rateLimits.values());
        const usageError = rateLimits.length === 0 ? usage.error : undefined;
        ws.send(JSON.stringify({ type: 'accountUsage', account, rateLimits, usageError, usagePending: false }));
      });
    } else if (msg.type === 'getModels') {
      fetchModels().then(({ models, error }) => {
        const runtimeDefaultModel = readConfig().runtimeDefaultModel || '';
        ws.send(JSON.stringify({ type: 'modelList', models, error, runtimeDefaultModel }));
      });
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
      newState.totalBgTasks = 0;
      // broadcast() on the new entry goes only to this client (the entry is fresh).
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
      ws.send(JSON.stringify({ type: 'workspaceList', workspaces: listWorkspaces(), currentPath: s.workspaceDir }));
    } else if (msg.type === 'listAllSessions') {
      ws.send(JSON.stringify({ type: 'allSessionList', sessions: listAllSessions(), currentId: s.sessionId }));
    } else if (msg.type === 'listDir') {
      ws.send(JSON.stringify({ type: 'dirList', ...listDir(typeof msg.path === 'string' ? msg.path : undefined) }));
    }
  });
}

function handleSend(s: SessionState, msg: { type?: string; text?: string; images?: Array<{ data: string; mediaType: string; name?: string }>; mode?: string; _silent?: boolean; _askResume?: boolean }) {
  const text = msg.text ?? '';
  const images = msg.images;

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
  if (s.model) baseArgs.push('--model', s.model);
  if (!s.thinking) {
    baseArgs.push('--effort', 'low');
  } else if (s.effort) {
    baseArgs.push('--effort', s.effort);
  }
  const cfg = readConfig();
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
  s.suppressCliOutput = false;
  s.userStopped = false;
  s.cliDone = false;
  s.toolMap.clear();
  s.answeredTools.clear();
  s.pendingAskTools.clear();
  s.pendingFollowUp = undefined;

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
    proc = spawn(spawnCmd, args, { cwd: s.workspaceDir, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true });
    s.currentProc = proc;
    s.currentProcKey = procKey;
    attachProcHandlers(s, proc);
  }

  s.pendingBgTasks.clear();
  s.totalBgTasks = 0;
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
  // Don't kill currentProc - the active CLI turn belongs to the whole entry, not this client.
  const procRunning = !!s.currentProc && !s.cliDone;
  // isBrowsing: proc is active AND the user is viewing a session other than the one being streamed.
  // If the proc is idle, any resumeSession is a direct switch (live mode) - no conflict possible.
  const isBrowsing = procRunning && id !== s.sessionId;
  // Only update the session pointer when the proc is idle or the user is returning to the live session.
  // Updating it while browsing a different session would corrupt the --resume arg for the next spawn.
  if (!isBrowsing) s.sessionId = id;
  channel.setBrowsing(ws, isBrowsing);
  const messages = loadSession(id, s.workspaceDir);
  s.sendLog('info', `Resuming session ${id} (${plural(messages.length, 'message')})`);
  ws.send(JSON.stringify({ type: 'sessionLoaded', id, messages }));
  if (!isBrowsing) channel.replaySnapshot(ws);
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
  if (s.currentProc) {
    s.userStopped = true;
    killProc(s.currentProc);
  } else {
    s.broadcast(JSON.stringify({ type: 'done' }));
  }
}
