/**
 * Reset the database to ONE empty pilot tenant (Summit Ortho Supply, synthetic): people, two hospitals,
 * a warehouse and receiving rules; no items, stock or cases.
 *   npm run pilot:reset              empty tenant, demo clock 09:00 Central today
 *   npm run pilot:reset -- --staged  also performs the "day before" work for the ten-minute demo
 */
import { resetDb } from '../src/server/seed/seed.js';
import { pool } from '../src/server/db.js';
import { provisionPilot, stageDemo, PILOT } from '../src/server/pilot/provision.js';

const staged = process.argv.includes('--staged');
const time = process.argv.find((a) => a.startsWith('--time='))?.split('=')[1] ?? '09:00';
await resetDb();
const { tenantId } = await provisionPilot({ clockTime: time });
if (staged) await stageDemo(tenantId);
console.log(`[pilot] ${PILOT.name}: ${staged ? 'staged for the demo (day-1 workbook loaded, reservations and deliveries done)' : 'empty tenant ready'}. Demo clock ${time} Central.`);
console.log(`[pilot] Sign in as ${PILOT.users.coordinator} (coordinator) or ${PILOT.users.ops} (operations manager). Password for all synthetic accounts: ${PILOT.password}`);
await pool.end();
