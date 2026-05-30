import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { captureForegroundWindow, focusCachedWindow } from '../utils/win32Focus';
import { copyImageToClipboard } from '../utils/win32Clipboard';

import { getServerPort } from '../extension';

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

  public sendWithContext(prefix: string): void {
    this.panel.reveal();
    this.post({ type: 'prefill', text: prefix });
  }

  public newSession(): void {
    this.post({ type: 'newSession' }); // shim forwards to WS (kills proc, resets session)
    this.post({ type: 'clear' }); // App.tsx dispatches clear (clears UI immediately)
  }

  private async onWebviewMessage(msg: { type: string; path?: string; line?: number; url?: string; data?: string; mediaType?: string; active?: boolean; outcome?: string }): Promise<void> {
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
      const filePath = path.isAbsolute(msg.path) ? msg.path : path.resolve(root, msg.path);
      const resolved = path.resolve(filePath);
      if (!path.isAbsolute(msg.path) && !resolved.startsWith(root + path.sep) && resolved !== root) {
        return;
      }
      try {
        const ext = path.extname(filePath).toLowerCase();
        const imageExts: Record<string, string> = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
          '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
          '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff',
        };
        const mime = imageExts[ext];
        if (mime) {
          const base64 = fs.readFileSync(filePath).toString('base64');
          this.post({ type: 'filePreview', path: filePath, content: `data:${mime};base64,${base64}` });
        } else {
          const content = fs.readFileSync(filePath, 'utf-8');
          this.post({ type: 'filePreview', path: filePath, content });
        }
      } catch (err) {
        this.outputChannel.appendLine(`[Error] Cannot read file: ${filePath}`);
      }
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
    } else if (msg.type === 'focusPanel') {
      this.outputChannel.appendLine(`[${new Date().toISOString()}] focusPanel received`);
      focusCachedWindow((text) => this.outputChannel.appendLine(`[${new Date().toISOString()}] ${text}`));
      this.panel.reveal(undefined, false);
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

  private getHtml(): string {
    const webview = this.panel.webview;
    const mediaPath = vscode.Uri.joinPath(this.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'webview.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'webview.js'));
    const nonce = getNonce();

    const port = getServerPort();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const wsUrl = port ? `ws://localhost:${port}/agent${root ? '?dir=' + encodeURIComponent(root) : ''}` : '';

    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'chat.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');
    html = html
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace('{{cssUri}}', cssUri.toString())
      .replace('{{jsUri}}', jsUri.toString())
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
