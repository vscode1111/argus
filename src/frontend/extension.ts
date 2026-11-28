import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { ChatPanel } from './chat/ChatPanel';
import { ArgusCodeLensProvider } from './providers/CodeLensProvider';
import { InlineSuggestProvider } from './providers/InlineSuggestProvider';
import { getSelection } from './utils/workspace';
import { isInlineCompletionsEnabled, isCodeLensEnabled } from './utils/config';
import { readDaemonInfo, clearDaemonInfo, isProcessAlive, isDaemonUp, discoveryFile, type DaemonInfo } from '../backend/daemonInfo';
import { decideUpdateRestart } from './updateRestart';

let extensionId = 'local.argus';

// A toast click launches this protocol in a separate process. The helper dismisses
// Notification Center before switching to the VS Code window's virtual desktop.
export const FOCUS_PROTOCOL = 'argus-focus';

function registerFocusProtocol(extensionUri: vscode.Uri): void {
  if (process.platform !== 'win32') return;
  const helper = vscode.Uri.joinPath(extensionUri, 'media', 'argus-focus.exe').fsPath;
  const command = `"${helper}" "%1"`;
  const base = `HKCU\\Software\\Classes\\${FOCUS_PROTOCOL}`;
  const add = (args: string[]) => execFile('reg', args, () => { /* best-effort */ });
  add(['add', base, '/ve', '/d', 'URL:Argus Focus', '/f']);
  add(['add', base, '/v', 'URL Protocol', '/d', '', '/f']);
  add(['add', `${base}\\shell\\open\\command`, '/ve', '/d', command, '/f']);
}

// Connect-only: the extension does not host a server. It reads the daemon's
// discovery file (written by `server/daemon.ts`) fresh on every panel open and
// reconnect, so a daemon restart (new nonce/port) is picked up. Returns undefined
// when the daemon is not running, which drives the "daemon not running" panel state.
export function readDaemon(): DaemonInfo | undefined {
  const info = readDaemonInfo();
  // A hard-killed daemon leaves a stale discovery file with a dead pid. Treat that
  // as "no daemon" so ChatPanel.buildWsUrl falls through to ensureDaemon() and spawns
  // a fresh one, instead of baking a URL to a dead process and failing forever.
  if (info && !isProcessAlive(info.pid)) return undefined;
  return info;
}

// Daemon lifecycle log. Separate from ChatPanel's per-panel 'Argus' output channel
// because ensureDaemon is decoupled from any single panel (module-level, called from
// buildWsUrl on any panel's reconnect); logging here via console.log/error alone only
// reaches the Extension Host's dev console, which is not somewhere a user (or a future
// debugging agent) would think to look when the daemon silently fails to come back.
let daemonLog: vscode.OutputChannel | undefined;
function logDaemon(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (!daemonLog) daemonLog = vscode.window.createOutputChannel('Argus Daemon');
  daemonLog.appendLine(line);
}

// Auto-spawn: if no daemon is running, launch the compiled daemon windowless and
// detached so it outlives this extension host and self-exits when idle. Called when
// a panel needs a connection. The daemon's single-instance guard makes concurrent
// launches safe (a second one exits early); we also debounce here to avoid spawning
// a burst of short-lived processes while the first is still coming up.
let lastDaemonSpawn = 0;
let consecutiveFailures = 0;
let warnedUser = false;

function spawnDaemon(extensionPath: string, force: boolean): void {
  const daemonJs = path.join(extensionPath, 'out', 'backend', 'daemon.js');
  if (!fs.existsSync(daemonJs)) {
    logDaemon(`cannot start daemon: not found at ${daemonJs} (run \`yarn compile\`)`);
    onSpawnOutcome(extensionPath, false);
    return;
  }
  try {
    // process.execPath is the VS Code (Electron) binary; ELECTRON_RUN_AS_NODE makes
    // it behave as plain Node so we need no separate node install on PATH. force adds
    // ARGUS_DAEMON_FORCE_START so a restart's replacement skips the single-instance
    // guard and retries the port while the old one releases it.
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    if (force) env.ARGUS_DAEMON_FORCE_START = '1';
    const child = spawn(process.execPath, [daemonJs], {
      cwd: extensionPath,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env,
    });
    // If the daemon exits within 2s it failed to bind (port in use). Reset the
    // debounce so ensureDaemon() can try again on the next needWsUrl cycle.
    const spawnedAt = Date.now();
    child.once('exit', (code) => {
      if (Date.now() - spawnedAt < 2000) {
        logDaemon(`daemon exited immediately (code ${code}) - port likely in use; resetting debounce`);
        lastDaemonSpawn = 0;
      }
    });
    child.unref();
    logDaemon(force ? 'restarted daemon' : 'auto-started daemon');
    // Give it a few seconds to bind, then verify with a real TCP connect rather
    // than just trusting the discovery file it (should have) written - closes the
    // gap where isProcessAlive's pid heuristics misjudge staleness for any reason
    // and the extension retries forever with zero visible signal.
    setTimeout(() => { void verifyDaemonUp(extensionPath); }, 4000);
  } catch (err) {
    logDaemon(`failed to launch daemon process: ${err}`);
    onSpawnOutcome(extensionPath, false);
  }
}

async function verifyDaemonUp(extensionPath: string): Promise<void> {
  const info = readDaemonInfo();
  const up = !!info && await isDaemonUp(info);
  if (!up && info) {
    // A discovery file that fails verification is worse than none: it blocks every
    // future respawn attempt (both ours and the daemon's own single-instance guard
    // trust it at face value). Clear it so the next attempt starts clean.
    logDaemon(`daemon did not come up; discarding discovery file (pid ${info.pid}, port ${info.port})`);
    clearDaemonInfo(info.pid);
  }
  onSpawnOutcome(extensionPath, up);
}

function onSpawnOutcome(extensionPath: string, success: boolean): void {
  if (success) {
    consecutiveFailures = 0;
    warnedUser = false;
    return;
  }
  consecutiveFailures++;
  if (consecutiveFailures < 3 || warnedUser) return;
  warnedUser = true;
  const log = daemonLog;
  vscode.window.showErrorMessage(
    'Argus daemon failed to start automatically. See the "Argus Daemon" output channel for details.',
    'Show Log', 'Retry'
  ).then((choice) => {
    if (choice === 'Show Log') log?.show();
    if (choice === 'Retry') {
      consecutiveFailures = 0;
      warnedUser = false;
      lastDaemonSpawn = 0;
      ensureDaemon(extensionPath);
    }
  });
}

// Make sure a daemon is actually reachable, starting one if it is not. Called on
// every buildWsUrl (panel open and each needWsUrl reconnect), which is exactly when
// the answer matters and nothing else is going on.
//
// The liveness test is the port, not the pid. `isProcessAlive(info.pid)` used to be
// the whole check, and because it must accept `Code.exe` (the extension launches the
// daemon as Electron-as-node) any recycled pid landing on one of VS Code's many
// utility processes reads as "already running" - so this returned early, buildWsUrl
// handed the webview a URL to a dead port, and the reconnect loop retried that same
// dead URL forever with no way out: the post-spawn verifyDaemonUp that would have
// discarded the file only runs after a spawn, and the spawn never happened.
// Observed with a pid recycled 15h after the daemon died; the panel showed Server "-"
// and never recovered, including across VS Code restarts.
let healthCheckInFlight = false;
export async function ensureDaemon(extensionPath: string): Promise<void> {
  if (healthCheckInFlight) return;
  healthCheckInFlight = true;
  try {
    const info = readDaemonInfo();
    if (info) {
      if (await isDaemonUp(info)) return; // really there, and answering
      // The file points at nothing reachable. Discard it before spawning: both our
      // own check above and the daemon's single-instance guard trust it at face
      // value, so leaving it in place is what makes the failure permanent.
      logDaemon(`discovery file points at an unreachable daemon (pid ${info.pid}, port ${info.port}); discarding`);
      clearDaemonInfo(info.pid);
    }
    if (Date.now() - lastDaemonSpawn < 5000) return; // a spawn is likely still starting
    lastDaemonSpawn = Date.now();
    spawnDaemon(extensionPath, false);
  } finally {
    healthCheckInFlight = false;
  }
}

// Explicit restart (Settings "Apply" button in the VS Code panel): hard-kill the
// running daemon, clear its discovery file, then spawn a fresh one that reads the
// updated config (new port/idle). The FORCE_START flag already handles EADDRINUSE
// with up to 25 retries (5s), so no port check here - a premature check would
// falsely fail when Windows hasn't released the port yet and silently overwrite
// the configured port with a default. The webview's reconnect loop picks up the
// new port from the rewritten discovery file.
export async function restartDaemon(extensionPath: string): Promise<void> {
  const info = readDaemonInfo();
  // Confirm the recorded pid is really our daemon before force-killing it. A pid
  // alone is not evidence: a recycled one belonging to a VS Code utility process
  // passes isProcessAlive, and `taskkill /F /T` on that would take down part of the
  // user's editor to "restart the daemon" (the tree flag makes it worse). The port
  // probe is what tells the two apart, so a file that answers nothing is simply
  // cleared and replaced rather than killed.
  const ours = !!info && await isDaemonUp(info);
  // Ownership-aware, like every other clear: drop only the registration we just read.
  // An unconditional clear deletes whatever is there *now*, and between the read above
  // and this line that can be a different daemon's file - including the one a daemon
  // whose registration went missing has just re-asserted. Deleting a live daemon's file
  // is the permanent strand healRegistration() in daemon.ts exists to undo, so this
  // path must not be a way of creating it.
  if (info) clearDaemonInfo(info.pid);
  lastDaemonSpawn = Date.now();
  const afterKill = () => { setTimeout(() => { spawnDaemon(extensionPath, true); }, 300); };
  if (info && ours) {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/F', '/T', '/PID', String(info.pid)], afterKill);
    } else {
      try { process.kill(info.pid); } catch { /* already gone */ }
      afterKill();
    }
  } else {
    afterKill();
  }
}

// Self-restart after an update. Installing a VSIX leaves every open window on the old
// extension host ("Restart Required") until its extensions restart, and VS Code offers
// no CLI hook to do that from outside. Each window therefore watches the daemon
// registration: when a newer daemon is serving and that version is installed next to
// this one, it restarts its own extension host (see updateRestart.ts for the guards).
// A restart also restarts the window's other extensions, so `auto` shows a cancellable
// countdown first; `prompt` asks; `off` leaves it to the user.
const UPDATE_ATTEMPTS_KEY = 'argus.updateRestartAttempts';
// Wait after the registration changes so the target-first handover finishes (the old
// daemon is still being stopped for a few seconds after the new one registers).
const UPDATE_SETTLE_MS = 8000;
const UPDATE_INITIAL_CHECK_MS = 15000;
const UPDATE_COUNTDOWN_S = 10;
let updateCheckRunning = false;

// One attempt per window per target. Keyed by workspace because globalState is shared
// by every window: a single key would let the first window's restart suppress the rest.
function windowKey(): string {
  return vscode.workspace.workspaceFile?.toString()
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString()
    ?? 'no-folder';
}

async function confirmUpdateRestart(mode: string, own: string, target: string): Promise<boolean> {
  const what = `Argus ${target} is installed and serving; this window still runs ${own}.`;
  if (mode === 'prompt') {
    const choice = await vscode.window.showInformationMessage(
      `${what} Restart extensions to load it? This also restarts the window's other extensions.`,
      'Restart Extensions', 'Later');
    return choice === 'Restart Extensions';
  }
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Argus update',
    cancellable: true,
  }, async (progress, token) => {
    for (let left = UPDATE_COUNTDOWN_S; left > 0; left--) {
      if (token.isCancellationRequested) return false;
      progress.report({ message: `${what} Restarting extensions in ${left}s (this also restarts other extensions in this window).` });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return !token.isCancellationRequested;
  });
}

async function checkForUpdateRestart(context: vscode.ExtensionContext): Promise<void> {
  if (updateCheckRunning) return;
  const mode = vscode.workspace.getConfiguration('argus').get<string>('restartOnUpdate', 'auto');
  if (mode === 'off') return;
  updateCheckRunning = true;
  try {
    const own = String(context.extension.packageJSON.version ?? '');
    const attempts = context.globalState.get<Record<string, string>>(UPDATE_ATTEMPTS_KEY, {});
    const key = windowKey();
    const decision = decideUpdateRestart({
      extensionId: context.extension.id,
      ownVersion: own,
      extensionPath: context.extensionPath,
      daemonVersion: readDaemon()?.version,
      development: context.extensionMode !== vscode.ExtensionMode.Production,
      attemptedTarget: attempts[key],
    });
    if (!decision.restart) return;
    // Recorded before asking, so a cancelled countdown is not shown again on every
    // registration change; the manual button below still offers the restart.
    await context.globalState.update(UPDATE_ATTEMPTS_KEY, { ...attempts, [key]: decision.target });
    if (!await confirmUpdateRestart(mode, own, decision.target)) {
      logDaemon(`update restart to ${decision.target} declined (running ${own})`);
      if (mode === 'auto') {
        void vscode.window.showInformationMessage(
          `Argus ${decision.target} is installed; this window still runs ${own}.`, 'Restart Extensions')
          .then((choice) => {
            if (choice) void vscode.commands.executeCommand('workbench.action.restartExtensionHost');
          });
      }
      return;
    }
    logDaemon(`restarting extension host to load Argus ${decision.target} (running ${own})`);
    await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
  } catch (err) {
    logDaemon(`update restart check failed: ${err}`);
  } finally {
    updateCheckRunning = false;
  }
}

function watchForUpdates(context: vscode.ExtensionContext): void {
  if (context.extensionMode !== vscode.ExtensionMode.Production) return;
  const file = discoveryFile();
  let pending: NodeJS.Timeout | undefined;
  const schedule = (delay: number) => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = undefined; void checkForUpdateRestart(context); }, delay);
  };
  // watchFile polls, so it also notices a file that is deleted and written again by
  // the next daemon, which fs.watch handles unreliably on Windows.
  const listener = (curr: fs.Stats, prev: fs.Stats) => {
    if (curr.mtimeMs !== prev.mtimeMs) schedule(UPDATE_SETTLE_MS);
  };
  fs.watchFile(file, { interval: 5000, persistent: false }, listener);
  schedule(UPDATE_INITIAL_CHECK_MS);
  context.subscriptions.push({ dispose: () => { fs.unwatchFile(file, listener); if (pending) clearTimeout(pending); } });
}

/** Extension id (publisher.name), used to build the `vscode://` toast click-to-focus URI. */
export function getExtensionId(): string {
  return extensionId;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionId = context.extension.id;

  // Focus a chat panel when a notification toast is clicked. The argus-focus://
  // protocol runs a fresh, foreground-righted helper that switches to the VS Code
  // window (a background process can't switch virtual desktops). The vscode://<id>/
  // focus URI handler is a secondary path for the installed stable instance.
  registerFocusProtocol(context.extensionUri);
  watchForUpdates(context);
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        if (uri.path === '/focus') ChatPanel.revealForActivation(context.extensionUri);
      },
    })
  );

  const codeLensProvider = new ArgusCodeLensProvider();
  let codeLensDisposable: vscode.Disposable | undefined;
  let inlineSuggestDisposable: vscode.Disposable | undefined;

  function registerCodeLens(): void {
    codeLensDisposable?.dispose();
    codeLensDisposable = undefined;
    if (isCodeLensEnabled()) {
      codeLensDisposable = vscode.languages.registerCodeLensProvider('*', codeLensProvider);
    }
  }

  function registerInlineCompletions(): void {
    inlineSuggestDisposable?.dispose();
    inlineSuggestDisposable = undefined;
    if (isInlineCompletionsEnabled()) {
      inlineSuggestDisposable = vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' },
        new InlineSuggestProvider()
      );
    }
  }

  registerCodeLens();
  registerInlineCompletions();

  // Clean up dynamic disposables on deactivation
  context.subscriptions.push({ dispose: () => { codeLensDisposable?.dispose(); inlineSuggestDisposable?.dispose(); } });

  // Re-register when settings change
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('argus.codeLens')) registerCodeLens();
    if (e.affectsConfiguration('argus.inlineCompletions')) registerInlineCompletions();
  }, null, context.subscriptions);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('argus.openChat', () => {
      ChatPanel.createNew(context.extensionUri);
    }),
    vscode.commands.registerCommand('argus.openAgents', () => {
      ChatPanel.createNew(context.extensionUri, 'agents');
    }),

    vscode.commands.registerCommand('argus.newSession', () => {
      const panel = ChatPanel.focusOrCreate(context.extensionUri);
      panel.newSession();
    }),

    vscode.commands.registerCommand('argus.askSelection', (args?: { line?: number; context?: string }) => {
      const panel = ChatPanel.focusOrCreate(context.extensionUri);
      let text = '';

      if (args?.context) {
        text = `Explain this code:\n\`\`\`\n${args.context}\n\`\`\`\n`;
      } else {
        const selection = getSelection();
        if (selection) {
          text = `Explain this code from ${selection.file} (line ${selection.startLine}):\n\`\`\`\n${selection.text}\n\`\`\`\n`;
        }
      }

      if (text) panel.sendWithContext(text);
    }),

    vscode.commands.registerCommand('argus.editSelection', () => {
      const panel = ChatPanel.focusOrCreate(context.extensionUri);
      const selection = getSelection();
      if (!selection) {
        vscode.window.showInformationMessage('Select some code first');
        return;
      }
      const prefix = `Edit this code from ${selection.file} (line ${selection.startLine}):\n\`\`\`\n${selection.text}\n\`\`\`\n\nChange: `;
      panel.sendWithContext(prefix);
    }),

    vscode.commands.registerCommand('argus.sendPath', (uri?: vscode.Uri) => {
      if (!uri) return;
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const filePath = root ? path.relative(root, uri.fsPath) : uri.fsPath;
      // Prefix with "@" so the Claude CLI treats it as a file/dir reference (and pulls in its
      // content) rather than plain text; "@" mentions are parsed with forward slashes.
      const mention = '@' + filePath.replace(/\\/g, '/');
      const panel = ChatPanel.focusOrCreate(context.extensionUri);
      panel.sendWithContext(mention + ' ');
    }),

    vscode.commands.registerCommand('argus.reviewSelection', () => {
      const panel = ChatPanel.focusOrCreate(context.extensionUri);
      const selection = getSelection();
      if (!selection) {
        vscode.window.showInformationMessage('Select some code first');
        return;
      }
      const prefix = `Review this code from ${selection.file} (line ${selection.startLine}):\n\`\`\`\n${selection.text}\n\`\`\`\n\nCheck for bugs, security issues, and improvements.`;
      panel.sendWithContext(prefix);
    })
  );
}

export function deactivate(): void {
  // Connect-only: nothing to tear down. The shared daemon self-exits when idle.
}
