import * as fs from 'fs';
import * as path from 'path';

// Desktop launches add their bundled CLI to PATH; ordinary Windows terminals do not.
// Respect an explicit override and PATH before looking in the desktop install cache.
export function resolveCodexBinary(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.ARGUS_CODEX_BIN) return env.ARGUS_CODEX_BIN;
  if (platform !== 'win32') return 'codex';
  const executable = (file: string): number | undefined => {
    try { const stat = fs.statSync(file); return stat.isFile() ? stat.mtimeMs : undefined; }
    catch { return undefined; }
  };
  const searchPath = env.PATH ?? env.Path ?? '';
  for (const entry of searchPath.split(';')) {
    const dir = entry.trim().replace(/^"|"$/g, '');
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, 'codex.exe');
    if (executable(file) !== undefined) return file;
  }
  if (env.LOCALAPPDATA) {
    const root = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(root, entry.name, 'codex.exe'))
        .map(file => ({ file, modified: executable(file) }))
        .filter((entry): entry is { file: string; modified: number } => entry.modified !== undefined)
        .sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
      if (candidates.length) return candidates[0].file;
    } catch { /* No desktop installation; preserve the normal CLI error. */ }
  }
  return 'codex';
}
