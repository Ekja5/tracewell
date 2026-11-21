import type { Db } from './db.js';
import { nowIso } from './clock.js';

type Actor = { tenantId: string; userId: string | null };

export async function audit(db: Db, ctx: Actor, action: string, entity: string, entityId: string | null, data: any = {}, opts: { caseId?: string | null; reason?: string; occurredAt?: string } = {}) {
  const rec = nowIso();
  await db.query(
    `insert into audit_log(tenant_id, actor_user_id, action, entity, entity_id, case_id, occurred_at, recorded_at, reason, data) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.tenantId, ctx.userId, action, entity, entityId, opts.caseId ?? null, opts.occurredAt ?? rec, rec, opts.reason ?? null, data],
  );
}

type Msg = { kind: string; message: string; caseId?: string | null; facilityId?: string | null; dedupe?: string };

export async function notify(db: Db, tenantId: string, userId: string | null | undefined, msg: Msg) {
  if (!userId) return;
  // Facility users may only ever receive notifications about their own facility.
  const u = (await db.query(`select facility_id from users where id=$1 and tenant_id=$2`, [userId, tenantId])).rows[0];
  if (!u) return;
  if (u.facility_id && u.facility_id !== msg.facilityId) return;
  await db.query(
    `insert into notifications(tenant_id,user_id,case_id,facility_id,kind,message,created_at,dedupe_key) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tenant_id,user_id,dedupe_key) do nothing`,
    [tenantId, userId, msg.caseId ?? null, msg.facilityId ?? null, msg.kind, msg.message, nowIso(), msg.dedupe ?? null],
  );
}

export async function notifyRole(db: Db, tenantId: string, roles: string[], msg: Msg) {
  const users = await db.query(`select id from users where tenant_id=$1 and active and role = any($2)`, [tenantId, roles]);
  for (const u of users.rows) await notify(db, tenantId, u.id, msg);
}

export async function raiseException(db: Db, tenantId: string, e: { kind: string; severity: 'info' | 'warning' | 'critical'; title: string; detail: string; caseId?: string | null; facilityId?: string | null; refTable?: string; refId?: string; ownerRole?: string; ownerUserId?: string | null; dedupe?: string }) {
  const r = await db.query(
    `insert into exceptions(tenant_id,kind,severity,title,detail,case_id,facility_id,ref_table,ref_id,owner_role,owner_user_id,status,created_at,dedupe_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,$13) on conflict (tenant_id,dedupe_key) do nothing returning id`,
    [tenantId, e.kind, e.severity, e.title, e.detail, e.caseId ?? null, e.facilityId ?? null, e.refTable ?? null, e.refId ?? null, e.ownerRole ?? null, e.ownerUserId ?? null, nowIso(), e.dedupe ?? null],
  );
  return r.rows[0]?.id ?? null;
}
