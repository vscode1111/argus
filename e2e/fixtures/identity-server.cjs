const fs = require('node:fs');
const path = require('node:path');

process.env.ARGUS_USAGE_POLL = '0';
process.env.ARGUS_MODEL_REFRESH = '0';
const { startServer } = require(path.resolve(__dirname, '../../out/backend/index.js'));
startServer({ port: 0 }).then(server => {
  fs.writeFileSync(process.argv[2], JSON.stringify({ port: server.port, nonce: server.nonce, pid: process.pid }));
}).catch(() => { process.exitCode = 1; });
