import { test, expect } from './provider-fixtures';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  ensureCompiled, startDaemon, readInfo, isAlive, stopDaemon, waitFor, daemonEnv,
  type DaemonHandle,
} from './daemonHelpers';

// The discovery file used to be written once, at startup, and losing it was therefore
// permanent rather than awkward. Reported 2026-09-27: a healthy daemon (pid 17368,
// port 37071, answering /health) sat behind a panel stuck on "Starting Argus
// daemon...", across VS Code restarts, because the file was gone while the process was
// alive and still holding the port. Nothing could recover that on its own - the
// extension read no file and spawned a replacement, the replacement died on EADDRINUSE
// against the incumbent, and the nonce needed to reach the incumbent existed only in
// its memory. The daemon now re-asserts its own registration on a timer, being the
// only party that knows the nonce.
//
// Real daemon processes on private ports + throwaway discovery files, so none of this
// touches the user's own ~/.claude/argus-daemon.json. Serial to keep ports predictable.
test.describe.configure({ mode: 'serial' });

const DAEMON_JS = path.resolve(__dirname, '..', 'out', 'backend', 'daemon.js');
const HEAL_MS = 300;

test.describe('daemon registration heal (integration)', () => {
  let d: DaemonHandle | undefined;

  test.beforeAll(() => ensureCompiled());
  test.afterEach(() => { stopDaemon(d); d = undefined; });

  test('rewrites its discovery file after it is deleted', { tag: ["@shared"] }, async () => {
    const PORT = 3921;
    d = await startDaemon({ port: PORT, healMs: HEAL_MS });
    const before = readInfo(d.file);

    fs.unlinkSync(d.file);
    expect(fs.existsSync(d.file)).toBe(false);

    expect(await waitFor(() => fs.existsSync(d!.file), 5000)).toBe(true);
    const after = readInfo(d.file);
    // The same registration, not a fresh one. The nonce above all cannot be
    // regenerated: it is what every already-connected client is holding, and a new
    // value would lock them out just as thoroughly as the missing file did.
    expect(after.pid).toBe(before.pid);
    expect(after.port).toBe(before.port);
    expect(after.nonce).toBe(before.nonce);
    expect(isAlive(before.pid)).toBe(true);
  });

  // The control, and the reason the heal tests for a *missing* file rather than for
  // one that does not name us. Without this, a build that rewrote the file on every
  // tick regardless of its contents would satisfy both other tests while stranding
  // whichever daemon had legitimately registered - the same failure, pointed the
  // other way.
  test('leaves a discovery file that names another daemon alone', { tag: ["@shared"] }, async () => {
    const PORT = 3922;
    d = await startDaemon({ port: PORT, healMs: HEAL_MS });
    const mine = readInfo(d.file);

    const foreign = {
      port: PORT + 500,
      nonce: 'f'.repeat(32),
      pid: mine.pid + 1,
      version: '9.9.9',
      startedAt: 1,
    };
    fs.writeFileSync(d.file, JSON.stringify(foreign));

    await new Promise((r) => setTimeout(r, HEAL_MS * 6));
    expect(readInfo(d.file)).toEqual(foreign);
    expect(isAlive(mine.pid)).toBe(true); // still running, just not the registered one
  });

  test('a launch after the file was restored declines instead of dying on EADDRINUSE', { tag: ["@shared"] }, async () => {
    const PORT = 3923;
    d = await startDaemon({ port: PORT, healMs: HEAL_MS });
    const first = readInfo(d.file);

    // Reproduce the reported state, then let the daemon repair it.
    fs.unlinkSync(d.file);
    expect(await waitFor(() => fs.existsSync(d!.file), 5000)).toBe(true);

    // With the registration back, the single-instance guard can see the incumbent and
    // step aside. Without the heal this exits 1: no file to read, so it tries to bind
    // the port the incumbent holds. That is the loop the user sat in, one spawn per
    // reconnect, until the error toast gave up.
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn(process.execPath, [DAEMON_JS], {
        env: daemonEnv({ ARGUS_DAEMON_PORT: String(PORT), ARGUS_DAEMON_FILE: d!.file }),
        stdio: 'ignore',
      });
      p.on('exit', resolve);
    });

    expect(code).toBe(0);
    expect(isAlive(first.pid)).toBe(true);
    expect(readInfo(d.file).pid).toBe(first.pid);
  });
});
