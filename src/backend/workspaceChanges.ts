import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

const exec = promisify(execFile);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 1000;

export interface WorkspaceChanges {
  added: number;
  removed: number;
  isIncomplete: boolean;
  error?: string;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

function countTextLines(bytes: Buffer): number {
  if (!bytes.length) return 0;
  let count = 0;
  for (const byte of bytes) if (byte === 10) count++;
  return count + (bytes[bytes.length - 1] === 10 ? 0 : 1);
}

export async function workspaceChanges(workspaceDir: string): Promise<WorkspaceChanges> {
  const result: WorkspaceChanges = { added: 0, removed: 0, isIncomplete: false };
  try {
    const root = path.resolve((await runGit(workspaceDir, ['rev-parse', '--show-toplevel'])).trim());
    const diff = await runGit(root, ['diff', '--numstat', '--no-renames', '-z', 'HEAD', '--']);
    for (const row of diff.split('\0')) {
      if (!row) continue;
      const first = row.indexOf('\t');
      const second = row.indexOf('\t', first + 1);
      if (first < 0 || second < 0) continue;
      const added = Number(row.slice(0, first));
      const removed = Number(row.slice(first + 1, second));
      if (!Number.isFinite(added) || !Number.isFinite(removed)) { result.isIncomplete = true; continue; }
      result.added += added;
      result.removed += removed;
    }
    const untracked = (await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    if (untracked.length > MAX_UNTRACKED_FILES) result.isIncomplete = true;
    for (const relative of untracked.slice(0, MAX_UNTRACKED_FILES)) {
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep)) { result.isIncomplete = true; continue; }
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_FILE_BYTES) { result.isIncomplete = true; continue; }
        const bytes = await fs.readFile(file);
        if (bytes.includes(0)) { result.isIncomplete = true; continue; }
        result.added += countTextLines(bytes);
      } catch { result.isIncomplete = true; }
    }
  } catch (error) {
    return { ...result, error: error instanceof Error ? error.message : String(error) };
  }
  return result;
}
