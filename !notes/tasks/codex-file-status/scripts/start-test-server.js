const path = require('path');
const root = path.resolve(__dirname, '../../../..');
process.env.ARGUS_CONFIG = path.join(root, 'e2e', 'argus.json');
process.env.ARGUS_AUTH_FILE = path.join(root, 'e2e', 'argus-auth.e2e.json');
process.env.ARGUS_USAGE_POLL = '0';
process.env.ARGUS_MODEL_REFRESH = '0';
require(path.join(root, 'out/backend/index')).startServer({ port: 5182 });
