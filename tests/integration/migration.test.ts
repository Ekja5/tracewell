import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { migrate } from '../../src/server/migrate.js';

/**
 * Upgrade from the first build: restore a pg_dump taken from a first-build database (schema 001 only,
 * demo data with history), apply the second-pass migrations, and check that data is preserved and the
 * new behavior works on old records. Needs a local superuser connection (ADMIN_DATABASE_URL) to restore.
 */
const ADMIN = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/postgres';
const DB = 'tracewell_migtest';
const APP = (process.env.DATABASE_URL ?? '').replace(/\/[^/]+$/, `/${DB}`);
const fixture = new URL('../fixtures/first-build-schema001.sql', import.meta.url).pathname;
const admin = (sql: string, db = 'postgres') => execFileSync('psql', [ADMIN.replace(/\/[^/]+$/, `/${db}`), '-qtAc', sql], { encoding: 'utf8' }).trim();

let client: pg.Client;
const before: Record<string, number> = {};
const TABLES = ['tenants', 'cases', 'inventory_movements', 'stock_balances', 'usage_events', 'charges', 'audit_log', 'notifications', 'reservations', 'billing_packets'];

beforeAll(async () => {
  admin(`drop database if exists ${DB}`); admin(`create database ${DB} owner orthoapp`);
  execFileSync('psql', [ADMIN.replace(/\/[^/]+$/, `/${DB}`), '-q', '-v', 'ON_ERROR_STOP=1', '-f', fixture], { encoding: 'utf8' });
  // The dump was restored by a superuser; hand ownership to the non-superuser app role (as production would have it).
  admin(`do $$ declare r record; begin
    for r in select tablename from pg_tables where schemaname='public' loop execute format('alter table %I owner to orthoapp', r.tablename); end loop;
    for r in select sequence_name from information_schema.sequences where sequence_schema='public' loop execute format('alter sequence %I owner to orthoapp', r.sequence_name); end loop;
    for r in select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' loop execute format('alter function %I owner to orthoapp', r.proname); end loop;
    end $$;`, DB);
  for (const t of TABLES) before[t] = Number(admin(`select count(*) from ${t}`, DB));
  expect(admin(`select string_agg(name, ',' order by name) from schema_migrations`, DB)).toBe('001_core.sql');
  await migrate(APP);
  client = new pg.Client({ connectionString: APP });
  await client.connect();
});
afterAll(async () => { await client?.end(); });

describe('Upgrade from the first build', () => {
  it('applies the new migration and preserves every existing record', async () => {
    expect(admin(`select string_agg(name, ',' order by name) from schema_migrations`, DB)).toBe('001_core.sql,002_ownership_finance_alerts.sql');
    for (const t of TABLES) expect(Number(admin(`select count(*) from ${t}`, DB))).toBe(before[t]);
    // Backfills: price history for old charges; receiving hours for old policies; alert timestamps.
    expect(Number(admin(`select count(*) from charge_events where kind='derived'`, DB))).toBe(before.charges);
    expect(Number(admin(`select count(*) from facility_policies where receiving_open is null`, DB))).toBe(0);
    expect(Number(admin(`select count(*) from notifications where last_at is null`, DB))).toBe(0);
    // Row-level security is forced again on every tenant table after the backfill.
    expect(Number(admin(`select count(*) from pg_class c join information_schema.columns col on col.table_name=c.relname and col.column_name='tenant_id' and col.table_schema='public' where c.relkind='r' and c.relname not in ('users','sessions') and not (c.relrowsecurity and c.relforcerowsecurity)`, DB))).toBe(0);
  });

  it('old data works with new behavior: ledger reconciles, issues derive, row-level security still isolates tenants', async () => {
    process.env.DATABASE_URL = APP;
    const tenants = admin(`select string_agg(id::text, ',') from tenants`, DB).split(',');
    const { withTenant, pool } = await import('../../src/server/db.js');
    // db.ts pool is bound to the test DB; use a dedicated pool for the migrated DB.
    const p = new pg.Pool({ connectionString: APP });
    for (const t of tenants) {
      const c = await p.connect();
      try {
        await c.query('begin'); await c.query(`select set_config('app.tenant_id', $1, true)`, [t]);
        const { ledgerReconciliation } = await import('../../src/server/domain/inventory.js');
        const { readinessWithIssues } = await import('../../src/server/domain/cases.js');
        expect((await ledgerReconciliation(c as any)).matches).toBe(true);
        const cases = (await c.query(`select id from cases where status='scheduled'`)).rows;
        for (const cs of cases) await readinessWithIssues(c as any, t, cs.id);
        const others = (await c.query(`select count(*)::int n from cases where tenant_id <> $1`, [t])).rows[0].n;
        expect(others).toBe(0);
        await c.query('rollback');
      } finally { c.release(); }
    }
    await p.end();
    void withTenant; void pool;
  });
});
