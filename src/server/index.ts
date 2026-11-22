import { buildApp } from './app.js';
import { config } from './config.js';
import { refreshClock } from './clock.js';

// Review deployments build the synthetic demo account on first start.
const { ensureDemo, reviewMode } = await import('./pilot/review.js');
if (reviewMode) { const { migrate } = await import('./migrate.js'); await migrate(config.databaseUrl); await ensureDemo(); }
await refreshClock(true);
const app = await buildApp();
await app.listen({ port: config.port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`[server] Tracewell listening on http://127.0.0.1:${config.port} (demo shortcuts: ${config.demoLoginShortcuts ? 'on (development only)' : 'off'})`);
