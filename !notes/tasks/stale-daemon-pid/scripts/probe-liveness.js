// Reproduces the reported stranding and checks the fix, against the compiled bundle.
// Case 1 is the real one: a discovery file whose pid was recycled onto a live
// Code.exe (VS Code utility process) while nothing listens on the recorded port.
// isProcessAlive says yes - that is the bug - and isDaemonUp must say no.
const http = require('http');
const { isProcessAlive, isDaemonUp, probeDaemon } = require('../../../../out/backend/daemonInfo');

const recycledPid = Number(process.argv[2]);

(async () => {
  // A port nothing is on. 0 -> OS picks one, then we close it, so it is free.
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const deadPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));

  const info = { port: deadPort, nonce: 'x', pid: recycledPid, version: '0', startedAt: 0 };
  console.log(`case 1  recycled pid ${recycledPid} (live Code.exe), dead port ${deadPort}`);
  console.log(`  isProcessAlive : ${isProcessAlive(recycledPid)}   <- the defeated heuristic`);
  console.log(`  probeDaemon    : ${await probeDaemon(deadPort)}`);
  console.log(`  isDaemonUp     : ${await isDaemonUp(info)}   (expect false)`);

  // Case 2, the control: a real Argus /health on a live port must read as up.
  // Without it, "always return false" would pass case 1.
  const real = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configPath: 'x', pid: process.pid }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => real.listen(0, '127.0.0.1', r));
  const livePort = real.address().port;
  console.log(`\ncase 2  control: real /health on live port ${livePort}`);
  console.log(`  probeDaemon    : ${await probeDaemon(livePort)}`);
  console.log(`  isDaemonUp     : ${await isDaemonUp({ ...info, port: livePort, pid: process.pid })}   (expect true)`);

  // Case 3: port held by something that is not Argus -> down, so we do not
  // hand the webview a URL to a stranger's server.
  const squatter = http.createServer((_req, res) => { res.writeHead(200); res.end('hello'); });
  await new Promise((r) => squatter.listen(0, '127.0.0.1', r));
  const squatPort = squatter.address().port;
  console.log(`\ncase 3  non-Argus server squatting port ${squatPort}`);
  console.log(`  probeDaemon    : ${await probeDaemon(squatPort)}   (expect down)`);

  await new Promise((r) => real.close(r));
  await new Promise((r) => squatter.close(r));
})();
