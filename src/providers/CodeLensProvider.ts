import * as vscode from 'vscode';

export class ArgusCodeLensProvider implements vscode.CodeLensProvider {
  private onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isFunctionOrClassStart(line, document.languageId)) {
        const range = new vscode.Range(i, 0, i, line.length);
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(hubot) Ask Argus',
            command: 'argus.askSelection',
            arguments: [{ line: i, context: extractBlock(lines, i) }],
          })
        );
      }
    }
    return lenses;
  }

  refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }
}

function isFunctionOrClassStart(line: string, langId: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return false;

  const patterns: Record<string, RegExp[]> = {
    typescript: [/^(export\s+)?(async\s+)?function\s+\w+/, /^(export\s+)?(abstract\s+)?class\s+\w+/, /^\w+\s*[=:]\s*(async\s+)?\(/, /^(public|private|protected|static)\s+/],
    javascript: [/^(export\s+)?(async\s+)?function\s+\w+/, /^(export\s+)?class\s+\w+/, /^\w+\s*[=:]\s*(async\s+)?\(/],
    python: [/^def\s+\w+/, /^class\s+\w+/, /^\s+(def|async def)\s+\w+/],
    rust: [/^(pub\s+)?(async\s+)?fn\s+\w+/, /^(pub\s+)?struct\s+\w+/, /^(pub\s+)?impl\s+/],
    go: [/^func\s+/, /^type\s+\w+\s+struct/],
  };

  const matchers = patterns[langId] ?? patterns.javascript;
  return matchers.some(re => re.test(trimmed));
}

function extractBlock(lines: string[], startLine: number): string {
  return lines.slice(startLine, Math.min(startLine + 30, lines.length)).join('\n');
}
