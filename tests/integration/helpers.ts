import { pool, q, withTenant, Db, one } from '../../src/server/db.js';
import { seed } from '../../src/server/seed/seed.js';
import { buildApp } from '../../src/server/app.js';
import type { Ctx } from '../../src/server/perms.js';

export { withTenant, one, pool, q };
export type { Db };

export let T1 = '';
export let T2 = '';

/** Reset the test database and load the deterministic synthetic seed (demo date fixed by vitest env). */
export async function freshSeed() {
  const r = await seed({ quiet: true });
  T1 = r.tenantId; T2 = r.tenant2Id;
  return r;
}

export async function ctxFor(email: string): Promise<Ctx> {
  const [u] = await q(`select * from users where email=$1`, [email]);
  if (!u) throw new Error('no user ' + email);
  return { userId: u.id, tenantId: u.tenant_id, role: u.role, facilityId: u.facility_id, territoryId: u.territory_id, displayName: u.display_name };
}

export const tx = <T>(fn: (db: Db) => Promise<T>, tenant = T1) => withTenant(tenant, fn);

export async function caseId(ref: string, tenant = T1) {
  return tx(async (db) => (await one(db, `select id from cases where case_ref=$1`, [ref])).id, tenant);
}
export async function reqId(caseRef: string, itemRef: string) {
  return tx(async (db) => (await one(db, `select cr.id from case_requirements cr join cases c on c.id=cr.case_id join catalog_items ci on ci.id=cr.catalog_item_id where c.case_ref=$1 and ci.ref=$2 and cr.active`, [caseRef, itemRef])).id);
}
export async function stock(serialOrLot: string) {
  return tx(async (db) => one(db, `select s.*, ci.ref, ci.unit_gtin from stock_items s join catalog_items ci on ci.id=s.catalog_item_id where s.serial_number=$1 or (s.serial_number is null and s.lot_number=$1) limit 1`, [serialOrLot]));
}
export async function balanceOf(stockItemId: string) {
  return tx((db) => db.query(`select l.code, l.kind, b.condition, b.qty from stock_balances b join locations l on l.id=b.location_id where b.stock_item_id=$1 and b.qty>0 order by l.code`, [stockItemId]).then((r) => r.rows));
}
export async function count(sql: string, params: any[] = [], tenant = T1) {
  return tx(async (db) => Number((await db.query(sql, params)).rows[0].n), tenant);
}

export async function httpApp() {
  const app = await buildApp();
  const sessions = new Map<string, string>();
  async function as(email: string) {
    if (!sessions.has(email)) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-tw-csrf': '1' }, payload: { email, password: 'Pilot-Demo-2026!' } });
      if (r.statusCode !== 200) throw new Error(`login failed for ${email}: ${r.body}`);
      const c = r.cookies.find((c: any) => c.name === 'tw_session')!;
      sessions.set(email, `tw_session=${c.value}`);
    }
    const cookie = sessions.get(email)!;
    return {
      get: (url: string) => app.inject({ method: 'GET', url, headers: { cookie } }),
      post: (url: string, payload: any = {}) => app.inject({ method: 'POST', url, headers: { cookie, 'x-tw-csrf': '1' }, payload }),
    };
  }
  return { app, as };
}
