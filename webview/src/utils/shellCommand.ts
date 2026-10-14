export type ShellKind = 'powershell' | 'bash' | 'cmd' | 'zsh' | 'fish' | 'sh' | 'orchestrate';

export interface ShellCommand {
  shell: ShellKind;
  display: string;
}

const SHELLS: Record<string, ShellKind> = {
  powershell: 'powershell', pwsh: 'powershell', bash: 'bash',
  cmd: 'cmd', zsh: 'zsh', fish: 'fish', sh: 'sh',
};

function unwrap(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  return (quote === '"' || quote === "'") && trimmed.endsWith(quote)
    ? trimmed.slice(1, -1) : trimmed;
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
  const shell = SHELLS[executable];
  if (!shell) return { shell: 'bash', display: command };
  const args = match[4];
  const script = shell === 'powershell'
    ? /^(?:(?:-NoProfile|-NonInteractive|-NoLogo|-ExecutionPolicy\s+\S+)\s+)*(?:-Command|-c)\s+([\s\S]+)$/i.exec(args)?.[1]
    : shell === 'cmd'
      ? /^\/(?:c|k)\s+([\s\S]+)$/i.exec(args)?.[1]
      : /^-(?:[a-z]*c|c[a-z]*)\s+([\s\S]+)$/i.exec(args)?.[1];
  return orchestratorCommand(script === undefined ? command : unwrap(script)) || { shell, display: script === undefined ? command : unwrap(script) };
}
