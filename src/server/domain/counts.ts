import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, requirePerm } from '../perms.js';
import { nowIso } from '../clock.js';
import { audit, raiseException } from '../audit.js';
import { applyMovement } from './inventory.js';

/** Blind cycle counts: counters never see expected quantities; variance is computed at submission. */
export async function startCount(db: Db, ctx: Ctx, input: { locationId: string }) {
  requirePerm(ctx, 'count.perform');
  const loc = await one(db, `select * from locations where id=$1`, [input.locationId]);
  if (!['warehouse', 'trunk', 'consignment', 'hospital_receiving'].includes(loc.kind)) throw new AppError(400, 'bad_location', 'Counts are for physical stock locations');
  if (ctx.role === 'rep' && loc.holder_user_id !== ctx.userId) throw new AppError(403, 'forbidden', 'Reps can count only their own trunk');
  const s = (await db.query(`insert into count_sessions(tenant_id, location_id, status, created_by, created_at) values ($1,$2,'open',$3,$4) returning *`, [ctx.tenantId, loc.id, ctx.userId, nowIso()])).rows[0];
  await audit(db, ctx, 'count.start', 'count_session', s.id, { location: loc.code });
  return s;
}

export async function countSession(db: Db, ctx: Ctx, id: string) {
  const s = await one(db, `select cs.*, l.name location_name, l.code location_code, u.display_name counter from count_sessions cs join locations l on l.id=cs.location_id join users u on u.id=cs.created_by where cs.id=$1`, [id]);
  const blind = s.status === 'open';
  const lines = await rows(db, `select cl.id, cl.stock_item_id, cl.owner_party_id, cl.counted_qty, cl.counted_at, ${blind ? 'null::int' : 'cl.expected_qty'} expected_qty, ci.ref, ci.description, si.serial_number, si.lot_number, p.name owner
     from count_lines cl join stock_items si on si.id=cl.stock_item_id join catalog_items ci on ci.id=si.catalog_item_id join parties p on p.id=cl.owner_party_id where cl.session_id=$1 order by ci.ref`, [id]);
  return { session: s, lines, blind };
}

export async function addCountLine(db: Db, ctx: Ctx, id: string, input: { ref: string; lot?: string; serial?: string; ownerPartyId?: string; countedQty: number }) {
  requirePerm(ctx, 'count.perform');
  const s = await one(db, `select * from count_sessions where id=$1`, [id]);
  if (s.status !== 'open') throw new AppError(409, 'closed', 'Count is no longer open');
  const item = await maybe(db, `select * from catalog_items where lower(ref)=lower($1)`, [input.ref]);
  if (!item) throw new AppError(400, 'unknown_ref', `Unknown ref ${input.ref}`);
  const st = item.tracking === 'serial' ? await maybe(db, `select * from stock_items where catalog_item_id=$1 and serial_number=$2`, [item.id, input.serial])
    : await maybe(db, `select * from stock_items where catalog_item_id=$1 and lot_number=$2 and serial_number is null`, [item.id, input.lot]);
  if (!st) {
    await raiseException(db, ctx.tenantId, { kind: 'count_unknown_unit', severity: 'warning', title: 'Counted unit has no inventory record', detail: `${input.ref} ${input.serial ?? input.lot ?? ''} counted at session ${id}; not added to stock without review`, ownerRole: 'inventory_coordinator', dedupe: `cnt:${id}:${input.ref}:${input.serial ?? input.lot}` });
    throw new AppError(409, 'unknown_unit', 'No inventory record for that lot/serial. Logged to the exception queue for review; stock is not created from a count.');
  }
  if (!Number.isInteger(input.countedQty) || input.countedQty < 0) throw new AppError(400, 'bad_qty', 'Count must be a whole number of units');
  const owner = input.ownerPartyId ?? (await maybe(db, `select owner_party_id from stock_balances where stock_item_id=$1 and location_id=$2 order by qty desc limit 1`, [st.id, s.location_id]))?.owner_party_id
    ?? (await one(db, `select id from parties where kind='distributor' limit 1`)).id;
  await db.query(`insert into count_lines(tenant_id, session_id, stock_item_id, owner_party_id, counted_qty, counted_at) values ($1,$2,$3,$4,$5,$6)
     on conflict (session_id, stock_item_id, owner_party_id) do update set counted_qty=excluded.counted_qty, counted_at=excluded.counted_at`, [ctx.tenantId, id, st.id, owner, input.countedQty, nowIso()]);
  return countSession(db, ctx, id);
}

export async function submitCount(db: Db, ctx: Ctx, id: string) {
  requirePerm(ctx, 'count.perform');
  const s = await one(db, `select * from count_sessions where id=$1 for update`, [id]);
  if (s.status !== 'open') throw new AppError(409, 'closed', 'Already submitted');
  // Anything the ledger expects at this location but was not counted is an implicit zero.
  const expected = await rows(db, `select stock_item_id, owner_party_id, sum(qty)::int qty from stock_balances where location_id=$1 and condition='sealed' and qty>0 group by 1,2`, [s.location_id]);
  for (const e of expected) {
    await db.query(`insert into count_lines(tenant_id, session_id, stock_item_id, owner_party_id, counted_qty, counted_at) values ($1,$2,$3,$4,0,$5) on conflict do nothing`, [ctx.tenantId, id, e.stock_item_id, e.owner_party_id, nowIso()]);
  }
  await db.query(`update count_lines cl set expected_qty = coalesce((select sum(b.qty) from stock_balances b where b.stock_item_id=cl.stock_item_id and b.owner_party_id=cl.owner_party_id and b.location_id=$2 and b.condition='sealed'),0) where session_id=$1`, [id, s.location_id]);
  await db.query(`update count_sessions set status='submitted', submitted_by=$2, submitted_at=$3 where id=$1`, [id, ctx.userId, nowIso()]);
  const variances = await rows(db, `select * from count_lines where session_id=$1 and counted_qty<>expected_qty`, [id]);
  if (variances.length) await raiseException(db, ctx.tenantId, { kind: 'count_variance', severity: 'warning', title: `Count variance at session ${id.slice(0, 8)}`, detail: `${variances.length} line(s) differ from the ledger. Review before approving adjustments.`, refTable: 'count_sessions', refId: id, ownerRole: 'inventory_coordinator', dedupe: `cntvar:${id}` });
  await audit(db, ctx, 'count.submit', 'count_session', id, { variances: variances.length });
  return countSession(db, ctx, id);
}

/** Approving posts adjustment movements for each variance. The approver must differ from the counter. */
export async function reviewCount(db: Db, ctx: Ctx, id: string, input: { decision: 'approve' | 'reject'; note: string }) {
  requirePerm(ctx, 'count.approve');
  const s = await one(db, `select * from count_sessions where id=$1 for update`, [id]);
  if (s.status !== 'submitted') throw new AppError(409, 'bad_state', `Count is ${s.status}`);
  if (s.created_by === ctx.userId || s.submitted_by === ctx.userId) throw new AppError(409, 'same_person', 'The counter cannot approve their own count');
  if (!input.note?.trim()) throw new AppError(400, 'note_required', 'Review note required');
  if (input.decision === 'approve') {
    const lines = await rows(db, `select * from count_lines where session_id=$1 and counted_qty<>expected_qty`, [id]);
    for (const l of lines) {
      const diff = l.counted_qty - l.expected_qty;
      await applyMovement(db, ctx, { stockItemId: l.stock_item_id, qty: Math.abs(diff), ownerPartyId: l.owner_party_id,
        from: diff < 0 ? { locationId: s.location_id, condition: 'sealed' } : null, to: diff > 0 ? { locationId: s.location_id, condition: 'sealed' } : null,
        type: 'adjustment', reason: `Approved cycle count adjustment (${diff > 0 ? '+' : ''}${diff}): ${input.note}`, countSessionId: id, idempotencyKey: `count:${l.id}` });
    }
  }
  await db.query(`update count_sessions set status=$2, reviewed_by=$3, reviewed_at=$4, review_note=$5 where id=$1`, [id, input.decision === 'approve' ? 'approved' : 'rejected', ctx.userId, nowIso(), input.note]);
  await db.query(`update exceptions set status='resolved', resolved_by=$2, resolved_at=$3, resolution=$4 where ref_table='count_sessions' and ref_id=$1 and status='open'`, [id, ctx.userId, nowIso(), input.note]);
  await audit(db, ctx, `count.${input.decision}`, 'count_session', id, {}, { reason: input.note });
  return countSession(db, ctx, id);
}
