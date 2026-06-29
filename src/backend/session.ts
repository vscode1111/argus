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
import { createSessionState, type SessionState } from './sessionState';
import { attachProcHandlers } from './cliHandler';
import { listSessions, loadSession, deleteSession, renameSession, listWorkspaces, listAllSessions, listDir } from './sessions';

const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];
const PLAN_BLOCKED_TOOLS = ['Write', 'Edit', 'AskUserQuestion'];

export interface ConnectionHooks {
  // Re-check live connections after a settings change (e.g. Network access toggle).
  onSettingsChange?: () => void;
  // Current count of open client sockets, for the Settings "Network" tab.
  getClientCount?: () => number;
  // Actual port this HTTP/WebSocket server is listening on, for the Settings "Network" tab.
  getServerPort?: () => number;
  // Restart the daemon (browser-served "Apply" button). Undefined for the dev server.
  onRestartRequest?: () => void;
}

export function handleConnection(
  ws: WebSocket,
  workspaceDir: string,
  model: string,
  hooks: ConnectionHooks = {},
): void {
  const initCfg = readConfig();
  const s = createSessionState(
    ws, workspaceDir,
    initCfg.model || model,
    initCfg.effort ?? 'high',
    initCfg.thinking ?? true,
  );

  s.sendLog = (level, text) => {
    ws.send(JSON.stringify({ type: 'log', level, text, timestamp: new Date().toISOString() }));
  };

  const login = createLoginHandler(ws, s.sendLog);

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
        ws.send(JSON.stringify({ type: 'error', text: errText, errorKind }));
        ws.send(JSON.stringify({ type: 'done' }));
      }
    }, 3000);
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
      ws.emit('message', Buffer.from(JSON.stringify({ type: 'send', text: followUp, mode, _silent: true, _askResume: true })));
    }, 200);
  };

  const watchdog = createWatchdog({
    ws,
    getProc: () => s.currentProc,
    getCliDone: () => s.cliDone,
    setCliDone: (v) => { s.cliDone = v; s.resetStaleTimer(); },
    getPendingAskCount: () => s.pendingAskTools.size,
    getLastMessage: () => s.lastMessage,
    sendLog: s.sendLog,
    emitSyntheticSend: (msg) => ws.emit('message', Buffer.from(msg)),
    checkApiError: () => {
      const errContent = s.textAccum.trim() || s.stderrOutput.trim();
      return errContent && API_ERROR_RE.test(errContent) ? errContent : undefined;
    },
  });
  s.watchdog = watchdog;

  ws.on('close', () => {
    watchdog.state.active = false;
    clearInterval(watchdog.interval);
    s.resetStaleTimer();
    if (s.currentProc) killProc(s.currentProc);
    login.kill();
  });

  ws.on('message', (data: Buffer) => {
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
      s.sessionId = undefined;
      if (s.currentProc) {
        const proc = s.currentProc;
        s.currentProc = undefined;
        s.currentProcKey = undefined;
        killProc(proc);
      }
      s.pendingBgTasks.clear();
      s.totalBgTasks = 0;
      ws.send(JSON.stringify({ type: 'clear' }));
    } else if (msg.type === 'send' && (msg.text || msg.images?.length)) {
      handleSend(s, msg);
    } else if (msg.type === 'getSettings') {
      ws.send(JSON.stringify({ type: 'settings', settings: readConfig() }));
    } else if (msg.type === 'restartDaemon') {
      // Browser-served UI: restart the daemon in place. No-op on the dev server.
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
        // Re-check live connections so a Network-access change applies at once
        // (e.g. turning it off disconnects remote clients without a restart).
        hooks.onSettingsChange?.();
      }
    } else if (msg.type === 'getInfo') {
      let version = '';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
        version = pkg.version ?? '';
      } catch {}
      ws.send(JSON.stringify({ type: 'workspaceInfo', path: workspaceDir, version, model: s.model, effort: s.effort, thinking: s.thinking }));
    } else if (msg.type === 'switchModel') {
      const newModel = typeof (msg as { model?: string }).model === 'string' ? (msg as { model?: string }).model! : '';
      s.model = newModel;
      const config = readConfig();
      writeConfig({ ...config, model: newModel });
      ws.send(JSON.stringify({ type: 'modelChanged', model: s.model }));
    } else if (msg.type === 'switchEffort') {
      const newEffort = typeof (msg as { effort?: string }).effort === 'string' ? (msg as { effort?: string }).effort! : 'high';
      s.effort = newEffort;
      writeConfig({ ...readConfig(), effort: newEffort });
      ws.send(JSON.stringify({ type: 'effortChanged', effort: s.effort }));
    } else if (msg.type === 'switchThinking') {
      const newThinking = (msg as { thinking?: boolean }).thinking !== false;
      s.thinking = newThinking;
      writeConfig({ ...readConfig(), thinking: newThinking });
      ws.send(JSON.stringify({ type: 'thinkingChanged', thinking: s.thinking }));
    } else if (msg.type === 'retry') {
      if (s.lastMessage) {
        s.sendLog('info', 'Retrying last message');
        ws.send(JSON.stringify({ type: 'retry_clean' }));
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'send', text: s.lastMessage.text, images: s.lastMessage.images, mode: s.lastMessage.mode, _silent: true,
        })));
      }
    } else if (msg.type === 'forceError') {
      if (s.currentProc) killProc(s.currentProc);
      ws.send(JSON.stringify({ type: 'error', text: 'Forced error (kill button)' }));
    } else if (msg.type === 'getSkills') {
      ws.send(JSON.stringify({ type: 'skills', skills: getSkills(workspaceDir) }));
    } else if (msg.type === 'login') {
      login.start(workspaceDir);
    } else if (msg.type === 'loginCode' && msg.text) {
      login.submitCode(msg.text);
    } else if (msg.type === 'toolAnswer') {
      handleToolAnswer(s, msg as { type: string; id?: string; answers?: unknown; mode?: string });
    } else if (msg.type === 'readFilePreview' && msg.path) {
      const result = readFilePreview(msg.path, workspaceDir);
      ws.send(JSON.stringify({ type: 'filePreview', ...result }));
    } else if (msg.type === 'getAccountUsage') {
      // Prefer the live usage API (all windows, immediately); fall back to
      // windows accumulated from streamed rate_limit_events if it is unavailable.
      const accountP = fetchAccountInfo();
      const usageP = fetchUsage(msg.force);
      // Phase 1: send account as soon as it resolves so the modal renders it
      // immediately (matching the official panel) instead of waiting on usage,
      // which can be slow or rate-limited. `usagePending` keeps the usage section
      // in a loading state. Registered before usageP's handler so it always wins
      // ordering when both resolve together.
      accountP.then((account) => {
        ws.send(JSON.stringify({ type: 'accountUsage', account, usagePending: true }));
      });
      // Phase 2: account + usage once usage resolves.
      Promise.all([accountP, usageP]).then(([account, usage]) => {
        const rateLimits = usage.windows.length > 0 ? usage.windows : Array.from(s.rateLimits.values());
        // Only surface the fetch error when there is no fallback data to show.
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
      // Fresh start: abandon the current turn, reset the session, and clear the
      // webview (same teardown as /clear so every newSession caller behaves the
      // same - the top-right New chat button, the error-block button, and the
      // argus.newSession command).
      s.sessionId = undefined;
      if (s.currentProc) {
        const proc = s.currentProc;
        s.currentProc = undefined;
        s.currentProcKey = undefined;
        killProc(proc);
      }
      s.pendingBgTasks.clear();
      s.totalBgTasks = 0;
      s.lastMessage = null;
      ws.send(JSON.stringify({ type: 'clear' }));
    } else if (msg.type === 'listSessions') {
      ws.send(JSON.stringify({ type: 'sessionList', sessions: listSessions(workspaceDir), currentId: s.sessionId }));
    } else if (msg.type === 'resumeSession' && msg.id) {
      handleResumeSession(s, msg.id);
    } else if (msg.type === 'deleteSession' && msg.id) {
      deleteSession(msg.id, workspaceDir);
      if (s.sessionId === msg.id) s.sessionId = undefined;
      ws.send(JSON.stringify({ type: 'sessionList', sessions: listSessions(workspaceDir), currentId: s.sessionId }));
    } else if (msg.type === 'renameSession' && msg.id && typeof msg.title === 'string') {
      renameSession(msg.id, workspaceDir, msg.title);
      ws.send(JSON.stringify({ type: 'sessionList', sessions: listSessions(workspaceDir), currentId: s.sessionId }));
    } else if (msg.type === 'listWorkspaces') {
      ws.send(JSON.stringify({ type: 'workspaceList', workspaces: listWorkspaces(), currentPath: workspaceDir }));
    } else if (msg.type === 'listAllSessions') {
      ws.send(JSON.stringify({ type: 'allSessionList', sessions: listAllSessions(), currentId: s.sessionId }));
    } else if (msg.type === 'listDir') {
      ws.send(JSON.stringify({ type: 'dirList', ...listDir(typeof msg.path === 'string' ? msg.path : undefined) }));
    }
  });
}

function handleSend(s: SessionState, msg: { text?: string; images?: Array<{ data: string; mediaType: string; name?: string }>; mode?: string; _silent?: boolean; _askResume?: boolean }) {
  const text = msg.text ?? '';
  const images = msg.images;

  // Mid-turn: write to stdin silently, CLI merges it into the active turn
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
    s.ws.send(JSON.stringify({ type: 'user_inject', text }));
    return;
  }

  if (!msg._silent) {
    s.ws.send(JSON.stringify({ type: 'message', message: { id: String(Date.now()), role: 'user', content: text, images } }));
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
    s.ws.send(JSON.stringify({ type: 'thinking_start', reused: canReuse }));
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

  s.ws.send(JSON.stringify({ type: 'tool_end', call: { id: answerId, name: tc?.name ?? 'AskUserQuestion', input: tc?.input ?? {}, result: content } }));
  s.sendLog('info', `Tool answer for ${answerId}: ${content.slice(0, 100)}`);

  if (s.pendingAskTools.size === 0 && s.sessionId && answers && Object.keys(answers).length > 0) {
    s.pendingFollowUp = { answers, toolId: answerId, mode: msg.mode };
    if (s.cliDone) s.flushAskFollowUp();
  } else {
    if (s.pendingAskTools.size === 0) s.suppressCliOutput = false;
    if (s.currentProc?.stdin?.writable) s.currentProc.stdin.end();
    if (s.pendingAskTools.size === 0 && s.cliDone) {
      setTimeout(() => s.ws.send(JSON.stringify({ type: 'done' })), 100);
    }
  }
}

// Switch the live session to a stored one: tear down any current proc (detaching
// first so its close handler stays quiet, like /clear), point sessionId at the
// chosen transcript so the next send spawns with `--resume`, and replay the
// stored conversation into the UI.
function handleResumeSession(s: SessionState, id: string) {
  if (s.currentProc) {
    const proc = s.currentProc;
    s.currentProc = undefined;
    s.currentProcKey = undefined;
    killProc(proc);
  }
  s.cliDone = false;
  s.userStopped = false;
  s.pendingBgTasks.clear();
  s.totalBgTasks = 0;
  s.lastMessage = null;
  s.sessionId = id;
  const messages = loadSession(id, s.workspaceDir);
  s.sendLog('info', `Resuming session ${id} (${plural(messages.length, 'message')})`);
  s.ws.send(JSON.stringify({ type: 'sessionLoaded', id, messages }));
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
    s.ws.send(JSON.stringify({ type: 'tool_end', call: { id: toolId, name: tc?.name ?? 'AskUserQuestion', input: tc?.input ?? {}, result: JSON.stringify({ cancelled: true }) } }));
  }
  s.pendingAskTools.clear();
  if (s.currentProc) {
    s.userStopped = true;
    killProc(s.currentProc);
  } else {
    s.ws.send(JSON.stringify({ type: 'done' }));
  }
}
