# Showing a foreign document inside the panel

Argus previews files it did not author: an `.html` export today, plausibly an SVG, a
notebook or a PDF next. Each one raises the same three questions, and the answers found
while building the html preview ([../tasks/html-preview/notes.md](../tasks/html-preview/notes.md))
generalise.

## 1. How much privilege does it get?

None by default. `<iframe srcDoc sandbox="">` - the empty value is every restriction on:
no scripts, no forms, no same-origin. The reasoning, and why an inline `onerror=` is the
real risk rather than a `<script>` tag, is in [security.md](security.md) ("Rendering a
file's own HTML"), which owns that decision. A document that genuinely needs its script
is a separate feature ("open in a real browser"), not a loosened sandbox.

## 2. How does it get the panel's colours?

A `srcdoc` frame **cannot see the parent's CSS custom properties**, so `var(--bg)` inside
it resolves to nothing. Read the values in JS from the live panel
(`getComputedStyle(document.body).getPropertyValue('--bg')`, which returns the substituted
colour) and inline them into a stylesheet you inject.

Two placement rules, both learned the hard way:

- **Append the stylesheet after the document's markup, never before it.** A `<style>`
  ahead of the doctype puts the document into quirks mode. Appended, it also comes last in
  the cascade, so it wins every specificity tie for free.
- **`!important` on the essentials** (background, colour, link colour, borders). A
  markdown export ships VS Code's `markdown.css` and paints its own colours; without it
  the injected sheet loses.

Keep the sheet to **colours**. An early version painted `thead, th`, which turned one
export's empty header row into a grey bar - the document's own defect, amplified by our
styling. A blanket `* { background: transparent !important }` would flatten a document
that paints opaque light panels, but it also destroys legitimate backgrounds (badges, code
blocks), so that case is knowingly left unhandled.

## 3. How is it tested?

- **Playwright reaches into a `sandbox=""` frame.** `page.frameLocator(...)` and
  `locator.evaluate()` both work; the sandbox blocks the page's own scripts, not CDP.
- **Assert the computed value, not the declared one.** The whole point of the injected
  sheet is winning a cascade, so read `getComputedStyle(el).backgroundColor` from inside
  the frame and compare it against the panel's, with a fixture that paints itself the
  opposite colour. An attribute or "the style tag exists" check passes on a build where
  the sheet never applied.
- **Test the sandbox by behaviour.** Put a `<script>` in the fixture that would add a
  marker element, and assert the marker is absent. Asserting `sandbox=""` only restates
  the source.
