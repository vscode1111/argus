import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentSession } from '../agent/AgentSession';
import { ChatMessage, createUserMessage, createAssistantMessage } from './ChatMessage';

export class ChatPanel {
  public static current: ChatPanel | undefined;
  private static readonly viewType = 'argusChat';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly outputChannel: vscode.OutputChannel;
  private messages: ChatMessage[] = [];
  private session: AgentSession;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.outputChannel = vscode.window.createOutputChannel('Argus');
    this.session = new AgentSession(this.outputChannel);

    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(this.onWebviewMessage.bind(this), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(extensionUri: vscode.Uri): ChatPanel {
    const column = vscode.ViewColumn.Beside;
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(column);
      return ChatPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      'Argus',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    ChatPanel.current = new ChatPanel(panel, extensionUri);
    return ChatPanel.current;
  }

  public sendWithContext(prefix: string): void {
    this.panel.reveal();
    this.post({ type: 'prefill', text: prefix });
  }

  public newSession(): void {
    this.messages = [];
    this.session.reset();
    this.post({ type: 'clear' });
  }

  private async onWebviewMessage(msg: { type: string; text?: string; path?: string }): Promise<void> {
    console.log('[Argus] onWebviewMessage:', JSON.stringify(msg));
    if (msg.type === 'send' && msg.text) {
      await this.handleUserMessage(msg.text);
    } else if (msg.type === 'stop') {
      this.session.abort();
    } else if (msg.type === 'forceError') {
      this.session.abort();
      this.post({ type: 'error', text: 'Process killed manually' });
      this.post({ type: 'done' });
      this.showError('Claude Code process exited with code 3221226505');
    } else if (msg.type === 'newSession') {
      this.newSession();
    } else if (msg.type === 'openFile' && msg.path) {
      const uri = vscode.Uri.file(msg.path);
      vscode.window.showTextDocument(uri, { preview: true, viewColumn: vscode.ViewColumn.One });
    }
  }

  private async handleUserMessage(text: string): Promise<void> {
    console.log('[Argus] handleUserMessage:', text);
    const userMsg = createUserMessage(text);
    this.messages.push(userMsg);
    this.post({ type: 'message', message: userMsg });
    this.post({ type: 'thinking_start' });

    const systemPrompt = this.buildSystemPrompt();
    let responseText = '';
    let thinkingText = '';
    const toolCalls: { name: string; input?: unknown; result?: string }[] = [];

    try {
      for await (const event of this.session.send(text, systemPrompt)) {
        switch (event.type) {
          case 'thinking':
            thinkingText += event.text;
            this.post({ type: 'thinking_chunk', text: event.text });
            break;

          case 'text':
            responseText += event.text;
            this.post({ type: 'text_chunk', text: event.text });
            break;

          case 'tool_start':
            toolCalls.push({ name: event.name, input: event.input });
            this.post({ type: 'tool_start', call: { id: String(toolCalls.length), name: event.name, input: event.input ?? {} } });
            break;

          case 'tool_end': {
            const last = toolCalls[toolCalls.length - 1];
            if (last) last.result = event.result;
            this.post({ type: 'tool_end', call: { id: String(toolCalls.length), name: last?.name ?? '', input: last?.input ?? {}, result: event.result } });
            break;
          }

          case 'result':
            // Claude Code sends final result - use it as the definitive response text
            if (!responseText) responseText = event.text;
            break;

          case 'error':
            this.post({ type: 'error', text: event.message });
            this.showError(event.message);
            break;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', text: errMsg });
      this.showError(errMsg);
    }

    if (responseText) {
      this.messages.push(createAssistantMessage(responseText, { thinking: thinkingText || undefined }));
    }

    this.post({ type: 'done' });
  }

  private buildSystemPrompt(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
    return [
      'You are Argus, an AI coding assistant integrated into VS Code.',
      root ? `Workspace root: ${root}` : '',
      activeFile ? `Active file: ${activeFile}` : '',
      'Be concise. When editing files, prefer Edit over Write for existing files.',
    ].filter(Boolean).join('\n');
  }

  private showError(message: string): void {
    this.outputChannel.appendLine(`[Error] ${message}`);
    vscode.window.showErrorMessage(`Argus: ${message}`, 'View Output')
      .then(action => { if (action === 'View Output') { this.outputChannel.show(); } });
  }

  private post(data: unknown): void {
    this.panel.webview.postMessage(data);
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const mediaPath = vscode.Uri.joinPath(this.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'webview.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'webview.js'));
    const nonce = getNonce();

    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'chat.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');
    html = html
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace('{{cssUri}}', cssUri.toString())
      .replace('{{jsUri}}', jsUri.toString())
      .replace('{{cspSource}}', webview.cspSource);
    return html;
  }

  private dispose(): void {
    ChatPanel.current = undefined;
    this.panel.dispose();
    this.outputChannel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible[Math.floor(Math.random() * possible.length)];
  return text;
}
