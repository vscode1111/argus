import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The idle-CLI watchdog terminates CLI processes THIS server is holding once their
// session has been idle past `cliIdleTimeoutSec`, reclaiming ~250MB apiece from panels
// left open. Driven here on the compiled bundle against **decoy** processes, never real
// CLIs: `reapIdleCliProcs` takes `now` as an argument, so a decoy can be made to look
// hours idle without waiting, and killProc kills by pid so the decoy need not pretend to
// be a claude.
//
// The control is the whole point. Reaping by elapsed time alone would also kill a CLI
// that is mid-turn, and killing one whose transcript ends on an unanswered user message
// makes the next --resume splice a synthetic "No response requested." assistant turn
// into the conversation, which the model then sees forever
// (!notes/tasks/no-response-requested/notes.md). So a busy entry that looks equally idle
// by the clock must survive.

const ROOT = path.resolve(__dirname, '..');
const CHANNEL_JS = path.join(ROOT, 'out', 'backend', 'channel.js');

interface FakeState {
  currentProc?: ChildProcess;
  currentProcKey?: string;
  cliDone: boolean;
  sessionId?: string;
}

type ChannelModule = {
  getOrCreateChannel(dir: string): {
    addClient(ws: unknown, fresh?: boolean): boolean;
    getClientState(ws: unknown): FakeState;
  };
  destroyChannel(dir: string): void;
  reapIdleCliProcs(idleMs: number, now?: number): Array<{ pid: number; sessionId: string; idleMs: number }>;
};

let mod: ChannelModule;
const spawned: ChildProcess[] = [];

function decoy(): ChildProcess {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true });
  spawned.push(p);
  return p;
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A socket stand-in: the channel only adds it to a Set and calls send() on broadcast.
const fakeWs = () => ({ readyState: 1, send() { /* no client to receive it */ } });

test.beforeAll(() => {
  if (!fs.existsSync(CHANNEL_JS)) execSync('npx tsc -p ./', { cwd: ROOT, stdio: 'inherit' });
  mod = require(CHANNEL_JS) as ChannelModule;
});

test.afterAll(() => {
  for (const p of spawned) { try { p.kill(); } catch { /* already gone */ } }
});

async function settle(): Promise<void> {
  await new Promise(r => setTimeout(r, 700));
}

test.describe('idle CLI reaper', () => {
  test('terminates an idle CLI and spares one that is mid-turn', async () => {
    const dirIdle = 'D:\\scub-reap-idle';
    const dirBusy = 'D:\\scub-reap-busy';
    const idle = decoy();
    const busy = decoy();
    await new Promise(r => setTimeout(r, 400));

    const cIdle = mod.getOrCreateChannel(dirIdle);
    const cBusy = mod.getOrCreateChannel(dirBusy);
    const wsIdle = fakeWs();
    const wsBusy = fakeWs();
    cIdle.addClient(wsIdle);
    cBusy.addClient(wsBusy);

    const sIdle = cIdle.getClientState(wsIdle);
    const sBusy = cBusy.getClientState(wsBusy);
    sIdle.currentProc = idle; sIdle.cliDone = true; sIdle.sessionId = 'sess-idle';
    sBusy.currentProc = busy; sBusy.cliDone = false; sBusy.sessionId = 'sess-busy';

    // Both look hours idle by the clock; only one of them is actually finished.
    const reaped = mod.reapIdleCliProcs(1_000, Date.now() + 3_600_000);
    await settle();

    expect(reaped.map(r => r.sessionId)).toEqual(['sess-idle']);
    expect(alive(idle.pid)).toBe(false);
    // The control: a turn in flight is never interrupted by housekeeping.
    expect(alive(busy.pid)).toBe(true);

    // Detached, so the close event cannot mutate an entry that no longer owns it...
    expect(sIdle.currentProc).toBeUndefined();
    // ...but the session survives, so the next message respawns with --resume and the
    // conversation continues. Dropping this is the difference between reclaiming memory
    // and silently losing the user's context.
    expect(sIdle.sessionId).toBe('sess-idle');
    expect(sBusy.currentProc).toBe(busy);

    mod.destroyChannel(dirIdle);
    mod.destroyChannel(dirBusy);
  });

  test('leaves everything alone until the idle limit is actually reached', async () => {
    const dir = 'D:\\scub-reap-young';
    const young = decoy();
    await new Promise(r => setTimeout(r, 400));

    const ch = mod.getOrCreateChannel(dir);
    const ws = fakeWs();
    ch.addClient(ws);
    const s = ch.getClientState(ws);
    s.currentProc = young; s.cliDone = true; s.sessionId = 'sess-young';

    // Idle for a moment, limit an hour: nothing to do.
    expect(mod.reapIdleCliProcs(3_600_000)).toEqual([]);
    await settle();
    expect(alive(young.pid)).toBe(true);
    expect(s.currentProc).toBe(young);

    mod.destroyChannel(dir);
  });

  test('is disabled by a zero or negative limit rather than reaping everything', async () => {
    const dir = 'D:\\scub-reap-off';
    const proc = decoy();
    await new Promise(r => setTimeout(r, 400));

    const ch = mod.getOrCreateChannel(dir);
    const ws = fakeWs();
    ch.addClient(ws);
    const s = ch.getClientState(ws);
    s.currentProc = proc; s.cliDone = true; s.sessionId = 'sess-off';

    // 0 is the "off" value the config ships with, and the far-future clock means a
    // build that treated it as "idle for longer than 0ms" would kill this instantly.
    expect(mod.reapIdleCliProcs(0, Date.now() + 3_600_000)).toEqual([]);
    await settle();
    expect(alive(proc.pid)).toBe(true);

    mod.destroyChannel(dir);
  });
});
