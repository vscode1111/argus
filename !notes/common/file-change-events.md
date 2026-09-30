# File-change event display

The Codex provider passes each native `fileChange` item's `changes` into the shared tool-call model. Each change has a path, a `kind.type` such as `add`, `delete`, or `update`, and a unified patch string. `ToolCall.tsx` uses `kind.type` for the path style and `countUnifiedDiff()` for the numbers. The counter counts lines beginning with `+` or `-` in the patch body; it is scoped to that event, not to the file's lifetime or Git status.

Consequently, a file created earlier in a conversation can later appear as an update with `-8`, even while Git still sees it as untracked. That number means the later patch contains eight removed lines; it does not mean the file was deleted. In the reported screenshot, the exact eight patch lines were not recovered, so the explanation is based on the event display contract rather than a verified raw event.

An add or delete event can carry an empty patch. In that case the UI shows its status through the path color and strike-through, with no zero counters or empty Diff link. A metadata-only nonempty patch retains a Diff link. See the [file-status task](../tasks/codex-file-status/notes.md) and [diff viewer task](../tasks/codex-diff-viewer/notes.md) for controls and regression coverage.
