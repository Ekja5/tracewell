/** CLI: rebuild the demo account.  DATABASE_URL=... npx tsx video/seed-demo.ts [--day=YYYY-MM-DD] */
import { pool } from '../src/server/db.js';
import { seedDemoAccount, DEMO } from '../src/server/pilot/demo-account.js';
export { DEMO };
const day = process.argv.find((a) => a.startsWith('--day='))?.split('=')[1];
const r = await seedDemoAccount({ day });
console.log(`[video-demo] ${DEMO.tenant}: demo day ${r.day} (tomorrow ${r.tomorrow}). Clock 9:00 AM Central.`);
await pool.end();
