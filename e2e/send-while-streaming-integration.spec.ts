import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('send while streaming', () => {
  // Both tests run a whole turn with a mid-turn inject folded into it, and the second runs
  // a second turn after that. They were written against the old 90s project timeout - the
  // comment below still refers to it - and were never rebudgeted when it flattened to 30s,
  // which no longer covers even one turn here with margin: a fresh session in this
  // workspace starts at ~77k input tokens, so a turn costs 5-20s. Observed failing both
  // inside a full suite run and in isolation, always on the wait rather than on an inject
  // assertion (!notes/common/e2e-testing.md, timeout section).
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
    // Start each test in a clean session. Integration tests share a channel entry
    // (same workspace dir, fresh=false), so replayed history from a previous test
    // contains completed timers that cause false-positive checks (e.g. timer.last()
    // matches an old turn before the current one finishes). newSession resets the
    // entry state and kills any orphaned CLI from a prior timeout, preventing cascade.
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 5_000 });
  });

  test('second message sent during streaming appears as inline inject', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');

    // Send a task long enough to leave room for a mid-turn inject.
    await textarea.fill('Read package.json, then read CLAUDE.md, then summarize both.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Gate on the Stop button, not on a tool call: whether the model actually calls a
    // tool (and how fast) is its own choice, so a toolCall locator is a model-dependent
    // proxy that intermittently never appears. Stop is rendered for every active turn,
    // which is exactly the precondition here - the turn is still in flight.
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });

    // Inject second message while the turn is still running
    await textarea.fill('What is 123 + 456? Reply with just the number.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the whole turn (including the inject) to complete. We gate on the Stop
    // button disappearing rather than timer.first(): timer.first() could match a timer
    // from a replayed prior turn and produce a false positive before the CLI finishes.
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 90_000 });

    // The injected user message should appear inline as a userInject block
    const inject = page.locator('div[class*="userInject"]');
    await expect(inject).toBeVisible();
    await expect(inject).toContainText('123 + 456');

    // No error blocks
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);
  });

  test('can send normally after mid-turn inject completes', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');

    // First: a task with tool calls
    await textarea.fill('Read package.json and tell me the version number.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Gate on the Stop button rather than a tool call - see the note in the test above:
    // a toolCall locator depends on the model choosing to call a tool, Stop does not.
    const stopBtn = page.getByRole('button', { name: 'Stop' });
    await expect(stopBtn).toBeVisible({ timeout: 30_000 });

    // Inject a short question mid-turn
    await textarea.fill('Say "scub-inject-ok" and nothing else.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the whole turn (inject included) to complete. We gate on the Stop button
    // disappearing rather than timer.last(): timer.last() can match a timer from a
    // replayed older turn and return a false positive before the current CLI turn
    // finishes. That false positive would cause the follow-up send to arrive mid-turn
    // as a second inject, inflating the combined CLI work past the 90s test timeout.
    await expect(stopBtn).toHaveCount(0, { timeout: 60_000 });

    // Inject should be visible
    const inject = page.locator('div[class*="userInject"]');
    await expect(inject).toBeVisible();

    // Now send a regular follow-up (between turns, not mid-turn)
    await textarea.fill('Say "scub-followup-ok" and nothing else.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the follow-up turn to start (Stop button appears), then complete (Stop gone)
    await expect(stopBtn).toBeVisible({ timeout: 30_000 });
    await expect(stopBtn).toHaveCount(0, { timeout: 90_000 });

    // Now we have at least 2 timers - assert the follow-up text is present
    await expect(page.getByText('scub-followup-ok').first()).toBeVisible({ timeout: 10_000 });

    // No error blocks
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);
  });
});
