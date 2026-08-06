import * as fsp from 'fs/promises';
import * as path from 'path';
import { projectsRoot } from './sessions';

// Local usage insights: the "What's contributing to your limits usage?" analysis,
// mirroring the official Claude Code client. Scans the last 7 days of transcripts
// in ~/.claude/projects (including per-session subagents/ folders) and aggregates
// an approximate cost per behavior, skill, subagent, plugin and MCP server. The
// numbers are heuristic weights, not billing data: each assistant event costs
// (cache_read + input*10 + cache_creation*12.5 + output*50) * model tier, with
// tiers fable=10 / opus=5 / haiku=1 / other=3 - the same weighting the official
// panel uses, so percentages match what the user sees there.

export interface InsightRow {
  name: string;
  pct: number; // 0-100, rounded; rows at 0% are dropped
}

export interface BehaviorStat {
  key: string; // cache_miss | long_context | subagent_heavy | high_parallel | cron
  pct: number; // share of total cost, 0-100 rounded
  count: number; // events (cache_miss/long_context/high_parallel) or sessions (subagent_heavy/cron)
}

export interface InsightsReport {
  totalCost: number;
  requestCount: number;
  sessionCount: number;
  behaviors: BehaviorStat[]; // sorted by cost desc
  skills: InsightRow[];
  agents: InsightRow[];
  plugins: InsightRow[];
  mcpServers: InsightRow[];
}

export interface UsageInsights {
  day: InsightsReport; // last 24h
  week: InsightsReport; // last 7d
}

// UI threshold: behaviors below this share are noise and hidden (same as official).
export const MIN_BEHAVIOR_PCT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Behavior thresholds (official values).
const CACHE_MISS_INPUT_TOKENS = 100_000; // uncached input above this = cold-start cache miss
const LONG_CONTEXT_TOKENS = 150_000; // total context above this = long-context request
const SUBAGENT_HEAVY_COUNT = 3; // subagent events per session
const SUBAGENT_HEAVY_RATIO = 0.5; // or subagent share of session cost
const PARALLEL_BUCKET_MS = 5 * 60 * 1000; // 5-min buckets for parallel-session detection
const PARALLEL_SESSIONS = 4; // distinct sessions per bucket to count as parallel
const LONG_RUNNING_HOURS = 8; // distinct active hours to count a session as long-running

const FILE_CHUNK = 4; // transcripts parsed concurrently per batch

interface UsageEvent {
  ts: number;
  sessionId: string;
  cached: number; // cache_read_input_tokens
  cacheCreate: number; // cache_creation_input_tokens
  uncached: number; // input_tokens
  output: number; // output_tokens
  isSubagent: boolean;
  modelTier: number;
  uuid: string; // requestId, falling back to the msg_ id / record uuid; '' = never dedup
  attributionAgent?: string;
  attributionSkill?: string;
  attributionPlugin?: string;
  attributionMcpServer?: string;
}

interface SessionAgg {
  cost: number;
  subCost: number;
  subCount: number;
  hours: Set<number>;
}

interface BucketAgg {
  sids: Set<string>;
  cost: number;
  count: number;
}

interface Accumulator {
  totalCost: number;
  requestCount: number;
  cacheMissCost: number;
  cacheMissCount: number;
  longCtxCost: number;
  longCtxCount: number;
  sessions: Map<string, SessionAgg>;
  buckets: Map<number, BucketAgg>;
  byAgent: Map<string, number>;
  bySkill: Map<string, number>;
  byPlugin: Map<string, number>;
  byMcpServer: Map<string, number>;
}

function emptyAccumulator(): Accumulator {
  return {
    totalCost: 0,
    requestCount: 0,
    cacheMissCost: 0,
    cacheMissCount: 0,
    longCtxCost: 0,
    longCtxCount: 0,
    sessions: new Map(),
    buckets: new Map(),
    byAgent: new Map(),
    bySkill: new Map(),
    byPlugin: new Map(),
    byMcpServer: new Map(),
  };
}

// --- Line parsing ------------------------------------------------------------
// Transcript lines are large JSON records; targeted substring extraction is much
// cheaper than JSON.parse over megabytes of history (and matches how the official
// scanner reads them). Values read here (ids, token counts, attribution names)
// never contain escaped quotes.

function strField(line: string, key: string): string | undefined {
  const needle = `"${key}":"`;
  const i = line.indexOf(needle);
  if (i < 0) return undefined;
  const start = i + needle.length;
  const end = line.indexOf('"', start);
  return end < 0 ? undefined : line.slice(start, end);
}

function numField(line: string, key: string): number {
  const needle = `"${key}":`;
  const i = line.indexOf(needle);
  if (i < 0) return 0;
  let j = i + needle.length;
  let v = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    v = v * 10 + (c - 48);
    j++;
  }
  return v;
}

// The API message id specifically ("id":"msg_..."): a bare "id" key also matches
// unrelated ids elsewhere in the record.
function msgId(line: string): string | undefined {
  const i = line.indexOf('"id":"msg_');
  if (i < 0) return undefined;
  const start = i + '"id":"'.length;
  const end = line.indexOf('"', start);
  return end < 0 ? undefined : line.slice(start, end);
}

function modelTier(model: string | undefined): number {
  if (!model) return 3;
  const t = model.toLowerCase();
  if (t.includes('fable')) return 10;
  if (t.includes('opus')) return 5;
  if (t.includes('haiku')) return 1;
  return 3;
}

function eventCost(ev: UsageEvent): number {
  return (ev.cached + ev.uncached * 10 + ev.cacheCreate * 12.5 + ev.output * 50) * ev.modelTier;
}

export function parseUsageEvent(line: string, minTs: number): UsageEvent | undefined {
  if (!line.includes('"type":"assistant"') || !line.includes('"usage":{')) return undefined;
  const timestamp = strField(line, 'timestamp');
  const sessionId = strField(line, 'sessionId');
  if (!timestamp || !sessionId) return undefined;
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts) || ts < minTs) return undefined;
  const uncached = numField(line, 'input_tokens');
  const output = numField(line, 'output_tokens');
  const cacheCreate = numField(line, 'cache_creation_input_tokens');
  const cached = numField(line, 'cache_read_input_tokens');
  if (uncached + output + cacheCreate + cached === 0) return undefined;
  const ev: UsageEvent = {
    ts,
    sessionId,
    cached,
    cacheCreate,
    uncached,
    output,
    isSubagent: line.includes('"isSidechain":true') || line.includes('"isSidechain": true'),
    modelTier: modelTier(strField(line, 'model')),
    uuid: strField(line, 'requestId') ?? msgId(line) ?? strField(line, 'uuid') ?? '',
  };
  if (line.includes('"attribution')) {
    ev.attributionAgent = strField(line, 'attributionAgent');
    ev.attributionSkill = strField(line, 'attributionSkill');
    ev.attributionPlugin = strField(line, 'attributionPlugin');
    ev.attributionMcpServer = strField(line, 'attributionMcpServer');
  }
  return ev;
}

// --- Aggregation -------------------------------------------------------------

function addTo(map: Map<string, number>, key: string | undefined, cost: number): void {
  if (key) map.set(key, (map.get(key) ?? 0) + cost);
}

function accumulate(acc: Accumulator, ev: UsageEvent): void {
  const cost = eventCost(ev);
  acc.totalCost += cost;
  acc.requestCount++;

  // Subagent events attribute to the Subagents table (keyed by the skill that
  // spawned them when known); main-chain events attribute to Skills.
  if (ev.attributionAgent) addTo(acc.byAgent, ev.attributionSkill ?? ev.attributionAgent, cost);
  else addTo(acc.bySkill, ev.attributionSkill, cost);
  addTo(acc.byPlugin, ev.attributionPlugin, cost);
  addTo(acc.byMcpServer, ev.attributionMcpServer, cost);

  const context = ev.cached + ev.cacheCreate + ev.uncached;
  if (ev.uncached > CACHE_MISS_INPUT_TOKENS) {
    acc.cacheMissCost += cost;
    acc.cacheMissCount++;
  }
  if (context > LONG_CONTEXT_TOKENS) {
    acc.longCtxCost += cost;
    acc.longCtxCount++;
  }

  let session = acc.sessions.get(ev.sessionId);
  if (!session) {
    session = { cost: 0, subCost: 0, subCount: 0, hours: new Set() };
    acc.sessions.set(ev.sessionId, session);
  }
  session.cost += cost;
  if (ev.isSubagent) {
    session.subCost += cost;
    session.subCount++;
  }
  session.hours.add(Math.floor(ev.ts / (60 * 60 * 1000)));

  const bucketKey = Math.floor(ev.ts / PARALLEL_BUCKET_MS);
  let bucket = acc.buckets.get(bucketKey);
  if (!bucket) {
    bucket = { sids: new Set(), cost: 0, count: 0 };
    acc.buckets.set(bucketKey, bucket);
  }
  bucket.sids.add(ev.sessionId);
  bucket.cost += cost;
  bucket.count++;
}

function toRows(map: Map<string, number>, totalCost: number): InsightRow[] {
  if (map.size === 0 || totalCost === 0) return [];
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, cost]) => ({ name, pct: Math.round((cost / totalCost) * 100) }))
    .filter((row) => row.pct > 0);
}

function finalize(acc: Accumulator): InsightsReport {
  let parallelCost = 0;
  let parallelCount = 0;
  for (const bucket of acc.buckets.values()) {
    if (bucket.sids.size >= PARALLEL_SESSIONS) {
      parallelCost += bucket.cost;
      parallelCount += bucket.count;
    }
  }

  let subagentCost = 0;
  let subagentSessions = 0;
  let longRunningCost = 0;
  let longRunningSessions = 0;
  for (const session of acc.sessions.values()) {
    const heavy = session.subCount >= SUBAGENT_HEAVY_COUNT ||
      (session.cost > 0 && session.subCost / session.cost > SUBAGENT_HEAVY_RATIO);
    if (heavy) {
      subagentCost += session.cost;
      subagentSessions++;
    }
    if (session.hours.size >= LONG_RUNNING_HOURS) {
      longRunningCost += session.cost;
      longRunningSessions++;
    }
  }

  const pct = (cost: number) => (acc.totalCost > 0 ? Math.round((cost / acc.totalCost) * 100) : 0);
  const behaviors: BehaviorStat[] = [
    { key: 'cache_miss', cost: acc.cacheMissCost, count: acc.cacheMissCount },
    { key: 'long_context', cost: acc.longCtxCost, count: acc.longCtxCount },
    { key: 'subagent_heavy', cost: subagentCost, count: subagentSessions },
    { key: 'high_parallel', cost: parallelCost, count: parallelCount },
    { key: 'cron', cost: longRunningCost, count: longRunningSessions },
  ]
    .sort((a, b) => b.cost - a.cost)
    .map(({ key, cost, count }) => ({ key, pct: pct(cost), count }));

  return {
    totalCost: acc.totalCost,
    requestCount: acc.requestCount,
    sessionCount: acc.sessions.size,
    behaviors,
    skills: toRows(acc.bySkill, acc.totalCost),
    agents: toRows(acc.byAgent, acc.totalCost),
    plugins: toRows(acc.byPlugin, acc.totalCost),
    mcpServers: toRows(acc.byMcpServer, acc.totalCost),
  };
}

// --- Transcript discovery ----------------------------------------------------

// All transcripts of one project folder: the session *.jsonl files directly in
// it, plus any <session-data-dir>/subagents/**/*.jsonl below it.
async function projectTranscripts(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(dir, entry.name));
    else if (entry.isDirectory()) subdirs.push(entry.name);
  }
  for (const sub of subdirs) {
    const subagentsDir = path.join(dir, sub, 'subagents');
    try {
      const nested = await fsp.readdir(subagentsDir, { recursive: true }) as string[];
      for (const rel of nested) {
        if (rel.endsWith('.jsonl')) files.push(path.join(subagentsDir, rel));
      }
    } catch {
      // no subagents folder for this session
    }
  }
  return files;
}

async function fileEvents(file: string, minTs: number): Promise<UsageEvent[]> {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.mtimeMs < minTs) return [];
  let content: string;
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const events: UsageEvent[] = [];
  for (const line of content.split('\n')) {
    const ev = parseUsageEvent(line, minTs);
    if (ev) events.push(ev);
  }
  return events;
}

// --- Collection --------------------------------------------------------------

async function collect(): Promise<UsageInsights> {
  const weekCutoff = Date.now() - WEEK_MS;
  const dayCutoff = Date.now() - DAY_MS;
  const root = projectsRoot();

  let projectDirs: string[];
  try {
    projectDirs = await fsp.readdir(root);
  } catch {
    return { day: finalize(emptyAccumulator()), week: finalize(emptyAccumulator()) };
  }

  const fileLists = await Promise.all(projectDirs.map((d) => projectTranscripts(path.join(root, d))));
  const files = fileLists.flat();

  const day = emptyAccumulator();
  const week = emptyAccumulator();
  // Streaming rewrites duplicate an API response across lines under one
  // requestId; the first occurrence wins, the rest are dropped.
  const seen = new Set<string>();

  for (let i = 0; i < files.length; i += FILE_CHUNK) {
    const batch = files.slice(i, i + FILE_CHUNK);
    const results = await Promise.all(batch.map((f) => fileEvents(f, weekCutoff)));
    for (const events of results) {
      for (const ev of events) {
        if (ev.uuid) {
          if (seen.has(ev.uuid)) continue;
          seen.add(ev.uuid);
        }
        accumulate(week, ev);
        if (ev.ts >= dayCutoff) accumulate(day, ev);
      }
    }
  }

  return { day: finalize(day), week: finalize(week) };
}

// The scan reads every recent transcript, so reuse a fresh result for repeat
// opens and share one in-flight run between concurrent clients.
let insightsCache: { data: UsageInsights; ts: number } | null = null;
let insightsInFlight: Promise<UsageInsights> | null = null;
const INSIGHTS_TTL_MS = 60_000;

export function collectUsageInsights(force = false): Promise<UsageInsights> {
  if (!force && insightsCache && Date.now() - insightsCache.ts < INSIGHTS_TTL_MS) {
    return Promise.resolve(insightsCache.data);
  }
  if (insightsInFlight) return insightsInFlight;
  insightsInFlight = collect()
    .then((data) => {
      insightsCache = { data, ts: Date.now() };
      return data;
    })
    .finally(() => {
      insightsInFlight = null;
    });
  return insightsInFlight;
}
