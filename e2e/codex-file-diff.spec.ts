import { test, expect } from '@playwright/test';
import * as path from 'path';
import { waitForApp } from './helpers';

test('file change opens the original patch for each changed file', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const call = {
      id: 'scub-change-1', name: 'fileChange', kind: 'fileChange',
      input: { changes: [
        { path: 'D:/scub/one.ts', kind: { type: 'update' }, diff: '@@ -1,2 +1,2 @@\n scub-context\n-scub-old\n+scub-new\n@@ -20 +20 @@\n-scub-later-old\n+scub-later-new\n' },
        { path: 'D:/scub/two.ts', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+scub-second-file\n' },
      ] },
      result: 'completed',
    };
    for (const data of [
      { type: 'thinking_start' },
      { type: 'tool_start', call: { ...call, input: { changes: [] }, result: undefined } },
      { type: 'tool_end', call },
      { type: 'done' },
    ]) window.dispatchEvent(new MessageEvent('message', { data }));
  });

  const firstLink = page.getByRole('link', { name: 'fileChange' });
  const secondFile = page.getByRole('link', { name: 'D:/scub/two.ts' });
  await expect(firstLink).toBeVisible();
  await expect(secondFile).toBeVisible();
  await expect(firstLink.locator('..').locator('[class*="statsAdded"]')).toHaveText('+3');
  await expect(firstLink.locator('..').locator('[class*="statsRemoved"]')).toHaveText('-2');
  await expect(secondFile.locator('..').locator('[class*="statsAdded"]')).toHaveText('+1');
  await expect(secondFile.locator('..').locator('[class*="statsRemoved"]')).toHaveText('-0');
  await secondFile.locator('..').getByRole('link', { name: 'Diff' }).click();
  const secondDiff = page.getByRole('dialog', { name: 'Diff: D:/scub/two.ts' });
  await expect(secondDiff).toBeVisible();
  await expect(secondDiff.getByText('scub-second-file')).toBeVisible();
  await expect(secondDiff.getByText('scub-old')).toHaveCount(0);
  await secondDiff.getByRole('button', { name: 'Close' }).click();

  await firstLink.click();
  const firstDiff = page.getByRole('dialog', { name: 'Diff: D:/scub/one.ts' });
  await expect(firstDiff).toBeVisible();
  await expect(firstDiff.getByText('scub-old')).toBeVisible();
  await expect(firstDiff.getByText('scub-new')).toBeVisible();
  await expect(firstDiff.getByText('scub-later-old')).toBeVisible();
  await expect(firstDiff.getByText('scub-later-new')).toBeVisible();
  await expect(firstDiff.getByText('@@ -20 +20 @@')).toBeVisible();
  await expect(firstDiff.getByText('+2', { exact: true })).toBeVisible();
  await expect(firstDiff.getByText('-2', { exact: true })).toBeVisible();
});

test('single file change shows additions and removals beside the diff link', async ({ page }) => {
  await waitForApp(page);
  const filePath = path.resolve(__dirname, 'fixtures', 'scub-file-change.txt');
  await page.evaluate(filePath => {
    const call = {
      id: 'scub-change-single', name: 'fileChange', kind: 'fileChange',
      input: { changes: [{
        path: filePath, kind: { type: 'update' },
        diff: '--- a/scub-file-change.txt\n+++ b/scub-file-change.txt\n@@ -1 +1,2 @@\n-scub-before\n+scub-after\n+scub-extra\n',
      }] }, result: 'completed',
    };
    for (const data of [
      { type: 'thinking_start' },
      { type: 'tool_start', call: { ...call, input: { changes: [] }, result: undefined } },
      { type: 'tool_end', call },
      { type: 'done' },
    ]) window.dispatchEvent(new MessageEvent('message', { data }));
  }, filePath);
  const diffLink = page.getByRole('link', { name: 'Diff' });
  const row = diffLink.locator('..');
  await expect(row.locator('[class*="statsAdded"]')).toHaveText('+2');
  await expect(row.locator('[class*="statsRemoved"]')).toHaveText('-1');
  await page.getByRole('link', { name: filePath }).click();
  const fileViewer = page.getByRole('dialog', { name: 'File viewer: scub-file-change.txt' });
  await expect(fileViewer.getByText('scub-current-file-content')).toBeVisible();
  await fileViewer.getByRole('button', { name: 'Close' }).click();
  await diffLink.click();
  await expect(page.getByRole('dialog', { name: `Diff: ${filePath}` })).toBeVisible();
});
