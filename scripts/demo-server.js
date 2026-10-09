import { createServer } from '../server.js';
import { fileURLToPath } from 'node:url';

const server = createServer({ dataDir: fileURLToPath(new URL('../.local-data/demo/', import.meta.url)), demoMode: true, sceneEnv: {} });
const port = Number(process.env.PORT || 3001), host = process.env.HOST || '127.0.0.1';
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, host, () => console.log(`Demo workbench listening on ${host}:${port}; ERP requests are simulated`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
