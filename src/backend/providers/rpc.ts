import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { win32 as path } from 'path';
import { killProc } from '../cli';
import { resolveCodexBinary } from './executable';
import { noteCliLaunch } from '../cliLaunchCount';

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function string(value: unknown): string { return typeof value === 'string' ? value : ''; }

// Bidirectional JSONL RPC. A server request is NOT a notification: it needs one response.
export class AppServerRpc {
  private proc?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 0;
  private buffer = '';
  private closed = false;
  private pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  onMessage: (method: string, params: JsonObject, id?: string | number) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  get pid(): number | undefined { return this.proc?.pid; }

  constructor(private readonly binary = resolveCodexBinary(), private readonly args = ['app-server']) {}

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.initialize();
    return this.ready;
  }

  private async initialize(): Promise<void> {
    if (this.closed) throw new Error('Provider connection is closed');
    let env: NodeJS.ProcessEnv | undefined;
    if (process.platform === 'win32') {
      const gitBashDir = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin');
      if (existsSync(path.join(gitBashDir, 'bash.exe'))) {
        const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
        env = { ...process.env, [pathKey]: `${gitBashDir};${process.env[pathKey] || ''}` };
      }
    }
    this.proc = spawn(this.binary, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, env });
    if (this.proc.pid) noteCliLaunch('codex');
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 32 * 1024 * 1024) return this.fail(new Error('Provider frame exceeds the size limit'));
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(object(JSON.parse(line))); }
        catch { this.fail(new Error('Invalid provider protocol message')); break; }
      }
    });
    // Never relay raw stderr: runtimes may include private configuration in diagnostics.
    this.proc.stderr.resume();
    this.proc.on('error', () => this.fail(new Error('Cannot start Codex. Install its CLI or set ARGUS_CODEX_BIN on the server.')));
    this.proc.on('exit', () => this.fail(new Error('Provider process exited. Reopen the conversation before retrying.')));
    await this.request('initialize', { clientInfo: { name: 'argus', version: '0.0.104' } });
    this.write({ method: 'initialized' });
  }

  request(method: string, params: JsonObject = {}): Promise<JsonObject> {
    if (this.closed) return Promise.reject(new Error('Provider connection is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Provider request timed out: ${method}. Its execution status may be unknown.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id: string | number, result: JsonObject): void { this.write({ id, result }); }
  reject(id: string | number): void { this.write({ id, error: { code: -32601, message: 'This interaction is not supported by Argus' } }); }

  private write(message: JsonObject): void {
    if (this.closed || !this.proc?.stdin.writable) throw new Error('Provider connection is closed');
    this.proc.stdin.write(JSON.stringify(message) + '\n', error => { if (error) this.fail(new Error('Provider input pipe closed')); });
  }

  private receive(message: JsonObject): void {
    if (typeof message.method === 'string') {
      const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : undefined;
      this.onMessage(message.method, object(message.params), id);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(string(object(message.error).message) || 'Provider request failed'));
    else pending.resolve(object(message.result));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.dispose();
    this.onFailure(error);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Provider connection closed')); }
    this.pending.clear();
    if (this.proc) killProc(this.proc);
  }
}
