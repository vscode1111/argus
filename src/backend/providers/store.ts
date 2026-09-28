import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_PATH, readConfig } from '../config';
import type { ProviderSelection } from '../../shared/provider';

export interface SessionRecord {
  id: string;
  cwd: string;
  selection: ProviderSelection;
  title: string;
  updatedAt: number;
}

// Metadata only. Native transcripts and credentials stay with their owning runtime.
const file = path.join(path.dirname(CONFIG_PATH), 'argus-provider-sessions.json');
export function records(): SessionRecord[] {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.filter((r): r is SessionRecord => !!r && typeof r.id === 'string'
      && typeof r.cwd === 'string' && typeof r.title === 'string' && typeof r.updatedAt === 'number'
      && !!r.selection && typeof r.selection.providerId === 'string' && typeof r.selection.model === 'string'
      && typeof r.selection.effort === 'string' && typeof r.selection.thinking === 'boolean');
  } catch { return []; }
}

function write(all: SessionRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(all), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function sameWorkspace(a: string, b: string): boolean {
  const normalize = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return normalize(a) === normalize(b);
}

export function sessionRecord(id: string, cwd?: string): SessionRecord | undefined {
  return records().find(r => r.id === id && (cwd === undefined || sameWorkspace(r.cwd, cwd)));
}

export function saveSession(record: SessionRecord): void {
  const all = records().filter(r => r.id !== record.id);
  all.push(record);
  write(all);
}

export function forgetSession(id: string): void { write(records().filter(r => r.id !== id)); }

export function defaultSelection(providerId?: string): ProviderSelection {
  const cfg = readConfig();
  providerId ??= cfg.defaultProvider || 'claude';
  const saved = cfg.providerDefaults?.[providerId];
  if (saved && saved.providerId === providerId && typeof saved.model === 'string' && typeof saved.effort === 'string' && typeof saved.thinking === 'boolean') return { ...saved };
  if (providerId === 'claude') return { providerId, model: cfg.model, effort: cfg.effort, thinking: cfg.thinking };
  return { providerId, model: '', effort: '', thinking: true };
}

export function selectionFor(id: string | undefined, cwd: string): ProviderSelection {
  return id ? sessionRecord(id, cwd)?.selection ?? defaultSelection(id.includes(':') ? id.split(':')[0] : 'claude') : defaultSelection();
}
