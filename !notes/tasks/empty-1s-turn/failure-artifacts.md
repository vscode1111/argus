# Failure artifacts from the 2026-08-26 full integration run

Extracted from test-results/ before re-running (Playwright wipes it each run).
Full a11y snapshots and screenshots discarded; the decisive lines are below.

## image-recognize-integratio-036f2--recognize-text-in-response-integration

```
# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('[class*="messageList"], [class*="messages"]')
Timeout: 5000ms
- Expected substring  - 1
+ Received string     + 2

- finalMessage
+ Recognize text⧉The image shows "Key Conventions" text with a bullet noting the agent model is claude-opus-4-6 and inline completions use claude-haiku-4-5, plus streaming/tool-approval/no-Python/webview conventions.
+ This looks like a stale/old version of the CLAUDE.md snippet though — the actual current CLAUDE.md in this repo (per the system context) says model is free-text (argus.model, empty defers to CLI default), not hardcoded to claude-opus-4-6. Want me to check if this screenshot reflects an outdated doc state, or is this just for OCR purposes?4s (23:25:27) · 89,911 in / 205 out

Call log:
  - Expect "toContainText" with timeout 5000ms
  - waiting for locator('[class*="messageList"], [class*="messages"]')
    2 × locator resolved to <div class="_messages_iseta_17">…</div>
      - unexpected value "Recognize text⧉The image shows "Key Conventions" text with a bullet noting the agent model is claude-opus-4-6 and inline completions use `2s · 89,911 in / 32 out"
    2 × locator resolved to <div class="_messages_iseta_17">…</div>
      - unexpected value "Recognize text⧉The image shows "Key Conventions" text with a bullet noting the agent model is claude-opus-4-6 and inline completions use `3s · 89,911 in / 32 out"
    - locator resolved to <div class="_messages_iseta_17">…</div>
    - unexpected value "Recognize text⧉The image shows "Key Conventions" text with a bullet noting the agent model is claude-opus-4-6 and inline completions use claude-haiku-4-5, plus streaming/tool-approval/no-Python/webview conventions.
This looks like a stale/old version of the3s · 89,911 in / 62 out"
    4 × locator resolved to <div class="_messages_iseta_17">…</div>
      - unexpected value "Recognize text⧉The image shows "Key Conventions" text with a bullet noting the agent model is claude-opus-4-6 and inline completions use claude-haiku-4-5, plus streaming/tool-approval/no-Python/webview conventions.
This looks like a stale/old version of the CLAUDE.md snippet though — the actual current CLAUDE.md in this repo (per the system context) says model is free-text (argus.model, empty defers to CLI default), not hardcoded to claude-opus-4-6. Want me to check if this screenshot reflects an outdated doc state, or is this just for OCR purposes?4s (23:25:27) · 89,911 in / 205 out"

```

```

Guard fired (`Ignoring task-notification`): 0
Buttons present: button "Send" 
Completed timer: 4s (23:25:27) · 89,911 in / 205 out

## session-active-marker-inte-c4637-s-and-unmarked-when-it-ends-integration

```
# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByRole('dialog', { name: 'Session History' }).locator('[data-session-id="5f89fb8e-4556-4528-a49f-9a7a847f0daa"]').getByRole('img', { name: 'Working now' })
Expected: 1
Received: 0
Timeout:  15000ms

Call log:
  - Expect "toHaveCount" with timeout 15000ms
  - waiting for getByRole('dialog', { name: 'Session History' }).locator('[data-session-id="5f89fb8e-4556-4528-a49f-9a7a847f0daa"]').getByRole('img', { name: 'Working now' })
    18 × locator resolved to 0 elements
       - unexpected value "0"

```

# Page snapshot
```

Guard fired (`Ignoring task-notification`): 0
Buttons present: button "Send" 
Completed timer: 6s (23:26:46) · 89,779 in / 618 out

