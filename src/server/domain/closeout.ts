import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit, notifyRole, raiseException } from '../audit.js';
import { parseScan } from '../../shared/gs1.js';
import { applyMovement, locationByKind, reverseMovement } from './inventory.js';
import { getVisibleCase } from './cases.js';
import { deriveCharge } from './billing.js';
import { syncIssues } from './issues.js';

export type Disposition = 'implanted' | 'opened_unused' | 'wasted' | 'damaged' | 'returned_sealed' | 'missing';
export const DISPOSITIONS: Disposition[] = ['implanted', 'opened_unused', 'wasted', 'damaged', 'returned_sealed', 'missing'];

export interface UsageInput {
  clientEventId: string;
  caseId: string;
  disposition: Disposition;
  entryMethod: 'scanner' | 'camera' | 'manual' | 'simulator';
  rawScan?: string | null;
  manual?: { ref: string; lot?: string; serial?: string; expiry?: string } | null;
  qtyUnits?: number | null; // explicit count of individual units; required when a package label is scanned
  occurredAt?: string;
  offline?: boolean;
}

/**
 * Record one usage/disposition event. Shared by online closeout and offline sync.
 * Idempotent per clientEventId: a retry returns the original outcome and posts nothing new.
 * Never guesses lot, serial or package conversion: anything ambiguous becomes needs_review.
 */
export async function recordUsage(db: Db, ctx: Ctx, input: UsageInput) {
  requirePerm(ctx, 'closeout.record');
  if (!input.clientEventId || input.clientEventId.length > 100) throw new AppError(400, 'client_event_id', 'clientEventId is required');
  if (!DISPOSITIONS.includes(input.disposition)) throw new AppError(400, 'bad_disposition', 'Unknown disposition');
  const prior = await maybe(db, `select * from usage_events where client_event_id=$1`, [input.clientEventId]);
  if (prior) {
    if (prior.case_id !== input.caseId) throw new AppError(409, 'event_id_reuse', 'clientEventId already used for another case');
    return { usageEvent: prior, replayed: true, status: prior.status, reviewReason: prior.review_reason };
  }
  const c = await getVisibleCase(db, ctx, input.caseId);
  if (ctx.role === 'rep' && c.rep_user_id !== ctx.userId) throw new AppError(403, 'not_assigned', 'Only the assigned rep can record usage for this case');
  const occurredAt = input.occurredAt ? new Date(input.occurredAt).toISOString() : nowIso();
  if (new Date(occurredAt).getTime() > now().getTime() + 5 * 60e3) throw new AppError(400, 'future_time', 'Event time is in the future');

  let review: string[] = [];
  let parsed: any = null; let catalog: any = null; let packageGtin: string | null = null; let unitsPerPackage: number | null = null;
  let lot: string | undefined; let serial: string | undefined; let labelExpiry: string | undefined; let scanFormat: string | null = null;

  if (input.rawScan) {
    parsed = parseScan(input.rawScan, { referenceYear: now().getUTCFullYear() });
    scanFormat = parsed.format;
    if (!parsed.ok) review.push(...parsed.errors);
    else {
      lot = parsed.lot; serial = parsed.serial; labelExpiry = parsed.expiry;
      catalog = await maybe(db, `select * from catalog_items where unit_gtin=$1`, [parsed.gtin]);
      if (!catalog) {
        const pkg = await maybe(db, `select p.*, row_to_json(ci) ci from packages p join catalog_items ci on ci.id=p.catalog_item_id where p.gtin=$1`, [parsed.gtin]);
        if (pkg) { catalog = pkg.ci; packageGtin = pkg.gtin; unitsPerPackage = pkg.units_per_package; }
        else review.push(`GTIN ${parsed.gtin} is not in the catalog or package configuration`);
      }
    }
  } else if (input.manual) {
    scanFormat = 'MANUAL';
    const cands = await rows(db, `select ci.*, p.name manufacturer from catalog_items ci left join parties p on p.id=ci.manufacturer_party_id where lower(ci.ref)=lower($1) and ($2::uuid is null or ci.id=$2)`, [input.manual.ref, (input.manual as any).catalogItemId ?? null]);
    // Prefer the item this case actually requires when a catalog number is shared by manufacturers.
    const onCase = cands.length > 1 ? (await rows(db, `select catalog_item_id from case_requirements where case_id=$1`, [c.id])).map((x) => x.catalog_item_id) : [];
    const narrowed = cands.length > 1 ? cands.filter((x) => onCase.includes(x.id)) : cands;
    if (!cands.length) review.push(`Catalog ref ${input.manual.ref} not found`);
    else if (narrowed.length !== 1) review.push(`Catalog ref ${input.manual.ref} is used by ${cands.length} manufacturers (${cands.map((x) => x.manufacturer).join(', ')}); review must pick one`);
    else catalog = narrowed[0];
    lot = input.manual.lot?.trim() || undefined; serial = input.manual.serial?.trim() || undefined; labelExpiry = input.manual.expiry || undefined;
  } else throw new AppError(400, 'no_identity', 'Provide a scan or a manual entry');

  // Quantity in individual units. A package label never implies a unit count.
  let qty = input.qtyUnits ?? null;
  if (packageGtin) {
    if (qty == null) review.push(`Package-level label (${unitsPerPackage} units per package) scanned. Enter how many individual units were ${input.disposition.replace('_', ' ')}; the system will not assume 1 or ${unitsPerPackage}.`);
  } else if (qty == null) qty = 1;
  if (qty != null && (!Number.isInteger(qty) || qty < 1)) throw new AppError(400, 'bad_qty', 'Quantity must be a whole number of units');

  let stock: any = null;
  if (catalog && !review.length) {
    if (catalog.tracking === 'serial') {
      if (!serial) review.push(`${catalog.ref} is serial-tracked but no serial was ${input.rawScan ? 'on the label' : 'entered'}`);
      else stock = await maybe(db, `select * from stock_items where catalog_item_id=$1 and serial_number=$2`, [catalog.id, serial]);
      if (qty != null && qty !== 1) review.push('A serialized unit has a quantity of exactly 1');
    } else {
      if (!lot) review.push(`${catalog.ref} is lot-tracked but no lot was ${input.rawScan ? 'on the label' : 'entered'}`);
      else stock = await maybe(db, `select * from stock_items where catalog_item_id=$1 and lot_number=$2 and serial_number is null`, [catalog.id, lot]);
    }
    if ((serial || lot) && !stock && !review.length) review.push(`No inventory record for ${catalog.ref} ${serial ? 'SN ' + serial : 'lot ' + lot}. Units are never created from a scan; review required.`);
    if (stock && labelExpiry && stock.expiry_date && stock.expiry_date !== labelExpiry) review.push(`Label expiry ${labelExpiry} differs from recorded expiry ${stock.expiry_date}`);
    if (stock && input.entryMethod === 'manual' && !['import', 'label', 'seed', 'reviewed_entry'].includes(stock.data_source)) review.push('Manually entered identifiers must match a validated record');
  }

  // A serialized unit can be used once. A rescan of the same serial is rejected (not posted), and says so.
  let duplicateOf: any = null;
  if (stock?.is_serial && !review.length) {
    duplicateOf = await maybe(db, `select ue.id, ue.disposition, ue.occurred_at, c2.case_ref from usage_events ue join cases c2 on c2.id=ue.case_id
       where ue.stock_item_id=$1 and ue.status='recorded' and ue.disposition <> 'returned_sealed' limit 1`, [stock.id]);
  }
  // Locate the unit in the ledger: the case facility first, then the assigned rep's trunk, then quarantine.
  let source: any = null;
  if (stock && !review.length && !duplicateOf && input.disposition !== 'returned_sealed') {
    source = await maybe(db, `select b.*, l.kind, l.name from stock_balances b join locations l on l.id=b.location_id
       where b.stock_item_id=$1 and b.qty >= $2 and b.condition='sealed' and (l.facility_id=$3 or l.holder_user_id=$4 or l.kind='quarantine')
       order by (l.facility_id=$3) desc nulls last, (l.kind='quarantine') limit 1`, [stock.id, qty, c.facility_id, c.rep_user_id]);
    if (!source) {
      const where = await maybe(db, `select l.name, b.condition, b.qty from stock_balances b join locations l on l.id=b.location_id where b.stock_item_id=$1 and b.qty>0 limit 1`, [stock.id]);
      review.push(`Ledger does not show ${qty} sealed unit(s) at ${c.facility_name} or the rep's trunk${where ? ` (it shows ${where.qty} ${where.condition} at ${where.name})` : ''}`);
    }
  }

  const status = duplicateOf ? 'rejected' : review.length ? 'needs_review' : 'recorded';
  if (duplicateOf) review.push(`Duplicate scan: SN ${stock.serial_number} was already recorded as ${duplicateOf.disposition.replace('_', ' ')} on ${duplicateOf.case_ref} at ${new Date(duplicateOf.occurred_at).toISOString()}. A serialized unit is used once, so this scan was not posted to stock or billing.`);
  const ev = (await db.query(`insert into usage_events(tenant_id, case_id, client_event_id, catalog_item_id, stock_item_id, disposition, qty_units, package_gtin, units_per_package, entry_method, raw_scan, scan_format, parsed, status, review_reason, recorded_offline, actor_user_id, occurred_at, recorded_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) on conflict (tenant_id, client_event_id) do nothing returning *`,
    [ctx.tenantId, c.id, input.clientEventId, catalog?.id ?? null, stock?.id ?? null, input.disposition, qty, packageGtin, unitsPerPackage, input.entryMethod, input.rawScan ?? null, scanFormat,
      parsed ? { ...parsed, raw: undefined } : input.manual ?? null, status, review.join(' ') || null, !!input.offline, ctx.userId, occurredAt, nowIso()])).rows[0];
  if (!ev) { const p = await one(db, `select * from usage_events where client_event_id=$1`, [input.clientEventId]); return { usageEvent: p, replayed: true, status: p.status, reviewReason: p.review_reason }; }
  await audit(db, ctx, input.offline ? 'usage.sync_offline' : 'usage.record', 'usage_event', ev.id, { disposition: input.disposition, status, review, raw_scan_present: !!input.rawScan }, { caseId: c.id, occurredAt });

  if (status === 'recorded') await postUsage(db, ctx, ev, source, c);
  else if (status === 'needs_review') await raiseException(db, ctx.tenantId, { kind: 'usage_review', severity: 'warning', title: `${c.case_ref}: usage needs review`, detail: review.join(' '), caseId: c.id, refTable: 'usage_events', refId: ev.id, ownerRole: 'inventory_coordinator', dedupe: `usage:${ev.id}` });
  return { usageEvent: await one(db, `select * from usage_events where id=$1`, [ev.id]), replayed: false, status, reviewReason: review.join(' ') || null };
}

async function postUsage(db: Db, ctx: Ctx, ev: any, source: any, c: any) {
  const stockId = ev.stock_item_id;
  const qty = ev.reviewed_qty_units ?? ev.qty_units;
  const base = { stockItemId: stockId, qty, ownerPartyId: source?.owner_party_id, caseId: c.id, usageEventId: ev.id, occurredAt: new Date(ev.occurred_at).toISOString(), idempotencyKey: `usage:${ev.id}` };
  const from = source ? { locationId: source.location_id, condition: 'sealed' as const } : null;
  switch (ev.disposition) {
    case 'implanted': await applyMovement(db, ctx, { ...base, from, to: { locationId: (await locationByKind(db, 'consumed')).id, condition: 'used' }, type: 'consume', reason: `Implanted in case ${c.case_ref}` }); break;
    case 'wasted': await applyMovement(db, ctx, { ...base, from, to: { locationId: (await locationByKind(db, 'wasted')).id, condition: 'opened' }, type: 'consume', reason: `Wasted in case ${c.case_ref} (not implanted)` }); break;
    case 'opened_unused': await applyMovement(db, ctx, { ...base, from, to: { locationId: source.location_id, condition: 'opened' }, type: 'condition_change', reason: `Opened but not used in case ${c.case_ref} (not implanted)` }); break;
    case 'damaged': await applyMovement(db, ctx, { ...base, from, to: { locationId: source.location_id, condition: 'damaged' }, type: 'condition_change', reason: `Damaged in case ${c.case_ref}` }); break;
    case 'missing':
      await applyMovement(db, ctx, { ...base, from, to: { locationId: (await locationByKind(db, 'missing')).id, condition: 'sealed' }, type: 'adjustment', reason: `Reported missing after case ${c.case_ref}` });
      await raiseException(db, ctx.tenantId, { kind: 'missing_unit', severity: 'critical', title: `${c.case_ref}: unit reported missing`, detail: `Usage event ${ev.id} reported a unit missing. Investigate before billing or replenishment.`, caseId: c.id, refTable: 'usage_events', refId: ev.id, ownerRole: 'ops_manager', dedupe: `missing:${ev.id}` });
      break;
    case 'returned_sealed': break; // stays sealed in stock; a return shipment moves it physically
  }
  // Reservation bookkeeping: consumed for anything that left sellable stock, released for returns.
  const resv = await maybe(db, `select * from reservations where case_id=$1 and stock_item_id=$2 and status='active' limit 1`, [c.id, stockId]);
  if (resv) await db.query(`update reservations set status=$2, released_at=$3, release_reason=$4 where id=$1`, [resv.id, ev.disposition === 'returned_sealed' ? 'released' : 'consumed', nowIso(), `Closeout: ${ev.disposition}`]);

  // Usage of a unit under quality hold is preserved as fact and escalated, never discarded.
  const hold = await maybe(db, `select h.*, r.ref recall_ref, r.id rid from quality_holds h left join recalls r on r.id=h.recall_id where h.stock_item_id=$1 and h.status='active' limit 1`, [stockId]);
  if (hold) {
    const before = new Date(ev.occurred_at) < new Date(hold.placed_at);
    const detail = `${c.case_ref}: ${ev.disposition} of a unit under ${hold.recall_ref ?? 'quality hold'} reported ${ev.recorded_offline ? 'from an offline device ' : ''}at ${new Date(ev.recorded_at).toISOString()}; usage occurred ${new Date(ev.occurred_at).toISOString()}, ${before ? 'BEFORE' : 'AFTER'} the hold was placed (${new Date(hold.placed_at).toISOString()}). Recorded usage preserved.`;
    if (hold.rid) await db.query(`insert into recall_tasks(tenant_id, recall_id, task_type, stock_item_id, case_id, usage_event_id, qty, status, detail, created_at) values ($1,$2,'late_usage_review',$3,$4,$5,$6,'open',$7,$8)`,
      [ctx.tenantId, hold.rid, stockId, c.id, ev.id, qty, detail, nowIso()]);
    await raiseException(db, ctx.tenantId, { kind: 'recall_late_usage', severity: 'critical', title: `Usage reported for held unit (${hold.recall_ref ?? 'hold'})`, detail, caseId: c.id, refTable: 'usage_events', refId: ev.id, ownerRole: 'quality_manager', dedupe: `lateuse:${ev.id}` });
    await notifyRole(db, ctx.tenantId, ['quality_manager'], { kind: 'recall_late_usage', message: detail, caseId: c.id, facilityId: c.facility_id, dedupe: `lateuse:${ev.id}` });
    await audit(db, ctx, 'recall.late_usage_escalated', 'usage_event', ev.id, { recall: hold.recall_ref, before_hold: before }, { caseId: c.id });
  }
  await deriveCharge(db, ctx, ev.id);
}

/** Reviewer links a needs_review event to an existing validated stock record (never creates stock). */
export async function reviewUsage(db: Db, ctx: Ctx, usageEventId: string, input: { decision: 'accept' | 'reject'; stockItemId?: string; qtyUnits?: number; note: string }) {
  requirePerm(ctx, 'usage.review');
  const ev = await one(db, `select * from usage_events where id=$1`, [usageEventId]);
  if (ev.status !== 'needs_review') throw new AppError(409, 'not_pending', `Usage event is ${ev.status}`);
  if (!input.note?.trim()) throw new AppError(400, 'note_required', 'A review note is required');
  const c = await getVisibleCase(db, ctx, ev.case_id);
  if (input.decision === 'reject') {
    await db.query(`update usage_events set status='rejected', reviewed_by=$2, reviewed_at=$3, review_reason=coalesce(review_reason,'') || $4 where id=$1`, [usageEventId, ctx.userId, nowIso(), ` | Rejected: ${input.note}`]);
  } else {
    if (!input.stockItemId) throw new AppError(400, 'stock_required', 'Select the validated stock record this event refers to');
    const st = await one(db, `select s.*, ci.tracking from stock_items s join catalog_items ci on ci.id=s.catalog_item_id where s.id=$1`, [input.stockItemId]);
    const qty = input.qtyUnits ?? ev.qty_units ?? 0;
    if (st.is_serial && qty !== 1) throw new AppError(400, 'bad_qty', 'Serialized unit quantity must be 1');
    if (ev.package_gtin && input.qtyUnits == null) throw new AppError(400, 'qty_required', 'Package-level scan: reviewer must enter the number of individual units');
    const source = ev.disposition === 'returned_sealed' ? null : await maybe(db, `select b.* from stock_balances b join locations l on l.id=b.location_id where b.stock_item_id=$1 and b.qty >= $2 and b.condition='sealed' and (l.facility_id=$3 or l.holder_user_id=$4 or l.kind='quarantine') limit 1`, [st.id, qty, c.facility_id, c.rep_user_id]);
    if (ev.disposition !== 'returned_sealed' && !source) throw new AppError(409, 'not_located', 'Ledger does not show that unit at the facility or rep trunk; record a count adjustment first');
    // usage facts are immutable; review links the stock record via a reviewed copy would duplicate. Instead we update only review fields + stock link.
    // Captured facts stay immutable; the reviewer's stock link and unit count are stored in review fields.
    await db.query(`update usage_events set status='recorded', stock_item_id=$2, catalog_item_id=$3, reviewed_qty_units=$4, reviewed_by=$5, reviewed_at=$6, review_reason=coalesce(review_reason,'') || $7 where id=$1`,
      [usageEventId, st.id, st.catalog_item_id, input.qtyUnits ?? null, ctx.userId, nowIso(), ` | Reviewed: ${input.note}${input.qtyUnits ? ` (reviewer entered ${input.qtyUnits} unit(s))` : ''}`]);
    await postUsage(db, ctx, await one(db, `select * from usage_events where id=$1`, [usageEventId]), source, c);
  }
  await db.query(`update exceptions set status='resolved', resolved_by=$2, resolved_at=$3, resolution=$4 where ref_table='usage_events' and ref_id=$1 and kind='usage_review' and status='open'`, [usageEventId, ctx.userId, nowIso(), input.note]);
  await audit(db, ctx, `usage.review_${input.decision}`, 'usage_event', usageEventId, { stock_item_id: input.stockItemId, qty_units: input.qtyUnits }, { caseId: ev.case_id, reason: input.note });
  return one(db, `select * from usage_events where id=$1`, [usageEventId]);
}

export async function recordInstrumentReturn(db: Db, ctx: Ctx, caseId: string, input: { trayStockItemId: string; status: 'returned' | 'missing_items'; note?: string; clientEventId?: string }) {
  requirePerm(ctx, 'closeout.record');
  const c = await getVisibleCase(db, ctx, caseId);
  if (input.clientEventId) {
    const ex = await maybe(db, `select * from instrument_returns where client_event_id=$1`, [input.clientEventId]);
    if (ex) return ex;
  }
  const r = (await db.query(`insert into instrument_returns(tenant_id, case_id, tray_stock_item_id, status, note, recorded_by, recorded_at, client_event_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [ctx.tenantId, caseId, input.trayStockItemId, input.status, input.note ?? null, ctx.userId, nowIso(), input.clientEventId ?? null])).rows[0];
  if (input.status === 'missing_items') await raiseException(db, ctx.tenantId, { kind: 'instrument_missing_after_case', severity: 'warning', title: `${c.case_ref}: instruments missing at return`, detail: input.note ?? 'Rep reported missing instruments', caseId, ownerRole: 'ops_manager', dedupe: `instret:${r.id}` });
  await audit(db, ctx, 'instrument.return', 'tray', input.trayStockItemId, { status: input.status }, { caseId });
  return r;
}

export async function closeoutState(db: Db, ctx: Ctx, caseId: string) {
  const c = await getVisibleCase(db, ctx, caseId);
  const reservations = await rows(db, `select r.*, ci.ref, ci.description, ci.item_type, ci.tracking, ci.unit_gtin, s.serial_number, s.lot_number, s.expiry_date, l.name location_name
     from reservations r join stock_items s on s.id=r.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join locations l on l.id=r.location_id where r.case_id=$1 and r.status in ('active','consumed') order by ci.item_type, ci.ref`, [caseId]);
  const usage = await rows(db, `select ue.*, ci.ref, ci.description, s.serial_number, s.lot_number from usage_events ue left join catalog_items ci on ci.id=ue.catalog_item_id left join stock_items s on s.id=ue.stock_item_id where ue.case_id=$1 order by ue.occurred_at`, [caseId]);
  const returns = await rows(db, `select * from instrument_returns where case_id=$1 order by recorded_at`, [caseId]);
  return { case: c, reservations, usage, instrumentReturns: returns };
}

export async function submitCloseout(db: Db, ctx: Ctx, caseId: string, input: { completedAt?: string }) {
  requirePerm(ctx, 'closeout.record');
  const c = await getVisibleCase(db, ctx, caseId);
  if (ctx.role === 'rep' && c.rep_user_id !== ctx.userId) throw new AppError(403, 'not_assigned', 'Only the assigned rep can submit closeout');
  if (c.status !== 'scheduled') throw new AppError(409, 'bad_state', `Case is already ${c.status}`);
  const open = await rows(db, `select ci.ref, s.serial_number, s.lot_number from reservations r join stock_items s on s.id=r.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id where r.case_id=$1 and r.status='active' and ci.item_type <> 'tray'`, [caseId]);
  if (open.length) throw new AppError(409, 'unaccounted_units', `Record a disposition (including "returned sealed") for: ${open.map((o) => `${o.ref} ${o.serial_number ?? o.lot_number}`).join(', ')}`);
  const pendingReview = (await one(db, `select count(*)::int n from usage_events where case_id=$1 and status='needs_review'`, [caseId])).n;
  const trays = await rows(db, `select r.id, r.stock_item_id from reservations r join stock_items s on s.id=r.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id where r.case_id=$1 and r.status='active' and ci.item_type='tray'`, [caseId]);
  for (const t of trays) {
    await db.query(`update reservations set status='released', released_at=$2, release_reason='Case completed; tray awaiting return and reprocessing' where id=$1`, [t.id, nowIso()]);
    const has = await maybe(db, `select 1 from instrument_returns where case_id=$1 and tray_stock_item_id=$2`, [caseId, t.stock_item_id]);
    if (!has) await db.query(`insert into instrument_returns(tenant_id, case_id, tray_stock_item_id, status, recorded_by, recorded_at) values ($1,$2,$3,'awaiting_return',$4,$5)`, [ctx.tenantId, caseId, t.stock_item_id, ctx.userId, nowIso()]);
  }
  await db.query(`update cases set status='completed', completed_at=$2, version=version+1 where id=$1`, [caseId, input.completedAt ?? nowIso()]);
  await syncIssues(db, ctx.tenantId, caseId, { status: 'completed', blockers: [] });
  await audit(db, ctx, 'closeout.submit', 'case', caseId, { pending_review: pendingReview }, { caseId });
  await notifyRole(db, ctx.tenantId, ['finance'], { kind: 'closeout', message: `Closeout submitted for ${c.case_ref}${pendingReview ? ` (${pendingReview} usage line(s) under review)` : ''}`, caseId, facilityId: c.facility_id, dedupe: `closeout:${caseId}` });
  return { ok: true, pendingReview };
}

/**
 * Correct a recorded usage line (wrong item scanned, wrong disposition). The original event is kept;
 * its stock movement is reversed by a linked reversal, its draft charge is voided with history, and
 * the reservation is restored. Once a packet has been sent, money is corrected by a credit instead.
 */
export async function voidUsage(db: Db, ctx: Ctx, usageEventId: string, input: { reason: string }) {
  requirePerm(ctx, 'usage.void');
  if (!input.reason?.trim()) throw new AppError(400, 'reason_required', 'Say why this line is being corrected');
  const ev = await one(db, `select * from usage_events where id=$1 for update`, [usageEventId]);
  const c = await getVisibleCase(db, ctx, ev.case_id);
  if (ctx.role === 'rep' && c.rep_user_id !== ctx.userId) throw new AppError(403, 'not_assigned', 'Only the assigned rep can correct this case');
  if (ev.status === 'voided') return { usageEvent: ev, replayed: true };
  if (ev.status === 'needs_review' || ev.status === 'rejected') {
    await db.query(`update usage_events set status='voided', voided_by=$2, voided_at=$3, void_reason=$4 where id=$1`, [ev.id, ctx.userId, nowIso(), input.reason]);
    await db.query(`update exceptions set status='resolved', resolved_by=$2, resolved_at=$3, resolution=$4 where ref_table='usage_events' and ref_id=$1 and status='open'`, [ev.id, ctx.userId, nowIso(), `Voided: ${input.reason}`]);
    await audit(db, ctx, 'usage.void', 'usage_event', ev.id, { prior_status: ev.status }, { caseId: c.id, reason: input.reason });
    return { usageEvent: await one(db, `select * from usage_events where id=$1`, [ev.id]), replayed: false };
  }
  const ch = await maybe(db, `select ch.*, bp.status packet_status from charges ch left join billing_packets bp on bp.id=ch.packet_id where ch.usage_event_id=$1`, [ev.id]);
  if (ch?.packet_id && ch.packet_status !== 'draft') throw new AppError(409, 'packet_sent', 'This line is on a packet that was already sent. Finance must issue a credit; stock is corrected separately by ops.');
  const mv = await maybe(db, `select m.id from inventory_movements m where m.usage_event_id=$1 and m.movement_type <> 'reversal' and not exists (select 1 from inventory_movements r where r.reverses_movement_id=m.id)`, [ev.id]);
  if (mv) await reverseMovement(db, ctx, mv.id, `Usage correction: ${input.reason}`);
  await db.query(`update reservations set status='active', released_at=null, release_reason=null where id = (select id from reservations where case_id=$1 and stock_item_id=$2 and status in ('consumed','released') order by created_at desc limit 1) and $3`, [c.id, ev.stock_item_id, c.status === 'scheduled']);
  if (ch) {
    await db.query(`update charges set status='void', packet_id=null where id=$1`, [ch.id]);
    await db.query(`insert into charge_events(tenant_id, charge_id, kind, from_status, to_status, amount_cents, reason, actor_user_id, at) values ($1,$2,'voided',$3,'void',$4,$5,$6,$7)`, [ctx.tenantId, ch.id, ch.status, ch.amount_cents, `Usage line corrected: ${input.reason}`, ctx.userId, nowIso()]);
    await db.query(`update exceptions set status='resolved', resolved_by=$2, resolved_at=$3, resolution='Usage line voided' where ref_table='charges' and ref_id=$1 and status='open'`, [ch.id, ctx.userId, nowIso()]);
  }
  await db.query(`update replenishments set status='void' where usage_event_id=$1`, [ev.id]);
  await db.query(`update usage_events set status='voided', voided_by=$2, voided_at=$3, void_reason=$4 where id=$1`, [ev.id, ctx.userId, nowIso(), input.reason]);
  await audit(db, ctx, 'usage.void', 'usage_event', ev.id, { reversed_movement: mv?.id ?? null, charge_voided: ch?.id ?? null }, { caseId: c.id, reason: input.reason });
  return { usageEvent: await one(db, `select * from usage_events where id=$1`, [ev.id]), replayed: false };
}

/** A device event that could not be stored as usage is quarantined (never dropped) and surfaced to ops. */
export async function quarantineSyncEvent(db: Db, ctx: Ctx, payload: any, reason: string) {
  const id = String(payload?.clientEventId ?? '').slice(0, 100) || `missing-id-${Date.now()}`;
  const r = await db.query(`insert into sync_quarantine(tenant_id, client_event_id, actor_user_id, payload, reason, received_at) values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id, client_event_id) do nothing returning id`,
    [ctx.tenantId, id, ctx.userId, payload ?? {}, reason, nowIso()]);
  if (r.rows[0]) {
    await raiseException(db, ctx.tenantId, { kind: 'sync_quarantine', severity: 'critical', title: `Field usage from ${ctx.displayName} could not be posted`, detail: `${reason}. The event (captured ${payload?.occurredAt ?? 'unknown time'}, ${payload?.disposition ?? 'unknown disposition'}) is held in quarantine for review; it was not discarded.`, refTable: 'sync_quarantine', refId: r.rows[0].id, ownerRole: 'ops_manager', dedupe: `quar:${id}` });
    await audit(db, ctx, 'usage.sync_quarantined', 'sync_quarantine', r.rows[0].id, { reason });
  }
  return id;
}
