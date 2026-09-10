import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

// The "CLI launches" value in Settings > Info opens a list of every Claude CLI process
// on the server's machine. `listCliProcesses` is in webview/index.html's MOCK_SUPPRESSED,
// so the live dev backend never answers here and these tests own the data - which is what
// lets them pin cases the real machine would not reproduce on demand (a process with no
// CPU baseline yet, a failed listing).

const ROW = '[data-testid="cli-process-row"]';

function reply(processes: unknown[], extra: Record<string, unknown> = {}) {
  return { type: 'cliProcessList', processes, cores: 8, ...extra };
}

// One process this server owns and one it does not, so every assertion below has a
// control row sitting next to it in the same table.
const SAMPLE = [
  {
    pid: 4242, ppid: 100, startedAt: Date.now() - 3_600_000, cpuSeconds: 125, cpuPercent: 62.4,
    memBytes: 268_435_456, sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', model: 'claude-opus-5',
    command: 'claude.exe --print --resume aaaaaaaa', ours: true, current: true,
    lastActivityAt: Date.now() - 5_400_000, sessionRunning: true,
  },
  {
    pid: 777, ppid: 1, startedAt: Date.now() - 90_000, cpuSeconds: 3, cpuPercent: null,
    memBytes: 104_857_600, command: 'claude.exe --print', ours: false, current: false,
    sessionRunning: null,
  },
];

async function openProcessList(page: import('@playwright/test').Page, processes: unknown[] = SAMPLE, extra: Record<string, unknown> = {}) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Info' }).click();
  await page.getByTestId('cli-launches').click();
  const dialog = page.getByRole('dialog', { name: 'Claude CLI processes' });
  await expect(dialog).toBeVisible();
  // The modal registers its listener in an effect, so re-dispatch until it lands.
  await expect(async () => {
    await page.evaluate(payload => {
      window.dispatchEvent(new MessageEvent('message', { data: payload }));
    }, reply(processes, extra));
    await expect(dialog.getByTestId('cli-processes-body')).not.toContainText('Loading...', { timeout: 250 });
  }).toPass({ timeout: 5000 });
  return { dialog, settings };
}

test.describe('CLI process list', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('clicking the CLI launches value asks the server for the process list', async ({ page }) => {
    // The request never reaches the socket in a mock run - the dev shim suppresses it so
    // the live backend cannot answer with this machine's real processes - and it logs
    // each suppression, which is the only observable proof that the app asked at all.
    const suppressed: string[] = [];
    page.on('console', m => {
      const t = m.text();
      if (t.includes('[mock] suppressed')) suppressed.push(t.replace('[mock] suppressed ', '').trim());
    });

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Info' }).click();
    await page.getByTestId('cli-launches').click();

    await expect(page.getByRole('dialog', { name: 'Claude CLI processes' })).toBeVisible();
    await expect.poll(() => suppressed).toContain('listCliProcesses');
  });

  test('renders each process with its pid, age, cpu time and memory', async ({ page }) => {
    const { dialog } = await openProcessList(page);
    await expect(dialog.locator(ROW)).toHaveCount(2);

    const mine = dialog.locator(`${ROW}[data-pid="4242"]`);
    await expect(mine).toContainText('4242');
    await expect(mine).toContainText('aaaaaaaa');   // session, truncated to its first block
    await expect(mine).toContainText('1h 0m');      // uptime, ticked from startedAt
    await expect(mine).toContainText('2m 5s');      // 125s of CPU time
    await expect(mine).toContainText('256 MB');
    // Kept as an exact match rather than loosened when the ownership clause was added:
    // the whole summary line is worth pinning, and SAMPLE has exactly one owned row.
    await expect(dialog.getByTestId('cli-processes-summary')).toHaveText('2 processes · 356 MB total · 1 from this server');
  });

  test('a process with no CPU baseline yet shows no percentage rather than zero', async ({ page }) => {
    const { dialog } = await openProcessList(page);
    // The server reports null until it has two samples of a pid. Printing "0%" there
    // would claim an idle process, which is the one thing the column must not invent.
    await expect(dialog.locator(`${ROW}[data-pid="777"]`).getByTestId('cli-process-cpu')).toHaveText('-');
    // Control: a row that does have a baseline prints it, so "never render a percent"
    // cannot pass this pair.
    await expect(dialog.locator(`${ROW}[data-pid="4242"]`).getByTestId('cli-process-cpu')).toHaveText('62%');
  });

  test('marks only the process behind this panel', async ({ page }) => {
    const { dialog } = await openProcessList(page);
    await expect(dialog.locator(`${ROW}[data-pid="4242"]`)).toContainText('this panel');
    await expect(dialog.locator(`${ROW}[data-pid="777"]`)).not.toContainText('this panel');
    await expect(dialog.locator(`${ROW}[data-pid="777"]`)).not.toContainText('this server');
  });

  test('reports why a listing failed instead of showing an empty machine', async ({ page }) => {
    const { dialog } = await openProcessList(page, [], { error: 'powershell not found' });
    await expect(dialog.getByTestId('cli-processes-error')).toContainText('powershell not found');
    await expect(dialog.locator(ROW)).toHaveCount(0);
  });

  test('says so when no CLI is running, which is not an error', async ({ page }) => {
    const { dialog } = await openProcessList(page, []);
    await expect(dialog.getByTestId('cli-processes-body')).toContainText('No Claude CLI processes are running.');
    await expect(dialog.getByTestId('cli-processes-error')).toHaveCount(0);
  });

  test('the Info tab counts the live processes, so a 0 launch count is not read as a broken counter', async ({ page }) => {
    // "CLI launches" counts only what THIS server spawned, so a fresh dev server shows 0
    // while ten CLIs run on the machine. Reported as a bug the first time the two sat one
    // click apart with nothing between them: the row below is fed by the same reply the
    // list renders, so the pair can never disagree.
    const { settings, dialog } = await openProcessList(page);
    await expect(settings.getByTestId('cli-processes-count')).toHaveText('2');
    await expect(dialog.locator(ROW)).toHaveCount(2);
  });

  test('says how many of the listed processes are this server\'s, including when none are', async ({ page }) => {
    // The reported confusion: "CLI launches" said 2 while the list showed nothing of
    // ours, because both had since exited. The tally counts spawn *events* and cannot
    // fall, so the answer to "where are they?" has to be stated, not inferred from a
    // group header that isn't there.
    const { dialog, settings } = await openProcessList(page, [
      { ...SAMPLE[1], pid: 10, ours: false, current: false },
      { ...SAMPLE[1], pid: 11, ours: false, current: false },
    ]);
    await expect(dialog.getByTestId('cli-processes-summary')).toContainText('none from this server');
    await expect(settings.getByTestId('cli-launches-scope')).toContainText('0 still alive');

    // Control: with an owned process both places count it, so a build that hardcoded
    // "none" - which would satisfy the assertions above - fails here.
    await page.evaluate(payload => {
      window.dispatchEvent(new MessageEvent('message', { data: payload }));
    }, reply([
      { ...SAMPLE[1], pid: 10, ours: false, current: false },
      { ...SAMPLE[0], pid: 11, ours: true, current: true },
    ]));
    await expect(dialog.getByTestId('cli-processes-summary')).toContainText('1 from this server');
    await expect(settings.getByTestId('cli-launches-scope')).toContainText('1 still alive');
  });

  test('a failed listing leaves the live count blank rather than claiming an empty machine', async ({ page }) => {
    const { settings } = await openProcessList(page, [], { error: 'powershell not found' });
    await expect(settings.getByTestId('cli-processes-count')).toHaveText('-');
    // Control: an empty list with no error is a real answer - zero processes, shown as 0.
    await page.evaluate(payload => {
      window.dispatchEvent(new MessageEvent('message', { data: payload }));
    }, reply([]));
    await expect(settings.getByTestId('cli-processes-count')).toHaveText('0');
  });

  test('distinguishes a session that is mid-turn, one that is idle, and one it cannot know about', async ({ page }) => {
    const { dialog } = await openProcessList(page, [
      { ...SAMPLE[0], pid: 1, sessionRunning: true },
      { ...SAMPLE[0], pid: 2, sessionRunning: false, current: false },
      { ...SAMPLE[1], pid: 3, sessionRunning: null },
    ]);
    const cell = (pid: number) => dialog.locator(`${ROW}[data-pid="${pid}"] [data-testid="cli-process-running"]`);

    await expect(cell(1)).toHaveText('yes');
    await expect(cell(2)).toHaveText('no');
    // The third is the one that matters: only the server that spawned a CLI can tell
    // whether it is working, so a foreign process is unknown - and rendering that as
    // "no" would be a claim the server cannot support. All three are asserted together
    // because collapsing null into false passes any two of them alone.
    await expect(cell(3)).toHaveText('-');
  });

  test('reports when each session was last active, and says nothing when it cannot', async ({ page }) => {
    const { dialog } = await openProcessList(page, [
      { ...SAMPLE[0], pid: 1, lastActivityAt: Date.now() - 7_200_000 },
      { ...SAMPLE[0], pid: 2, lastActivityAt: Date.now() - 30_000 },
      { ...SAMPLE[1], pid: 3, lastActivityAt: undefined },
    ]);
    await expect(dialog.locator(`${ROW}[data-pid="1"]`)).toContainText('2h');
    // Under a minute reads as "now" rather than a jittering seconds counter.
    await expect(dialog.locator(`${ROW}[data-pid="2"]`)).toContainText('now');
    // A session with no transcript on disk yet has no last activity to report; a zero
    // or an epoch date here would invent one.
    const cells = await dialog.locator(`${ROW}[data-pid="3"] td`).allTextContents();
    expect(cells).toContain('-');
  });

  test('groups the CLIs under the process that started each one', async ({ page }) => {
    const { dialog } = await openProcessList(page, [
      { ...SAMPLE[0], owner: { pid: 4128, name: 'code.exe', label: 'Argus daemon', chain: 'cmd.exe (100) <- code.exe (4128)' } },
      { ...SAMPLE[1], owner: { pid: 4128, name: 'code.exe', label: 'Argus daemon', chain: 'cmd.exe (101) <- code.exe (4128)' } },
      { ...SAMPLE[1], pid: 999, owner: { pid: 5000, name: 'node.exe', chain: 'cmd.exe (102) <- node.exe (5000)' } },
    ]);
    const groups = dialog.locator('[data-testid="cli-process-group"]');
    await expect(groups).toHaveCount(2);
    // Two CLIs share one owner and the third has its own - a grouping that keyed off
    // anything but the owner pid would not split them 2/1.
    await expect(groups.filter({ hasText: 'Argus daemon' })).toContainText('2 CLIs');
    await expect(groups.filter({ hasText: 'node.exe (5000)' })).toContainText('1 CLI');
    // The hop the owner search skipped is still readable on the header.
    await expect(groups.first().locator('td')).toHaveAttribute('title', /cmd\.exe \(100\)/);
  });

  test('nests a CLI under the CLI that started it, and counts it in that group', async ({ page }) => {
    const owner = { pid: 4128, name: 'code.exe', label: 'Argus daemon', chain: 'code.exe (4128)' };
    const { dialog } = await openProcessList(page, [
      { ...SAMPLE[0], pid: 100, owner },
      { ...SAMPLE[1], pid: 200, parentCliPid: 100, owner: { pid: 100, name: 'claude.exe', chain: 'claude.exe (100)' } },
    ]);
    // One group, not two: the child belongs to its parent CLI, which belongs to the daemon.
    await expect(dialog.locator('[data-testid="cli-process-group"]')).toHaveCount(1);
    await expect(dialog.locator('[data-testid="cli-process-group"]')).toContainText('2 CLIs');
    // Indented, and rendered after its parent.
    await expect(dialog.locator(`${ROW}[data-pid="200"]`)).toHaveAttribute('data-depth', '1');
    await expect(dialog.locator(`${ROW}[data-pid="100"]`)).toHaveAttribute('data-depth', '0');
    const order = await dialog.locator(ROW).evaluateAll(rows => rows.map(r => r.getAttribute('data-pid')));
    expect(order).toEqual(['100', '200']);
  });

  test('a child whose parent CLI has already exited is shown, not dropped', async ({ page }) => {
    const { dialog } = await openProcessList(page, [
      { ...SAMPLE[0], pid: 200, parentCliPid: 4242, owner: { pid: 4242, name: 'claude.exe', chain: 'claude.exe (4242)' } },
    ]);
    // Nesting under an absent parent would hide the row entirely - it has to fall back
    // to being a root of its own group.
    await expect(dialog.locator(ROW)).toHaveCount(1);
    await expect(dialog.locator(`${ROW}[data-pid="200"]`)).toHaveAttribute('data-depth', '0');
  });

  test('the Flat view drops the grouping and keeps every row', async ({ page }) => {
    const { dialog } = await openProcessList(page, [
      { ...SAMPLE[0], pid: 100, owner: { pid: 4128, name: 'code.exe', chain: 'code.exe (4128)' } },
      { ...SAMPLE[1], pid: 200, parentCliPid: 100, owner: { pid: 100, name: 'claude.exe', chain: 'claude.exe (100)' } },
    ]);
    await dialog.getByTestId('cli-processes-view').click();
    await expect(dialog.getByTestId('cli-processes-view')).toHaveText('Flat');
    await expect(dialog.locator('[data-testid="cli-process-group"]')).toHaveCount(0);
    // A nested row must survive the switch - flattening by "roots only" would lose it.
    await expect(dialog.locator(ROW)).toHaveCount(2);
    await expect(dialog.locator(`${ROW}[data-pid="200"]`)).toHaveAttribute('data-depth', '0');
  });

  test('the terminate button asks the server to kill that pid and drops the row', async ({ page }) => {
    // killCliProcess is in MOCK_SUPPRESSED, so this click cannot reach the live backend
    // and really kill a CLI on the machine running the suite; the suppression log is also
    // the only place an outgoing message is observable.
    const suppressed: string[] = [];
    page.on('console', m => {
      const t = m.text();
      if (t.includes('[mock] suppressed')) suppressed.push(t.replace('[mock] suppressed ', '').trim());
    });

    const { dialog } = await openProcessList(page);
    await dialog.locator(`${ROW}[data-pid="4242"] [data-testid="cli-process-kill"]`).click();

    await expect.poll(() => suppressed).toContain('killCliProcess');
    // Gone immediately, like Session History's delete - waiting for the next poll would
    // leave a row the user has already told to die sitting there for up to three seconds.
    await expect(dialog.locator(`${ROW}[data-pid="4242"]`)).toHaveCount(0);
    // Control: the row next to it is untouched, so "clear the table" cannot pass.
    await expect(dialog.locator(`${ROW}[data-pid="777"]`)).toHaveCount(1);
  });

  test('a refused kill says so instead of leaving the row silently gone', async ({ page }) => {
    const { dialog } = await openProcessList(page);
    await dialog.locator(`${ROW}[data-pid="4242"] [data-testid="cli-process-kill"]`).click();
    await expect(dialog.locator(`${ROW}[data-pid="4242"]`)).toHaveCount(0);

    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'cliProcessKilled', pid: 4242, killed: false, error: 'not a running Claude CLI process' },
      }));
    });
    // The row was removed optimistically, so a failure that said nothing would read as a
    // successful kill until the next poll quietly put the process back.
    await expect(dialog.getByTestId('cli-process-kill-error')).toContainText('Could not stop 4242');
    await expect(dialog.getByTestId('cli-process-kill-error')).toContainText('not a running Claude CLI process');
  });

  test('the terminate button stays hidden until its row is hovered', async ({ page }) => {
    const { dialog } = await openProcessList(page);
    const btn = dialog.locator(`${ROW}[data-pid="4242"] [data-testid="cli-process-kill"]`);
    // Same affordance as Session History's delete: present for every row, revealed only
    // for the one under the cursor, so a mis-aimed click cannot land on a neighbour.
    await expect(btn).toHaveCSS('opacity', '0');
    await dialog.locator(`${ROW}[data-pid="4242"]`).hover();
    await expect(btn).not.toHaveCSS('opacity', '0');
  });

  test('Escape closes the process list and leaves Settings open behind it', async ({ page }) => {
    const { dialog, settings } = await openProcessList(page);
    // Both modals listen for Escape on window, so an unguarded Settings handler would
    // close both at once and dump the user out of the panel they came from.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(settings).toBeVisible();
  });
});
