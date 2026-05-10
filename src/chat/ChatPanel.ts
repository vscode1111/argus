import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { captureForegroundWindow, focusCachedWindow } from '../utils/win32Focus';
import { getServerPort } from '../extension';

export class ChatPanel {
  private static readonly panels = new Set<ChatPanel>();
  private static lastFocused: ChatPanel | undefined;
  private static readonly viewType = 'argusChat';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly outputChannel: vscode.OutputChannel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.outputChannel = vscode.window.createOutputChannel('Argus');

    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(this.onWebviewMessage.bind(this), null, this.disposables);
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
    if (ChatPanel.lastFocused) {
      ChatPanel.lastFocused.panel.reveal(undefined, true);
      return ChatPanel.lastFocused;
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

  private async onWebviewMessage(msg: { type: string; path?: string; line?: number; url?: string }): Promise<void> {
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
      try {
        const content = fs.readFileSync(msg.path, 'utf-8');
        this.post({ type: 'filePreview', path: msg.path, content });
      } catch (err) {
        this.outputChannel.appendLine(`[Error] Cannot read file: ${msg.path}`);
      }
    } else if (msg.type === 'focusPanel') {
      this.outputChannel.appendLine(`[${new Date().toISOString()}] focusPanel received`);
      focusCachedWindow((text) => this.outputChannel.appendLine(`[${new Date().toISOString()}] ${text}`));
      this.panel.reveal(undefined, false);
    }
  }

  private post(data: object): void {
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
