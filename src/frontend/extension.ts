import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { ChatPanel } from './chat/ChatPanel';
import { ArgusCodeLensProvider } from './providers/CodeLensProvider';
import { InlineSuggestProvider } from './providers/InlineSuggestProvider';
import { getSelection } from './utils/workspace';
import { isInlineCompletionsEnabled, isCodeLensEnabled } from './utils/config';
import { readDaemonInfo, clearDaemonInfo, isProcessAlive, isPortListening, type DaemonInfo } from '../backend/daemonInfo';

let extensionId = 'local.argus';

// Toast click-to-focus delivery. A clicked toast can only launch a URI, and the
// background extension host cannot switch virtual desktops (only a process holding
// foreground/input rights can). So the toast launches `argus-focus://` -> a
// windowless launcher (argus-focus.vbs) that runs argus-focus-switch.ps1; that
// freshly-spawned, foreground-righted helper does the actual SwitchToThisWindow.
export const FOCUS_PROTOCOL = 'argus-focus';

function registerFocusProtocol(extensionUri: vscode.Uri): void {
  if (process.platform !== 'win32') return;
  const vbs = vscode.Uri.joinPath(extensionUri, 'media', 'argus-focus.vbs').fsPath;
  const ps1 = vscode.Uri.joinPath(extensionUri, 'media', 'argus-focus-switch.ps1').fsPath;
  // vbs (windowless) runs the focus PowerShell passed as arg 0; %1 (the URI) is ignored.
  const command = `wscript.exe "${vbs}" "${ps1}" "%1"`;
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
  const up = !!info && isProcessAlive(info.pid) && await isPortListening(info.port);
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

export function ensureDaemon(extensionPath: string): void {
  const info = readDaemonInfo();
  if (info && isProcessAlive(info.pid)) return; // already running
  if (Date.now() - lastDaemonSpawn < 5000) return; // a spawn is likely still starting
  lastDaemonSpawn = Date.now();
  spawnDaemon(extensionPath, false);
}

// Explicit restart (Settings "Apply" button in the VS Code panel): hard-kill the
// running daemon, clear its discovery file, then spawn a fresh one that reads the
// updated config (new port/idle). The FORCE_START flag already handles EADDRINUSE
// with up to 25 retries (5s), so no port check here - a premature check would
// falsely fail when Windows hasn't released the port yet and silently overwrite
// the configured port with a default. The webview's reconnect loop picks up the
// new port from the rewritten discovery file.
export function restartDaemon(extensionPath: string): void {
  const info = readDaemonInfo();
  clearDaemonInfo();
  lastDaemonSpawn = Date.now();
  const afterKill = () => { setTimeout(() => { spawnDaemon(extensionPath, true); }, 300); };
  if (info && isProcessAlive(info.pid)) {
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
