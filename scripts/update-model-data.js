#!/usr/bin/env node
// Manual trigger for the model-data refresh: detects the CLI default model
// (runtimeDefaultModel), extracts per-family model descriptions from the installed
// Claude CLI bundle, and caches the /v1/models list - all written to argus.json.
// The daemon runs the same refresh automatically once a day on startup
// (src/backend/modelData.ts).
//
// Usage: yarn update-models   (needs the compiled backend: run `yarn compile` first)

const path = require('path');

let modelData;
try {
  modelData = require(path.join(__dirname, '..', 'out', 'backend', 'modelData.js'));
} catch {
  console.error('Compiled backend not found (out/backend/modelData.js). Run `yarn compile` first.');
  process.exit(1);
}

modelData
  .refreshModelData((msg) => console.log(msg))
  .then((result) => {
    console.log(
      `Done: default model ${result.defaultModel ?? '(not detected)'}, ` +
      `${Object.keys(result.families).length}/4 family descriptions, ` +
      `${result.cachedModels} models cached`
    );
  })
  .catch((err) => {
    console.error('Refresh failed:', err);
    process.exit(1);
  });
