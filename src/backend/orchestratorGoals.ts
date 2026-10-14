import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface OrchestratorWorker {
  key: string;
  title: string;
  status: string;
  sessionId?: string;
  workspace: string;
  providerId?: string;
  model?: string;
  updatedAt: number;
}

export interface OrchestratorGoal {
  company: string;
  goal: string;
  title: string;
  status: string;
  updatedAt: number;
  workers: OrchestratorWorker[];
}

const ROOT = process.env.ARGUS_ORCHESTRATOR_RUNS || path.join(os.homedir(), '.agents', 'runs', 'orchestrate');
const SAFE_NAME = /^[a-zA-Z0-9._-]{1,80}$/;
const STATUSES = new Set(['active', 'blocked', 'done']);

function readSmallJson(file: string): Record<string, unknown> | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return undefined;
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function listOrchestratorGoals(): OrchestratorGoal[] {
  const goals: OrchestratorGoal[] = [];
  let companies: fs.Dirent[];
  try { companies = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return goals; }
  for (const companyEntry of companies.slice(0, 50)) {
    if (!companyEntry.isDirectory() || !SAFE_NAME.test(companyEntry.name)) continue;
    const company = companyEntry.name;
    const folder = path.join(ROOT, company);
    let files: fs.Dirent[];
    try { files = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    const workers: Array<OrchestratorWorker & { goal?: string }> = [];
    for (const entry of files.slice(0, 500)) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.goal.json')) continue;
      const data = readSmallJson(path.join(folder, entry.name));
      if (!data || data.company !== company || !SAFE_NAME.test(String(data.key))
        || typeof data.workspace !== 'string' || typeof data.title !== 'string') continue;
      workers.push({ key: data.key as string, title: data.title.slice(0, 100),
        status: typeof data.status === 'string' ? data.status.slice(0, 30) : 'unknown',
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
        workspace: data.workspace, providerId: typeof data.providerId === 'string' ? data.providerId : undefined,
        model: typeof data.model === 'string' ? data.model : undefined,
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
        goal: typeof data.goal === 'string' && SAFE_NAME.test(data.goal) ? data.goal : undefined });
    }
    for (const entry of files.slice(0, 500)) {
      if (!entry.isFile() || !entry.name.endsWith('.goal.json')) continue;
      const data = readSmallJson(path.join(folder, entry.name));
      if (!data || data.company !== company || !SAFE_NAME.test(String(data.goal))
        || typeof data.title !== 'string' || !STATUSES.has(String(data.status))) continue;
      goals.push({ company, goal: data.goal as string, title: data.title.slice(0, 150),
        status: data.status as string, updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
        workers: workers.filter(worker => worker.goal === data.goal).sort((a, b) => b.updatedAt - a.updatedAt) });
    }
  }
  return goals.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
}
