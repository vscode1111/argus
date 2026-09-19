import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The idle-connection reaper (channel.ts reapIdleClients) closes every client of a
// session entry this server holds once that entry has sat idle past
// `connectionIdleTimeoutSec` - the same clock and the same "never touch a mid-turn
// entry" rule as reapIdleCliProcs (cli-idle-reaper.spec.ts), one layer up: that one
// reclaims a finished process, this one reclaims the connection and, eventually, the
// entry itself. Driven directly on the compiled bundle with fake sockets - no real
// WebSocket, no real CLI - since the question is purely which entries reapIdleClients
// decides to touch and what it does to them.
//
// The decisive control is the same shape as the CLI reaper's: an entry that looks
// equally idle by the clock but is mid-turn must survive, or a real conversation could
// be cut off mid-turn by housekeeping.
//
const ROOT = path.resolve(__dirname, '..');
const CHANNEL_JS = path.join(ROOT, 'out', 'backend', 'channel.js');

interface FakeState {
  currentProc?: { pid: number };
  currentProcKey?: string;
  cliDone: boolean;
  sessionId?: string;
}

interface FakeWs {
  readyState: number;
  send(): void;
  close(code?: number, reason?: string): void;
  closes: Array<{ code?: number; reason?: string }>;
}

type ChannelModule = {
  getOrCreateChannel(dir: string): {
    addClient(ws: unknown, fresh?: boolean, sessionId?: string, panelId?: string): boolean;
    getClientState(ws: unknown): FakeState;
    removeClient(ws: unknown): void;
  };
  destroyChannel(dir: string): void;
  reapIdleClients(idleMs: number, now?: number): Array<{ workspacePath: string; sessionId: string; clientsClosed: number; idleMs: number }>;
  CLOSE_CODE_IDLE: number;
};

let mod: ChannelModule;

test.beforeAll(() => {
  if (!fs.existsSync(CHANNEL_JS)) execSync('npx tsc -p ./', { cwd: ROOT, stdio: 'inherit' });
  mod = require(CHANNEL_JS) as ChannelModule;
  // Shortens the 30s post-disconnect eviction grace period so the ownerLastSession
  // tests below do not have to wait out the real thing; read fresh per call in
  // channel.ts (not captured at import), so it cannot leak into another spec file that
  // happens to load the same compiled module later in a reused worker. Set here rather
  // than at module top-level: with --repeat-each, beforeAll/afterAll re-fire once per
  // repeat while top-level module code runs only once (require caching), so a
  // top-level set paired with an afterAll delete left every repeat after the first
  // with the env var gone and the real 30s delay silently back in effect - measured via
  // a diagnostic log, not assumed.
  process.env.ARGUS_ENTRY_GRACE_MS = '150';
});

test.afterAll(() => {
  delete process.env.ARGUS_ENTRY_GRACE_MS;
});

// A distinct registry key per test/repeat, so a --repeat-each run (or a grace timer left
// over from a previous test) can never collide on the same dir.
function uniqueDir(tag: string): string {
  return `D:\\scub-connreap-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// A socket stand-in that records what was closed and how, and can be told to answer a
// send the way the channel expects (it never reads the return value).
function fakeWs(): FakeWs {
  const closes: Array<{ code?: number; reason?: string }> = [];
  return {
    readyState: 1,
    send() { /* no client to receive it */ },
    close(code?: number, reason?: string) { this.readyState = 3; closes.push({ code, reason }); },
    closes,
  };
}

async function settle(ms = 50): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

test.describe('idle connection reaper', () => {
  test('closes an idle entry\'s clients and spares one that is mid-turn', async () => {
    const dirIdle = uniqueDir('idle');
    const dirBusy = uniqueDir('busy');
    const cIdle = mod.getOrCreateChannel(dirIdle);
    const cBusy = mod.getOrCreateChannel(dirBusy);
    const wsIdle = fakeWs();
    const wsBusy = fakeWs();
    cIdle.addClient(wsIdle);
    cBusy.addClient(wsBusy);

    const sIdle = cIdle.getClientState(wsIdle);
    const sBusy = cBusy.getClientState(wsBusy);
    sIdle.cliDone = true; sIdle.sessionId = 'sess-conn-idle';
    sBusy.currentProc = { pid: 999999 }; sBusy.cliDone = false; sBusy.sessionId = 'sess-conn-busy';

    // Both entries look hours idle by the clock; only one of them is actually finished.
    const reaped = mod.reapIdleClients(1_000, Date.now() + 3_600_000);
    await settle();

    expect(reaped.map(r => r.sessionId)).toEqual(['sess-conn-idle']);
    expect(wsIdle.closes).toEqual([{ code: mod.CLOSE_CODE_IDLE, reason: 'Idle connection closed to save resources' }]);
    // The control: a turn in flight is never interrupted by housekeeping.
    expect(wsBusy.closes).toEqual([]);

    cIdle.removeClient(wsIdle);
    cBusy.removeClient(wsBusy);
    mod.destroyChannel(dirIdle);
    mod.destroyChannel(dirBusy);
  });

  test('leaves everything alone until the idle limit is actually reached', async () => {
    const dir = uniqueDir('young');
    const ch = mod.getOrCreateChannel(dir);
    const ws = fakeWs();
    ch.addClient(ws);
    ch.getClientState(ws).cliDone = true;

    expect(mod.reapIdleClients(3_600_000)).toEqual([]);
    await settle();
    expect(ws.closes).toEqual([]);

    ch.removeClient(ws);
    mod.destroyChannel(dir);
  });

  test('is disabled by a zero or negative limit rather than reaping everything', async () => {
    const dir = uniqueDir('off');
    const ch = mod.getOrCreateChannel(dir);
    const ws = fakeWs();
    ch.addClient(ws);
    ch.getClientState(ws).cliDone = true;

    // 0 is the "off" value the config ships with, and the far-future clock means a
    // build that treated it as "idle for longer than 0ms" would close this instantly.
    expect(mod.reapIdleClients(0, Date.now() + 3_600_000)).toEqual([]);
    await settle();
    expect(ws.closes).toEqual([]);

    ch.removeClient(ws);
    mod.destroyChannel(dir);
  });

  test('does not touch an entry with no clients - it is already on the ordinary eviction path', async () => {
    const dir = uniqueDir('empty');
    const ch = mod.getOrCreateChannel(dir);
    const ws = fakeWs();
    ch.addClient(ws);
    ch.getClientState(ws).cliDone = true;
    ch.removeClient(ws); // entry now has zero clients, grace timer already scheduled

    expect(mod.reapIdleClients(1_000, Date.now() + 3_600_000)).toEqual([]);

    // Let the (shortened) grace timer run out so it doesn't leak into the next test.
    await settle(700);
    mod.destroyChannel(dir);
  });
});

// A panel's session entry is owned by its panelId, so a reconnect after the entry has
// fully evicted (idle-closed and nobody reconnected within the grace window, or a
// manual disconnect from Connected Clients the user did not act on quickly) would
// otherwise create a brand-new entry with an empty sessionId - the next message would
// silently start a fresh CLI conversation instead of resuming, even though the client's
// own view of the old transcript is still on screen (a WS reconnect never clears it).
// ownerLastSession is what keeps a much-later reconnect resumable, the same guarantee
// reapIdleCliProcs already makes for a killed process, one layer up.
test.describe('session id survives full entry eviction (ownerLastSession)', () => {
  test('a quick reconnect (within the grace window) still finds the live entry', async () => {
    // The ordinary, common-case path - not what this describe block is about, but the
    // control that makes the next test meaningful: without it, a build that always
    // created a fresh entry (defeating panel reconnection entirely) would still pass
    // "restores the last known sessionId" below, for the wrong reason.
    const dir = uniqueDir('quick');
    const ch = mod.getOrCreateChannel(dir);
    const ws1 = fakeWs();
    ch.addClient(ws1, false, undefined, 'panel-a');
    ch.getClientState(ws1).sessionId = 'sess-quick-rejoin';
    ch.removeClient(ws1); // last client leaves - grace timer starts, entry still alive

    const ws2 = fakeWs();
    expect(ch.addClient(ws2, false, undefined, 'panel-a')).toBe(true);
    expect(ch.getClientState(ws2).sessionId).toBe('sess-quick-rejoin');

    ch.removeClient(ws2);
    await settle(700); // let the grace timer run out so it doesn't leak into later tests
    mod.destroyChannel(dir);
  });

  test('a panelId reconnect after eviction restores the last known sessionId', async () => {
    const dir = uniqueDir('resume');
    const ch = mod.getOrCreateChannel(dir);
    const ws1 = fakeWs();
    ch.addClient(ws1, false, undefined, 'panel-a');
    ch.getClientState(ws1).sessionId = 'sess-resume-me';
    ch.removeClient(ws1); // last client leaves - grace timer starts, entry still alive

    // Wait out the (test-shortened) grace period so the entry actually evicts.
    await settle(700);

    const ws2 = fakeWs();
    const attached = ch.addClient(ws2, false, undefined, 'panel-a');
    // No live entry to rejoin - a fresh one was created (this is the regression case:
    // without the fix, a fresh entry has an empty sessionId here).
    expect(attached).toBe(false);
    expect(ch.getClientState(ws2).sessionId).toBe('sess-resume-me');

    ch.removeClient(ws2);
    mod.destroyChannel(dir);
  });

  test('an entry with no sessionId at eviction clears a stale mapping instead of leaving it', async () => {
    const dir = uniqueDir('forget');
    const ch = mod.getOrCreateChannel(dir);

    // First entry: a real session, evicted - seeds the map.
    const ws1 = fakeWs();
    ch.addClient(ws1, false, undefined, 'panel-b');
    ch.getClientState(ws1).sessionId = 'sess-should-be-forgotten';
    ch.removeClient(ws1);
    await settle(700);

    // Second entry for the SAME panel (e.g. "New chat" was clicked): reconnecting first
    // picks up the old mapping (expected - the fix cannot distinguish this from an
    // ordinary reconnect yet), but the moment this new, sessionId-less entry evicts in
    // turn, the stale mapping must be cleared rather than left pointing at the old one.
    const ws2 = fakeWs();
    ch.addClient(ws2, false, undefined, 'panel-b');
    expect(ch.getClientState(ws2).sessionId).toBe('sess-should-be-forgotten');
    // Simulate "New chat": the entry moves on with no sessionId of its own (a fresh
    // conversation the CLI has not named yet).
    ch.getClientState(ws2).sessionId = undefined;
    ch.removeClient(ws2);
    await settle(700);

    const ws3 = fakeWs();
    ch.addClient(ws3, false, undefined, 'panel-b');
    // Control: without the clear-on-empty fix, this would still read the first
    // session's id, silently resurrecting a conversation the user had already left.
    expect(ch.getClientState(ws3).sessionId).toBeUndefined();

    ch.removeClient(ws3);
    mod.destroyChannel(dir);
  });
});
