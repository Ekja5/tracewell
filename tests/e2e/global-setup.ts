export default async function globalSetup() {
  process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  process.env.DEMO_DATE = process.env.DEMO_DATE ?? '2026-11-21';
  const { seed } = await import('../../src/server/seed/seed.ts');
  const { pool } = await import('../../src/server/db.ts');
  await seed({ quiet: true });
  await pool.end();
}
