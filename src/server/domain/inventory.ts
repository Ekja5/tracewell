import { AppError, Db, maybe, rows } from '../db.js';
import type { Ctx } from '../perms.js';
import { nowIso } from '../clock.js';

export type Condition = 'sealed' | 'opened' | 'damaged' | 'used';

export interface MovementInput {
  stockItemId: string;
  qty: number;
  ownerPartyId: string;
  from?: { locationId: string; condition: Condition } | null;
  to?: { locationId: string; condition: Condition } | null;
  type: string;
  reason: string;
  shipmentId?: string | null;
  caseId?: string | null;
  usageEventId?: string | null;
  importBatchId?: string | null;
  countSessionId?: string | null;
  reversesMovementId?: number | null;
  occurredAt?: string;
  idempotencyKey?: string | null;
}

/**
 * The only way stock changes. Appends to the ledger and updates the balance projection in the
 * caller's transaction. Source balance rows are locked FOR UPDATE so concurrent movements serialize.
 * Replaying the same idempotency key returns the original movement id and changes nothing.
 */
export async function applyMovement(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, m: MovementInput): Promise<{ id: number; replayed: boolean }> {
  if (!Number.isInteger(m.qty) || m.qty <= 0) throw new AppError(400, 'bad_qty', 'Movement quantity must be a positive whole number of units');
  if (m.idempotencyKey) {
    const ex = await maybe(db, `select id from inventory_movements where tenant_id=$1 and idempotency_key=$2`, [ctx.tenantId, m.idempotencyKey]);
    if (ex) return { id: ex.id, replayed: true };
  }
  if (m.from) {
    const bal = await maybe(db,
      `select id, qty from stock_balances where stock_item_id=$1 and location_id=$2 and owner_party_id=$3 and condition=$4 for update`,
      [m.stockItemId, m.from.locationId, m.ownerPartyId, m.from.condition]);
    if (!bal || bal.qty < m.qty) {
      throw new AppError(409, 'insufficient_stock', `Ledger shows ${bal?.qty ?? 0} unit(s) at the source in condition "${m.from.condition}"; cannot move ${m.qty}`);
    }
  }
  const rec = nowIso();
  const ins = await db.query(
    `insert into inventory_movements(tenant_id, stock_item_id, qty, owner_party_id, from_location_id, from_condition, to_location_id, to_condition,
       movement_type, shipment_id, case_id, usage_event_id, import_batch_id, count_session_id, reverses_movement_id, reason, actor_user_id, occurred_at, recorded_at, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     on conflict (tenant_id, idempotency_key) do nothing returning id`,
    [ctx.tenantId, m.stockItemId, m.qty, m.ownerPartyId, m.from?.locationId ?? null, m.from?.condition ?? null, m.to?.locationId ?? null, m.to?.condition ?? null,
      m.type, m.shipmentId ?? null, m.caseId ?? null, m.usageEventId ?? null, m.importBatchId ?? null, m.countSessionId ?? null, m.reversesMovementId ?? null,
      m.reason, ctx.userId, m.occurredAt ?? rec, rec, m.idempotencyKey ?? null]);
  if (!ins.rows[0]) {
    const ex = await maybe(db, `select id from inventory_movements where tenant_id=$1 and idempotency_key=$2`, [ctx.tenantId, m.idempotencyKey]);
    return { id: ex.id, replayed: true };
  }
  const id = ins.rows[0].id as number;
  if (m.from) {
    await db.query(`update stock_balances set qty = qty - $5, last_movement_id=$6 where stock_item_id=$1 and location_id=$2 and owner_party_id=$3 and condition=$4`,
      [m.stockItemId, m.from.locationId, m.ownerPartyId, m.from.condition, m.qty, id]);
  }
  if (m.to) {
    await db.query(
      `insert into stock_balances(tenant_id, stock_item_id, location_id, owner_party_id, condition, qty, last_movement_id) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (stock_item_id, location_id, owner_party_id, condition) do update set qty = stock_balances.qty + excluded.qty, last_movement_id = excluded.last_movement_id`,
      [ctx.tenantId, m.stockItemId, m.to.locationId, m.ownerPartyId, m.to.condition, m.qty, id]);
  }
  return { id, replayed: false };
}

/** Linked reversal of a prior movement (history is never rewritten). */
export async function reverseMovement(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, movementId: number, reason: string) {
  const mv = await maybe(db, `select * from inventory_movements where id=$1`, [movementId]);
  if (!mv) throw new AppError(404, 'not_found', 'Movement not found');
  if (mv.movement_type === 'reversal') throw new AppError(409, 'not_reversible', 'A reversal cannot itself be reversed; record a correction');
  const already = await maybe(db, `select id from inventory_movements where reverses_movement_id=$1`, [movementId]);
  if (already) throw new AppError(409, 'already_reversed', `Movement ${movementId} was already reversed by ${already.id}`);
  return applyMovement(db, ctx, {
    stockItemId: mv.stock_item_id, qty: mv.qty, ownerPartyId: mv.owner_party_id,
    from: mv.to_location_id ? { locationId: mv.to_location_id, condition: mv.to_condition } : null,
    to: mv.from_location_id ? { locationId: mv.from_location_id, condition: mv.from_condition } : null,
    type: 'reversal', reason, reversesMovementId: movementId, caseId: mv.case_id, shipmentId: mv.shipment_id,
  });
}

/** Rebuild balances purely from the ledger and compare with the projection. */
export async function ledgerReconciliation(db: Db) {
  const diffs = await rows(db, `
    with ledger as (
      select stock_item_id, loc as location_id, owner_party_id, cond as condition, sum(delta) as qty from (
        select stock_item_id, to_location_id as loc, owner_party_id, to_condition as cond, qty as delta from inventory_movements where to_location_id is not null
        union all
        select stock_item_id, from_location_id, owner_party_id, from_condition, -qty from inventory_movements where from_location_id is not null
      ) x group by 1,2,3,4
    )
    select coalesce(l.stock_item_id, b.stock_item_id) stock_item_id, coalesce(l.location_id,b.location_id) location_id,
           coalesce(l.owner_party_id,b.owner_party_id) owner_party_id, coalesce(l.condition,b.condition) condition,
           coalesce(l.qty,0) ledger_qty, coalesce(b.qty,0) balance_qty
    from ledger l full outer join stock_balances b
      on b.stock_item_id=l.stock_item_id and b.location_id=l.location_id and b.owner_party_id=l.owner_party_id and b.condition=l.condition
    where coalesce(l.qty,0) <> coalesce(b.qty,0)`);
  const totals = await rows(db, `
    select l.kind, sum(b.qty)::int as on_hand from stock_balances b join locations l on l.id=b.location_id group by l.kind order by l.kind`);
  const movementCount = (await rows(db, `select count(*)::int n from inventory_movements`))[0].n;
  return { matches: diffs.length === 0, differences: diffs, totalsByLocationKind: totals, movementCount };
}

/**
 * Availability per balance row: on hand (sealed, allocatable location) minus active reservations,
 * excluding anything under an active quality hold. Used by search, rescue and reservations.
 */
export const AVAILABILITY_SQL = `
  select b.stock_item_id, b.location_id, b.owner_party_id, b.condition, b.qty as on_hand,
    coalesce((select sum(r.qty) from reservations r where r.stock_item_id=b.stock_item_id and r.location_id=b.location_id and r.owner_party_id=b.owner_party_id and r.status='active'),0)::int as reserved,
    exists(select 1 from quality_holds h where h.stock_item_id=b.stock_item_id and h.status='active') as on_hold,
    l.kind as location_kind, l.allocatable, l.name as location_name, l.code as location_code, l.facility_id as location_facility_id, l.holder_user_id
  from stock_balances b join locations l on l.id=b.location_id where b.qty > 0`;

export async function locationByKind(db: Db, kind: string, facilityId?: string | null) {
  const r = await maybe(db, `select * from locations where kind=$1 and ($2::uuid is null or facility_id=$2) order by code limit 1`, [kind, facilityId ?? null]);
  if (!r) throw new AppError(500, 'config', `No ${kind} location configured`);
  return r;
}

export async function activeHold(db: Db, stockItemId: string) {
  return maybe(db, `select h.*, r.ref as recall_ref from quality_holds h left join recalls r on r.id=h.recall_id where h.stock_item_id=$1 and h.status='active' limit 1`, [stockItemId]);
}

/**
 * Reserve stock for a case. Concurrency: the balance row is locked FOR UPDATE, and serialized
 * units are additionally protected by a partial unique index (one active reservation per unit).
 */
export async function reserve(db: Db, ctx: Ctx, r: { caseId: string; requirementId?: string | null; stockItemId: string; locationId: string; ownerPartyId: string; qty: number; idempotencyKey?: string }) {
  if (r.idempotencyKey) {
    const ex = await maybe(db, `select * from reservations where tenant_id=$1 and idempotency_key=$2`, [ctx.tenantId, r.idempotencyKey]);
    if (ex) return { reservation: ex, replayed: true };
  }
  const si = await maybe(db, `select s.*, c.ref, c.description from stock_items s join catalog_items c on c.id=s.catalog_item_id where s.id=$1`, [r.stockItemId]);
  if (!si) throw new AppError(404, 'not_found', 'Stock item not found');
  const cs = await maybe(db, `select c.*, f.timezone from cases c join facilities f on f.id=c.facility_id where c.id=$1`, [r.caseId]);
  if (!cs) throw new AppError(404, 'not_found', 'Case not found');
  if (cs.status !== 'scheduled') throw new AppError(409, 'case_not_open', `Case ${cs.case_ref} is ${cs.status}; cannot reserve`);
  if (r.requirementId) {
    const req = await maybe(db, `select catalog_item_id from case_requirements where id=$1 and case_id=$2 and active`, [r.requirementId, r.caseId]);
    if (!req) throw new AppError(404, 'not_found', 'Requirement not found on this case');
    // Exact item only: the software never substitutes a different catalog item.
    if (req.catalog_item_id !== si.catalog_item_id) throw new AppError(409, 'not_exact_item', `${si.ref} is not the exact item required; substitutes are not allowed`);
  }
  const bal = await maybe(db, `select b.*, l.allocatable, l.kind from stock_balances b join locations l on l.id=b.location_id
     where b.stock_item_id=$1 and b.location_id=$2 and b.owner_party_id=$3 and b.condition='sealed' for update of b`, [r.stockItemId, r.locationId, r.ownerPartyId]);
  const hold = await activeHold(db, r.stockItemId);
  if (hold) throw new AppError(409, 'on_hold', `${si.ref} ${si.serial_number ?? si.lot_number} is on quality hold${hold.recall_ref ? ` (${hold.recall_ref})` : ''}; it cannot be allocated`);
  if (!bal || bal.qty < 1) throw new AppError(409, 'not_on_hand', 'No sealed stock on hand at that location');
  if (!bal.allocatable) throw new AppError(409, 'not_allocatable', `Stock at a ${bal.kind} location cannot be allocated`);
  const planned = localDate(new Date(cs.scheduled_start), cs.timezone);
  if (si.expiry_date && si.expiry_date < planned) throw new AppError(409, 'expired_at_use', `Expires ${si.expiry_date}, before planned use ${planned}`);
  const reserved = (await rows(db, `select coalesce(sum(qty),0)::int n from reservations where stock_item_id=$1 and location_id=$2 and owner_party_id=$3 and status='active'`,
    [r.stockItemId, r.locationId, r.ownerPartyId]))[0].n;
  if (bal.qty - reserved < r.qty) {
    const holder = await maybe(db, `select c.case_ref, c.scheduled_start from reservations r join cases c on c.id=r.case_id where r.stock_item_id=$1 and r.status='active' limit 1`, [r.stockItemId]);
    throw new AppError(409, 'already_reserved', `Only ${Math.max(0, bal.qty - reserved)} unit(s) available; ${holder ? `reserved for case ${holder.case_ref}` : 'others are reserved'}`);
  }
  try {
    await db.query('savepoint resv');
    const ins = await db.query(
      `insert into reservations(tenant_id, case_id, requirement_id, stock_item_id, location_id, owner_party_id, qty, is_serial, status, created_by, created_at, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11) returning *`,
      [ctx.tenantId, r.caseId, r.requirementId ?? null, r.stockItemId, r.locationId, r.ownerPartyId, r.qty, si.is_serial, ctx.userId, nowIso(), r.idempotencyKey ?? null]);
    await db.query('release savepoint resv');
    return { reservation: ins.rows[0], replayed: false };
  } catch (e: any) {
    await db.query('rollback to savepoint resv');
    if (e.code === '23505') throw new AppError(409, 'already_reserved', 'That unit was just reserved by another user');
    throw e;
  }
}

export function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export async function lastVerification(db: Db, stockItemId: string, locationId?: string | null): Promise<{ at: string; kind: string } | null> {
  const r = await maybe(db, `
    select at, kind from (
      select cl.counted_at as at, 'cycle count' as kind from count_lines cl join count_sessions s on s.id=cl.session_id where cl.stock_item_id=$1 and ($2::uuid is null or s.location_id=$2)
      union all select tv.verified_at, 'tray contents verified' from tray_verifications tv where tv.tray_stock_item_id=$1 and ($2::uuid is null or tv.location_id=$2)
      union all select m.occurred_at, case when m.movement_type='receive' then 'received & checked' when m.movement_type='opening_balance' then 'opening balance import' else m.movement_type end
        from inventory_movements m where m.stock_item_id=$1 and m.movement_type in ('receive','opening_balance','adjustment') and ($2::uuid is null or m.to_location_id=$2)
    ) x order by at desc limit 1`, [stockItemId, locationId ?? null]);
  return r ? { at: new Date(r.at).toISOString(), kind: r.kind } : null;
}
