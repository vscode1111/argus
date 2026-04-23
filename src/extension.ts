import * as vscode from 'vscode';
import { ChatPanel } from './chat/ChatPanel';
import { ArgusCodeLensProvider } from './providers/CodeLensProvider';
import { InlineSuggestProvider } from './providers/InlineSuggestProvider';
import { getSelection } from './utils/workspace';
import { isInlineCompletionsEnabled, isCodeLensEnabled } from './utils/config';

export function activate(context: vscode.ExtensionContext): void {
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

export function deactivate(): void {}
