import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { ChatPanel } from './chat/ChatPanel';
import { ArgusCodeLensProvider } from './providers/CodeLensProvider';
import { InlineSuggestProvider } from './providers/InlineSuggestProvider';
import { getSelection } from './utils/workspace';
import { isInlineCompletionsEnabled, isCodeLensEnabled, getModel } from './utils/config';
import { startServer } from '../backend/index';
import type { ArgusServer } from '../backend/index';

let argusServer: ArgusServer | undefined;
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

export function getServerPort(): number | undefined {
  return argusServer?.port;
}

export function getServerNonce(): string | undefined {
  return argusServer?.nonce;
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

  // Start the WebSocket server on a dynamic port
  try {
    argusServer = await startServer({ port: 0, model: getModel() });
    console.log('[Argus] WebSocket server started on port', argusServer.port);
  } catch (err) {
    console.error('[Argus] Failed to start WebSocket server:', err);
  }

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
  if (argusServer) {
    argusServer.close();
    argusServer = undefined;
  }
}
