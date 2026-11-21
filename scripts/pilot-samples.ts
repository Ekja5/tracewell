/** Writes today's copies of the synthetic sample files to docs/pilot/samples/ (dates are relative to today). */
import fs from 'node:fs';
import { SAMPLES, sampleFile } from '../src/server/pilot/samples.js';
import { pool } from '../src/server/db.js';
fs.mkdirSync('docs/pilot/samples', { recursive: true });
for (const s of SAMPLES) { const f = await sampleFile(s.name); fs.writeFileSync(`docs/pilot/samples/${s.name}`, f!.body); console.log('wrote', s.name); }
await pool.end();
