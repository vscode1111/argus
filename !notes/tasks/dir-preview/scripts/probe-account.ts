// Does phase 1 of getAccountUsage resolve, and how fast? Both branches of the handler
// swallow rejections, so a reject looks identical to a hang from the client side.
import { fetchAccountInfo } from '../../../../src/backend/accountUsage';
import { requestUsageRefresh } from '../../../../src/backend/usagePoller';

const t0 = Date.now();
fetchAccountInfo()
  .then(a => console.log('fetchAccountInfo RESOLVED in', Date.now() - t0, 'ms ->', JSON.stringify(a).slice(0, 120)))
  .catch(e => console.log('fetchAccountInfo REJECTED in', Date.now() - t0, 'ms ->', e && e.message));

const t1 = Date.now();
requestUsageRefresh()
  .then(s => console.log('requestUsageRefresh RESOLVED in', Date.now() - t1, 'ms -> windows=', s.windows.length, 'error=', s.error))
  .catch(e => console.log('requestUsageRefresh REJECTED in', Date.now() - t1, 'ms ->', e && e.message));

setTimeout(() => { console.log('--- 25s elapsed, exiting ---'); process.exit(0); }, 25000);
