import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const root = getWorkspaceRoot();
  if (!root) throw new Error('No workspace folder open');
  return path.join(root, filePath);
}

export function getActiveFilePath(): string | undefined {
  return vscode.window.activeTextEditor?.document.uri.fsPath;
}

export function getActiveFileContent(): string | undefined {
  return vscode.window.activeTextEditor?.document.getText();
}

export function getSelection(): { text: string; file: string; startLine: number } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return undefined;
  return {
    text: editor.document.getText(editor.selection),
    file: editor.document.uri.fsPath,
    startLine: editor.selection.start.line + 1,
  };
}

export async function applyEdit(filePath: string, newContent: string): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(uri, fullRange, newContent);
  await vscode.workspace.applyEdit(edit);
}

export function ensureSessionDir(): string {
  const root = getWorkspaceRoot();
  if (!root) throw new Error('No workspace folder open');
  const dir = path.join(root, '.argus', 'sessions');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
