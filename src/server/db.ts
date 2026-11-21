import pg from 'pg';
import { config } from './config.js';

pg.types.setTypeParser(20, (v) => Number(v)); // bigint counts -> number
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric -> number
pg.types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
export type Db = pg.PoolClient;

/** Run fn in a transaction scoped to one tenant (row-level security uses app.tenant_id). */
export async function withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>, opts: { isolation?: 'serializable' } = {}): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(opts.isolation === 'serializable' ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN');
    await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Non-tenant queries (auth lookups, tenant enumeration for workers, settings). */
export async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const r = await pool.query(sql, params);
  return r.rows as T[];
}

export async function one<T = any>(db: Db, sql: string, params: any[] = []): Promise<T> {
  const r = await db.query(sql, params);
  if (r.rows.length === 0) throw new AppError(404, 'not_found', 'Record not found or not visible to you');
  return r.rows[0] as T;
}
export async function rows<T = any>(db: Db, sql: string, params: any[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}
export async function maybe<T = any>(db: Db, sql: string, params: any[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}
