# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: version-skew.spec.ts >> Client/Server version skew direction >> flags the Client row when the daemon is newer, not the Server row
- Location: e2e\version-skew.spec.ts:51:7

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  getByRole('dialog', { name: 'Settings' }).getByTestId('client-version')
Expected: "0.0.79 (stale)"
Received: "0.0.91"
Timeout:  5000ms

Call log:
  - Expect "toHaveText" with timeout 5000ms
  - waiting for getByRole('dialog', { name: 'Settings' }).getByTestId('client-version')
    9 × locator resolved to <span class="_infoValue_1s54r_403" data-testid="client-version">0.0.91</span>
      - unexpected value "0.0.91"

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
      - button "Account & usage" [ref=e19] [cursor=pointer]:
        - img [ref=e20]
      - button "Hide session bar" [ref=e22] [cursor=pointer]:
        - img [ref=e23]
    - generic [ref=e28]:
      - generic [ref=e30]:
        - textbox "Ask Argus... (paste images, text, or PDFs with Ctrl+V)" [ref=e32]
        - generic "Connected" [ref=e33]
      - generic [ref=e34]:
        - generic [ref=e35]:
          - button "Edit" [ref=e36] [cursor=pointer]
          - generic [ref=e37]:
            - button "Settings" [ref=e38] [cursor=pointer]: ⚙
            - dialog "Settings" [ref=e40]:
              - button "Close settings" [ref=e42] [cursor=pointer]: ×
              - generic [ref=e43]:
                - generic [ref=e44]:
                  - button "General" [ref=e45] [cursor=pointer]
                  - button "Watchdog" [ref=e46] [cursor=pointer]
                  - button "Network" [ref=e47] [cursor=pointer]
                  - button "Info" [active] [ref=e48] [cursor=pointer]
                - generic [ref=e49]:
                  - generic [ref=e50]:
                    - generic "Version of this extension/UI build" [ref=e51]: Client
                    - generic [ref=e52]: 0.0.91
                  - generic [ref=e53]:
                    - generic "Version of the daemon serving this panel. The daemon is a separate install found through a machine-global discovery file, so an older one left running elsewhere can serve a newer UI - which then silently misses features." [ref=e54]: Server
                    - generic "Serving daemon is 0.0.80, this build is 0.0.91 - restart the daemon" [ref=e55]: 0.0.80 (stale)
                  - generic [ref=e56]:
                    - generic [ref=e57]: Path
                    - button "D:\\_Projects\\scub111g\\argus" [ref=e58] [cursor=pointer]
                  - generic [ref=e59]:
                    - generic "Number of Claude CLI processes spawned since the server started (or since the last 'Stop all Claude CLI processes')" [ref=e60]: CLI launches
                    - generic [ref=e61]: "1"
                  - generic [ref=e62]:
                    - generic "Id of the conversation this panel is in. Empty until the CLI reports one (a new chat has none until its first turn)." [ref=e63]: Session
                    - generic [ref=e64]: (no session yet)
                  - generic [ref=e65]:
                    - generic "Transcript file the CLI stores this conversation in" [ref=e66]: Transcript
                    - generic [ref=e67]: "-"
                  - generic [ref=e68]:
                    - generic [ref=e69]: Force-stops every Claude Code CLI process on this machine (all workspaces and terminals) - not just this panel's session.
                    - button "Stop all Claude CLI processes" [ref=e70] [cursor=pointer]
                    - generic [ref=e71]: Shuts down the Argus daemon serving this panel, the same as running yarn daemon:stop. Every panel on it disconnects and any running turn ends.
                    - button "Stop daemon" [ref=e72] [cursor=pointer]
              - button "Toggle debug panel" [ref=e73] [cursor=pointer]: dev
              - button "Reset dialog layout" [ref=e74] [cursor=pointer]: Reset layout
        - button "Send" [ref=e76] [cursor=pointer]:
          - img [ref=e77]
  - generic [ref=e81]:
    - generic [ref=e82]:
      - generic [ref=e83]: Debug Log
      - generic [ref=e84]:
        - button "⚙" [ref=e86] [cursor=pointer]
        - button "Clear" [ref=e87] [cursor=pointer]
        - button "✕" [ref=e88] [cursor=pointer]
    - generic [ref=e91]: No log entries yet. Send a message to see communication logs.
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import { waitForApp } from './helpers';
  3  | 
  4  | // Settings > Info shows Client (this build) and Server (the daemon serving the
  5  | // panel) versions, and flags whichever one is actually behind with "(stale)". A
  6  | // plain inequality check can't tell direction, so it used to always blame the
  7  | // Server row even when the daemon was the newer side - see SettingsModal.tsx's
  8  | // versionCompare/serverIsStale/clientIsStale.
  9  | 
  10 | async function openInfoTab(page: import('@playwright/test').Page) {
  11 |   await page.getByRole('button', { name: 'Settings' }).click();
  12 |   const dialog = page.getByRole('dialog', { name: 'Settings' });
  13 |   await expect(dialog).toBeVisible();
  14 |   await dialog.getByRole('button', { name: 'Info' }).click();
  15 |   return dialog;
  16 | }
  17 | 
  18 | function setClientVersion(page: import('@playwright/test').Page, version: string) {
  19 |   return page.evaluate((v) => {
  20 |     window.dispatchEvent(new MessageEvent('message', { data: { type: 'workspaceInfo', path: '/tmp/scub-workspace', version: v } }));
  21 |   }, version);
  22 | }
  23 | 
  24 | function setServerVersion(page: import('@playwright/test').Page, serverVersion: string) {
  25 |   return page.evaluate((v) => {
  26 |     window.dispatchEvent(new MessageEvent('message', { data: { type: 'serverInfo', port: 3001, cliLaunchCount: 1, sessionId: '', sessionPath: null, serverVersion: v } }));
  27 |   }, serverVersion);
  28 | }
  29 | 
  30 | test.describe('Client/Server version skew direction', () => {
  31 |   test.beforeEach(async ({ page }) => {
  32 |     // Opening the Info tab posts a real getServerInfo at the live mock-project
  33 |     // backend; its reply carries the dev server's actual version and lands after
  34 |     // setServerVersion's mock, clobbering it (invisible while the real version
  35 |     // happened to equal the mocked one, guaranteed red once they diverge - e.g.
  36 |     // after a version bump). getServerInfo cannot go into MOCK_SUPPRESSED
  37 |     // (kill-all-claude.spec.ts asserts on the outgoing send), so drop the frame
  38 |     // at the socket for this spec only, before the app scripts load.
  39 |     await page.addInitScript(() => {
  40 |       const origSend = WebSocket.prototype.send;
  41 |       WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
  42 |         try {
  43 |           if (typeof data === 'string' && JSON.parse(data).type === 'getServerInfo') return;
  44 |         } catch { /* not JSON - pass through */ }
  45 |         return origSend.call(this, data);
  46 |       };
  47 |     });
  48 |     await waitForApp(page);
  49 |   });
  50 | 
  51 |   test('flags the Client row when the daemon is newer, not the Server row', async ({ page }) => {
  52 |     await setClientVersion(page, '0.0.79');
  53 |     const dialog = await openInfoTab(page);
  54 |     await setServerVersion(page, '0.0.80');
  55 | 
> 56 |     await expect(dialog.getByTestId('client-version')).toHaveText('0.0.79 (stale)');
     |                                                        ^ Error: expect(locator).toHaveText(expected) failed
  57 |     await expect(dialog.getByTestId('server-version')).toHaveText('0.0.80');
  58 |     await expect(dialog.getByTestId('server-version')).not.toContainText('stale');
  59 |   });
  60 | 
  61 |   test('flags the Server row when the daemon is older, not the Client row', async ({ page }) => {
  62 |     await setClientVersion(page, '0.0.80');
  63 |     const dialog = await openInfoTab(page);
  64 |     await setServerVersion(page, '0.0.79');
  65 | 
  66 |     await expect(dialog.getByTestId('server-version')).toHaveText('0.0.79 (stale)');
  67 |     await expect(dialog.getByTestId('client-version')).toHaveText('0.0.80');
  68 |     await expect(dialog.getByTestId('client-version')).not.toContainText('stale');
  69 |   });
  70 | 
  71 |   test('compares version segments numerically, not lexicographically', async ({ page }) => {
  72 |     // A string compare puts "0.0.9" after "0.0.10" (since '9' > '1'), which would
  73 |     // wrongly flag the newer 0.0.10 client as stale.
  74 |     await setClientVersion(page, '0.0.10');
  75 |     const dialog = await openInfoTab(page);
  76 |     await setServerVersion(page, '0.0.9');
  77 | 
  78 |     await expect(dialog.getByTestId('server-version')).toHaveText('0.0.9 (stale)');
  79 |     await expect(dialog.getByTestId('client-version')).toHaveText('0.0.10');
  80 |     await expect(dialog.getByTestId('client-version')).not.toContainText('stale');
  81 |   });
  82 | 
  83 |   test('matching versions are never flagged on either side', async ({ page }) => {
  84 |     await setClientVersion(page, '0.0.80');
  85 |     const dialog = await openInfoTab(page);
  86 |     await setServerVersion(page, '0.0.80');
  87 | 
  88 |     await expect(dialog.getByTestId('client-version')).toHaveText('0.0.80');
  89 |     await expect(dialog.getByTestId('server-version')).toHaveText('0.0.80');
  90 |   });
  91 | });
  92 | 
```