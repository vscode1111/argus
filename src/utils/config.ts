import * as vscode from 'vscode';

export function getModel(): string {
  return vscode.workspace.getConfiguration('argus').get<string>('model') ?? 'claude-opus-4-6';
}

export function isInlineCompletionsEnabled(): boolean {
  return vscode.workspace.getConfiguration('argus.inlineCompletions').get<boolean>('enabled') ?? false;
}

export function getInlineDebounceMs(): number {
  return vscode.workspace.getConfiguration('argus.inlineCompletions').get<number>('debounceMs') ?? 500;
}

export function getInlineModel(): string {
  return vscode.workspace.getConfiguration('argus.inlineCompletions').get<string>('model') ?? 'claude-haiku-4-5';
}

export function isCodeLensEnabled(): boolean {
  return vscode.workspace.getConfiguration('argus.codeLens').get<boolean>('enabled') ?? true;
}

export function useBashIntegratedTerminal(): boolean {
  return vscode.workspace.getConfiguration('argus.bash').get<boolean>('useIntegratedTerminal') ?? true;
}
