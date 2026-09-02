# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: session-active-marker-integration.spec.ts >> running-session marker (integration) >> a turn running in one panel is marked in another panel list
- Location: e2e\session-active-marker-integration.spec.ts:73:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('dialog', { name: 'Session History' }).locator('[data-session-id="09b76117-2eb9-4dd4-9edd-0c23f97d312e"]')
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
  - waiting for getByRole('dialog', { name: 'Session History' }).locator('[data-session-id="09b76117-2eb9-4dd4-9edd-0c23f97d312e"]')

```

# Page snapshot

```yaml
- generic [ref=e4]:
  - generic [ref=e5]:
    - generic [ref=e6]:
      - button "New chat" [ref=e7] [cursor=pointer]:
        - img [ref=e8]
      - button "Refresh current session" [disabled] [ref=e10] [cursor=pointer]:
        - img [ref=e11]
      - button "Session history" [ref=e15] [cursor=pointer]:
        - img [ref=e16]
      - button "Switch workspace" [ref=e17] [cursor=pointer]:
        - generic [ref=e18]: argus
      - 'button "Usage limits. Session (5hr): 30% · Resets in 1h 24m · Thu 1:59 AM. Weekly (7 day): 18% · Resets in 3d 20h · Sun 8:59 PM. Weekly Fable: 0%" [ref=e19] [cursor=pointer]'
      - button "Hide session bar" [ref=e25] [cursor=pointer]:
        - img [ref=e26]
    - generic [ref=e30]:
      - generic [ref=e31]:
        - generic [ref=e32]: "Run exactly `sleep 10` with the Bash tool, in the foreground (not in the background), then reply DONE."
        - button "Copy to clipboard" [ref=e33] [cursor=pointer]: ⧉
      - generic [ref=e34]:
        - generic [ref=e36]:
          - generic [ref=e37]: Bash
          - generic "Sleep for 10 seconds" [ref=e38]
          - generic "sleep 10" [ref=e39]
        - generic [ref=e40]: 16s (2s) · 98,967 in / 82 out
    - generic [ref=e41]:
      - generic [ref=e43]:
        - textbox "Ask Argus... (paste images, text, or PDFs with Ctrl+V)" [ref=e45]
        - generic "Connected" [ref=e46]
      - generic [ref=e47]:
        - generic [ref=e48]:
          - button "Edit" [ref=e49] [cursor=pointer]
          - 'generic "49% used Input: 98,967 tokens Output: 17 tokens Window: 200,000 tokens" [ref=e50]': 49%
          - button "Settings" [ref=e52] [cursor=pointer]: ⚙
        - generic [ref=e53]:
          - button "Send" [active] [ref=e54] [cursor=pointer]:
            - img [ref=e55]
          - button "Stop" [ref=e57] [cursor=pointer]:
            - img [ref=e58]
  - generic [ref=e62]:
    - generic [ref=e63]:
      - generic [ref=e64]: Debug Log (17)
      - generic [ref=e65]:
        - button "⚙" [ref=e67] [cursor=pointer]
        - button "Clear" [ref=e68] [cursor=pointer]
        - button "✕" [ref=e69] [cursor=pointer]
    - generic [ref=e71]:
      - generic [ref=e72]:
        - generic [ref=e73]:
          - generic [ref=e74]: 00:35:41.381
          - generic [ref=e75]: INFO
        - generic [ref=e76]: "Spawning claude: --print --verbose --output-format stream-json --input-format stream-json --include-partial-messages --tools Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch,AskUserQuestion --allowedTools Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch,AskUserQuestion --effort low"
      - generic [ref=e77]:
        - generic [ref=e78]:
          - generic [ref=e79]: 00:35:41.412
          - generic [ref=e80]: DEBUG
        - generic [ref=e81]: "stdin: 181 bytes"
      - generic [ref=e82]:
        - generic [ref=e83]:
          - generic [ref=e84]: 00:35:42.377
          - generic [ref=e85]: DEBUG
        - generic [ref=e86]: "event: system {\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"D:\\\\_Projects\\\\scub111g\\\\argus\",\"session_id\":\"09b76117-2eb9-4dd4-9edd-0c23f97d3"
      - generic [ref=e87]:
        - generic [ref=e88]:
          - generic [ref=e89]: 00:35:42.377
          - generic [ref=e90]: DEBUG
        - generic [ref=e91]: "event: system {\"type\":\"system\",\"subtype\":\"status\",\"status\":\"requesting\",\"uuid\":\"0d15d1ae-30d9-4896-a8a6-9051a7671fd1\",\"session_id\":\"09"
      - generic [ref=e92]:
        - generic [ref=e93]:
          - generic [ref=e94]: 00:35:43.316
          - generic [ref=e95]: DEBUG
        - generic [ref=e96]: "event: rate_limit_event {\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed\",\"resetsAt\":1788390000,\"rateLimitType\":\"five_hour\",\"over"
      - generic [ref=e97]:
        - generic [ref=e98]:
          - generic [ref=e99]: 00:35:44.746
          - generic [ref=e100]: DEBUG
        - generic [ref=e101]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-5\",\"id\":\"msg_011CefLEJCiguHYnAH"
      - generic [ref=e102]:
        - generic [ref=e103]:
          - generic [ref=e104]: 00:35:44.746
          - generic [ref=e105]: DEBUG
        - generic [ref=e106]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01"
      - generic [ref=e107]:
        - generic [ref=e108]:
          - generic [ref=e109]: 00:35:44.746
          - generic [ref=e110]: DEBUG
        - generic [ref=e111]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\""
      - generic [ref=e112]:
        - generic [ref=e113]:
          - generic [ref=e114]: 00:35:45.619
          - generic [ref=e115]: DEBUG
        - generic [ref=e116]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\""
      - generic [ref=e117]:
        - generic [ref=e118]:
          - generic [ref=e119]: 00:35:45.620
          - generic [ref=e120]: DEBUG
        - generic [ref=e121]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\""
      - generic [ref=e122]:
        - generic [ref=e123]:
          - generic [ref=e124]: 00:35:45.620
          - generic [ref=e125]: DEBUG
        - generic [ref=e126]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\""
      - generic [ref=e127]:
        - generic [ref=e128]:
          - generic [ref=e129]: 00:35:45.636
          - generic [ref=e130]: DEBUG
        - generic [ref=e131]: "event: assistant {\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-5\",\"id\":\"msg_011CefLEJCiguHYnAHS8RmZE\",\"type\":\"message\",\"role\":\"as"
      - generic [ref=e132]:
        - generic [ref=e133]:
          - generic [ref=e134]: 00:35:45.636
          - generic [ref=e135]: INFO
        - generic [ref=e136]: "tool_start: Bash (toolu_01FxV4RXMQjn3C2Dj6zrcoyB)"
      - generic [ref=e137]:
        - generic [ref=e138]:
          - generic [ref=e139]: 00:35:45.671
          - generic [ref=e140]: DEBUG
        - generic [ref=e141]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0},\"session_id\":\"09b76117-2eb9-4dd4-9edd-0c23f97d312"
      - generic [ref=e142]:
        - generic [ref=e143]:
          - generic [ref=e144]: 00:35:45.672
          - generic [ref=e145]: DEBUG
        - generic [ref=e146]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null,\"stop_deta"
      - generic [ref=e147]:
        - generic [ref=e148]:
          - generic [ref=e149]: 00:35:45.678
          - generic [ref=e150]: DEBUG
        - generic [ref=e151]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"message_stop\"},\"session_id\":\"09b76117-2eb9-4dd4-9edd-0c23f97d312e\",\"parent_tool_"
      - generic [ref=e152]:
        - generic [ref=e153]:
          - generic [ref=e154]: 00:35:54.654
          - generic [ref=e155]: DEBUG
        - generic [ref=e156]: "event: system {\"type\":\"system\",\"subtype\":\"task_started\",\"task_id\":\"bgkj10ryw\",\"tool_use_id\":\"toolu_01FxV4RXMQjn3C2Dj6zrcoyB\",\"descript"
```

# Test source

```ts
  1  | import { test, expect, type Page } from '@playwright/test';
  2  | import { waitForApp } from './helpers';
  3  | 
  4  | // The running-session marker end to end against the real backend: `listActiveSessions`
  5  | // in channel.ts reports every entry that holds a live CLI process mid-turn, and
  6  | // `notifyActiveSessions` pushes that set to every client of every workspace channel.
  7  | // These are integration tests because the set is derived from real spawned processes,
  8  | // and because the point of the feature is that a turn started in one panel is visible
  9  | // in another one's history list.
  10 | 
  11 | // The turn has to still be running while a modal opens AND a session list loads off disk.
  12 | // A generation-length prompt does not buy that: "list the numbers from 1 to 300" came back
  13 | // in 6s (~610 output tokens - the model abbreviates rather than emitting 300 lines), which
  14 | // flaked both tests, one on the marker already being gone and one on the row not being
  15 | // listed yet. How long the model talks is model-owned; a Bash sleep is not, and holds the
  16 | // turn open for a fixed window however fast the model is. Bash is in ALLOWED_TOOLS, so it
  17 | // needs no approval, and Stop kills the whole process tree with it.
  18 | const LONG_PROMPT = 'Run exactly `sleep 10` with the Bash tool, in the foreground (not in the background), then reply DONE.';
  19 | 
  20 | async function startTurn(page: Page, prompt: string) {
  21 |   await page.getByPlaceholder('Ask Argus').fill(prompt);
  22 |   await page.getByRole('button', { name: 'Send' }).click();
  23 |   await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 15_000 });
  24 | }
  25 | 
  26 | // The browser shim keeps ?session=<id> in step with the live session, so the id the
  27 | // CLI assigned is readable from the address bar once its first event lands.
  28 | async function currentSessionId(page: Page): Promise<string> {
  29 |   let id: string | null = null;
  30 |   await expect.poll(
  31 |     () => { id = new URL(page.url()).searchParams.get('session'); return id; },
  32 |     { timeout: 20_000 },
  33 |   ).not.toBeNull();
  34 |   return id!;
  35 | }
  36 | 
  37 | async function openHistory(page: Page) {
  38 |   await page.getByRole('button', { name: 'Session history' }).click();
  39 |   const dialog = page.getByRole('dialog', { name: 'Session History' });
  40 |   await expect(dialog).toBeVisible();
  41 |   return dialog;
  42 | }
  43 | 
  44 | test.describe('running-session marker (integration)', () => {
  45 |   test('the live session is marked while its turn runs and unmarked when it ends', async ({ page }) => {
  46 |     await waitForApp(page);
  47 |     await startTurn(page, LONG_PROMPT);
  48 |     const id = await currentSessionId(page);
  49 | 
  50 |     // Mid-turn: the session's own row is both the current one and marked as working.
  51 |     const dialog = await openHistory(page);
  52 |     const row = dialog.locator(`[data-session-id="${id}"]`);
  53 |     await expect(row).toBeVisible({ timeout: 15_000 });
  54 |     await expect(row.getByRole('img', { name: 'Working now' })).toHaveCount(1, { timeout: 15_000 });
  55 | 
  56 |     // The modal must be closed to reach Stop: the centered-modal shell renders a
  57 |     // full-viewport `.overlay` (position: fixed; inset: 0) as its click-outside-to-close
  58 |     // catcher, so it swallows every click behind it. Stopping with the list open is not
  59 |     // something a user can do either. The "mark clears while the list stays open" case is
  60 |     // the second test's job, where the stop comes from a different page.
  61 |     await page.keyboard.press('Escape');
  62 |     await expect(dialog).toHaveCount(0);
  63 |     await page.getByRole('button', { name: 'Stop' }).click();
  64 | 
  65 |     // Reopening reads the ids from App state (server-pushed), not from the row cache,
  66 |     // so the finished turn is unmarked.
  67 |     const reopened = await openHistory(page);
  68 |     const stoppedRow = reopened.locator(`[data-session-id="${id}"]`);
  69 |     await expect(stoppedRow).toBeVisible({ timeout: 15_000 });
  70 |     await expect(stoppedRow.getByRole('img', { name: 'Working now' })).toHaveCount(0, { timeout: 15_000 });
  71 |   });
  72 | 
  73 |   test('a turn running in one panel is marked in another panel list', async ({ page, context }) => {
  74 |     await waitForApp(page);
  75 |     const other = await context.newPage();
  76 |     await waitForApp(other);
  77 | 
  78 |     // The second page is a separate client with its own session entry, so anything it
  79 |     // shows about the first page's session came from the server's active set.
  80 |     await startTurn(page, LONG_PROMPT);
  81 |     const id = await currentSessionId(page);
  82 | 
  83 |     const dialog = await openHistory(other);
  84 |     const row = dialog.locator(`[data-session-id="${id}"]`);
> 85 |     await expect(row).toBeVisible({ timeout: 15_000 });
     |                       ^ Error: expect(locator).toBeVisible() failed
  86 |     await expect(row.getByRole('img', { name: 'Working now' })).toHaveCount(1, { timeout: 15_000 });
  87 | 
  88 |     await page.getByRole('button', { name: 'Stop' }).click();
  89 |     await expect(row.getByRole('img', { name: 'Working now' })).toHaveCount(0, { timeout: 15_000 });
  90 |     await other.close();
  91 |   });
  92 | });
  93 | 
```