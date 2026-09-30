# codex-async-question-dialog: question choices appear as plain text

## Problem
The user reported on 2026-09-29 that a choice request in session `codex:01a0ec13-765a-7782-90dd-5083b79bcc67` appeared as two bullet points in the conversation instead of an interactive question window.

## Reproduction
Environment: Argus `main` at `d57e328`, extension 0.0.105, Codex CLI 0.155.0-alpha.16, Windows. The cited transcript contains a `request_user_input_async` call at line 996. The tool result at line 999 is `{ "accepted": true }`, and the agent continues with another tool call at line 1003. Expected in Argus: a visible choice UI associated with that request. Actual in the screenshot: plain bullets in the chat, followed by continued tool activity.

Read-only protocol probe: `node !notes/tasks/codex-async-question-dialog/scripts/probe-thread-items.js 01a0ec13-765a-7782-90dd-5083b79bcc67 [mapper-root]`. It prints only item types and field names, not conversation text. The same provider data was passed through the old compiled mapper and the new one:

| Mapper | Native async question items | Argus messages with an interaction |
| --- | ---: | ---: |
| Original worktree, before fix | 2 | 0 |
| Isolated worktree, after fix | 2 | 2 |

The provider's `thread/read` returns both questions as `agentMessage` items with `delivery: "async"` and a `questions` array. The reported item's `questions[0]` has `title` and two string `options`.

## Root cause
`CodexSession.receive()` mapped every completed `agentMessage` to text only, even when the item carried asynchronous question metadata. `replayThread()` likewise discarded that metadata, so a reopened session could only display bullets. A synchronous question takes a different path, `item/tool/requestUserInput`, which was already handled. The counterhypothesis that the frontend hid an existing interaction is ruled out by the pre-fix mapper producing zero interactions from the exact native records.

## Fix
The Codex provider maps native asynchronous questions to a typed interaction on live events and disk replay. It retains the latest question across `turn/completed` and replaces it when a newer question arrives. The webview opens it with native `dialog.showModal()`, so background controls are blocked. It presents the native choices plus a free-text option. Submission sends an ordinary user message using the saved permission mode, since the asynchronous tool has already returned `accepted: true` and has no pending RPC request to answer. A subsequent user message clears the modal; replay restores only the latest question with no later user message. The existing synchronous RPC question and approval paths remain separate.

## Verification
The provider contract test was red before the fix (`request?.kind` was `undefined`) and green after. Full provider contract run in the main worktree, including the earlier launch-count change: 19 passed. The added second case answers a question while its turn is still running through `turn/steer`. Browser test on the compiled browser-served UI: 2 passed, covering modal display, native modal status, turn completion, second-choice submission with permission mode, latest-question replay, and dismissal after a user reply. The screenshot in [scripts/dialog.png](scripts/dialog.png) was visually inspected; a centering defect found there was corrected and the screenshot recaptured. `tsc -p .` and Vite production build passed. `git diff --check` passed. Webview typecheck still reports the existing `FileViewerModal.tsx:582` `SyntaxHighlighter` JSX type error; lint cannot run because `eslint` is not installed.

A neighboring provider-picker test failed in this private browser-served harness because its mock data was overwritten by the live private backend. This harness uses `media/browser.html`, whose `?mock=1` does not suppress backend replies as Vite's dev shim does. The targeted modal test intercepts its own outbound `send`, so it never starts a model turn. The Vite dev shim itself did not mount in this worktree due to an unrelated `PATH_CH` initialization cycle in `markdown.tsx`; the production bundle and private server mounted successfully.

## Files changed
`src/backend/providers/codex.ts`, `src/backend/sessions.ts`, `src/shared/provider.ts`, `webview/src/reducer.ts`, `webview/src/types.ts`, `webview/src/components/ProviderInteraction.tsx`, `webview/src/components/ProviderSelector.module.css`, `webview/src/components/InputArea.tsx`, `webview/src/utils/permissionMode.ts`, the provider fixture and contract test, and `e2e/provider-async-question.spec.ts`.

## Gotchas
`request_user_input_async` is asynchronous by design; the provider can continue work after posting it. A blocking UI may still be appropriate for the user, but it must not imply that the agent turn is paused.
The user's installed extension/daemon still runs its previous build. This change has not been installed or restarted. No live native turn was triggered to call the async question tool; the exact recorded `thread/read` items, deterministic provider stream fixture, and real browser rendering were tested separately.

## Decisions
The task was investigated in a clean detached worktree at the same commit and then merged into the original main worktree without replacing its previous watchdog/count changes.
The question stays in the chat text as historical context while the dialog is open. This avoids deleting the agent's own message from the transcript.

## Related tickets

- [Codex asynchronous user questions](../../common/codex-async-questions.md) records the reusable protocol distinction.
