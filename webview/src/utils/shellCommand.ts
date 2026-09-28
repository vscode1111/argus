export type ShellKind = 'powershell' | 'bash' | 'cmd' | 'zsh' | 'fish' | 'sh';

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

export function shellCommand(command: string): ShellCommand {
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
  return { shell, display: script === undefined ? command : unwrap(script) };
}
