# A Bash row's description truncated to four characters at any width

| | |
|---|---|
| Status | DONE / verified in the browser at two viewport widths, plus a long-description and a no-description control |
| Reported | 2026-09-09, by the user, two screenshots of the same rows at different widths |
| Produced by | Claude Code, model claude-opus-5 |

## Symptom

> Just make these captions wider

A `Bash` row renders the model's `description` and then the `command`. On rows whose command was a
long `node -e "..."` or a vault-read pipeline, the description showed as `Обно…`, `Провери…`,
`Постп…` - four to seven characters. The user sent the same rows at 1507px and 1583px to show that
widening the window changed nothing.

## Root cause

Flex distributes a deficit **in proportion to each item's content width**, so both items shrink by
the same *ratio*, and the ratio is what destroys the short one:

```
container 1051px, description 160px, command 4000px   ->  ratio ~0.25
description  160 * 0.25 =  40px   (four letters)
command     4000 * 0.25 = 1011px  (still a readable command)
```

Both spans carried the same `.toolSummary` (`min-width: 0`, `overflow: hidden`, ellipsis) and the
default `flex: 0 1 auto`, so nothing said which of the two was the one meant to truncate. Because the
ratio is fixed rather than the absolute shortfall, a wider window is spent mostly on the command -
which is exactly what the two screenshots demonstrate.

## Changes made

`webview/src/components/ToolCall.module.css`:

```css
.toolSummaryDesc { flex-shrink: 0; max-width: 45%; }
```

`webview/src/components/ToolCall.tsx`: a `bashDesc` flag (`name === 'Bash' && !!bashCommand &&
summary !== bashCommand`) marks the first span when it is a description rather than the command, and
now also gates the second span's render - the condition was already written out inline there, so the
flag replaced a duplicate rather than adding one.

The cap carries as much weight as the `flex-shrink: 0`: without it a 135-character description takes
the row and the command vanishes instead, the same bug facing the other way.

## Decisions

**Rejected `flex: 1 1 0` on the command.** It reads well (basis 0, so it never contributes to the
deficit and grows into whatever is left) and is right for a long command, but a *short* one then
grows into the leftover space and pushes the trailing `Out` link to the far right, changing a layout
nobody complained about. `.toolOutLink` has `flex-shrink: 0` and no `margin-left: auto`, so today it
sits directly after the command; that stays true.

**A dedicated class, not a rule on `.toolSummary`.** That class is shared with non-Bash single
summaries and with the `Read`/`Write`/`Edit` file link, which legitimately uses the whole row for a
long path. A `max-width: 45%` there would have been a regression on every file row.

## Verified

Driven through the user's own cases in a browser rather than reasoned about:

| Case | Result |
|------|--------|
| the three real commands from the screenshot, 1500px | descriptions render in full |
| same, 760px | short one full, long one capped, command still readable |
| 135-char description | clamped to 519px = 45% of 1154px, command keeps the rest |
| `git status`, no description | single span, `Out` still adjacent - layout unchanged |

## Gotchas

**The first measurement said the fix had failed.** See
[../bg-task-elapsed-timer/notes.md](../bg-task-elapsed-timer/notes.md) - reading widths in the same
`evaluate` that dispatched the mock messages returns the previous render. The rule was correct all
along; the reading was of a stale row.

**Existing specs were unaffected, and it is worth knowing why**: several locate with
`[class*="toolSummary"]`, which `toolSummaryDesc` also matches as a substring, and one uses
`.first()`. Adding a class to an element that already carried `toolSummary` changes neither the match
count nor the DOM order, so no selector moved.

## Remaining work

None. Same deploy caveat as every webview change - see
[../../common/backend-restart.md](../../common/backend-restart.md).
