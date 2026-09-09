# UI that renders correctly and still reads as broken

Two failures from the same family, both reported by the user as bugs, both produced by code that
was doing exactly what it was told. Neither is caught by any assertion about layout, logic or
state, which is why they survive a green suite and are found by eye.

## A colour that equals its surface

The usage bars' track (the unfilled part) was invisible: a 14% bar looked like a floating stub
with nothing to be a fraction *of*. Nothing was wrong with the width - the track was painted in
the background's own colour.

```
track background : rgb(25, 26, 27)
modal background : rgb(25, 26, 27)
```

`--input-bg` is `--vscode-input-background`, which in the Dark 2026 theme happens to equal the
surface it sits on. **A VS Code colour token is not a promise of contrast against a neighbouring
token**; the theme decides, and a pairing that reads fine in one theme collapses in another.

Fix: derive such colours from the foreground instead, so contrast holds by construction on any
theme. `global.css` now owns `--track-bg: color-mix(in srgb, var(--fg) 14%, transparent)`, used by
both the modal's full bars and the header indicator's mini bars. Applies to anything whose job is
to show *unfilled* capacity: progress tracks, sliders, meters, the inactive half of a toggle.

Note that a border can mask this: the Settings toggle uses `--input-bg` too but carries
`1px solid var(--border)`, so it still reads. The bug only surfaces where the shape is defined by
fill alone.

## An empty state that does not say why

The usage indicator hides its bars when there are no windows to draw and falls back to a plain
icon. Correct behaviour (three dead grey lines would look broken), but it was reported as
"I don't see that feature" - because a silent empty state is indistinguishable from an
unimplemented one. The reason was already in the server's reply and the UI discarded it.

**If a widget can render empty, it must carry the reason.** Keep the failure reason in the
payload (`{ windows: [], error: 'rate limited (HTTP 429)' }`), answer the request even when the
fetch failed - one request, one reply, so a client can tell "unavailable" from "still loading" -
and surface it where the user is already looking (here, the tooltip: `Usage data unavailable:
rate limited (HTTP 429)`).

## A label crushed by the neighbour it shares a row with

A Bash tool row renders two variable-length things side by side: the model's description and the
command it ran. Next to a 500-character `node -e "..."`, the description `Запустить фоновый поллер CI`
came out as `Запу…` - four characters - and stayed four characters at **any** window width, which is
what made it look like a bug rather than a tight fit.

Nothing was wrong with the layout. Flex distributes the deficit **in proportion to each item's
content width**, so both items shrink by the same *ratio*, and a ratio is exactly what destroys the
short one:

```
container 1051px, description 160px, command 4000px  ->  ratio 0.25
description 160 * 0.25 =  40px   (four letters)
command    4000 * 0.25 = 1011px  (still a readable command)
```

This is why widening the window does not help and why the report arrived from a 1583px-wide panel:
the ratio is what is fixed, not the absolute shortfall.

Fix: decide which item is *meant* to be the one that truncates, and take the other out of the
proportional split entirely.

```css
.toolSummaryDesc { flex-shrink: 0; max-width: 45%; }   /* never sacrificed, but capped */
```

The cap matters as much as the `flex-shrink: 0` - without it a long description takes the row and
the command disappears instead, which is the same bug facing the other way. Rejected: `flex: 1 1 0`
on the command. It is correct for a long command, but a short one then grows into the leftover space
and pushes the trailing `Out` link to the far right, changing a layout nobody complained about.

**General rule: when two variable-length items share a flex row, proportional shrink silently elects
the shorter one as the loser.** Name the loser explicitly rather than letting content length decide.

## Long work with nothing on screen moving

A CI poller launched as a background task ran for 45 minutes. The turn that started it finished in
57s, and the note under it read `1 background task still running`. Both statements were true, and
both were frozen - so the screen was indistinguishable from a session that had died. The transcript
shows the user typing "текущий статус CI" by hand six minutes in, because asking was the only way to
find out whether anything was happening.

The rule that produced this was written here deliberately and was too broad: *no spinner, no dots, no
ticking timer*, on the grounds that Argus cannot tell a build that will finish from a browser started
for CDP that never will. That reasoning is sound about a **spinner**, which claims progress towards
an end. It does not cover a **count-up from an event that already happened**, which claims only that
time has passed. Split the ban along that line:

| Forbidden | Allowed |
|-----------|---------|
| spinner, progress dots, "waiting…" | elapsed time since a known past timestamp |
| any shape implying completion is near | a number that only grows |

Two traps in implementing it:

- **Never re-purpose a completed measurement as the live one.** The `57s` beside the note is how long
  the *turn* took; making it tick would destroy a real fact to answer a different question.
- **When the start time is unknown, render nothing.** An older daemon sends no launch timestamp, and
  starting a clock at zero would report a half-hour poller as seconds old. No number beats a wrong one.

**General rule: when work legitimately outlives the thing that reported it, something on screen has to
keep moving, or "finished" and "stuck" render identically.**

## Testing them

Both are invisible to normal assertions - the element exists, is visible, has the right size and
the right children. Assert the thing that actually failed:

```ts
// contrast: compare the computed colours, not the layout
const { track, surface } = await page.evaluate(() => { /* getComputedStyle both */ });
expect(track).not.toBe(surface);
expect(track).not.toBe('rgba(0, 0, 0, 0)');

// empty state: the reason must reach the user
await expect(indicator).toHaveAttribute('title', /rate limited \(HTTP 429\)/);

// crushed label: assert the width it is actually given, or the rendered text
expect(descWidth).toBeGreaterThan(0.3 * headerWidth);

// nothing moving: assert that it moves, not that it rendered once
const first = await elapsed.textContent();
await expect.poll(() => elapsed.textContent(), { timeout: 4000 }).not.toBe(first);
```

The last one needs its own control, and it is the opposite direction: with no launch timestamp the
element must be **absent**, otherwise "always render a clock, starting at zero" passes the tick test
happily.

Run the red first (see [e2e-testing.md](e2e-testing.md)): revert the token to `--input-bg` and
confirm the colour test fails, otherwise it is only asserting that two strings differ.

Live in `e2e/usage-indicator.spec.ts`; full context in
[../tasks/usage-limits-indicator/notes.md](../tasks/usage-limits-indicator/notes.md).
