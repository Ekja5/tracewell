/**
 * Three read-only views for Operations, all straight from the ledger and shipments:
 *  - where every unit is right now (warehouse, reps, hospitals, in transit, quarantine), reserved or free
 *  - each case's progress from entry to return
 *  - today's and tomorrow's run sheet: what must leave where, in order of the latest safe departure
 */
import { Db, rows } from '../db.js';
import { Ctx, can, requirePerm } from '../perms.js';
import { now } from '../clock.js';
import { fmtLocal } from '../domain/cases.js';
import { caseScope } from '../perms.js';
import { getSettings } from './settings.js';

const BUCKET: Record<string, string> = { warehouse: 'warehouse', trunk: 'reps', consignment: 'hospitals', hospital_receiving: 'hospitals', hospital_spd: 'hospitals', in_transit: 'inTransit', quarantine: 'quarantine', returns: 'returns' };
export const BUCKET_LABEL: Record<string, string> = { warehouse: 'Warehouse', reps: 'With reps', hospitals: 'At hospitals', inTransit: 'In transit', quarantine: 'Quarantine', returns: 'Being returned' };

export async function whereIsEverything(db: Db, ctx: Ctx & { tenantTz?: string }) {
  requirePerm(ctx, 'inventory.view');
  const t = now(); const s = await getSettings(db);
  const bal = await rows(db, `select b.qty, b.condition, st.id stock_item_id, st.lot_number, st.serial_number, st.expiry_date, ci.id catalog_item_id, ci.ref, ci.description, ci.item_type, l.id location_id, l.name location, l.kind, hu.display_name holder, p.name owner, p.kind owner_kind,
      coalesce((select sum(r.qty) from reservations r where r.stock_item_id=b.stock_item_id and r.location_id=b.location_id and r.owner_party_id=b.owner_party_id and r.status='active'),0)::int reserved,
      (select string_agg(distinct c.case_ref, ', ') from reservations r join cases c on c.id=r.case_id where r.stock_item_id=b.stock_item_id and r.location_id=b.location_id and r.status='active') reserved_for,
      exists(select 1 from quality_holds h where h.stock_item_id=b.stock_item_id and h.status='active') on_hold,
      (select sh.ref from shipment_lines sl join shipments sh on sh.id=sl.shipment_id where sl.stock_item_id=b.stock_item_id and sh.status='dispatched' limit 1) shipment_ref,
      (select ln.ref from loaner_requests ln where ln.stock_item_id=b.stock_item_id and ln.status='received' limit 1) loaner_ref
    from stock_balances b join stock_items st on st.id=b.stock_item_id join catalog_items ci on ci.id=st.catalog_item_id join locations l on l.id=b.location_id join parties p on p.id=b.owner_party_id left join users hu on hu.id=l.holder_user_id
    where b.qty>0 and l.kind not in ('consumed','wasted','missing') and ci.item_type <> 'instrument' order by ci.ref, l.kind, l.name`);
  const demand = new Map((await rows(db, `select cr.catalog_item_id, sum(greatest(cr.qty - coalesce((select sum(r.qty) from reservations r where r.requirement_id=cr.id and r.status='active'),0),0))::int n
     from case_requirements cr join cases c on c.id=cr.case_id where cr.active and cr.mandatory and c.status='scheduled' and c.scheduled_start between $1 and $2 group by 1`, [t.toISOString(), new Date(t.getTime() + s.planningWindowHours * 3600e3).toISOString()])).map((d) => [d.catalog_item_id, d.n]));
  const items = new Map<string, any>();
  for (const b of bal) {
    if (!items.has(b.catalog_item_id)) items.set(b.catalog_item_id, { catalogItemId: b.catalog_item_id, ref: b.ref, description: b.description, itemType: b.item_type, total: 0, reserved: 0, free: 0, onHold: 0, onLoan: 0, buckets: { warehouse: 0, reps: 0, hospitals: 0, inTransit: 0, quarantine: 0, returns: 0 }, units: [] as any[], unreservedDemand: demand.get(b.catalog_item_id) ?? 0 });
    const it = items.get(b.catalog_item_id); const bucket = BUCKET[b.kind] ?? 'warehouse';
    const usable = b.condition === 'sealed' && !b.on_hold && ['warehouse', 'reps', 'hospitals'].includes(bucket);
    const free = usable ? Math.max(0, b.qty - b.reserved) : 0;
    it.total += b.qty; it.buckets[bucket] += b.qty; it.reserved += b.reserved; it.free += free; if (b.on_hold) it.onHold += b.qty; if (b.loaner_ref) it.onLoan += b.qty;
    it.units.push({ unit: b.serial_number ? `SN ${b.serial_number}` : `lot ${b.lot_number}`, location: b.location, bucket, bucketLabel: BUCKET_LABEL[bucket], holder: b.holder, qty: b.qty, reserved: b.reserved, reservedFor: b.reserved_for, free, condition: b.condition, onHold: b.on_hold,
      expiry: b.expiry_date ? (typeof b.expiry_date === 'string' ? b.expiry_date : b.expiry_date.toISOString().slice(0, 10)) : null, owner: b.owner, loaner: b.loaner_ref, shipment: b.shipment_ref });
  }
  const list = [...items.values()].map((it) => ({ ...it, gap: Math.max(0, it.unreservedDemand - it.free) })).sort((a, b) => b.gap - a.gap || a.ref.localeCompare(b.ref));
  const totals = list.reduce((a, it) => { for (const k of Object.keys(a)) a[k] += it.buckets[k]; return a; }, { warehouse: 0, reps: 0, hospitals: 0, inTransit: 0, quarantine: 0, returns: 0 } as Record<string, number>);
  return { asOfLocal: fmtLocal(t, ctx.tenantTz ?? 'UTC'), windowHours: s.planningWindowHours, labels: BUCKET_LABEL, totals, items: list,
    note: 'From the stock ledger at this moment. Free = sealed, not on hold, not reserved, in a warehouse, with a rep or at a hospital. It is as current as the last scan, count or upload recorded here.' };
}

const STAGES = ['Entered', 'Items reserved', 'Shipped', 'Checked in at hospital', 'Surgery done', 'Usage recorded', 'Closed'] as const;

/** Each case from entry to close, with the one thing it is waiting on. */
export async function caseTracker(db: Db, ctx: Ctx) {
  requirePerm(ctx, 'board.view');
  const t = now(); const s = await getSettings(db);
  const [scope, sp] = caseScope(ctx, 3);
  const cases = await rows(db, `select c.id, c.case_ref, c.status, c.scheduled_start, c.created_at, c.completed_at, f.name facility, f.timezone, f.id facility_id, u.display_name rep, c.procedure,
      (select count(*)::int from case_requirements cr where cr.case_id=c.id and cr.active and cr.mandatory) reqs,
      (select coalesce(sum(cr.qty),0)::int from case_requirements cr where cr.case_id=c.id and cr.active and cr.mandatory) need,
      (select coalesce(sum(r.qty),0)::int from reservations r join case_requirements cr on cr.id=r.requirement_id where r.case_id=c.id and r.status in ('active','consumed') and cr.active and cr.mandatory) held,
      (select coalesce(sum(r.qty),0)::int from reservations r join locations l on l.id=r.location_id where r.case_id=c.id and r.status='active' and l.facility_id=c.facility_id and l.kind in ('hospital_receiving','hospital_spd','consignment')) at_site,
      (select coalesce(sum(r.qty),0)::int from reservations r where r.case_id=c.id and r.status='active') active_resv,
      (select count(*)::int from shipments sh where sh.case_id=c.id and sh.status in ('planned','picked','packed')) not_left,
      (select count(*)::int from shipments sh where sh.case_id=c.id and sh.status='dispatched') on_road,
      (select count(*)::int from shipments sh where sh.case_id=c.id and sh.status='delivered') delivered,
      (select count(*)::int from shipments sh where sh.case_id=c.id and sh.status in ('received','closed')) received,
      (select count(*)::int from usage_events ue where ue.case_id=c.id and ue.status='recorded') usage,
      (select count(*)::int from usage_events ue where ue.case_id=c.id and ue.status='needs_review') usage_review,
      (select coalesce(sum(b.qty),0)::int from stock_balances b join locations l on l.id=b.location_id where l.facility_id=c.facility_id and l.kind in ('hospital_receiving','hospital_spd') and b.qty>0
         and b.stock_item_id in (select sl.stock_item_id from shipment_lines sl join shipments sh on sh.id=sl.shipment_id where sh.case_id=c.id)) left_at_site,
      (select string_agg(ln.ref, ', ') from loaner_requests ln where ln.case_id=c.id and ln.status in ('requested','confirmed','shipped','received')) loaners,
      (select string_agg(tr.ref, ', ') from transfer_requests tr where tr.case_id=c.id and tr.status='requested') transfers
    from cases c join facilities f on f.id=c.facility_id left join users u on u.id=c.rep_user_id
    where c.status <> 'cancelled' and c.scheduled_start between $1 and $2 and ${scope} order by c.scheduled_start`, [new Date(t.getTime() - 7 * 86400e3).toISOString(), new Date(t.getTime() + Math.max(s.planningWindowHours, 168) * 3600e3).toISOString(), ...sp]);
  const out = cases.map((c) => {
    const past = new Date(c.scheduled_start) < t; const doneCase = ['completed', 'closed'].includes(c.status);
    const reserved = c.reqs > 0 && c.held >= c.need;
    const allAtSite = c.active_resv > 0 && c.at_site >= c.active_resv;
    const shipped = reserved && (allAtSite || (c.not_left === 0 && (c.on_road + c.delivered + c.received) > 0));
    const checkedIn = reserved && (allAtSite || (c.not_left === 0 && c.on_road === 0 && c.delivered === 0 && c.received > 0));
    const done = [true, reserved || doneCase, shipped || doneCase, checkedIn || doneCase, doneCase, doneCase && c.usage_review === 0 && (c.usage > 0 || c.status === 'closed'), c.status === 'closed'];
    const idx = done.findIndex((d) => !d); const stage = idx === -1 ? STAGES.length - 1 : idx - 1;
    const waiting = idx === -1 ? null : idx === 1 ? (c.reqs === 0 ? 'Requirements have not been loaded' : `${c.need - c.held} unit(s) still to reserve${c.transfers ? ` (${c.transfers} awaiting acceptance)` : ''}${c.loaners ? ` (${c.loaners} on the way)` : ''}`)
      : idx === 2 ? (c.not_left ? `${c.not_left} shipment(s) not yet picked up` : 'Delivery not planned') : idx === 3 ? (c.delivered ? 'Hospital receiving to check the delivery in' : c.on_road ? 'On the road' : 'Not all items are at the hospital')
      : idx === 4 ? (past ? 'Rep to complete the case and record what was used' : null) : idx === 5 ? (c.usage_review ? `${c.usage_review} usage record(s) need review` : 'Usage to be recorded') : (c.left_at_site ? `${c.left_at_site} unit(s) still at the hospital to bring back` : 'Closeout to finish');
    return { id: c.id, caseRef: c.case_ref, facility: c.facility, rep: c.rep, procedure: c.procedure, startLocal: fmtLocal(c.scheduled_start, c.timezone), enteredLocal: fmtLocal(c.created_at, c.timezone), past, status: c.status,
      stage, stageName: STAGES[stage], steps: STAGES.map((n, i) => ({ name: n, done: done[i] })), waitingOn: waiting, behind: !!waiting && (idx <= 3 ? hoursTo(c.scheduled_start, t) < 24 : past && hoursTo(c.scheduled_start, t) < -24),
      leftAtSite: doneCase ? c.left_at_site : 0, loaners: c.loaners, transfers: c.transfers };
  });
  return { stages: STAGES, upcoming: out.filter((c) => !c.past), recent: out.filter((c) => c.past).reverse(), toBringBack: out.filter((c) => c.leftAtSite > 0).reduce((a, c) => a + c.leftAtSite, 0) };
}
const hoursTo = (iso: string, t: Date) => (new Date(iso).getTime() - t.getTime()) / 3600e3;

/** What has to leave, from where, in order of the latest safe departure. Ordered by deadline; not optimized for distance. */
export async function runSheet(db: Db, ctx: Ctx & { tenantTz?: string }) {
  if (!can(ctx, 'shipment.pick') && !can(ctx, 'shipment.courier') && !can(ctx, 'attention.view')) requirePerm(ctx, 'shipment.pick');
  const t = now(); const tz = ctx.tenantTz ?? 'UTC';
  const sh = await rows(db, `select sh.id, sh.ref, sh.kind, sh.status, sh.due_by, sh.courier_name, c.case_ref, c.id case_id, c.scheduled_start, fl.id from_id, fl.name from_name, fl.kind from_kind, hu.display_name from_holder, tl.name to_name, tf.name to_facility, tf.timezone, tf.id to_facility_id,
      te.minutes travel_min, (select coalesce(sum(sl.qty_expected),0)::int from shipment_lines sl where sl.shipment_id=sh.id) units,
      (select string_agg(distinct ci.ref, ', ') from shipment_lines sl join stock_items st on st.id=sl.stock_item_id join catalog_items ci on ci.id=st.catalog_item_id where sl.shipment_id=sh.id) items,
      tr.ref transfer_ref, tr.id transfer_id, tr.pickup_by, tr.pickup_at, tr.receiver
    from shipments sh join locations fl on fl.id=sh.from_location_id join locations tl on tl.id=sh.to_location_id left join facilities tf on tf.id=tl.facility_id left join cases c on c.id=sh.case_id left join users hu on hu.id=fl.holder_user_id
      left join travel_estimates te on te.from_location_id=sh.from_location_id and te.to_facility_id=tl.facility_id left join transfer_requests tr on tr.shipment_id=sh.id
    where sh.status in ('planned','picked','packed','dispatched','delivered') and ($1::uuid is null or tl.facility_id=$1) order by sh.due_by nulls last`, [ctx.facilityId]);
  const stops = sh.map((x) => {
    const zone = x.timezone ?? tz; const due = x.due_by ? new Date(x.due_by) : null;
    const leaveBy = due && x.travel_min != null ? new Date(due.getTime() - x.travel_min * 60e3) : null;
    const moving = ['dispatched', 'delivered'].includes(x.status);
    const next = x.status === 'planned' ? 'Pick' : x.status === 'picked' ? 'Pack' : x.status === 'packed' ? 'Hand to courier / dispatch' : x.status === 'dispatched' ? 'Deliver' : 'Hospital check-in';
    const minutesLeft = !moving && leaveBy ? Math.round((leaveBy.getTime() - t.getTime()) / 60e3) : null;
    return { id: x.id, ref: x.ref, kind: x.kind, kindLabel: x.transfer_ref ? `Transfer ${x.transfer_ref}` : x.kind === 'case_delivery' ? 'Case delivery' : x.kind === 'return' ? 'Return' : x.kind === 'replenishment' ? 'Replenishment' : 'Transfer', status: x.status, next, caseId: x.case_id, caseRef: x.case_ref,
      from: x.from_name, fromHolder: x.from_holder, to: x.to_facility ?? x.to_name, units: x.units, items: x.items, travelMinutes: x.travel_min, dueLocal: due ? fmtLocal(due, zone) : null, leaveByLocal: leaveBy ? fmtLocal(leaveBy, zone) : null, minutesLeft,
      late: minutesLeft != null && minutesLeft < 0, moving, who: x.pickup_by ?? x.courier_name ?? (x.from_kind === 'trunk' ? x.from_holder : 'Warehouse / courier'), plannedPickupLocal: x.pickup_at ? fmtLocal(x.pickup_at, zone) : null, receiver: x.receiver, transferId: x.transfer_id, sort: (leaveBy ?? due ?? new Date(8.64e15)).getTime() };
  }).sort((a, b) => Number(a.moving) - Number(b.moving) || a.sort - b.sort);
  const returns = can(ctx, 'loaner.view') ? (await rows(db, `select ln.id, ln.ref, ln.qty, ln.due_back, ln.source_name, ci.ref item_ref, c.case_ref, loc.name at_name from loaner_requests ln join catalog_items ci on ci.id=ln.catalog_item_id join cases c on c.id=ln.case_id left join locations loc on loc.id=ln.received_location_id where ln.status='received' order by ln.due_back`))
    .map((l) => ({ id: l.id, ref: l.ref, qty: l.qty, item: l.item_ref, caseRef: l.case_ref, at: l.at_name, source: l.source_name, dueBack: typeof l.due_back === 'string' ? l.due_back : l.due_back?.toISOString().slice(0, 10) })) : [];
  const groups = new Map<string, any[]>(); for (const st of stops.filter((x) => !x.moving)) { if (!groups.has(st.from)) groups.set(st.from, []); groups.get(st.from)!.push(st); }
  return { asOfLocal: fmtLocal(t, tz), toLeave: [...groups.entries()].map(([from, list]) => ({ from, stops: list })), onTheRoad: stops.filter((x) => x.moving), loanerReturns: returns,
    counts: { toLeave: stops.filter((x) => !x.moving).length, late: stops.filter((x) => x.late).length, onTheRoad: stops.filter((x) => x.moving).length },
    note: 'In order of the latest safe departure: required-by time minus the travel estimate entered for that route. This is a deadline order, not a distance-optimized route, and travel times are estimates, not live traffic.' };
}
