import * as fs from 'fs';
import * as path from 'path';
import { startServer } from '../src/backend/index';

// Safety net: log but survive unexpected errors so a single bad WS send or
// a transient rejection does not kill the shared dev/test server.
process.on('uncaughtException', (err) => {
  console.error('[argus-server] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[argus-server] unhandledRejection:', reason);
});

const PORT = parseInt(process.env.ARGUS_SERVER_PORT ?? '3001', 10);
const MODEL = process.env.ARGUS_MODEL ?? '';

startServer({ port: PORT, model: MODEL }).then(server => {
  const nonceFile = path.join(__dirname, '..', '.dev-nonce');
  fs.writeFileSync(nonceFile, server.nonce);
  console.log(`[argus-server] nonce=${server.nonce}`);
});
