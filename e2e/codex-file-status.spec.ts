import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('file changes distinguish added, deleted, and edited paths', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const call = {
      id: 'scub-status', name: 'fileChange', kind: 'fileChange',
      input: { changes: [
        { path: 'D:/scub/added.txt', kind: { type: 'add' }, diff: '' },
        { path: 'D:/scub/deleted.txt', kind: { type: 'delete' }, diff: '' },
        { path: 'D:/scub/edited.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-scub-old\n+scub-new\n' },
      ] }, result: 'completed',
    };
    for (const data of [
      { type: 'thinking_start' },
      { type: 'tool_start', call: { ...call, input: { changes: [] }, result: undefined } },
      { type: 'tool_end', call },
      { type: 'done' },
    ]) window.dispatchEvent(new MessageEvent('message', { data }));
  });

  const header = page.getByRole('link', { name: 'fileChange' }).locator('..');
  const added = page.getByText('D:/scub/added.txt').locator('..');
  const deleted = page.getByText('D:/scub/deleted.txt').locator('..');
  const edited = page.getByRole('link', { name: 'D:/scub/edited.txt' }).locator('..');

  await expect(header.locator('[class*="statsAdded"]')).toHaveText('+1');
  await expect(header.locator('[class*="statsRemoved"]')).toHaveText('-1');
  for (const row of [added, deleted]) {
    await expect(row.locator('[class*="statsAdded"], [class*="statsRemoved"]')).toHaveCount(0);
    await expect(row.getByRole('link', { name: 'Diff' })).toHaveCount(0);
  }
  await expect(added.locator('[class*="fileChangePath"]')).toHaveCSS('color', 'rgb(133, 232, 157)');
  await expect(deleted.locator('[class*="fileChangePath"]')).toHaveCSS('color', 'rgb(249, 117, 131)');
  await expect(deleted.locator('[class*="fileChangePath"]')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(edited.locator('[class*="statsAdded"]')).toHaveText('+1');
  await expect(edited.locator('[class*="statsRemoved"]')).toHaveText('-1');
  await page.getByRole('link', { name: 'fileChange' }).click();
  await expect(page.getByRole('dialog', { name: 'Diff: D:/scub/edited.txt' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Diff: D:/scub/edited.txt' }).getByRole('button', { name: 'Close' }).click();
  await edited.getByRole('link', { name: 'Diff' }).click();
  await expect(page.getByRole('dialog', { name: 'Diff: D:/scub/edited.txt' })).toBeVisible();
});

test('a single new file with no patch has no empty diff controls', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const call = {
      id: 'scub-single-status', name: 'fileChange', kind: 'fileChange',
      input: { changes: [{ path: 'D:/scub/new.txt', kind: { type: 'add' }, diff: '' }] },
      result: 'completed',
    };
    for (const data of [
      { type: 'thinking_start' },
      { type: 'tool_start', call: { ...call, input: { changes: [] }, result: undefined } },
      { type: 'tool_end', call },
      { type: 'done' },
    ]) window.dispatchEvent(new MessageEvent('message', { data }));
  });

  const name = page.getByText('fileChange', { exact: true });
  const row = name.locator('..');
  const file = page.getByRole('link', { name: 'D:/scub/new.txt' });
  await expect(name).toBeVisible();
  await expect(page.getByRole('link', { name: 'fileChange' })).toHaveCount(0);
  await expect(row.locator('[class*="statsAdded"], [class*="statsRemoved"]')).toHaveCount(0);
  await expect(row.getByRole('link', { name: 'Diff' })).toHaveCount(0);
  await expect(file).toHaveCSS('color', 'rgb(133, 232, 157)');
});

test('a single deleted file is struck through and cannot open a removed path', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const call = {
      id: 'scub-single-delete', name: 'fileChange', kind: 'fileChange',
      input: { changes: [{ path: 'D:/scub/removed.txt', kind: { type: 'delete' }, diff: '' }] },
      result: 'completed',
    };
    for (const data of [
      { type: 'thinking_start' },
      { type: 'tool_start', call: { ...call, input: { changes: [] }, result: undefined } },
      { type: 'tool_end', call },
      { type: 'done' },
    ]) window.dispatchEvent(new MessageEvent('message', { data }));
  });

  const file = page.getByText('D:/scub/removed.txt');
  const row = file.locator('..');
  await expect(file).toHaveCSS('color', 'rgb(249, 117, 131)');
  await expect(file).toHaveCSS('text-decoration-line', 'line-through');
  await expect(page.getByRole('link', { name: 'D:/scub/removed.txt' })).toHaveCount(0);
  await expect(row.locator('[class*="statsAdded"], [class*="statsRemoved"]')).toHaveCount(0);
  await expect(row.getByRole('link', { name: 'Diff' })).toHaveCount(0);
});

test('metadata-only patch keeps Diff but shows no zero counters', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const call = {
      id: 'scub-metadata', name: 'fileChange', kind: 'fileChange',
      input: { changes: [{
        path: 'D:/scub/moved.txt', kind: { type: 'update' },
        diff: 'diff --git a/scub-old.txt b/scub-moved.txt\nrename from scub-old.txt\nrename to scub-moved.txt\n',
      }] }, result: 'completed',
    };
    for (const data of [
      { type: 'thinking_start' },
      { type: 'tool_start', call: { ...call, input: { changes: [] }, result: undefined } },
      { type: 'tool_end', call },
      { type: 'done' },
    ]) window.dispatchEvent(new MessageEvent('message', { data }));
  });

  const diff = page.getByRole('link', { name: 'Diff' });
  const row = diff.locator('..');
  await expect(row.locator('[class*="statsAdded"], [class*="statsRemoved"]')).toHaveCount(0);
  await diff.click();
  const dialog = page.getByRole('dialog', { name: 'Diff: D:/scub/moved.txt' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[class*="statsAdded"], [class*="statsRemoved"]')).toHaveCount(0);
});
