import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { getInlineDebounceMs, getInlineModel } from '../utils/config';
import { resolveClaudeBin, IS_WIN } from '../../backend/cli';

const PREFIX_LINES = 40;
const SUFFIX_LINES = 10;
const MIN_PREFIX_LENGTH = 5;

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
      new vscode.Position(Math.max(0, position.line - PREFIX_LINES), 0),
      position
    ));
    const endLine = Math.min(document.lineCount - 1, position.line + SUFFIX_LINES);
    const suffix = document.getText(new vscode.Range(
      position,
      document.lineAt(endLine).range.end
    ));

    if (prefix.trim().length < MIN_PREFIX_LENGTH) { return Promise.resolve(null); }

    const prompt =
      `You are a code completion engine. Complete the code at the cursor position. ` +
      `Return ONLY the completion text (what comes after the cursor), no explanations, no markdown. ` +
      `Language: ${document.languageId}\n` +
      `<prefix>${prefix}</prefix><suffix>${suffix}</suffix>\n` +
      `Complete the code at the cursor (between prefix and suffix):`;

    return new Promise((resolve) => {
      const claudeBin = resolveClaudeBin();
      const spawnCmd = IS_WIN && /\s/.test(claudeBin) ? `"${claudeBin}"` : claudeBin;
      const proc = spawn(spawnCmd, ['--print', '--output-format', 'text', '--model', getInlineModel()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: IS_WIN,
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
