// The OS refusing a process makes execFile throw SYNCHRONOUSLY (spawn UNKNOWN,
// errno -4094) - a different path from the callback's `err`. fetchAccountInfo's
// executor only ever calls resolve(), so an unguarded sync throw rejects it, and the
// getAccountUsage handler swallows rejections: the client gets no reply at all.
//
// Runs against the COMPILED bundle: the emitted CJS calls child_process.execFile as a
// live property lookup, so it can be replaced. Under ESM the import is bound and the
// same patch silently does nothing (measured - the probe called the real CLI instead).
//
// Run: yarn compile && node !notes/tasks/dir-preview/scripts/probe-spawn-throw.js
const cp = require('child_process');
const err = Object.assign(new Error('spawn UNKNOWN'), { errno: -4094, code: 'UNKNOWN', syscall: 'spawn' });
cp.execFile = () => { throw err; };

const { fetchAccountInfo } = require('../../../../out/backend/accountUsage.js');

fetchAccountInfo().then(
  (account) => {
    console.log('RESOLVED ->', JSON.stringify(account));
    console.log('=> the handler still answers: one request, one reply');
    process.exit(0);
  },
  (e) => {
    console.log('REJECTED ->', e.message);
    console.log('=> both .catch(() => {}) swallow it, so ZERO frames reach the client');
    console.log('   which is exactly "no accountUsage frame within 20000ms"');
    process.exit(1);
  },
);
