import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function readSkillDescription(skillDir: string): string | undefined {
  const skillFile = path.join(skillDir, 'SKILL.md');
  try {
    const content = fs.readFileSync(skillFile, 'utf-8');
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (match) {
      const descMatch = match[1].match(/^description:\s*(.+)$/m);
      if (descMatch) return descMatch[1].trim();
    }
  } catch {}
  return undefined;
}

function readSkillsDir(dir: string, scope: 'global' | 'project') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ name: e.name, scope, kind: 'skill' as const, description: readSkillDescription(path.join(dir, e.name)) }));
}

export function readCommandsDir(dir: string, scope: 'global' | 'project') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => {
      const name = e.name.replace(/\.md$/, '');
      let description: string | undefined;
      try {
        const content = fs.readFileSync(path.join(dir, e.name), 'utf-8');
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
          if (descMatch) description = descMatch[1].trim();
        }
        if (!description) {
          const firstLine = content.split('\n')[0]?.trim();
          if (firstLine && firstLine !== '---') description = firstLine;
        }
      } catch {}
      return { name, scope, kind: 'command' as const, description };
    });
}

const BUILTIN_COMMANDS: { name: string; scope: 'builtin'; description: string }[] = [
  { name: 'clear', scope: 'builtin', description: 'Clear conversation history' },
  { name: 'compact', scope: 'builtin', description: 'Compact conversation to save context' },
  { name: 'context', scope: 'builtin', description: 'Show context window usage' },
  { name: 'cost', scope: 'builtin', description: 'Show token usage and cost' },
  { name: 'diff', scope: 'builtin', description: 'Show file changes since start' },
  { name: 'doctor', scope: 'builtin', description: 'Check installation health' },
  { name: 'help', scope: 'builtin', description: 'Show available commands' },
  { name: 'hooks', scope: 'builtin', description: 'Manage event hooks' },
  { name: 'ide', scope: 'builtin', description: 'IDE integration status' },
  { name: 'init', scope: 'builtin', description: 'Initialize project with CLAUDE.md' },
  { name: 'login', scope: 'builtin', description: 'Sign in to your account' },
  { name: 'logout', scope: 'builtin', description: 'Sign out of your account' },
  { name: 'memory', scope: 'builtin', description: 'Edit CLAUDE.md memory files' },
  { name: 'model', scope: 'builtin', description: 'Switch or show current model' },
  { name: 'permissions', scope: 'builtin', description: 'View or update tool permissions' },
  { name: 'plan', scope: 'builtin', description: 'Create and execute a plan' },
  { name: 'security-review', scope: 'builtin', description: 'Review code for vulnerabilities' },
  { name: 'status', scope: 'builtin', description: 'Show session and account info' },
  { name: 'terminal-setup', scope: 'builtin', description: 'Install shell integration' },
  { name: 'vim', scope: 'builtin', description: 'Toggle vim keybindings' },
];

export function getSkills(cwd: string) {
  return [
    ...BUILTIN_COMMANDS,
    ...readCommandsDir(path.join(os.homedir(), '.claude', 'commands'), 'global'),
    ...readCommandsDir(path.join(cwd, '.claude', 'commands'), 'project'),
    ...readSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'global'),
    ...readSkillsDir(path.join(cwd, '.claude', 'skills'), 'project'),
  ];
}
