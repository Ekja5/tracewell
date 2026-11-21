import { buildApp } from './app.js';
import { config } from './config.js';
import { refreshClock } from './clock.js';

await refreshClock(true);
const app = await buildApp();
await app.listen({ port: config.port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`[server] Tracewell listening on http://127.0.0.1:${config.port} (demo shortcuts: ${config.demoLoginShortcuts ? 'on (development only)' : 'off'})`);
