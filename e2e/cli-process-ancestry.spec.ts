import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// resolveAncestry answers "which process started this CLI" by walking up the parent
// chain. Its interesting cases cannot be produced on a real machine on demand - you
// cannot ask Windows for a pid cycle, and a CLI that shells out to another CLI needs a
// live agent doing exactly that at the moment the test runs - so it is exercised as the
// pure function it is, against the compiled bundle. No page, no CLI, no OS call.
//
// What it must get right, measured against the real tree first (see
// !notes/tasks/cli-process-list/notes.md): every CLI here sits under a cmd.exe that
// Argus itself inserts via `spawn(..., { shell: IS_WIN })`, and one sat NINE levels deep
// under yarn/tsx wrappers. Rendering that literally, Process Explorer style, indents a
// CLI nine times to say nothing, so the walk skips shell wrappers and stops at the first
// process that actually means something.

const ROOT = path.resolve(__dirname, '..');
const PROCESSES_JS = path.join(ROOT, 'out', 'backend', 'processes.js');

const CLI = process.platform === 'win32' ? 'claude.exe' : 'claude';

interface Proc { pid: number; ppid: number; name: string; startedAt: number; cpuSeconds: number; cpuPercent: null; memBytes: number; command: string }

type AncestryModule = {
  resolveAncestry(
    proc: Proc,
    all: Map<number, Proc>,
    labelFor?: (p: Proc) => string | undefined,
  ): { parentCliPid?: number; owner?: { pid: number; name: string; label?: string; chain: string } };
};

function proc(pid: number, ppid: number, name: string, command = ''): Proc {
  return { pid, ppid, name, startedAt: 0, cpuSeconds: 0, cpuPercent: null, memBytes: 0, command };
}

function tree(...procs: Proc[]): Map<number, Proc> {
  return new Map(procs.map(p => [p.pid, p]));
}

let mod: AncestryModule;

test.beforeAll(() => {
  if (!fs.existsSync(PROCESSES_JS)) execSync('npx tsc -p ./', { cwd: ROOT, stdio: 'inherit' });
  mod = require(PROCESSES_JS) as AncestryModule;
});

test.describe('CLI process ancestry', () => {
  test('skips the shell Argus spawns through and reports the real owner', async () => {
    const cli = proc(100, 200, CLI);
    const all = tree(cli, proc(200, 300, 'cmd.exe'), proc(300, 1, 'code.exe'));

    const { owner, parentCliPid } = mod.resolveAncestry(cli, all);
    // cmd.exe owns nothing - it is the wrapper `shell: IS_WIN` inserts.
    expect(owner?.pid).toBe(300);
    expect(owner?.name).toBe('code.exe');
    expect(parentCliPid).toBeUndefined();
    // Collapsed, not hidden: the skipped hop is still in the chain shown on hover.
    expect(owner?.chain).toBe(`cmd.exe (200) <- code.exe (300)`);
  });

  test('nests a CLI that another CLI started, through its shell', async () => {
    const child = proc(100, 200, CLI);
    const all = tree(child, proc(200, 300, 'cmd.exe'), proc(300, 400, CLI), proc(400, 1, 'code.exe'));

    const { parentCliPid, owner } = mod.resolveAncestry(child, all);
    // An agent shelling out to `claude` is real nesting worth drawing, so the walk stops
    // at the parent CLI instead of hoisting both to the code.exe above them.
    expect(parentCliPid).toBe(300);
    expect(owner?.pid).toBe(300);
  });

  test('does not treat an interactive shell as a wrapper', async () => {
    const cli = proc(100, 200, CLI);
    const all = tree(cli, proc(200, 300, 'powershell.exe'), proc(300, 1, 'windowsterminal.exe'));

    // A CLI a person started by hand really is owned by the terminal they typed it in;
    // only the shells inserted programmatically are skipped.
    expect(mod.resolveAncestry(cli, all).owner?.name).toBe('powershell.exe');
  });

  test('terminates on a parent cycle instead of hanging the server', async () => {
    const cli = proc(100, 200, CLI);
    // Windows recycles pids, so a stale ppid really can point back down the chain.
    const all = tree(cli, proc(200, 100, 'cmd.exe'));

    const { owner } = mod.resolveAncestry(cli, all);
    expect(owner?.chain).toBe('cmd.exe (200)');
  });

  test('handles a CLI whose launcher has already exited', async () => {
    const cli = proc(100, 999, CLI);
    const { owner, parentCliPid } = mod.resolveAncestry(cli, tree(cli));

    // Nothing above it is alive: no owner to name, and nothing to nest under.
    expect(owner).toBeUndefined();
    expect(parentCliPid).toBeUndefined();
  });

  test('applies the caller label to the owner it settles on', async () => {
    const cli = proc(100, 200, CLI);
    const all = tree(cli, proc(200, 300, 'cmd.exe'), proc(300, 1, 'code.exe'));

    const { owner } = mod.resolveAncestry(cli, all, p => (p.pid === 300 ? 'Argus daemon' : undefined));
    // The label has to land on the process the walk stopped at, not on the wrapper it
    // passed through - a "code.exe (4128)" row is unidentifiable without it.
    expect(owner?.label).toBe('Argus daemon');
  });
});
