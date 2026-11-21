import '../server/config.js';
import { refreshClock } from '../server/clock.js';
import { processOutboxForTenant, tenantIds } from '../server/domain/erp.js';
import { runReadinessAlerts } from './alerts.js';

/**
 * Background worker. Every job runs per tenant inside a tenant-scoped transaction, so
 * row-level security applies to background work exactly as it does to API requests.
 */
const INTERVAL = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
let stopping = false;
async function tick() {
  await refreshClock(true);
  for (const t of await tenantIds()) {
    try {
      const r = await processOutboxForTenant(t);
      if (r.processed) console.log(`[worker] tenant ${t.slice(0, 8)} outbox processed=${r.processed} delivered=${r.delivered}`);
      await runReadinessAlerts(t);
    } catch (e: any) { console.error(`[worker] tenant ${t.slice(0, 8)} error: ${e.code ?? ''} ${e.message}`); }
  }
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
console.log(`[worker] started, interval ${INTERVAL}ms`);
while (!stopping) { await tick(); await new Promise((r) => setTimeout(r, INTERVAL)); }
process.exit(0);
