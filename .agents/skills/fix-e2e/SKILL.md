---
name: fix-e2e
description: Run the Argus end-to-end suite, investigate failed or flaky tests, and fix them within three full-suite attempts.
---

# Fix end-to-end failures

Use this skill when asked to run `yarn test:e2e` and resolve any failures or flakes in Argus.

1. Read the relevant `!notes/` indexes and task notes, inspect `git status`, `package.json`, and `playwright.config.ts`, and preserve existing work. Check for a running suite and existing test servers before starting; never launch a duplicate or stop a server that belongs to another task. Establish which skips are intentional.
2. Run `yarn test:e2e` and monitor it through the final Playwright summary. Give progress updates at least every 60 seconds. If one infrastructure or setup failure is cascading across the suite, capture representative evidence and stop the run rather than spending the remaining tests on the same failure. Count every full-suite invocation as one attempt, including an interrupted run. Playwright's built-in per-test retry is part of that invocation. **Never exceed three full-suite attempts in one invocation of this skill.** Focused test runs, builds, and diagnostic probes do not consume this limit.
3. **After every attempt with a `failed` or `flaky` test, diagnose and fix the cause before another full-suite run or a final report.** A retry that passes is still a flake. Preserve the first error and retry result, screenshot or trace when available, and surrounding server output before a focused run can replace test artifacts. Distinguish a product defect, incorrect test expectation or fixture, environment problem, and timing/resource contention with evidence. Reproduce each distinct failure with a focused run or probe where possible; group failures only after confirming a shared cause. For an environment failure, repair the environment and rerun the same focused reproduction. Do not treat a process restart or a passing retry alone as proof that the underlying issue is fixed.
4. Fix product logic first when it violates intended behavior. Change a test only after showing that its expectation, setup, cleanup, or synchronization is wrong. Keep assertions meaningful; do not skip, weaken, or inflate timeouts merely to get green output. Add or adjust a regression check at the layer that owns the cause, then verify it with focused tests. Follow the repo's coding and test-data rules; do not reformat unrelated code.
5. Only after the failures from the previous attempt are resolved with focused evidence, run the full suite again if attempts remain. Success requires a completed run with zero failed and zero flaky tests; intentional skips are acceptable. After the third attempt, continue diagnosis, fixes, and focused verification without another full-suite run. Report any remaining failures only after a concrete fix attempt or a demonstrated blocker, and state that the full suite is not verified clean. Do not claim success from a focused run or a Playwright retry.

Do not commit, push, deploy, or publish results unless separately requested.
