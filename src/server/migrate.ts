import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import './config.js';

export async function migrate(url = process.env.DATABASE_URL!) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const dir = new URL('../../db/migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const done = await client.query('select 1 from schema_migrations where name=$1', [f]);
      if (done.rowCount) continue;
      await client.query('BEGIN');
      await client.query(readFileSync(new URL(f, dir), 'utf8'));
      await client.query('insert into schema_migrations(name) values($1)', [f]);
      await client.query('COMMIT');
      console.log(`[migrate] applied ${f}`);
    }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { await client.end(); }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => console.log('[migrate] up to date')).catch((e) => { console.error(e); process.exit(1); });
}
