// The risk the fix introduces: probing could call a LIVE daemon dead and discard its
// discovery file, whose replacement then exits on EADDRINUSE - stranding the extension
// with no file and no nonce, a worse failure than the one being fixed. The daemon is
// single-threaded, so a long sync stretch stalls its HTTP handler. A stalled daemon
// must read 'busy' (alive), never 'down'.
const net = require('net');
const { probeDaemon, isDaemonUp } = require('../../../../out/backend/daemonInfo');

(async () => {
  // Accepts the connection, then never answers - exactly a blocked event loop.
  const stalled = net.createServer(() => { /* hold it open, write nothing */ });
  await new Promise((r) => stalled.listen(0, '127.0.0.1', r));
  const port = stalled.address().port;

  const t = Date.now();
  const verdict = await probeDaemon(port, 1000);
  console.log(`stalled daemon (accepts, never replies) on port ${port}`);
  console.log(`  probeDaemon : ${verdict}   (expect busy, NOT down)  [${Date.now() - t}ms]`);
  console.log(`  isDaemonUp  : ${await isDaemonUp({ port, nonce: 'x', pid: process.pid, version: '0', startedAt: 0 })}   (expect true - do not discard)`);
  await new Promise((r) => stalled.close(r));
  process.exit(0);
})();
