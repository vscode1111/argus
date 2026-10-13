---
name: fix-e2e
description: Run the Argus end-to-end suite, investigate failed or flaky tests, and fix them within three full-suite attempts.
---

# Fix end-to-end failures

Use this skill when asked to run `yarn test:e2e` and resolve any failures or flakes in Argus.

1. Read the relevant `!notes/` indexes and task notes, inspect `git status`, `package.json`, and `playwright.config.ts`, and preserve existing work. Check for a running suite and existing test servers before starting; never launch a duplicate or stop a server that belongs to another task. Establish which skips are intentional.
2. Run `yarn test:e2e` and monitor it through the final Playwright summary. Give progress updates at least every 60 seconds. Count each full-suite invocation as one attempt, including a run interrupted by infrastructure failure. Playwright's built-in per-test retry is part of that invocation. **Never exceed three full-suite attempts in one invocation of this skill.** Focused test runs, builds, and diagnostic probes do not consume this limit.
3. Treat any `failed` or `flaky` test as unresolved, even when Playwright exits zero after a retry. For each failure, preserve the error, retry result, screenshot or trace when available, and the surrounding server output. Distinguish a product defect, incorrect test expectation or fixture, environment problem, and timing/resource contention with evidence. Reproduce the specific failure with a focused run or probe where possible. Do not assume that a passing retry proves the problem is gone.
4. Fix product logic first when it violates intended behavior. Change a test only after showing that its expectation, setup, cleanup, or synchronization is wrong. Keep assertions meaningful; do not skip, weaken, or inflate timeouts merely to get green output. Add or adjust a regression check at the layer that owns the cause, then verify it with focused tests before spending another full-suite attempt. Follow the repo's coding and test-data rules; do not reformat unrelated code.
5. After a fix, run the full suite again if attempts remain. Success requires a completed run with zero failed and zero flaky tests; intentional skips are acceptable. If the third attempt is not clean, stop full-suite runs, retain the evidence, and report what is still failing or flaky, what was changed, and which focused checks passed. Do not claim success from a focused run or a Playwright retry.

Do not commit, push, deploy, or publish results unless separately requested.
