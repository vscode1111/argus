import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { ChatPanel } from './chat/ChatPanel';
import { ArgusCodeLensProvider } from './providers/CodeLensProvider';
import { InlineSuggestProvider } from './providers/InlineSuggestProvider';
import { getSelection } from './utils/workspace';
import { isInlineCompletionsEnabled, isCodeLensEnabled } from './utils/config';
import { readDaemonInfo, clearDaemonInfo, isProcessAlive, type DaemonInfo } from '../backend/daemonInfo';

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

// Auto-spawn: if no daemon is running, launch the compiled daemon windowless and
// detached so it outlives this extension host and self-exits when idle. Called when
// a panel needs a connection. The daemon's single-instance guard makes concurrent
// launches safe (a second one exits early); we also debounce here to avoid spawning
// a burst of short-lived processes while the first is still coming up.
let lastDaemonSpawn = 0;
function spawnDaemon(extensionPath: string, force: boolean): void {
  const daemonJs = path.join(extensionPath, 'out', 'backend', 'daemon.js');
  if (!fs.existsSync(daemonJs)) {
    console.error('[Argus] cannot start daemon: not found at', daemonJs, '(run `yarn compile`)');
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
    child.unref();
    console.log(force ? '[Argus] restarted daemon' : '[Argus] auto-started daemon');
  } catch (err) {
    console.error('[Argus] failed to start daemon:', err);
  }
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
// updated config (new port/idle). The webview's reconnect loop picks up the new
// port from the rewritten discovery file.
export function restartDaemon(extensionPath: string): void {
  const info = readDaemonInfo();
  if (info && isProcessAlive(info.pid)) {
    try {
      if (process.platform === 'win32') execFile('taskkill', ['/F', '/T', '/PID', String(info.pid)], () => { /* best-effort */ });
      else process.kill(info.pid);
    } catch { /* already gone */ }
  }
  clearDaemonInfo();
  lastDaemonSpawn = Date.now();
  // Let the OS release the port, then force-spawn (retries the port if needed).
  setTimeout(() => spawnDaemon(extensionPath, true), 300);
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
