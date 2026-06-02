import * as fs from 'fs';
import * as path from 'path';
import { startServer } from '../src/backend/index';

const PORT = parseInt(process.env.ARGUS_SERVER_PORT ?? '3001', 10);
const MODEL = process.env.ARGUS_MODEL ?? '';

startServer({ port: PORT, model: MODEL }).then(server => {
  const nonceFile = path.join(__dirname, '..', '.dev-nonce');
  fs.writeFileSync(nonceFile, server.nonce);
  console.log(`[argus-server] nonce=${server.nonce}`);
});
