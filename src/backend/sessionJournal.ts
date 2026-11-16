import { randomUUID } from 'crypto';

export const JOURNAL_LIMITS = { events: 2000, sessionBytes: 8 * 1024 * 1024, bytes: 64 * 1024 * 1024,
  segments: 512, tombstones: 512, pageEvents: 256, pageBytes: 256 * 1024, ttl: 3600_000, waiters: 256 };
export interface JournalCursor { epoch: string; generation: string; seq: number }
interface JournalEvent {
  seq: number; time: number; turnId: string; kind: string; summary: string; data: Record<string, unknown>;
  output?: { text: string; originalBytes: number; truncated: boolean }; truncated?: boolean;
}
interface Segment {
  generation: string; sessionId?: string; events: JournalEvent[]; bytes: number; seq: number;
  produced: number; read: number; turnId: string; failed: boolean; retry: boolean; text: string; timer?: NodeJS.Timeout;
}
type Options = Partial<typeof JOURNAL_LIMITS> & { now?: () => number };
const kinds: Record<string, string> = { thinking_start: 'start', text_chunk: 'text', tool_start: 'tool-start', tool_end: 'tool-end',
  user_inject: 'inject', interaction: 'interaction', interaction_resolved: 'interaction-resolved', retry_status: 'retry', error: 'error', done: 'end' };
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function text(value: unknown, max = 200): string {
  if (typeof value !== 'string') return '';
  // UTF-16 length is a lower bound on UTF-8 bytes; only inspect a bounded prefix.
  const prefix = value.slice(0, max);
  if (prefix.length === value.length && Buffer.byteLength(prefix) <= max) return prefix;
  return Buffer.from(prefix).subarray(0, max).toString('utf8').replace(/\uFFFD$/u, '');
}

// Retained segments deliberately contain no runtime/state references and survive entry eviction.
export class SessionJournal {
  readonly epoch = randomUUID();
  private readonly limits;
  private readonly now: () => number;
  private readonly owners = new WeakMap<object, Segment>();
  private readonly segments = new Map<string, Segment>();
  private readonly sessions = new Map<string, Segment>();
  private readonly lost = new Map<string, string>();
  private readonly listeners = new Set<(sessionId: string | undefined, notable: boolean) => void>();
  private eventBudget: number;
  constructor(options: Options = {}) {
    this.limits = { ...JOURNAL_LIMITS, ...options }; this.now = options.now ?? Date.now;
    this.eventBudget = Math.max(512, Math.min(72 * 1024, this.limits.sessionBytes / 2, this.limits.bytes / 4, this.limits.pageBytes / 2));
  }
  private notify(sessionId: string | undefined, notable: boolean) { for (const callback of [...this.listeners]) callback(sessionId, notable); }
  private drop(segment: Segment) {
    if (segment.timer) clearTimeout(segment.timer);
    this.segments.delete(segment.generation);
    // The live owner's weak-map slot can outlast retention. Release its payload too.
    segment.events = []; segment.text = ''; segment.bytes = 0; segment.timer = undefined;
    if (segment.sessionId && this.sessions.get(segment.sessionId) === segment) {
      this.sessions.delete(segment.sessionId); this.lost.delete(segment.sessionId); this.lost.set(segment.sessionId, segment.generation);
      while (this.lost.size > this.limits.tombstones) this.lost.delete(this.lost.keys().next().value!);
    }
    this.notify(segment.sessionId, true);
  }
  private sweep() {
    for (const segment of [...this.segments.values()]) if (this.now() - segment.produced >= this.limits.ttl) this.drop(segment);
  }
  stats() {
    return { bytes: [...this.segments.values()].reduce((n, s) => n + s.bytes + Buffer.byteLength(s.text), 0) + this.lost.size * 256 + this.listeners.size * 512,
      segments: this.segments.size, tombstones: this.lost.size, waiters: this.listeners.size };
  }
  private trim(segment: Segment) {
    while (segment.events.length && (segment.events.length > this.limits.events || segment.bytes + Buffer.byteLength(segment.text) > this.limits.sessionBytes)) {
      segment.bytes -= bytes(segment.events.shift()!);
    }
    while (this.segments.size && (this.stats().bytes > this.limits.bytes || this.segments.size > this.limits.segments)) {
      const oldest = [...this.segments.values()].sort((a, b) => a.read - b.read)[0]; this.drop(oldest);
    }
  }
  private append(segment: Segment, kind: string, summary: string, data: Record<string, unknown>, output?: JournalEvent['output']) {
    const event: JournalEvent = { seq: ++segment.seq, time: this.now(), turnId: segment.turnId, kind, summary: text(summary), data, ...(output ? { output } : {}) };
    if (bytes(event) > this.eventBudget) { event.data = { truncated: true }; event.truncated = true; }
    segment.events.push(event); segment.bytes += bytes(event); this.trim(segment);
    this.notify(segment.sessionId, ['interaction', 'interaction-resolved', 'error', 'end'].includes(kind) || kind === 'tool-end' && (data.outcome === 'failure' || data.error === true));
  }
  private flush(segment: Segment) {
    if (segment.timer) clearTimeout(segment.timer); segment.timer = undefined;
    if (!segment.text || !this.segments.has(segment.generation)) return;
    const chunk = segment.text; segment.text = ''; this.append(segment, 'text', text(chunk), { text: chunk });
  }
  observe(owner: object, sessionId: string | undefined, event: Record<string, unknown>, secret?: string): void {
    this.sweep();
    const type = String(event.type), kind = kinds[type];
    let segment = this.owners.get(owner);
    if (segment && !this.segments.has(segment.generation)) segment = undefined;
    if (type === 'clear') { if (segment) this.flush(segment); this.owners.delete(owner); return; }
    if (!kind && type !== 'sessionId') return;
    if (segment?.sessionId && segment.sessionId !== sessionId) { this.flush(segment); segment = undefined; }
    if (!segment) {
      segment = { generation: randomUUID(), events: [], bytes: 384, seq: 0, produced: this.now(), read: this.now(),
        turnId: randomUUID(), failed: false, retry: false, text: '' };
      this.segments.set(segment.generation, segment); this.owners.set(owner, segment);
    }
    if (sessionId && !segment.sessionId) {
      const previous = this.sessions.get(sessionId); if (previous && previous !== segment) this.drop(previous);
      segment.sessionId = sessionId; this.sessions.set(sessionId, segment); this.lost.delete(sessionId);
    }
    segment.produced = this.now();
    const safe = (value: unknown, cap?: number) => {
      const clipped = text(value, (cap ?? 200) + (secret?.length ?? 0));
      return text(secret ? clipped.split(secret).join('[redacted]') : clipped, cap);
    };
    if (type === 'text_chunk') {
      let input = typeof event.text === 'string' ? event.text : '';
      if (secret) input = input.split(secret).join('[redacted]');
      const cap = Math.min(8192, Math.floor(this.eventBudget / 2));
      // Seal bounded UTF-8 chunks without allocating a buffer for the entire incoming text.
      for (let offset = 0; offset < input.length;) {
        const part = text(input.slice(offset, offset + cap), cap); offset += part.length;
        if (Buffer.byteLength(segment.text) + Buffer.byteLength(part) > cap) this.flush(segment);
        if (!this.segments.has(segment.generation)) return;
        segment.text += part;
        if (Buffer.byteLength(segment.text) >= cap) this.flush(segment);
        if (!this.segments.has(segment.generation)) return;
        if (!part.length) break;
      }
      if (!segment.timer) segment.timer = setTimeout(() => this.flush(segment!), 50);
      segment.timer.unref(); this.trim(segment); return;
    }
    this.flush(segment);
    if (!this.segments.has(segment.generation)) return;
    if (type === 'sessionId') { this.trim(segment); return; }
    if (type === 'thinking_start') {
      if (!segment.retry) segment.turnId = randomUUID();
      segment.retry = false; segment.failed = false;
      this.append(segment, 'start', 'Turn started', {});
    } else if (type === 'done') {
      this.append(segment, 'end', 'Turn ended', { outcome: segment.failed ? 'error' : event.interrupted ? 'stopped' : 'success' });
      segment.retry = false;
    } else if (type === 'error') {
      segment.failed = true; this.append(segment, 'error', safe(event.text), { text: safe(event.text, 2048) });
    } else if (type === 'retry_status') {
      const argus = event.errorRetry === true || typeof event.autoRetry === 'number';
      segment.retry = argus && event.timedOut !== true;
      if (event.timedOut === true) segment.failed = true;
      this.append(segment, 'retry', 'Retry notice', { source: argus ? 'argus' : 'native', attempt: typeof event.attempt === 'number' ? event.attempt : null, timedOut: event.timedOut === true });
    } else if (type === 'tool_start' || type === 'tool_end') {
      const call = obj(event.call), result = typeof call.result === 'string' ? call.result : '';
      const outputText = safe(result, Math.min(65536, Math.floor(this.eventBudget / 2)));
      this.append(segment, kind, safe(call.name), { id: safe(call.id, 160), name: safe(call.name, 100),
        exitCode: typeof call.exitCode === 'number' && Number.isInteger(call.exitCode) ? call.exitCode : null,
        outcome: ['success', 'failure', 'cancelled'].includes(String(call.outcome)) ? call.outcome : call.error === true ? 'failure' : 'unknown', error: call.error === true },
      type === 'tool_end' ? { text: outputText, originalBytes: Buffer.byteLength(result), truncated: Buffer.byteLength(result) > Buffer.byteLength(outputText) } : undefined);
    } else if (type === 'interaction') {
      if (!event.request) return;
      const request = obj(event.request), questions = Array.isArray(request.questions) ? request.questions : [];
      const truncated = questions.length > 16 || questions.some(value => {
        const q = obj(value), options = Array.isArray(q.options) ? q.options : [];
        return text(q.id, 160) !== q.id || text(q.question, 1024) !== q.question || options.length > 32
          || options.some(o => text(o, 200) !== o);
      }) || text(request.title) !== request.title;
      this.append(segment, kind, safe(request.title), { id: safe(request.id, 160), kind: safe(request.kind, 20), async: request.async === true,
        questions: questions.slice(0, 16).map(value => {
          const q = obj(value); return { id: safe(q.id, 160), question: safe(q.question, 1024), multiSelect: q.multiSelect === true,
            options: (Array.isArray(q.options) ? q.options : []).slice(0, 32).map(o => safe(o, 200)) };
        }), truncated });
    } else if (type === 'interaction_resolved') {
      this.append(segment, kind, 'Interaction resolved', { id: safe(event.id, 160), reason: safe(event.reason, 40) });
    } else if (type === 'user_inject') this.append(segment, 'inject', 'Input injected', { text: safe(event.text, 2048) });
  }
  read(sessionId: string, since?: JournalCursor, full = false) {
    if (since && (typeof since.epoch !== 'string' || !since.epoch || since.epoch.length > 64 || typeof since.generation !== 'string'
      || !since.generation || since.generation.length > 64 || !Number.isSafeInteger(since.seq) || since.seq < 0)) throw Error('invalid_cursor');
    this.sweep();
    const segment = this.sessions.get(sessionId);
    if (!segment) {
      const generation = this.lost.get(sessionId) ?? since?.generation;
      if (!generation) throw Error('unknown_session');
      return { events: [] as JournalEvent[], next: { epoch: this.epoch, generation, seq: 0 },
        reset: since && since.epoch !== this.epoch ? 'epoch' : 'unavailable' as string | null, oldestSeq: 0, hasMore: false };
    }
    segment.read = this.now();
    const oldestSeq = segment.events[0]?.seq ?? segment.seq + 1;
    let reset: string | null = !since ? null : since.epoch !== this.epoch ? 'epoch' : since.generation !== segment.generation ? 'generation'
      : since.seq > segment.seq ? 'future' : since.seq < oldestSeq - 1 ? 'overflow' : null;
    const seq = !since || reset ? oldestSeq - 1 : since.seq;
    const events: JournalEvent[] = []; let size = 512;
    for (const event of segment.events) if (event.seq > seq) {
      const delivered = full ? event : { ...event, output: undefined };
      const eventBytes = bytes(delivered);
      if (events.length >= this.limits.pageEvents || size + eventBytes > this.limits.pageBytes) break;
      // Copy at the observation boundary so callers cannot mutate retained records.
      events.push(JSON.parse(JSON.stringify(delivered)) as JournalEvent); size += eventBytes;
    }
    const next = { epoch: this.epoch, generation: segment.generation, seq: events.at(-1)?.seq ?? seq };
    return { events, next, reset, oldestSeq, hasMore: next.seq < segment.seq };
  }
  async watch(sessionId: string, since?: JournalCursor, full = false, wait = 0, signal?: AbortSignal) {
    const initial = this.read(sessionId, since, full);
    if (!wait || initial.events.length || initial.reset) return initial;
    if (this.listeners.size >= this.limits.waiters) throw Error('busy');
    if (signal?.aborted) throw Error('aborted');
    return new Promise<ReturnType<SessionJournal['read']>>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return; settled = true; clearTimeout(timer); this.listeners.delete(change); signal?.removeEventListener('abort', abort);
        if (signal?.aborted) { reject(Error('aborted')); return; }
        try { const segment = this.sessions.get(sessionId); if (segment) this.flush(segment); resolve(this.read(sessionId, since, full)); }
        catch (error) { reject(error); }
      };
      const change = (id: string | undefined, notable: boolean) => { if (id === sessionId && notable) finish(); };
      const abort = () => finish();
      const timer = setTimeout(finish, wait * 1000);
      this.listeners.add(change); signal?.addEventListener('abort', abort, { once: true });
      const segment = this.sessions.get(sessionId); if (segment) this.trim(segment);
    });
  }
}
export const sessionJournal = new SessionJournal();
