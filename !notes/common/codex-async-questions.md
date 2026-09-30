# Codex asynchronous user questions

`request_user_input_async` differs from synchronous `item/tool/requestUserInput`. The asynchronous call returns `{accepted: true}` immediately, so the provider may continue its turn. The answer is a later ordinary user message, not an RPC reply to a pending request.

On `thread/read`, the question appears as an `agentMessage` with `delivery: "async"` and structured `questions`; a text-only mapper leaves the options as inert bullets. Map the structured interaction in both live events and replay. Keep the latest unanswered question across `turn/completed`, replace it when a newer question arrives, and clear it on a later user message. The webview may use a native modal dialog to block the user's controls while the provider itself continues.

The [question-dialog task](../tasks/codex-async-question-dialog/notes.md) contains a read-only probe of native items, mapper controls, and browser coverage.
