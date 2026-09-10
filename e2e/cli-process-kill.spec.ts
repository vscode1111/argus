import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// killCliProcess terminates one Claude CLI by pid. The pid comes from a client, so the
// guard that it names an actual CLI is the security boundary here: without it, anything
// that can open a WebSocket to Argus could ask the server to kill any process on the
// machine.
//
// The guard is tested by aiming the kill at THIS test process, which is a node, not a
// claude. A build that dropped the check would kill the runner and the failure would be
// impossible to miss. Nothing else here kills anything: the success path is exercised by
// hand against a decoy (a copy of node.exe named claude.exe) rather than automated, since
// a suite that hunts for real claude.exe processes would eventually find a live session
// on whoever's machine runs it - the same reason e2e/kill-all-claude.spec.ts never
// performs its second click.

const ROOT = path.resolve(__dirname, '..');
const PROCESSES_JS = path.join(ROOT, 'out', 'backend', 'processes.js');

type KillModule = {
  killCliProcess(pid: number): Promise<{ pid: number; killed: boolean; error?: string }>;
};

let mod: KillModule;

test.beforeAll(() => {
  if (!fs.existsSync(PROCESSES_JS)) execSync('npx tsc -p ./', { cwd: ROOT, stdio: 'inherit' });
  mod = require(PROCESSES_JS) as KillModule;
});

test.describe('terminating one CLI process', () => {
  test('refuses a pid that is not a Claude CLI - including this test runner', async () => {
    const before = process.pid;
    const result = await mod.killCliProcess(process.pid);

    expect(result.killed).toBe(false);
    expect(result.error).toMatch(/not a running Claude CLI process/);
    // Reached at all, so the runner survived; asserted anyway to say what the test means.
    expect(process.pid).toBe(before);
  });

  test.describe('rejects a malformed pid without going near the OS', () => {
    for (const pid of [0, -1, 1.5, NaN]) {
      test(`pid ${pid}`, async () => {
        const result = await mod.killCliProcess(pid);
        expect(result.killed).toBe(false);
        expect(result.error).toBe('invalid pid');
      });
    }
  });

  test('reports a pid that is not running at all as not a CLI, rather than claiming success', async () => {
    // Well above the Windows/Linux pid ceiling in practice, so nothing can own it.
    const result = await mod.killCliProcess(4_000_000);
    expect(result.killed).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
