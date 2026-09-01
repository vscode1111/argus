# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tool-image-preview.spec.ts >> tool image preview >> a text Read still opens from the result it already has
- Location: e2e\tool-image-preview.spec.ts:100:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('[data-line="1"]')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('[data-line="1"]')

```

# Page snapshot

```yaml
- generic [ref=e1]:
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
        - generic [ref=e31]: Read
        - link "D:/scub/notes.md" [active] [ref=e32] [cursor=pointer]:
          - /url: "#"
      - generic [ref=e33]: 0s (20:54:01)
    - generic [ref=e34]:
      - generic [ref=e36]:
        - textbox "Ask Argus... (paste images, text, or PDFs with Ctrl+V)" [ref=e38]
        - generic "Connected" [ref=e39]
      - generic [ref=e40]:
        - generic [ref=e41]:
          - button "Edit" [ref=e42] [cursor=pointer]
          - button "Settings" [ref=e44] [cursor=pointer]: ⚙
        - button "Send" [ref=e46] [cursor=pointer]:
          - img [ref=e47]
  - dialog [ref=e50]:
    - generic [ref=e51]:
      - generic [ref=e52]:
        - generic [ref=e53]: D:/scub/notes.md
        - button [ref=e54] [cursor=pointer]:
          - img [ref=e55]
      - generic [ref=e58]:
        - combobox [ref=e59] [cursor=pointer]
        - button [ref=e60] [cursor=pointer]: ×
    - paragraph [ref=e63]: hello scub
```

# Test source

```ts
  7   |  *
  8   |  * The regression: the preview re-read the file off disk, so any image the agent had
  9   |  * since renamed, packaged or deleted opened as `Error reading file: ENOENT` rendered
  10  |  * as line 1 of a text file - while the bytes the model actually saw were sitting in
  11  |  * the transcript the whole time. They no longer travel inside the message (a session
  12  |  * of 48 image reads shipped 23.4MB of base64 that nothing rendered), so the click has
  13  |  * to fetch them by tool call id.
  14  |  */
  15  | 
  16  | // 1x1 transparent PNG. Small enough to inline, real enough for <img> to accept.
  17  | const PNG_1PX =
  18  |   'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  19  | 
  20  | function emitRead(page: Page, id: string, path: string, result: string) {
  21  |   return page.evaluate(({ id, path, result }) => {
  22  |     const input = { file_path: path };
  23  |     function fire(data: object) {
  24  |       window.dispatchEvent(new MessageEvent('message', { data }));
  25  |     }
  26  |     fire({ type: 'thinking_start' });
  27  |     fire({ type: 'tool_start', call: { id, name: 'Read', input } });
  28  |     fire({ type: 'tool_end', call: { id, name: 'Read', input, result } });
  29  |     fire({ type: 'done' });
  30  |   }, { id, path, result });
  31  | }
  32  | 
  33  | function reply(page: Page, data: object) {
  34  |   return page.evaluate((d) => {
  35  |     window.dispatchEvent(new MessageEvent('message', { data: d }));
  36  |   }, data);
  37  | }
  38  | 
  39  | // Outgoing webview->server messages never surface on window's own 'message' event.
  40  | // `readToolImage` is in the dev shim's MOCK_SUPPRESSED list (so the live backend
  41  | // cannot answer it in a mock run), and suppression is logged - which is exactly the
  42  | // hook needed to prove the app asked for it. `readFilePreview` is NOT suppressed, so
  43  | // it would reach the socket, and the prototype patch is what proves it did not.
  44  | async function watchRequests(page: Page) {
  45  |   const suppressed: string[] = [];
  46  |   page.on('console', (m) => {
  47  |     const t = m.text();
  48  |     if (t.includes('[mock] suppressed')) suppressed.push(t.replace('[mock] suppressed ', '').trim());
  49  |   });
  50  |   await page.evaluate(() => {
  51  |     const seen: string[] = [];
  52  |     (window as unknown as { __sentTypes: string[] }).__sentTypes = seen;
  53  |     const origSend = WebSocket.prototype.send;
  54  |     WebSocket.prototype.send = function (this: WebSocket, data: unknown) {
  55  |       try {
  56  |         const msg = JSON.parse(data as string);
  57  |         if (msg && typeof msg.type === 'string') seen.push(msg.type);
  58  |       } catch { /* binary frame */ }
  59  |       return origSend.call(this, data as string);
  60  |     };
  61  |   });
  62  |   return {
  63  |     suppressed,
  64  |     sent: () => page.evaluate(() => (window as unknown as { __sentTypes: string[] }).__sentTypes.slice()),
  65  |   };
  66  | }
  67  | 
  68  | const dialog = (page: Page) => page.locator('[role="dialog"]');
  69  | 
  70  | test.describe('tool image preview', () => {
  71  |   test.beforeEach(async ({ page }) => {
  72  |     await waitForApp(page);
  73  |   });
  74  | 
  75  |   test('an image Read fetches the tool image by id, never re-reads the file', async ({ page }) => {
  76  |     const watch = await watchRequests(page);
  77  |     // The result the backend now sends for an image: a marker, no bytes.
  78  |     await emitRead(page, 'img-1', 'D:/scub/gone/scub-scan.png', '[image image/png 174 KB]');
  79  | 
  80  |     const link = page.locator('[class*="toolFileLink"]', { hasText: 'scub-scan.png' });
  81  |     await expect(link).toBeVisible();
  82  |     await link.click();
  83  | 
  84  |     await expect(async () => {
  85  |       expect(watch.suppressed).toContain('readToolImage');
  86  |     }).toPass({ timeout: 3_000 });
  87  |     expect(await watch.sent()).not.toContain('readFilePreview');
  88  | 
  89  |     // A reply for a different tool call must not open this one: the match is on the
  90  |     // call id, which is what makes two images in one turn land in the right modal.
  91  |     await reply(page, { type: 'toolImage', toolUseId: 'img-OTHER', path: 'D:/scub/other.png', content: PNG_1PX });
  92  |     await expect(dialog(page)).toBeHidden();
  93  | 
  94  |     await reply(page, { type: 'toolImage', toolUseId: 'img-1', path: 'D:/scub/gone/scub-scan.png', content: PNG_1PX });
  95  |     const img = dialog(page).locator('img');
  96  |     await expect(img).toBeVisible({ timeout: 5_000 });
  97  |     expect(await img.getAttribute('src')).toBe(PNG_1PX);
  98  |   });
  99  | 
  100 |   test('a text Read still opens from the result it already has', async ({ page }) => {
  101 |     // The control. Without it, a build that asked for a tool image on every file - or
  102 |     // one that asked for nothing at all - would pass the test above.
  103 |     const watch = await watchRequests(page);
  104 |     await emitRead(page, 'txt-1', 'D:/scub/notes.md', '     1\thello scub');
  105 | 
  106 |     await page.locator('[class*="toolFileLink"]', { hasText: 'notes.md' }).click();
> 107 |     await expect(page.locator('[data-line="1"]')).toBeVisible({ timeout: 5_000 });
      |                                                   ^ Error: expect(locator).toBeVisible() failed
  108 |     await expect(dialog(page)).toContainText('hello scub');
  109 | 
  110 |     expect(watch.suppressed).not.toContain('readToolImage');
  111 |     expect(await watch.sent()).not.toContain('readFilePreview');
  112 |   });
  113 | });
  114 | 
```