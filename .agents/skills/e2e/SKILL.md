---
name: e2e
description: Run a requested Argus Playwright test mode or spec and report results.
---

# Run Argus Playwright tests

Work from the repository root. Run the mode requested by the user; default to `all` when none is given.

- `all`: `yarn test:e2e`
- `mock` or `integration`: `yarn test:e2e --project=<mode>`
- `headed`: `yarn test:e2e:headed`
- `ui`: `yarn test:e2e:ui`
- A spec name: `yarn test:e2e <name>`

Report passed, failed, and skipped counts. If a test fails, include the failure summary. Run only the requested mode and do not change test files unless asked to fix them.
