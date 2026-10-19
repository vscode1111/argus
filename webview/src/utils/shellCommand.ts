export type ShellKind = 'powershell' | 'bash' | 'cmd' | 'zsh' | 'fish' | 'sh' | 'orchestrate'
  | 'node' | 'git' | 'grep' | 'rg' | 'sed' | 'cat' | 'npm' | 'yarn';

export interface ShellCommand {
  shell: ShellKind;
  display: string;
}

const SHELLS: Record<string, ShellKind> = {
  powershell: 'powershell', pwsh: 'powershell', bash: 'bash',
  cmd: 'cmd', zsh: 'zsh', fish: 'fish', sh: 'sh',
};

const COMMANDS: Record<string, ShellKind> = {
  node: 'node', git: 'git', grep: 'grep', rg: 'rg', sed: 'sed', cat: 'cat',
  npm: 'npm', yarn: 'yarn',
};

function unwrap(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || !trimmed.endsWith(quote)) return trimmed;
  let escaped = false;
  for (let i = 1; i < trimmed.length - 1; i++) {
    if (escaped) { escaped = false; continue; }
    if (trimmed[i] === '\\') { escaped = true; continue; }
    if (trimmed[i] === quote) return trimmed;
  }
  return trimmed.slice(1, -1);
}

function unwrapShellScript(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  return (quote === '"' || quote === "'") && trimmed.endsWith(quote)
    ? trimmed.slice(1, -1) : trimmed;
}

function unwrapNodeEval(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'\"'")) return trimmed.slice(1, -3);
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && !/'\s+'/.test(trimmed))
    return trimmed.slice(1, -1);
  return unwrap(trimmed);
}

function orchestratorCommand(command: string): ShellCommand | null {
  const match = /^\s*(?:"[^"]*[\\/]node(?:\.exe)?"|'[^']*[\\/]node(?:\.exe)?'|(?:\S*[\\/])?node(?:\.exe)?)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(command);
  if (!match || !/[\\/](?:orchestrate|orchestrator)[\\/]scripts[\\/]control\.js$/i.test(match[1] || match[2] || match[3])) return null;
  const action = match[4];
  const args = match[5] || '';
  const key = /(?:^|\s)--(?:key|goal)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(args);
  return { shell: 'orchestrate', display: key ? `${action} ${key[1] || key[2] || key[3]}` : action };
}

export function shellCommand(command: string): ShellCommand {
  const orchestrator = orchestratorCommand(command);
  if (orchestrator) return orchestrator;
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]+)$/.exec(command);
  if (!match) return { shell: 'bash', display: command };
  const executable = (match[1] || match[2] || match[3]).split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  const quotedNodeEval = /^node(?:\.exe)?\s+-e$/.test(executable);
  const commandKind = quotedNodeEval ? 'node' : COMMANDS[executable];
  if (commandKind) {
    const args = match[4];
    const nodeEval = commandKind === 'node' && (quotedNodeEval || /^-e\s+/.test(args));
    const display = commandKind === 'node' && !quotedNodeEval ? args.replace(/^-e\s+/, '') : args;
    return { shell: commandKind, display: nodeEval ? unwrapNodeEval(display) : unwrap(display) };
  }
  const shell = SHELLS[executable];
  if (!shell) return { shell: 'bash', display: command };
  const args = match[4];
  const script = shell === 'powershell'
    ? /^(?:(?:-NoProfile|-NonInteractive|-NoLogo|-ExecutionPolicy\s+\S+)\s+)*(?:-Command|-c)\s+([\s\S]+)$/i.exec(args)?.[1]
    : shell === 'cmd'
      ? /^\/(?:c|k)\s+([\s\S]+)$/i.exec(args)?.[1]
      : /^-(?:[a-z]*c|c[a-z]*)\s+([\s\S]+)$/i.exec(args)?.[1];
  if (script === undefined) return { shell, display: command };
  const display = unwrapShellScript(script);
  const inner = shellCommand(display);
  return inner.shell === 'bash' && inner.display === display ? { shell, display } : inner;
}
