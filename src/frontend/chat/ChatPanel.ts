import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { captureForegroundWindow, focusCachedWindow, focusDiag } from '../utils/win32Focus';
import { copyImageToClipboard } from '../utils/win32Clipboard';
import { showWindowsToast } from '../utils/win32Toast';

import { readDaemon, ensureDaemon, restartDaemon, FOCUS_PROTOCOL } from '../extension';
import { readFilePreview } from '../../backend/filePreview';

export class ChatPanel {
  private static readonly panels = new Set<ChatPanel>();
  private static lastFocused: ChatPanel | undefined;
  private static readonly viewType = 'argusChat';
  private static readonly PULSE_OPACITIES = [1, 0.85, 0.65, 0.45, 0.3, 0.2, 0.1, 0.2, 0.3, 0.45, 0.65, 0.85];
  private static pulseFrameUris: vscode.Uri[] = [];

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly outputChannel: vscode.OutputChannel;
  private disposables: vscode.Disposable[] = [];
  private webviewReady = false;
  private pendingMessages: object[] = [];
  private spinInterval?: ReturnType<typeof setInterval>;
  private spinFrame = 0;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.outputChannel = vscode.window.createOutputChannel('Argus');

    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'webviewReady') {
        this.webviewReady = true;
        for (const m of this.pendingMessages) this.panel.webview.postMessage(m);
        this.pendingMessages = [];
        return;
      }
      this.onWebviewMessage(msg);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) ChatPanel.lastFocused = this;
    }, null, this.disposables);
    captureForegroundWindow();
  }

  public static createNew(extensionUri: vscode.Uri): ChatPanel {
    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      'Argus',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'argus-icon.svg');
    const instance = new ChatPanel(panel, extensionUri);
    ChatPanel.panels.add(instance);
    ChatPanel.lastFocused = instance;
    return instance;
  }

  public static focusOrCreate(extensionUri: vscode.Uri): ChatPanel {
    const target = ChatPanel.lastFocused ?? ChatPanel.panels.values().next().value;
    if (target) {
      target.panel.reveal(undefined, true);
      ChatPanel.lastFocused = target;
      return target;
    }
    return ChatPanel.createNew(extensionUri);
  }

  /** Reveal the last-focused panel and take focus (used by the toast click-to-focus URI handler). */
  public static revealForActivation(extensionUri: vscode.Uri): ChatPanel {
    const target = ChatPanel.lastFocused ?? ChatPanel.panels.values().next().value;
    focusDiag(`revealForActivation: panels=${ChatPanel.panels.size} hasTarget=${!!target}`);
    if (target) {
      // Bring the VS Code OS window forward first - this crosses virtual desktops,
      // which neither panel.reveal() nor the vscode:// protocol launch do on their own.
      focusCachedWindow((t) => target.outputChannel.appendLine(`[${new Date().toISOString()}] ${t}`));
      target.panel.reveal(undefined, false); // preserveFocus=false: focus the panel
      ChatPanel.lastFocused = target;
      return target;
    }
    return ChatPanel.createNew(extensionUri);
  }

  public sendWithContext(prefix: string): void {
    this.panel.reveal();
    this.post({ type: 'prefill', text: prefix });
  }

  public newSession(): void {
    this.post({ type: 'newSession' }); // shim forwards to WS (kills proc, resets session)
    this.post({ type: 'clear' }); // App.tsx dispatches clear (clears UI immediately)
  }

  private async onWebviewMessage(msg: { type: string; path?: string; line?: number; url?: string; data?: string; mediaType?: string; active?: boolean; outcome?: string; title?: string; body?: string }): Promise<void> {
    if (msg.type === 'openFile' && msg.path) {
      const uri = vscode.Uri.file(msg.path);
      const opts: vscode.TextDocumentShowOptions = { preview: true, viewColumn: vscode.ViewColumn.One };
      if (typeof msg.line === 'number') {
        const pos = new vscode.Position(Math.max(0, msg.line - 1), 0);
        opts.selection = new vscode.Range(pos, pos);
      }
      vscode.window.showTextDocument(uri, opts);
    } else if (msg.type === 'openUrl' && msg.url) {
      vscode.env.openExternal(vscode.Uri.parse(msg.url));
    } else if (msg.type === 'getInfo') {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const version = vscode.extensions.getExtension('local.argus')?.packageJSON?.version ?? '';
      this.post({ type: 'workspaceInfo', path: root, version });
    } else if (msg.type === 'readFilePreview' && msg.path) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const result = readFilePreview(msg.path, root);
      this.post({ type: 'filePreview', ...result });
    } else if (msg.type === 'copyImage' && msg.data) {
      const tmp = path.join(os.tmpdir(), `argus-clip-${Date.now()}.png`);
      try {
        fs.writeFileSync(tmp, Buffer.from(msg.data, 'base64'));
        const success = copyImageToClipboard(tmp);
        this.post({ type: 'copyImageResult', success });
      } catch {
        this.post({ type: 'copyImageResult', success: false });
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    } else if (msg.type === 'streamingState') {
      if (msg.active) this.startSpin();
      else this.stopSpin(msg.outcome);
    } else if (msg.type === 'restartDaemon') {
      // Settings "Apply": restart the daemon so a new port/idle config takes effect.
      // The webview's reconnect loop then picks up the new port from the discovery file.
      restartDaemon(this.extensionUri.fsPath);
    } else if (msg.type === 'needWsUrl') {
      // The webview lost (or never had) its connection and is asking for a fresh
      // daemon URL. The webview CSP blocks HTTP, so it cannot re-resolve the nonce
      // itself - only the extension can read the discovery file. Reply with the
      // current URL (empty if the daemon is still down) so the bridge reconnects or
      // shows the "daemon not running" state.
      this.post({ type: 'wsUrl', url: this.buildWsUrl() });
    } else if (msg.type === 'focusPanel') {
      this.outputChannel.appendLine(`[${new Date().toISOString()}] focusPanel received`);
      focusCachedWindow((text) => this.outputChannel.appendLine(`[${new Date().toISOString()}] ${text}`));
      this.panel.reveal(undefined, false);
    } else if (msg.type === 'notify') {
      // The webview Notification API can't reach the OS from inside a VS Code
      // webview, so the webview routes here. On Windows we fire a real OS toast
      // (shows even when VS Code isn't focused); clicking it activates the
      // `argus-focus://` protocol, whose windowless helper drops a signal file that
      // this extension host watches and turns into an in-process focus (see
      // registerFocusProtocol/watchFocusSignal in extension.ts). Elsewhere we fall
      // back to an in-VS Code notification with an "Open" action.
      const title = msg.title || 'Argus';
      const body = msg.body || '';
      const log = (t: string) => this.outputChannel.appendLine(`[${new Date().toISOString()}] ${t}`);
      const focusUri = `${FOCUS_PROTOCOL}://focus`;
      const toastShown = process.platform === 'win32' && showWindowsToast(title, body, log, focusUri);
      if (!toastShown) {
        const text = body ? `${title}: ${body}` : title;
        vscode.window.showInformationMessage(text, 'Open').then((action) => {
          if (action === 'Open') {
            focusCachedWindow(log);
            this.panel.reveal(undefined, false);
          }
        });
      }
    }
  }

  private static readonly OUTCOME_ICONS: Record<string, string> = {
    success: 'argus-icon-success.svg',
    error: 'argus-icon-error.svg',
    stopped: 'argus-icon-stopped.svg',
    retried: 'argus-icon-retried.svg',
  };

  private static ensurePulseFrames(): void {
    if (ChatPanel.pulseFrameUris.length > 0) return;
    const tmpDir = os.tmpdir();
    for (let i = 0; i < ChatPanel.PULSE_OPACITIES.length; i++) {
      const op = ChatPanel.PULSE_OPACITIES[i];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#3794ff" stroke-width="2" opacity="${op}"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>`;
      const filePath = path.join(tmpDir, `argus-pulse-${i}.svg`);
      fs.writeFileSync(filePath, svg);
      ChatPanel.pulseFrameUris.push(vscode.Uri.file(filePath));
    }
  }

  private startSpin(): void {
    if (this.spinInterval) return;
    ChatPanel.ensurePulseFrames();
    this.spinFrame = 0;
    this.panel.iconPath = ChatPanel.pulseFrameUris[0];
    this.spinInterval = setInterval(() => {
      this.spinFrame = (this.spinFrame + 1) % ChatPanel.pulseFrameUris.length;
      this.panel.iconPath = ChatPanel.pulseFrameUris[this.spinFrame];
    }, 200);
  }

  private stopSpin(outcome?: string): void {
    if (this.spinInterval) {
      clearInterval(this.spinInterval);
      this.spinInterval = undefined;
    }
    const iconFile = (outcome && ChatPanel.OUTCOME_ICONS[outcome]) || 'argus-icon.svg';
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', iconFile);
  }

  private post(data: object): void {
    if (!this.webviewReady) {
      this.pendingMessages.push(data);
      return;
    }
    this.panel.webview.postMessage(data);
  }

  // Resolve the daemon's connection URL fresh from its discovery file. Empty when
  // the daemon is not running (drives the "daemon not running" state in chat.html).
  // Re-read on every call so a daemon restart (new port/nonce) is picked up.
  private buildWsUrl(): string {
    const info = readDaemon();
    if (!info) {
      // Daemon not running - launch it. It writes its discovery file once listening;
      // the webview's overlay retry loop (needWsUrl) then re-reads it and connects.
      ensureDaemon(this.extensionUri.fsPath);
      return '';
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const wsParams = new URLSearchParams();
    wsParams.set('nonce', info.nonce);
    if (root) wsParams.set('dir', root);
    return `ws://localhost:${info.port}/agent?${wsParams.toString()}`;
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const mediaPath = vscode.Uri.joinPath(this.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'webview.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'webview.js'));
    const wsBridgeUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'ws-bridge.js'));
    const nonce = getNonce();
    const wsUrl = this.buildWsUrl();

    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'chat.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');
    html = html
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace('{{cssUri}}', cssUri.toString())
      .replace('{{jsUri}}', jsUri.toString())
      .replace('{{wsBridgeUri}}', wsBridgeUri.toString())
      .replace('{{cspSource}}', webview.cspSource)
      .replace('{{wsUrl}}', wsUrl);
    return html;
  }

  private dispose(): void {
    this.stopSpin();
    ChatPanel.panels.delete(this);
    if (ChatPanel.lastFocused === this) {
      ChatPanel.lastFocused = ChatPanel.panels.values().next().value;
    }
    this.panel.dispose();
    this.outputChannel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}
