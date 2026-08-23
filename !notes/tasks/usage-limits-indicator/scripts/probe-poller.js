// Probe the compiled usage poller in isolation: start it, wait, print the snapshot.
// Answers "did the daemon's startup poll actually land?" without the daemon, the WS
// layer or Playwright in the request path.
//
//   node "!notes/tasks/usage-limits-indicator/scripts/probe-poller.js"

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const poller = require(path.join(ROOT, 'out', 'backend', 'usagePoller.js'));

const t0 = Date.now();
poller.startUsagePoller((msg) => console.log(`[poller] ${msg}`));

setTimeout(() => {
  const snap = poller.getUsageSnapshot();
  console.log('elapsed ms:', Date.now() - t0);
  console.log('fetchedAt :', snap.fetchedAt, snap.fetchedAt ? `(${Date.now() - snap.fetchedAt}ms ago)` : '(never)');
  console.log('windows   :', JSON.stringify(snap.windows, null, 2));
  process.exit(0);
}, 6000);
