---
description: Run Playwright e2e tests. Accepts a mode argument (all, mock, integration, or a specific spec file name).
---

Run Playwright e2e tests for the Argus project.

Argument: $ARGUMENTS

## Modes

- `all` (default if no argument) - run all tests
- `mock` - run only mock project tests (no Claude CLI needed)
- `integration` - run only integration project tests (requires running dev server)
- `headed` - run all tests with visible browser
- `ui` - open Playwright UI mode
- A specific spec file name (e.g. `ask-dialog`, `chat`, `retry-clean`) - run only that test file

## Steps

1. Parse the argument. If empty or `all`, run `yarn test:e2e`.
2. If `mock` or `integration`, run `yarn test:e2e --project=<mode>`.
3. If `headed`, run `yarn test:e2e:headed`.
4. If `ui`, run `yarn test:e2e:ui`.
5. Otherwise treat the argument as a spec file name and run `yarn test:e2e <name>`.
6. Report the results: how many passed, failed, skipped.

## Rules

- Always run from the project root `d:\_Projects\scub111g\argus`.
- If tests fail, show the failure summary and suggest next steps.
- Do not modify any test files unless the user explicitly asks.
