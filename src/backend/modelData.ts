import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readConfig, writeConfig, type ArgusConfig } from './config';
import { fetchModels, type ModelInfo } from './accountUsage';

// Model metadata upkeep: family-based descriptions (mirroring the CLI's own
// substring classifier, so new snapshots of known families never render blank),
// detection of the CLI default model, and a daily refresh the daemon schedules
// on startup. Manual trigger: `yarn update-models` (scripts/update-model-data.js).

export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku';

// Baked-in fallback wording, taken from the Claude CLI 2.1.197 model picker.
// The daily refresh overwrites these via config.modelFamilyDescriptions when the
// installed CLI carries different strings.
export const FAMILY_DESCRIPTIONS: Record<ModelFamily, string> = {
  fable: 'Most capable for your hardest and longest-running tasks',
  opus: 'Best for everyday, complex tasks',
  sonnet: 'Efficient for routine tasks',
  haiku: 'Fastest for quick answers',
};

const FAMILIES = Object.keys(FAMILY_DESCRIPTIONS) as ModelFamily[];

export function modelFamily(id: string): ModelFamily | null {
  const t = id.toLowerCase();
  return FAMILIES.find((f) => t.includes(f)) ?? null;
}

/** Description for a model id: config-extracted family string first, then baked-in. */
export function describeModel(id: string, extracted?: Record<string, string>): string | undefined {
  const family = modelFamily(id);
  if (!family) return undefined;
  return extracted?.[family] || FAMILY_DESCRIPTIONS[family];
}

// --- Context window ----------------------------------------------------------

// Used when the model is unknown to the cached /v1/models list. Matches the Claude
// CLI's own default for an unrecognized id.
export const DEFAULT_CONTEXT_WINDOW = 200_000;

const SNAPSHOT_SUFFIX_RE = /-20\d{6}$/;

/** Model id without its snapshot date, so a dated id matches its dateless alias. */
function undated(id: string): string {
  return id.toLowerCase().replace(SNAPSHOT_SUFFIX_RE, '');
}

// Context window for a model id, from the cached /v1/models list (max_input_tokens).
// The window is NOT derivable from the family - opus-4-5 is 200k while opus-4-6 and
// later are 1M - so an unknown id falls back to the default rather than guessing.
// The CLI's own result event reports contextWindow too, but it defaults to 200k for
// any model missing from the installed bundle's registry, so it is not used here.
export function contextWindowFor(id: string, cache?: Array<{ id: string; contextWindow?: number }>): number {
  if (!id) return DEFAULT_CONTEXT_WINDOW;
  const models = cache ?? readConfig().modelListCache;
  const target = undated(id);
  const hit = models.find((m) => undated(m.id) === target);
  return hit?.contextWindow && hit.contextWindow > 0 ? hit.contextWindow : DEFAULT_CONTEXT_WINDOW;
}

// Refresh no more than once a day; a long-running daemon re-checks hourly.
export const MODEL_DATA_REFRESH_MS = 24 * 60 * 60 * 1000;
const REFRESH_RECHECK_MS = 60 * 60 * 1000;
// How long to wait before retrying after an attempt that fetched no model list.
// Shorter than the success interval so a transient failure (offline, expired token)
// costs an hour of a possibly wrong context window rather than a full day.
export const MODEL_DATA_RETRY_MS = 60 * 60 * 1000;
const DETECT_TIMEOUT_MS = 60_000;

type Log = (msg: string) => void;

// --- Claude CLI location -----------------------------------------------------

// Runnable launcher for spawning a detection turn (claude / claude.cmd).
function resolveClaudeLauncher(): string {
  if (process.platform !== 'win32') return 'claude';
  try {
    const out = execFileSync('where', ['claude.cmd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const hit = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (hit && fs.existsSync(hit)) return hit;
  } catch {}
  const nvmHome = process.env.NVM_HOME;
  if (nvmHome) {
    try {
      const versions = fs.readdirSync(nvmHome).filter((d) => /^v\d/.test(d)).sort().reverse();
      for (const v of versions) {
        const c = path.join(nvmHome, v, 'claude.cmd');
        if (fs.existsSync(c)) return c;
      }
    } catch {}
  }
  return 'claude';
}

// The actual CLI bundle (native exe or cli.js) that carries the model metadata strings.
function resolveClaudeBundle(): string | null {
  try {
    if (process.platform !== 'win32') {
      const out = execFileSync('which', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const bin = out.split('\n').map((l) => l.trim()).find(Boolean);
      return bin ? fs.realpathSync(bin) : null;
    }
    const launcher = resolveClaudeLauncher();
    if (!path.isAbsolute(launcher)) return null;
    const pkgDir = path.join(path.dirname(launcher), 'node_modules', '@anthropic-ai', 'claude-code');
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')) as { bin?: string | Record<string, string> };
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
    for (const rel of [binRel, 'cli.js']) {
      if (!rel) continue;
      const p = path.join(pkgDir, rel);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

// --- Description extraction --------------------------------------------------

const DESCRIPTION_AT_START_RE = /^([^"]{4,200})"/;
// A quoted printable string of description-like length inside a minified JS window.
const CLUSTER_STRING_RE = /="([\x20-\x21\x23-\x7e]{10,160})"/g;
const SCAN_WINDOW = 300;
const MAX_ANCHOR_HITS = 20;

function scanAfterAnchor(buf: Buffer, anchor: string, pick: (window: string) => string | undefined): string | undefined {
  const needle = Buffer.from(anchor);
  let idx = buf.indexOf(needle);
  for (let hits = 0; idx !== -1 && hits < MAX_ANCHOR_HITS; hits++) {
    const window = buf.subarray(idx + needle.length, idx + needle.length + SCAN_WINDOW).toString('utf8');
    const found = pick(window);
    if (found) return found;
    idx = buf.indexOf(needle, idx + 1);
  }
  return undefined;
}

// Pulls the per-family description strings out of the installed CLI bundle. The
// sonnet/opus/haiku picker entries are minified as value:"X",label:"Y",description:"Z"
// triplets; fable has no picker triplet, so it is found as the unknown string
// clustered right after the haiku description in the constants block. Any miss
// degrades to the baked-in FAMILY_DESCRIPTIONS.
export function extractFamilyDescriptions(log: Log): Record<string, string> {
  const bundle = resolveClaudeBundle();
  if (!bundle) {
    log('description extraction skipped: Claude CLI bundle not found');
    return {};
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(bundle);
  } catch (err) {
    log(`description extraction skipped: cannot read ${bundle} (${(err as Error).message})`);
    return {};
  }

  const found: Record<string, string> = {};
  const pickerFamilies = ['sonnet', 'opus', 'haiku'] as const;
  for (const family of pickerFamilies) {
    // The full value+label anchor matters: value:"sonnet" alone also matches the
    // opus-plan picker entry, whose description is not the family wording.
    const label = family.charAt(0).toUpperCase() + family.slice(1);
    const desc = scanAfterAnchor(buf, `value:"${family}",label:"${label}",description:"`, (w) => DESCRIPTION_AT_START_RE.exec(w)?.[1]);
    if (desc) found[family] = desc;
  }

  // fable has no picker triplet; it sits in a constants cluster right after the
  // haiku string as the one description that is not one of the picker three.
  // "Known" must not include any fable wording, or the real match gets rejected.
  const known = new Set(pickerFamilies.map((f) => found[f] ?? FAMILY_DESCRIPTIONS[f]));
  const haikuDesc = found.haiku ?? FAMILY_DESCRIPTIONS.haiku;
  const fableDesc = scanAfterAnchor(buf, `"${haikuDesc}"`, (w) => {
    for (const m of w.matchAll(CLUSTER_STRING_RE)) {
      if (!known.has(m[1])) return m[1];
    }
    return undefined;
  });
  if (fableDesc) found.fable = fableDesc;

  log(`description extraction: found ${Object.keys(found).length}/4 families in ${path.basename(bundle)}`);
  return found;
}

// --- Default model detection -------------------------------------------------

// Runs a minimal CLI turn with no --model flag and reads the model the CLI picked
// from the assistant event. Spawned in the temp dir so it never loads a real
// project's CLAUDE.md or memory.
export function detectDefaultModel(log: Log): Promise<string | null> {
  return new Promise((resolve) => {
    const bin = resolveClaudeLauncher();
    const args = ['--print', '--output-format', 'stream-json', '--verbose', '--effort', 'low', 'say: ok'];
    const proc = spawn(bin, args, {
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    let model: string | null = null;
    let buffered = '';
    const timer = setTimeout(() => {
      log(`default model detection timed out after ${DETECT_TIMEOUT_MS / 1000}s`);
      try { proc.kill(); } catch {}
    }, DETECT_TIMEOUT_MS);

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as { type?: string; message?: { model?: string } };
          if (ev.type === 'assistant' && ev.message?.model) model = ev.message.model;
        } catch {}
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      log(`default model detection failed to spawn: ${err.message}`);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (!model) log(`default model detection got no assistant event (exit code ${code})`);
      resolve(model);
    });
  });
}

// --- Refresh orchestration ---------------------------------------------------

export interface ModelRefreshResult {
  defaultModel: string | null;
  families: Record<string, string>;
  cachedModels: number;
}

let refreshInFlight = false;

// Config subset the refresh scheduling decision depends on. Taking it as an argument
// (rather than reading the config here) keeps the decision pure and testable.
export type RefreshClock = Pick<ArgusConfig, 'modelDataUpdatedAt' | 'modelDataAttemptedAt'>;

// Two independent gates, both of which must open:
//   - success gate: the last *fetched* data must be at least a day old.
//   - attempt gate: the last try, successful or not, must be at least an hour old.
// The attempt gate is what makes it safe for a failure to leave modelDataUpdatedAt
// alone. Without it, a permanently broken environment (logged out, offline) would be
// stale forever and therefore re-attempt on every daemon start, and each attempt
// spawns a real CLI turn to detect the default model.
export function shouldRefreshModelData(cfg: RefreshClock, now: number = Date.now()): boolean {
  if (now - (cfg.modelDataUpdatedAt || 0) < MODEL_DATA_REFRESH_MS) return false;
  if (now - (cfg.modelDataAttemptedAt || 0) < MODEL_DATA_RETRY_MS) return false;
  return true;
}

// Merge a refresh result into the config. Every field is written only when the
// corresponding lookup actually produced something, so a partial failure keeps the
// previous value instead of blanking it.
//
// The important asymmetry: `modelDataAttemptedAt` always advances, `modelDataUpdatedAt`
// only when a model list came back. The model list is what `contextWindowFor` reads,
// so stamping the success clock after a failed fetch would report a model whose window
// is unknown as the 200k default for a full day, which on a 1M model is a percentage
// five times too high.
export function applyRefreshResult(
  cfg: ArgusConfig,
  result: { defaultModel: string | null; families: Record<string, string>; models: ModelInfo[] },
  now: number = Date.now(),
): ArgusConfig {
  const next: ArgusConfig = { ...cfg, modelDataAttemptedAt: now };
  if (result.defaultModel) next.runtimeDefaultModel = result.defaultModel;
  if (Object.keys(result.families).length > 0) next.modelFamilyDescriptions = result.families;
  if (result.models.length > 0) {
    next.modelListCache = result.models;
    next.modelDataUpdatedAt = now;
  }
  return next;
}

// Refreshes runtimeDefaultModel, modelFamilyDescriptions and modelListCache in the
// global config. Partial failures keep the previous values (see applyRefreshResult).
export async function refreshModelData(log: Log): Promise<ModelRefreshResult> {
  if (refreshInFlight) {
    log('model-data refresh already in progress, skipping');
    return { defaultModel: null, families: {}, cachedModels: 0 };
  }
  refreshInFlight = true;
  try {
    log('refreshing model data (default model, descriptions, model list)...');
    const [defaultModel, { models }] = await Promise.all([
      detectDefaultModel(log),
      fetchModels(),
    ]);
    const families = extractFamilyDescriptions(log);

    writeConfig(applyRefreshResult(readConfig(), { defaultModel, families, models }));

    if (models.length === 0) {
      log('model list fetch returned nothing; keeping the cached windows and retrying in an hour');
    }
    log(`model data refreshed: default=${defaultModel ?? '(unchanged)'}, families=${Object.keys(families).length}, models=${models.length}`);
    return { defaultModel, families, cachedModels: models.length };
  } finally {
    refreshInFlight = false;
  }
}

// Called by the daemon on startup: records the launch time in the global config and
// keeps model data at most a day old. The gates are the two timestamps in
// shouldRefreshModelData, never the previous launch time - the daemon idle-exits and
// respawns many times a day, so a start-to-start gate would never reach 24h.
// ARGUS_MODEL_REFRESH=0 disables the refresh (used by e2e daemon specs, which must
// not spawn real CLI turns).
export function scheduleModelDataRefresh(log: Log): void {
  writeConfig({ ...readConfig(), daemonLastStartAt: Date.now() });
  if (process.env.ARGUS_MODEL_REFRESH === '0') return;

  const maybeRefresh = () => {
    if (!shouldRefreshModelData(readConfig())) return;
    refreshModelData(log).catch((err) => log(`model-data refresh failed: ${(err as Error).message ?? err}`));
  };
  maybeRefresh();
  const timer = setInterval(maybeRefresh, REFRESH_RECHECK_MS);
  timer.unref?.();
}
