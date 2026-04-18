import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AgentSession, ErrorKind, LoginResult } from '../agent/AgentSession';
import { ChatMessage, ImageAttachment, createUserMessage, createAssistantMessage } from './ChatMessage';

type WebviewMessage =
  | { type: 'message'; message: ChatMessage }
  | { type: 'thinking_start' }
  | { type: 'thinking_chunk'; text: string }
  | { type: 'text_chunk'; text: string }
  | { type: 'tool_start'; call: { id: string; name: string; input: unknown } }
  | { type: 'tool_end'; call: { id: string; name: string; input: unknown; result?: string } }
  | { type: 'done' }
  | { type: 'error'; text: string; errorKind?: ErrorKind }
  | { type: 'clear' }
  | { type: 'prefill'; text: string }
  | { type: 'workspaceInfo'; path: string }
  | { type: 'skills'; skills: { name: string; scope: 'global' | 'project' | 'builtin' }[] }
  | { type: 'log'; level: string; text: string; timestamp: string }
  | { type: 'contextUsage'; percent: number; inputTokens: number; outputTokens: number }
  | { type: 'loginUrl'; url: string }
  | { type: 'loginResult'; success: boolean; message?: string };

export class ChatPanel {
  public static current: ChatPanel | undefined;
  private static readonly viewType = 'argusChat';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly outputChannel: vscode.OutputChannel;
  private messages: ChatMessage[] = [];
  private session: AgentSession;
  private disposables: vscode.Disposable[] = [];
  private lastUserText: string = '';
  private lastUserImages: ImageAttachment[] | undefined;
  private loginSubmitCode: ((code: string) => Promise<boolean>) | undefined;
  private activeToolCalls: { id: string; name: string; input?: unknown; result?: string }[] = [];
  private turnInputTokens = 0;
  private turnOutputTokens = 0;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.outputChannel = vscode.window.createOutputChannel('Argus');
    this.session = new AgentSession(this.outputChannel, (level, text) => {
      this.post({ type: 'log', level, text, timestamp: new Date().toISOString() });
    });

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
    this.turnInputTokens = 0;
    this.turnOutputTokens = 0;
    this.post({ type: 'clear' });
  }

  private async onWebviewMessage(msg: { type: string; text?: string; path?: string; url?: string; images?: ImageAttachment[]; mode?: 'plan' | 'edit' }): Promise<void> {
    console.log('[Argus] onWebviewMessage:', JSON.stringify({ ...msg, images: msg.images ? `[${msg.images.length} images]` : undefined }));
    if (msg.type === 'send' && msg.text?.trim() === '/clear') {
      this.newSession();
    } else if (msg.type === 'send' && (msg.text || msg.images?.length)) {
      this.session.mode = msg.mode ?? 'edit';
      await this.handleUserMessage(msg.text ?? '', msg.images);
    } else if (msg.type === 'stop') {
      this.session.abort();
    } else if (msg.type === 'forceError') {
      this.session.abort();
      this.post({ type: 'error', text: 'Process killed manually', errorKind: 'generic' });
      this.post({ type: 'done' });
      this.showError('Claude Code process exited with code 3221226505');
    } else if (msg.type === 'newSession') {
      this.newSession();
    } else if (msg.type === 'openFile' && msg.path) {
      const uri = vscode.Uri.file(msg.path);
      vscode.window.showTextDocument(uri, { preview: true, viewColumn: vscode.ViewColumn.One });
    } else if (msg.type === 'openUrl' && msg.url) {
      vscode.env.openExternal(vscode.Uri.parse(msg.url));
    } else if (msg.type === 'getInfo') {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      this.post({ type: 'workspaceInfo', path: root });
    } else if (msg.type === 'getSkills') {
      this.post({ type: 'skills', skills: this.getSkills() });
    } else if (msg.type === 'retry' && this.lastUserText) {
      await this.handleUserMessage(this.lastUserText, this.lastUserImages);
    } else if (msg.type === 'toolAnswer') {
      const { id, answers } = msg as unknown as { id: string; answers: Record<string, string> };
      const content = JSON.stringify({ answers });
      const tc = this.activeToolCalls.find(t => t.id === id);
      if (tc) {
        tc.result = content;
        this.post({ type: 'tool_end', call: { id, name: tc.name, input: tc.input ?? {}, result: content } });
      }
      this.session.sendToolResult(id, content);
    } else if (msg.type === 'login') {
      await this.handleLogin();
    } else if (msg.type === 'loginCode' && msg.text) {
      await this.handleLoginCode(msg.text);
    }
  }

  private async handleUserMessage(text: string, images?: ImageAttachment[]): Promise<void> {
    console.log('[Argus] handleUserMessage:', text, images ? `(${images.length} images)` : '');
    this.lastUserText = text;
    this.lastUserImages = images;
    const userMsg = createUserMessage(text, images);
    this.messages.push(userMsg);
    this.post({ type: 'message', message: userMsg });
    this.post({ type: 'thinking_start' });

    const systemPrompt = this.buildSystemPrompt();
    const MAX_CONTEXT = 200_000;
    let responseText = '';
    let thinkingText = '';
    this.activeToolCalls = [];

    try {
      for await (const event of this.session.send(text, systemPrompt, images)) {
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
            this.activeToolCalls.push({ id: event.id, name: event.name, input: event.input });
            this.post({ type: 'tool_start', call: { id: event.id, name: event.name, input: event.input ?? {} } });
            break;

          case 'tool_end': {
            const match = this.activeToolCalls.find(tc => tc.id === event.id);
            if (match) match.result = event.result;
            console.log('[Argus] tool_end id:', event.id, 'match:', !!match, 'result length:', event.result?.length ?? 0);
            this.post({ type: 'tool_end', call: { id: event.id, name: match?.name ?? '', input: match?.input ?? {}, result: event.result } });
            break;
          }

          case 'usage': {
            if (event.inputTokens > 0) this.turnInputTokens = event.inputTokens;
            if (event.outputTokens > 0) this.turnOutputTokens = event.outputTokens;
            const total = this.turnInputTokens + this.turnOutputTokens;
            const percent = Math.min(100, Math.round(total / MAX_CONTEXT * 100));
            this.post({ type: 'contextUsage', percent, inputTokens: this.turnInputTokens, outputTokens: this.turnOutputTokens });
            break;
          }

          case 'result':
            // Claude Code sends final result - use it as the definitive response text
            if (!responseText) responseText = event.text;
            break;

          case 'error':
            this.post({ type: 'error', text: event.message, errorKind: event.errorKind });
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

  private getSkills(): { name: string; scope: 'global' | 'project' | 'builtin' }[] {
    const BUILTIN_COMMANDS = [
      'clear', 'compact', 'context', 'cost', 'diff', 'doctor',
      'help', 'hooks', 'ide', 'init', 'login', 'logout', 'memory',
      'model', 'permissions', 'plan', 'security-review', 'status',
      'terminal-setup', 'vim',
    ].map(name => ({ name, scope: 'builtin' as const }));

    const skills: { name: string; scope: 'global' | 'project' | 'builtin' }[] = [...BUILTIN_COMMANDS];

    const readSkillsDir = (dir: string, scope: 'global' | 'project') => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) skills.push({ name: entry.name, scope });
      }
    };

    readSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'global');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (root) readSkillsDir(path.join(root, '.claude', 'skills'), 'project');

    return skills;
  }

  private async handleLogin(): Promise<void> {
    const result = await this.session.startLogin();
    if (result.phase === 'url') {
      this.loginSubmitCode = result.submitCode;
      this.post({ type: 'loginUrl', url: result.url });
      vscode.env.openExternal(vscode.Uri.parse(result.url));
    } else {
      this.post({ type: 'loginResult', success: false, message: result.message });
    }
  }

  private async handleLoginCode(code: string): Promise<void> {
    if (!this.loginSubmitCode) {
      this.post({ type: 'loginResult', success: false, message: 'No login process active' });
      return;
    }
    const success = await this.loginSubmitCode(code);
    this.loginSubmitCode = undefined;
    this.post({ type: 'loginResult', success, message: success ? undefined : 'Authentication failed. Check the code and try again.' });
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

  private post(data: WebviewMessage): void {
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
  return crypto.randomBytes(16).toString('hex');
}
