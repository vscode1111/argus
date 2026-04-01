import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { getInlineDebounceMs } from '../utils/config';

export class InlineSuggestProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: NodeJS.Timeout | undefined;

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {
    return new Promise((resolve) => {
      if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) { resolve(null); return; }
        try {
          const result = await this.getSuggestion(document, position, token);
          resolve(result);
        } catch {
          resolve(null);
        }
      }, getInlineDebounceMs());
    });
  }

  private getSuggestion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {
    const prefix = document.getText(new vscode.Range(
      new vscode.Position(Math.max(0, position.line - 40), 0),
      position
    ));
    const suffix = document.getText(new vscode.Range(
      position,
      new vscode.Position(Math.min(document.lineCount - 1, position.line + 10), 10000)
    ));

    if (prefix.trim().length < 5) { return Promise.resolve(null); }

    const prompt =
      `You are a code completion engine. Complete the code at the cursor position. ` +
      `Return ONLY the completion text (what comes after the cursor), no explanations, no markdown. ` +
      `Language: ${document.languageId}\n` +
      `<prefix>${prefix}</prefix><suffix>${suffix}</suffix>\n` +
      `Complete the code at the cursor (between prefix and suffix):`;

    return new Promise((resolve) => {
      const proc = spawn('claude', ['--print', '--output-format', 'text', '--model', 'claude-haiku-4-5'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      token.onCancellationRequested(() => { proc.kill(); resolve(null); });

      proc.stdin.write(prompt);
      proc.stdin.end();

      let output = '';
      proc.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      proc.on('close', (code) => {
        if (code !== 0 || !output.trim()) { resolve(null); return; }
        resolve({
          items: [new vscode.InlineCompletionItem(output.trimEnd(), new vscode.Range(position, position))],
        });
      });
      proc.on('error', () => resolve(null));
    });
  }
}
