import { startServer } from '../src/backend/index';

const PORT = parseInt(process.env.ARGUS_SERVER_PORT ?? '3001', 10);
const MODEL = process.env.ARGUS_MODEL ?? 'claude-opus-4-6';

startServer({ port: PORT, model: MODEL }); // entry
