import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, isFacilityUser, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit, notify, notifyRole, raiseException } from '../audit.js';
import { activeHold, applyMovement, locationByKind } from './inventory.js';
import { getPolicy, getVisibleCase, fmtLocal } from './cases.js';
import { nextShipmentRef } from './rescue.js';

/** Facility users may only touch shipments to/from their facility; 404 hides others. */
export async function getVisibleShipment(db: Db, ctx: Ctx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'not_found', 'Shipment not found');
  const s = await maybe(db, `select s.*, fl.name from_name, fl.code from_code, fl.kind from_kind, fl.facility_id from_facility, fl.holder_user_id from_holder,
      tl.name to_name, tl.code to_code, tl.kind to_kind, tl.facility_id to_facility, tf.timezone to_tz, c.case_ref
    from shipments s join locations fl on fl.id=s.from_location_id join locations tl on tl.id=s.to_location_id
    left join facilities tf on tf.id=tl.facility_id left join cases c on c.id=s.case_id where s.id=$1`, [id]);
  if (!s) throw new AppError(404, 'not_found', 'Shipment not found');
  if (isFacilityUser(ctx) && s.to_facility !== ctx.facilityId && s.from_facility !== ctx.facilityId) throw new AppError(404, 'not_found', 'Shipment not found');
  // Reps see shipments for visible cases, plus anything leaving or arriving at their own trunk.
  if (ctx.role === 'rep' && s.case_id && s.from_holder !== ctx.userId) {
    const toHolder = await maybe(db, `select holder_user_id from locations where id=$1`, [s.to_location_id]);
    if (toHolder?.holder_user_id !== ctx.userId) await getVisibleCase(db, ctx, s.case_id);
  }
  return s;
}

export async function shipmentDetail(db: Db, ctx: Ctx, id: string) {
  const s = await getVisibleShipment(db, ctx, id);
  const lines = await rows(db, `select sl.*, si.serial_number, si.lot_number, si.expiry_date, ci.ref, ci.description, ci.item_type, p.name owner_name,
      ti.manifest_version_id from shipment_lines sl join stock_items si on si.id=sl.stock_item_id join catalog_items ci on ci.id=si.catalog_item_id
      join parties p on p.id=sl.owner_party_id left join tray_instances ti on ti.stock_item_id=si.id where sl.shipment_id=$1 order by ci.item_type desc, ci.ref`, [id]);
  const custody = await rows(db, `select e.*, u.display_name actor, a.display_name ack_name, fl.name from_name, tl.name to_name from custody_events e join users u on u.id=e.actor_user_id
      left join users a on a.id=e.ack_by left join locations fl on fl.id=e.from_location_id left join locations tl on tl.id=e.to_location_id where e.shipment_id=$1 order by e.occurred_at, e.recorded_at`, [id]);
  const discrepancies = await rows(db, `select d.*, ci.ref, ci.description, u.display_name reporter from discrepancies d left join catalog_items ci on ci.id=d.catalog_item_id join users u on u.id=d.reported_by where d.shipment_id=$1 order by d.reported_at`, [id]);
  const manifests: any = {};
  for (const l of lines.filter((l) => l.manifest_version_id)) {
    manifests[l.stock_item_id] = await trayManifest(db, l.stock_item_id);
  }
  return { shipment: s, lines, custody, discrepancies, manifests };
}

export async function trayManifest(db: Db, trayStockItemId: string) {
  const ti = await one(db, `select ti.*, mv.version, mv.status, s.serial_number asset_tag, ci.ref tray_ref, ci.description tray_name from tray_instances ti join tray_manifest_versions mv on mv.id=ti.manifest_version_id
     join stock_items s on s.id=ti.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id where ti.stock_item_id=$1`, [trayStockItemId]);
  const lines = await rows(db, `select ml.*, ci.ref, ci.description from tray_manifest_lines ml join catalog_items ci on ci.id=ml.catalog_item_id where ml.manifest_version_id=$1 order by ci.ref`, [ti.manifest_version_id]);
  const latest = await maybe(db, `select tv.*, u.display_name verifier, l.name location_name from tray_verifications tv join users u on u.id=tv.verified_by join locations l on l.id=tv.location_id where tray_stock_item_id=$1 order by verified_at desc, recorded_at desc limit 1`, [trayStockItemId]);
  const latestLines = latest ? await rows(db, `select * from tray_verification_lines where verification_id=$1`, [latest.id]) : [];
  return { tray: ti, lines, latestVerification: latest, latestLines };
}

async function custody(db: Db, ctx: Ctx, shipmentId: string, type: string, from: string | null, to: string | null, ack: 'pending' | 'acknowledged' | 'not_required', notes?: string, occurredAt?: string) {
  const r = await db.query(`insert into custody_events(tenant_id, shipment_id, event_type, actor_user_id, from_location_id, to_location_id, occurred_at, recorded_at, ack_state, ack_by, ack_at, notes)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [ctx.tenantId, shipmentId, type, ctx.userId, from, to, occurredAt ?? nowIso(), nowIso(), ack, ack === 'acknowledged' ? ctx.userId : null, ack === 'acknowledged' ? nowIso() : null, notes ?? null]);
  return r.rows[0].id;
}

/** Create delivery shipments for every reserved unit of a case that is not yet at the facility. */
export async function planCaseDelivery(db: Db, ctx: Ctx, caseId: string) {
  requirePerm(ctx, 'shipment.plan');
  const c = await getVisibleCase(db, ctx, caseId);
  const dest = await locationByKind(db, 'hospital_receiving', c.facility_id);
  const policy = await getPolicy(db, c.facility_id);
  const pending = await rows(db, `select r.*, ci.item_type from reservations r join stock_items s on s.id=r.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join locations l on l.id=r.location_id
     where r.case_id=$1 and r.status='active' and (l.facility_id is distinct from $2) and l.kind not in ('in_transit')
       and not exists (select 1 from shipment_lines sl join shipments s2 on s2.id=sl.shipment_id where sl.reservation_id=r.id and s2.status not in ('cancelled','rejected'))`, [caseId, c.facility_id]);
  const bySource = new Map<string, any[]>();
  for (const r of pending) bySource.set(r.location_id, [...(bySource.get(r.location_id) ?? []), r]);
  const created: any[] = [];
  for (const [loc, rs] of bySource) {
    const hrs = Math.max(...rs.map((r) => (r.item_type === 'tray' ? policy.tray_due_hours_before : policy.implant_due_hours_before)));
    const due = new Date(new Date(c.scheduled_start).getTime() - hrs * 3600e3).toISOString();
    const s = (await db.query(`insert into shipments(tenant_id, ref, case_id, from_location_id, to_location_id, kind, status, due_by, created_by, created_at) values ($1,$2,$3,$4,$5,'case_delivery','planned',$6,$7,$8) returning *`,
      [ctx.tenantId, await nextShipmentRef(db), caseId, loc, dest.id, due, ctx.userId, nowIso()])).rows[0];
    for (const r of rs) await db.query(`insert into shipment_lines(tenant_id, shipment_id, stock_item_id, owner_party_id, reservation_id, qty_expected) values ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, s.id, r.stock_item_id, r.owner_party_id, r.id, r.qty]);
    await audit(db, ctx, 'shipment.plan', 'shipment', s.id, { ref: s.ref, lines: rs.length }, { caseId });
    created.push(s);
  }
  return { created };
}

/** Ad-hoc shipment (e.g. replacement loose instrument, or return to warehouse). */
export async function createShipment(db: Db, ctx: Ctx, input: { fromLocationId: string; toLocationId: string; caseId?: string | null; kind: 'replenishment' | 'return' | 'case_delivery'; lines: { stockItemId: string; ownerPartyId: string; qty: number }[]; note?: string }) {
  requirePerm(ctx, 'shipment.plan');
  if (!input.lines?.length) throw new AppError(400, 'no_lines', 'At least one line is required');
  if (input.caseId) await getVisibleCase(db, ctx, input.caseId);
  const s = (await db.query(`insert into shipments(tenant_id, ref, case_id, from_location_id, to_location_id, kind, status, due_by, created_by, created_at) values ($1,$2,$3,$4,$5,$6,'planned',null,$7,$8) returning *`,
    [ctx.tenantId, await nextShipmentRef(db, input.kind === 'return' ? 'RTN' : 'SHP'), input.caseId ?? null, input.fromLocationId, input.toLocationId, input.kind, ctx.userId, nowIso()])).rows[0];
  for (const l of input.lines) {
    await db.query(`insert into shipment_lines(tenant_id, shipment_id, stock_item_id, owner_party_id, qty_expected) values ($1,$2,$3,$4,$5)`, [ctx.tenantId, s.id, l.stockItemId, l.ownerPartyId, l.qty]);
  }
  await audit(db, ctx, 'shipment.create', 'shipment', s.id, { ref: s.ref, kind: input.kind, note: input.note }, { caseId: input.caseId });
  return s;
}

/** Ship an exact replacement for a missing instrument: same catalog item, sealed, unreserved, not held, from a warehouse. */
export async function sendReplacement(db: Db, ctx: Ctx, discrepancyId: string) {
  requirePerm(ctx, 'shipment.plan');
  const d = await one(db, `select * from discrepancies where id=$1`, [discrepancyId]);
  if (d.kind !== 'missing_instrument' || d.status !== 'open' || !d.case_id) throw new AppError(409, 'bad_state', 'Only open missing-instrument discrepancies on a case can be replaced');
  const c = await getVisibleCase(db, ctx, d.case_id);
  const dest = await locationByKind(db, 'hospital_receiving', c.facility_id);
  const already = await maybe(db, `select s.ref from shipments s join shipment_lines sl on sl.shipment_id=s.id join stock_items si on si.id=sl.stock_item_id where s.case_id=$1 and si.catalog_item_id=$2 and s.status not in ('cancelled','rejected')`, [c.id, d.catalog_item_id]);
  if (already) throw new AppError(409, 'already_sent', `Replacement already on ${already.ref}`);
  const src = await maybe(db, `select b.* from stock_balances b join stock_items s on s.id=b.stock_item_id join locations l on l.id=b.location_id
     where s.catalog_item_id=$1 and l.kind='warehouse' and b.condition='sealed' and b.qty>0
       and not exists (select 1 from quality_holds h where h.stock_item_id=b.stock_item_id and h.status='active')
       and not exists (select 1 from reservations r where r.stock_item_id=b.stock_item_id and r.status='active') limit 1`, [d.catalog_item_id]);
  if (!src) throw new AppError(409, 'none_available', 'No unreserved, unheld unit of that exact instrument is in a warehouse');
  const s = await createShipment(db, ctx, { fromLocationId: src.location_id, toLocationId: dest.id, caseId: c.id, kind: 'case_delivery', lines: [{ stockItemId: src.stock_item_id, ownerPartyId: src.owner_party_id, qty: 1 }], note: `Replacement for discrepancy ${discrepancyId}` });
  const policy = await getPolicy(db, c.facility_id);
  await db.query(`update shipments set due_by=$2 where id=$1`, [s.id, new Date(new Date(c.scheduled_start).getTime() - policy.tray_due_hours_before * 3600e3).toISOString()]);
  await notifyRole(db, ctx.tenantId, ['warehouse'], { kind: 'replacement', message: `Pick replacement instrument on ${s.ref} for ${c.case_ref}`, caseId: c.id, facilityId: c.facility_id, dedupe: `repl:${s.id}` });
  return s;
}

export async function pickQueue(db: Db, ctx: Ctx) {
  requirePerm(ctx, 'shipment.pick');
  const list = await rows(db, `select s.*, fl.name from_name, fl.kind from_kind, fl.holder_user_id, tl.name to_name, c.case_ref, c.scheduled_start, f.timezone, te.minutes travel_min,
      (select count(*)::int from shipment_lines sl where sl.shipment_id=s.id) line_count,
      (select count(*)::int from shipment_lines sl where sl.shipment_id=s.id and sl.qty_picked >= sl.qty_expected) picked_count
    from shipments s join locations fl on fl.id=s.from_location_id join locations tl on tl.id=s.to_location_id left join cases c on c.id=s.case_id
    left join facilities f on f.id=tl.facility_id left join travel_estimates te on te.from_location_id=s.from_location_id and te.to_facility_id=tl.facility_id
    where s.status in ('planned','picked','packed') and ($1::uuid is null or fl.holder_user_id=$1 or fl.kind='warehouse')`, [ctx.role === 'rep' ? ctx.userId : null]);
  const t = now().getTime();
  for (const s of list) {
    s.dispatch_by = s.due_by && s.travel_min != null ? new Date(new Date(s.due_by).getTime() - s.travel_min * 60e3).toISOString() : s.due_by;
    s.minutes_left = s.dispatch_by ? Math.round((new Date(s.dispatch_by).getTime() - t) / 60e3) : null;
  }
  list.sort((a, b) => String(a.dispatch_by ?? '9').localeCompare(String(b.dispatch_by ?? '9')));
  return list;
}

/** Pick by scanning/entering the exact unit. Wrong serial or lot is rejected; no substitution. */
export async function pickLine(db: Db, ctx: Ctx, shipmentId: string, input: { lineId: string; qty: number; serial?: string; lot?: string }) {
  requirePerm(ctx, 'shipment.pick');
  const s = await getVisibleShipment(db, ctx, shipmentId);
  if (!['planned', 'picked'].includes(s.status)) throw new AppError(409, 'bad_state', `Shipment is ${s.status}`);
  const l = await one(db, `select sl.*, si.serial_number, si.lot_number from shipment_lines sl join stock_items si on si.id=sl.stock_item_id where sl.id=$1 and sl.shipment_id=$2`, [input.lineId, shipmentId]);
  if (input.serial && input.serial !== l.serial_number) throw new AppError(409, 'wrong_unit', `Scanned serial ${input.serial} does not match the reserved unit ${l.serial_number}`);
  if (input.lot && input.lot !== l.lot_number) throw new AppError(409, 'wrong_unit', `Scanned lot ${input.lot} does not match ${l.lot_number}`);
  if (input.qty < 0 || input.qty > l.qty_expected) throw new AppError(400, 'bad_qty', `Pick quantity must be between 0 and ${l.qty_expected}`);
  const hold = await activeHold(db, l.stock_item_id);
  if (hold) throw new AppError(409, 'on_hold', `Unit is on quality hold (${hold.recall_ref ?? hold.reason}); do not pick`);
  await db.query(`update shipment_lines set qty_picked=$2 where id=$1`, [l.id, input.qty]);
  await db.query(`update shipments set status='picked' where id=$1 and status='planned'`, [shipmentId]);
  await audit(db, ctx, 'shipment.pick', 'shipment_line', l.id, { qty: input.qty }, { caseId: s.case_id });
  return shipmentDetail(db, ctx, shipmentId);
}

export async function packShipment(db: Db, ctx: Ctx, shipmentId: string) {
  requirePerm(ctx, 'shipment.pick');
  const s = await getVisibleShipment(db, ctx, shipmentId);
  if (s.status !== 'picked') throw new AppError(409, 'bad_state', `Shipment must be picked before packing (is ${s.status})`);
  await db.query(`update shipments set status='packed' where id=$1`, [shipmentId]);
  await custody(db, ctx, shipmentId, 'packed', s.from_location_id, null, 'not_required');
  return shipmentDetail(db, ctx, shipmentId);
}

/** Dispatch moves picked quantities to in-transit. Partial shipments are allowed; unpicked quantity stays at source. Holds block dispatch. */
export async function dispatchShipment(db: Db, ctx: Ctx, shipmentId: string, input: { courierName?: string; occurredAt?: string } = {}) {
  requirePerm(ctx, 'shipment.dispatch');
  const s = await getVisibleShipment(db, ctx, shipmentId);
  if (!['picked', 'packed'].includes(s.status)) throw new AppError(409, 'bad_state', `Shipment must be picked/packed before dispatch (is ${s.status})`);
  const lines = await rows(db, `select * from shipment_lines where shipment_id=$1`, [shipmentId]);
  if (!lines.some((l) => l.qty_picked > 0)) throw new AppError(409, 'nothing_picked', 'Nothing has been picked');
  for (const l of lines) {
    const hold = await activeHold(db, l.stock_item_id);
    if (hold) throw new AppError(409, 'on_hold', `A unit on this shipment is on quality hold (${hold.recall_ref ?? hold.reason}); dispatch is blocked`);
  }
  const transit = await locationByKind(db, 'in_transit');
  for (const l of lines.filter((l) => l.qty_picked > 0)) {
    await applyMovement(db, ctx, { stockItemId: l.stock_item_id, qty: l.qty_picked, ownerPartyId: l.owner_party_id, from: { locationId: s.from_location_id, condition: 'sealed' }, to: { locationId: transit.id, condition: 'sealed' },
      type: 'dispatch', reason: `Dispatched on ${s.ref}`, shipmentId, caseId: s.case_id, idempotencyKey: `dispatch:${l.id}`, occurredAt: input.occurredAt });
    await db.query(`update shipment_lines set qty_dispatched=$2 where id=$1`, [l.id, l.qty_picked]);
    if (l.reservation_id) await db.query(`update reservations set location_id=$2 where id=$1 and status='active'`, [l.reservation_id, transit.id]);
  }
  const partial = lines.some((l) => l.qty_picked < l.qty_expected);
  await db.query(`update shipments set status='dispatched', courier_name=coalesce($2,courier_name) where id=$1`, [shipmentId, input.courierName ?? null]);
  await custody(db, ctx, shipmentId, 'dispatched', s.from_location_id, transit.id, 'pending', partial ? 'Partial shipment: some lines short-picked' : undefined, input.occurredAt);
  if (partial) await raiseException(db, ctx.tenantId, { kind: 'partial_shipment', severity: 'warning', title: `${s.ref} dispatched partially`, detail: 'One or more lines were short-picked; remaining quantity stays at the source.', caseId: s.case_id, refTable: 'shipments', refId: shipmentId, ownerRole: 'ops_manager', dedupe: `partial:${shipmentId}` });
  await audit(db, ctx, 'shipment.dispatch', 'shipment', shipmentId, { ref: s.ref, partial }, { caseId: s.case_id });
  return shipmentDetail(db, ctx, shipmentId);
}

/** Courier events never move stock and never make a case ready. */
export async function courierEvent(db: Db, ctx: Ctx, shipmentId: string, input: { type: 'courier_scan' | 'delivered'; note?: string; occurredAt?: string }) {
  requirePerm(ctx, 'shipment.courier');
  const s = await getVisibleShipment(db, ctx, shipmentId);
  if (!['dispatched', 'delivered'].includes(s.status)) throw new AppError(409, 'bad_state', `Shipment is ${s.status}`);
  // Courier acknowledges pickup custody when first scanning.
  await db.query(`update custody_events set ack_state='acknowledged', ack_by=$2, ack_at=$3 where shipment_id=$1 and event_type='dispatched' and ack_state='pending'`, [shipmentId, ctx.userId, nowIso()]);
  await custody(db, ctx, shipmentId, input.type, null, input.type === 'delivered' ? s.to_location_id : null, input.type === 'delivered' ? 'pending' : 'not_required', input.note, input.occurredAt);
  if (input.type === 'delivered') {
    await db.query(`update shipments set status='delivered' where id=$1`, [shipmentId]);
    if (s.to_facility) await notifyRole(db, ctx.tenantId, ['hospital_receiving'], { kind: 'delivery', message: `${s.ref} delivered to receiving${s.case_ref ? ` for case ${s.case_ref}` : ''}; please check in and verify.`, caseId: s.case_id, facilityId: s.to_facility, dedupe: `delivered:${shipmentId}` });
  }
  await audit(db, ctx, `shipment.${input.type}`, 'shipment', shipmentId, { note: input.note }, { caseId: s.case_id });
  return shipmentDetail(db, ctx, shipmentId);
}

function assertReceiver(ctx: Ctx, s: any) {
  if (s.to_facility && s.to_kind.startsWith('hospital')) {
    if (!isFacilityUser(ctx) || ctx.facilityId !== s.to_facility) throw new AppError(403, 'forbidden', 'Only hospital receiving or SPD staff of the destination facility may receive this delivery');
  } else if (isFacilityUser(ctx)) throw new AppError(403, 'forbidden', 'Hospital users cannot receive distributor shipments');
}

/**
 * Receive: actual quantities per line, seal condition, and any unexpected units. Quantities received
 * move from in-transit to the destination; shortfalls stay in transit with a discrepancy; broken
 * seals are received as "damaged" and flagged; unexpected units are recorded as disputed
 * observations without moving stock (the ledger shows them elsewhere until resolved).
 */
export async function receiveShipment(db: Db, ctx: Ctx, shipmentId: string, input: { lines: { lineId: string; qtyReceived: number; sealIntact: boolean; note?: string }[]; unexpected?: { description: string; serial?: string; lot?: string; ref?: string; rawScan?: string }[]; occurredAt?: string }) {
  requirePerm(ctx, 'shipment.receive');
  const s = await getVisibleShipment(db, ctx, shipmentId);
  assertReceiver(ctx, s);
  if (!['dispatched', 'delivered'].includes(s.status)) throw new AppError(409, 'bad_state', `Shipment is ${s.status}; nothing to receive`);
  const transit = await locationByKind(db, 'in_transit');
  const lines = await rows(db, `select sl.*, ci.ref, ci.description, ci.id catalog_item_id from shipment_lines sl join stock_items si on si.id=sl.stock_item_id join catalog_items ci on ci.id=si.catalog_item_id where sl.shipment_id=$1`, [shipmentId]);
  const occurredAt = input.occurredAt ?? nowIso();
  let issues = 0;
  for (const inp of input.lines) {
    const l = lines.find((x) => x.id === inp.lineId);
    if (!l) throw new AppError(400, 'bad_line', 'Line not on this shipment');
    const outstanding = l.qty_dispatched - l.qty_received;
    if (inp.qtyReceived < 0) throw new AppError(400, 'bad_qty', 'Received quantity cannot be negative');
    if (inp.qtyReceived > outstanding) {
      issues++;
      await disc(db, ctx, { shipmentId, caseId: s.case_id, stockItemId: l.stock_item_id, catalogItemId: l.catalog_item_id, kind: 'over', qty: inp.qtyReceived - outstanding, detail: `${l.ref}: counted ${inp.qtyReceived}, only ${outstanding} dispatched. Excess not posted to stock pending review.` });
    }
    const qty = Math.min(inp.qtyReceived, outstanding);
    if (qty > 0) {
      await applyMovement(db, ctx, { stockItemId: l.stock_item_id, qty, ownerPartyId: l.owner_party_id, from: { locationId: transit.id, condition: 'sealed' }, to: { locationId: s.to_location_id, condition: inp.sealIntact ? 'sealed' : 'damaged' },
        type: 'receive', reason: `Received on ${s.ref}${inp.sealIntact ? '' : ' with broken seal'}`, shipmentId, caseId: s.case_id, occurredAt, idempotencyKey: `receive:${l.id}:${l.qty_received + qty}` });
      await db.query(`update shipment_lines set qty_received=qty_received+$2, received_condition=$3 where id=$1`, [l.id, qty, inp.sealIntact ? 'sealed' : 'damaged']);
      if (l.reservation_id) await db.query(`update reservations set location_id=$2 where id=$1 and status='active'`, [l.reservation_id, s.to_location_id]);
    }
    if (!inp.sealIntact) {
      issues++;
      await disc(db, ctx, { shipmentId, caseId: s.case_id, stockItemId: l.stock_item_id, catalogItemId: l.catalog_item_id, kind: 'broken_seal', qty, detail: `${l.ref}: package seal broken on receipt; received as damaged and not usable.${inp.note ? ' ' + inp.note : ''}` });
      if (l.reservation_id) await db.query(`update reservations set status='released', released_at=$2, release_reason='Received with broken seal' where id=$1 and status='active'`, [l.reservation_id, nowIso()]);
    }
    if (inp.qtyReceived < outstanding) {
      issues++;
      await disc(db, ctx, { shipmentId, caseId: s.case_id, stockItemId: l.stock_item_id, catalogItemId: l.catalog_item_id, kind: 'short', qty: outstanding - inp.qtyReceived, detail: `${l.ref}: ${outstanding - inp.qtyReceived} of ${outstanding} not received; remains in transit until located.` });
    }
  }
  for (const u of input.unexpected ?? []) {
    issues++;
    await disc(db, ctx, { shipmentId, caseId: s.case_id, kind: 'unexpected_unit', detail: `Unexpected unit not on shipment: ${u.description}${u.ref ? ` ref ${u.ref}` : ''}${u.serial ? ` SN ${u.serial}` : ''}${u.lot ? ` lot ${u.lot}` : ''}${u.rawScan ? ` (raw scan preserved: ${u.rawScan})` : ''}. Not posted to stock.` });
  }
  const after = await rows(db, `select qty_dispatched, qty_received from shipment_lines where shipment_id=$1`, [shipmentId]);
  await db.query(`update shipments set status='received' where id=$1`, [shipmentId]);
  await db.query(`update custody_events set ack_state='acknowledged', ack_by=$2, ack_at=$3 where shipment_id=$1 and event_type in ('delivered','dispatched') and ack_state='pending'`, [shipmentId, ctx.userId, nowIso()]);
  await custody(db, ctx, shipmentId, 'received', transit.id, s.to_location_id, 'acknowledged', issues ? `${issues} discrepancy(ies) recorded` : 'Received as expected', occurredAt);
  await audit(db, ctx, 'shipment.receive', 'shipment', shipmentId, { issues, complete: after.every((l) => l.qty_received >= l.qty_dispatched) }, { caseId: s.case_id });
  if (issues && s.case_id) {
    const c = await one(db, `select rep_user_id, case_ref, facility_id from cases where id=$1`, [s.case_id]);
    await notify(db, ctx.tenantId, c.rep_user_id, { kind: 'receiving_discrepancy', message: `${s.ref} for ${c.case_ref} received with ${issues} discrepancy(ies)`, caseId: s.case_id, facilityId: c.facility_id, dedupe: `recvdisc:${shipmentId}` });
    await notifyRole(db, ctx.tenantId, ['ops_manager'], { kind: 'receiving_discrepancy', message: `${s.ref} for ${c.case_ref} received with ${issues} discrepancy(ies)`, caseId: s.case_id, facilityId: c.facility_id, dedupe: `recvdisc:${shipmentId}` });
  }
  return shipmentDetail(db, ctx, shipmentId);
}

export async function rejectShipment(db: Db, ctx: Ctx, shipmentId: string, input: { reason: string }) {
  requirePerm(ctx, 'shipment.receive');
  const s = await getVisibleShipment(db, ctx, shipmentId);
  assertReceiver(ctx, s);
  if (!input.reason?.trim()) throw new AppError(400, 'reason_required', 'A rejection reason is required');
  if (!['dispatched', 'delivered'].includes(s.status)) throw new AppError(409, 'bad_state', `Shipment is ${s.status}`);
  await db.query(`update shipments set status='rejected' where id=$1`, [shipmentId]);
  await custody(db, ctx, shipmentId, 'rejected', null, null, 'acknowledged', input.reason);
  await disc(db, ctx, { shipmentId, caseId: s.case_id, kind: 'rejected_delivery', detail: `Delivery rejected by hospital: ${input.reason}. Stock remains in transit custody with the courier until returned.` });
  await raiseException(db, ctx.tenantId, { kind: 'rejected_delivery', severity: 'critical', title: `${s.ref} rejected at receiving`, detail: input.reason, caseId: s.case_id, facilityId: s.to_facility, refTable: 'shipments', refId: shipmentId, ownerRole: 'ops_manager', dedupe: `reject:${shipmentId}` });
  await audit(db, ctx, 'shipment.reject', 'shipment', shipmentId, {}, { caseId: s.case_id, reason: input.reason });
  return shipmentDetail(db, ctx, shipmentId);
}

async function disc(db: Db, ctx: Ctx, d: { shipmentId?: string | null; caseId?: string | null; stockItemId?: string | null; catalogItemId?: string | null; trayStockItemId?: string | null; kind: string; qty?: number | null; detail: string }) {
  const r = await db.query(`insert into discrepancies(tenant_id, shipment_id, case_id, stock_item_id, catalog_item_id, tray_stock_item_id, kind, qty, detail, status, reported_by, reported_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$11) returning id`,
    [ctx.tenantId, d.shipmentId ?? null, d.caseId ?? null, d.stockItemId ?? null, d.catalogItemId ?? null, d.trayStockItemId ?? null, d.kind, d.qty ?? null, d.detail, ctx.userId, nowIso()]);
  await raiseException(db, ctx.tenantId, { kind: `discrepancy:${d.kind}`, severity: d.kind === 'missing_instrument' || d.kind === 'rejected_delivery' ? 'critical' : 'warning', title: `${d.kind.replace(/_/g, ' ')}`, detail: d.detail, caseId: d.caseId, refTable: 'discrepancies', refId: r.rows[0].id, ownerRole: 'ops_manager', dedupe: `disc:${r.rows[0].id}` });
  return r.rows[0].id;
}

/**
 * Record expected-vs-actual tray contents against the tray's versioned manifest. Missing required
 * instruments create discrepancies; a later complete verification resolves them with evidence.
 */
export async function verifyTray(db: Db, ctx: Ctx, trayStockItemId: string, input: { caseId?: string | null; shipmentId?: string | null; sealIntact: boolean; lines: { catalogItemId: string; actualQty: number }[]; occurredAt?: string }) {
  requirePerm(ctx, 'tray.verify');
  const m = await trayManifest(db, trayStockItemId);
  const bal = await maybe(db, `select b.location_id, l.facility_id, l.kind from stock_balances b join locations l on l.id=b.location_id where b.stock_item_id=$1 and b.qty>0 limit 1`, [trayStockItemId]);
  if (!bal) throw new AppError(409, 'no_location', 'Ledger has no current location for this tray');
  if (isFacilityUser(ctx) && bal.facility_id !== ctx.facilityId) throw new AppError(404, 'not_found', 'Tray not found');
  if (input.caseId) await getVisibleCase(db, ctx, input.caseId);
  const actual = new Map(input.lines.map((l) => [l.catalogItemId, l.actualQty]));
  const missing = m.lines.filter((l) => l.required && (actual.get(l.catalog_item_id) ?? 0) < l.qty);
  const result = missing.length === 0 && input.sealIntact ? 'complete' : 'incomplete';
  const at = input.occurredAt ?? nowIso();
  const v = (await db.query(`insert into tray_verifications(tenant_id, tray_stock_item_id, manifest_version_id, location_id, shipment_id, case_id, seal_intact, result, verified_by, verified_at, recorded_at, supersedes_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [ctx.tenantId, trayStockItemId, m.tray.manifest_version_id, bal.location_id, input.shipmentId ?? null, input.caseId ?? null, input.sealIntact, result, ctx.userId, at, nowIso(), m.latestVerification?.id ?? null])).rows[0];
  for (const l of m.lines) {
    await db.query(`insert into tray_verification_lines(tenant_id, verification_id, catalog_item_id, expected_qty, actual_qty, required) values ($1,$2,$3,$4,$5,$6)`,
      [ctx.tenantId, v.id, l.catalog_item_id, l.qty, actual.get(l.catalog_item_id) ?? 0, l.required]);
  }
  const open = await rows(db, `select * from discrepancies where tray_stock_item_id=$1 and status='open' and kind='missing_instrument'`, [trayStockItemId]);
  for (const l of missing) {
    if (open.find((d) => d.catalog_item_id === l.catalog_item_id)) continue;
    await disc(db, ctx, { shipmentId: input.shipmentId, caseId: input.caseId, trayStockItemId, catalogItemId: l.catalog_item_id, kind: 'missing_instrument', qty: l.qty - (actual.get(l.catalog_item_id) ?? 0), detail: `Tray ${m.tray.asset_tag} (manifest v${m.tray.version}) is missing ${l.description} (${l.ref}): expected ${l.qty}, found ${actual.get(l.catalog_item_id) ?? 0}` });
  }
  if (!input.sealIntact) await disc(db, ctx, { shipmentId: input.shipmentId, caseId: input.caseId, trayStockItemId, kind: 'broken_seal', detail: `Tray ${m.tray.asset_tag} container seal/lock not intact on verification` });
  if (result === 'complete') {
    for (const d of await rows(db, `select id from discrepancies where tray_stock_item_id=$1 and status='open' and kind in ('missing_instrument','broken_seal')`, [trayStockItemId])) {
      await db.query(`update discrepancies set status='resolved', resolution=$2, resolved_by=$3, resolved_at=$4 where id=$1`, [d.id, `Re-verified complete against manifest v${m.tray.version} (verification ${v.id})`, ctx.userId, nowIso()]);
      await db.query(`update exceptions set status='resolved', resolved_by=$2, resolved_at=$3, resolution='Tray re-verified complete' where ref_table='discrepancies' and ref_id=$1 and status='open'`, [d.id, ctx.userId, nowIso()]);
    }
  }
  await audit(db, ctx, 'tray.verify', 'tray', trayStockItemId, { result, missing: missing.map((l) => l.ref), manifest_version: m.tray.version }, { caseId: input.caseId });
  return { verification: v, result, missing: missing.map((l) => ({ ref: l.ref, description: l.description, expected: l.qty, actual: actual.get(l.catalog_item_id) ?? 0 })) };
}

export async function resolveDiscrepancy(db: Db, ctx: Ctx, id: string, input: { resolution: string }) {
  requirePerm(ctx, 'discrepancy.resolve');
  const d = await one(db, `select * from discrepancies where id=$1`, [id]);
  if (d.status !== 'open') throw new AppError(409, 'not_open', 'Discrepancy is already resolved');
  if (d.kind === 'missing_instrument') throw new AppError(409, 'needs_reverification', 'A missing-instrument discrepancy is resolved only by a complete re-verification of the tray at the facility');
  if (!input.resolution?.trim()) throw new AppError(400, 'resolution_required', 'Describe how it was resolved');
  await db.query(`update discrepancies set status='resolved', resolution=$2, resolved_by=$3, resolved_at=$4 where id=$1`, [id, input.resolution, ctx.userId, nowIso()]);
  await db.query(`update exceptions set status='resolved', resolved_by=$2, resolved_at=$3, resolution=$4 where ref_table='discrepancies' and ref_id=$1 and status='open'`, [id, ctx.userId, nowIso(), input.resolution]);
  await audit(db, ctx, 'discrepancy.resolve', 'discrepancy', id, {}, { caseId: d.case_id, reason: input.resolution });
  return { ok: true };
}

export async function closeHandoff(db: Db, ctx: Ctx, shipmentId: string) {
  requirePerm(ctx, 'shipment.receive');
  const s = await getVisibleShipment(db, ctx, shipmentId);
  if (s.status !== 'received') throw new AppError(409, 'bad_state', `Only received shipments can be closed (is ${s.status})`);
  const open = await rows(db, `select kind from discrepancies where shipment_id=$1 and status='open'`, [shipmentId]);
  if (open.length) throw new AppError(409, 'open_discrepancies', `Cannot close: ${open.length} open discrepancy(ies): ${open.map((o) => o.kind).join(', ')}`);
  await db.query(`update shipments set status='closed' where id=$1`, [shipmentId]);
  await custody(db, ctx, shipmentId, 'closed', null, s.to_location_id, 'acknowledged');
  await audit(db, ctx, 'shipment.close', 'shipment', shipmentId, {}, { caseId: s.case_id });
  return shipmentDetail(db, ctx, shipmentId);
}

export async function ackCustody(db: Db, ctx: Ctx, eventId: string, input: { decision: 'acknowledged' | 'disputed'; note?: string }) {
  const e = await one(db, `select * from custody_events where id=$1`, [eventId]);
  await getVisibleShipment(db, ctx, e.shipment_id);
  if (e.ack_state !== 'pending') throw new AppError(409, 'not_pending', `Already ${e.ack_state}`);
  if (e.actor_user_id === ctx.userId) throw new AppError(409, 'self_ack', 'The receiving party, not the sender, must acknowledge custody');
  await db.query(`update custody_events set ack_state=$2, ack_by=$3, ack_at=$4, notes=coalesce(notes,'') || $5 where id=$1`, [eventId, input.decision, ctx.userId, nowIso(), input.note ? ` | ack note: ${input.note}` : '']);
  if (input.decision === 'disputed') await disc(db, ctx, { shipmentId: e.shipment_id, kind: 'disputed_observation', detail: `Custody ${e.event_type} disputed: ${input.note ?? 'no note'}` });
  return { ok: true };
}

/**
 * Hospital release decision. Only hospital personnel of the case's facility. The facility policy
 * lists required evidence references (e.g. the hospital's own load record ID); the software stores
 * what the hospital enters and does not infer sterilization or issue clinical clearance.
 */
export async function recordRelease(db: Db, ctx: Ctx, caseId: string, input: { trayStockItemId: string; decision: 'released' | 'not_released'; evidence: Record<string, string> }) {
  requirePerm(ctx, 'hospital.release');
  const c = await getVisibleCase(db, ctx, caseId);
  if (ctx.facilityId !== c.facility_id) throw new AppError(403, 'forbidden', 'Only staff of the case facility may record its release decision');
  const policy = await getPolicy(db, c.facility_id);
  const latest = await maybe(db, `select * from tray_verifications where tray_stock_item_id=$1 order by verified_at desc, recorded_at desc limit 1`, [input.trayStockItemId]);
  if (input.decision === 'released') {
    if (!latest || latest.result !== 'complete') throw new AppError(409, 'not_verified', 'Tray contents must be verified complete before a release decision can be recorded');
    const missing = (policy.required_evidence as string[]).filter((k) => !input.evidence?.[k]?.trim());
    if (missing.length) throw new AppError(400, 'evidence_required', `${c.facility_name} policy v${policy.version} requires: ${missing.join(', ')}`);
  }
  const statement = 'Release decision recorded by authorized hospital personnel. Tracewell stores this decision and the evidence references provided; it does not determine sterility or provide clinical clearance.';
  const r = (await db.query(`insert into release_decisions(tenant_id, case_id, facility_id, tray_stock_item_id, decision, evidence, statement, recorded_by, recorded_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [ctx.tenantId, caseId, c.facility_id, input.trayStockItemId, input.decision, input.evidence ?? {}, statement, ctx.userId, nowIso()])).rows[0];
  await audit(db, ctx, 'hospital.release_decision', 'release_decision', r.id, { decision: input.decision, policy_version: policy.version }, { caseId });
  await notify(db, ctx.tenantId, c.rep_user_id, { kind: 'release', message: `${c.facility_name} recorded "${input.decision.replace('_', ' ')}" for case ${c.case_ref}`, caseId, facilityId: c.facility_id, dedupe: `rel:${r.id}` });
  return r;
}

export { fmtLocal };
