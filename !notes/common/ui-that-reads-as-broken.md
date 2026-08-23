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
```

Run the red first (see [e2e-testing.md](e2e-testing.md)): revert the token to `--input-bg` and
confirm the colour test fails, otherwise it is only asserting that two strings differ.

Live in `e2e/usage-indicator.spec.ts`; full context in
[../tasks/usage-limits-indicator/notes.md](../tasks/usage-limits-indicator/notes.md).
