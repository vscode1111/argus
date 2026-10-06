import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const ARGUS_DIR = path.join(os.homedir(), '.argus');
export const LEGACY_ARGUS_DIR = path.join(os.homedir(), '.claude');

export function migrateLegacyFile(destination: string, legacy: string): void {
  if (fs.existsSync(destination) || !fs.existsSync(legacy)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  try { fs.copyFileSync(legacy, destination, fs.constants.COPYFILE_EXCL); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
