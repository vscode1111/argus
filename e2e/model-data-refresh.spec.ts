import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The daily model-data refresh decides two things, and both used to be one unconditional
// `modelDataUpdatedAt: Date.now()`:
//
//   1. when to run     (shouldRefreshModelData)
//   2. what to persist (applyRefreshResult)
//
// The bug this covers: a refresh whose /v1/models fetch failed (expired OAuth token,
// offline) still stamped the success clock, so the next attempt was a full day away.
// Meanwhile `contextWindowFor` kept falling back to 200k for any model missing from the
// cache, which on a 1M model reports a context percentage five times too high.
//
// The fix splits the success clock from an attempt clock. Both functions are pure and take
// the config as an argument, so unlike contextWindowFor (which reads ARGUS_CONFIG at import
// time) they need no child process or temp config file - only the compiled bundle.

const ROOT = path.resolve(__dirname, '..');
const MODEL_DATA_JS = path.join(ROOT, 'out', 'backend', 'modelData.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_760_000_000_000; // fixed clock: these are pure functions, nothing should vary

type RefreshModule = {
  shouldRefreshModelData(
    cfg: { modelDataUpdatedAt: number; modelDataAttemptedAt: number },
    now?: number,
  ): boolean;
  applyRefreshResult(
    cfg: Record<string, unknown>,
    result: {
      defaultModel: string | null;
      families: Record<string, string>;
      models: Array<{ id: string; displayName: string; contextWindow?: number }>;
    },
    now?: number,
  ): Record<string, unknown>;
  MODEL_DATA_REFRESH_MS: number;
  MODEL_DATA_RETRY_MS: number;
};

let mod: RefreshModule;

test.beforeAll(() => {
  if (!fs.existsSync(MODEL_DATA_JS)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
  mod = require(MODEL_DATA_JS) as RefreshModule;
});

// A config as it looks after a healthy refresh, so each test only varies the clocks.
function cfg(updatedAt: number, attemptedAt: number) {
  return {
    modelDataUpdatedAt: updatedAt,
    modelDataAttemptedAt: attemptedAt,
    runtimeDefaultModel: 'claude-sonnet-5',
    modelFamilyDescriptions: { opus: 'old opus wording' },
    modelListCache: [{ id: 'claude-opus-5', displayName: 'Claude Opus 5', contextWindow: 1_000_000 }],
  };
}

const FETCHED = [{ id: 'claude-opus-6', displayName: 'Claude Opus 6', contextWindow: 2_000_000 }];

test.describe('model-data refresh scheduling', () => {
  test('the intervals are a day for success and an hour for retry', () => {
    expect(mod.MODEL_DATA_REFRESH_MS).toBe(DAY);
    expect(mod.MODEL_DATA_RETRY_MS).toBe(HOUR);
  });

  test('fresh data is not refreshed', () => {
    expect(mod.shouldRefreshModelData(cfg(NOW - HOUR, NOW - HOUR), NOW)).toBe(false);
  });

  test('a first run with no timestamps refreshes', () => {
    expect(mod.shouldRefreshModelData(cfg(0, 0), NOW)).toBe(true);
  });

  test('day-old data refreshes when the last attempt is old too', () => {
    expect(mod.shouldRefreshModelData(cfg(NOW - DAY - 1, NOW - 2 * HOUR), NOW)).toBe(true);
  });

  // The regression: stale data whose last attempt failed minutes ago must NOT hammer.
  // This is what makes it safe for a failure to leave modelDataUpdatedAt untouched.
  test('a recent failed attempt backs off even though the data is stale', () => {
    expect(mod.shouldRefreshModelData(cfg(NOW - DAY - 1, NOW - 10 * 60 * 1000), NOW)).toBe(false);
  });

  // The other half: once the retry window passes, it tries again - an hour later, not a
  // day. Without the split this case was unreachable, since the failure had already
  // stamped the success clock.
  test('a failed attempt is retried after the retry window, not after a day', () => {
    const stale = NOW - DAY - 1;
    expect(mod.shouldRefreshModelData(cfg(stale, NOW - HOUR - 1), NOW)).toBe(true);
    // ... and the same config half an hour earlier was still backing off.
    expect(mod.shouldRefreshModelData(cfg(stale, NOW - HOUR - 1), NOW - 30 * 60 * 1000)).toBe(false);
  });
});

test.describe('model-data refresh persistence', () => {
  test('a successful fetch advances both clocks and replaces the cache', () => {
    const out = mod.applyRefreshResult(
      cfg(NOW - DAY, NOW - DAY),
      { defaultModel: 'claude-opus-6', families: { opus: 'new opus wording' }, models: FETCHED },
      NOW,
    );
    expect(out.modelDataUpdatedAt).toBe(NOW);
    expect(out.modelDataAttemptedAt).toBe(NOW);
    expect(out.modelListCache).toEqual(FETCHED);
    expect(out.runtimeDefaultModel).toBe('claude-opus-6');
    expect(out.modelFamilyDescriptions).toEqual({ opus: 'new opus wording' });
  });

  // The core regression. An empty model list is what fetchModels returns for a missing or
  // expired OAuth token and for a network error, so this is the common failure, not an
  // exotic one.
  test('a failed fetch advances only the attempt clock and keeps the old windows', () => {
    const before = cfg(NOW - DAY - 1, NOW - DAY - 1);
    const out = mod.applyRefreshResult(
      before,
      { defaultModel: null, families: {}, models: [] },
      NOW,
    );
    expect(out.modelDataAttemptedAt).toBe(NOW);
    // The success clock must NOT move: that is the whole fix.
    expect(out.modelDataUpdatedAt).toBe(before.modelDataUpdatedAt);
    // And the previously cached windows survive, so contextWindowFor keeps working.
    expect(out.modelListCache).toEqual(before.modelListCache);
    expect(out.runtimeDefaultModel).toBe('claude-sonnet-5');
    expect(out.modelFamilyDescriptions).toEqual({ opus: 'old opus wording' });
  });

  // Ties the two halves together: after a failed refresh the scheduler must agree that
  // another attempt is due once the retry window passes. Asserting the functions
  // separately would not catch a mismatch in which field each one reads.
  test('after a failed refresh the scheduler retries an hour later', () => {
    const failed = mod.applyRefreshResult(
      cfg(NOW - DAY - 1, NOW - DAY - 1),
      { defaultModel: null, families: {}, models: [] },
      NOW,
    ) as unknown as { modelDataUpdatedAt: number; modelDataAttemptedAt: number };

    expect(mod.shouldRefreshModelData(failed, NOW + 60_000)).toBe(false);
    expect(mod.shouldRefreshModelData(failed, NOW + HOUR + 1)).toBe(true);
  });

  // A partial success must not be mistaken for a full one: the model list is the only
  // input contextWindowFor reads, so detecting a default model while the fetch failed
  // still leaves the windows stale and must not stamp the success clock.
  test('a detected default model alone does not count as a successful fetch', () => {
    const before = cfg(NOW - DAY - 1, NOW - DAY - 1);
    const out = mod.applyRefreshResult(
      before,
      { defaultModel: 'claude-opus-6', families: {}, models: [] },
      NOW,
    );
    expect(out.runtimeDefaultModel).toBe('claude-opus-6');
    expect(out.modelDataUpdatedAt).toBe(before.modelDataUpdatedAt);
  });
});
