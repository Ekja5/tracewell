/**
 * Loaners from the account's outside source (set in Settings). Tracewell records and tracks the request;
 * it does not transmit it to the source. Chain of custody: requested -> confirmed -> shipped -> received
 * (stock enters the ledger, owned by the manufacturer, and is reserved for the case) -> returned.
 */
import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit, notify } from '../audit.js';
import { applyMovement, localDate, reserve } from '../domain/inventory.js';
import { fmtLocal, getPolicy, getVisibleCase, releaseReservation } from '../domain/cases.js';
import { addDaysYmd, localYmd, nextReceivingOpen, receivingDeadline, zoned } from '../time.js';
import { getSettings, OpsSettings } from './settings.js';

const isBiz = (ymd: string) => ![0, 6].includes(new Date(ymd + 'T12:00:00Z').getUTCDay());

/** When the item must be at the facility for this case (the same rule the readiness board uses). */
export async function neededBy(db: Db, c: any, itemType: string) {
  const policy = await getPolicy(db, c.facility_id);
  const start = new Date(c.scheduled_start);
  return { policy, at: receivingDeadline(new Date(start.getTime() - (itemType === 'tray' ? policy.tray_due_hours_before : policy.implant_due_hours_before) * 3600e3), c.timezone, policy.receiving_open, policy.receiving_close).at };
}

/**
 * Can a loaner still arrive in time? A request placed by the source's daily cutoff ships that business day and
 * arrives `transit` hours later. Returns the last cutoff that still works and the arrival if asked for right now.
 */
export function loanerTiming(s: OpsSettings, need: Date, t: Date, c: { timezone: string }, policy: any) {
  if (!s.loanerSourceName) return null;
  const tz = s.loanerTimezone;
  const cutoffOn = (ymd: string) => zoned(ymd, s.loanerCutoffLocal, tz);
  const arrive = (cut: Date) => nextReceivingOpen(new Date(cut.getTime() + s.loanerTransitHours * 3600e3), c.timezone, policy?.receiving_open, policy?.receiving_close);
  let requestBy: Date | null = null;
  for (let d = localYmd(need, tz), i = 0; i < 21; i++, d = addDaysYmd(d, -1)) { if (!isBiz(d)) continue; const cut = cutoffOn(d); if (arrive(cut) <= need) { requestBy = cut; break; } }
  let d = localYmd(t, tz); while (!isBiz(d) || cutoffOn(d) < t) d = addDaysYmd(d, 1);
  const arrivalIfNow = arrive(cutoffOn(d));
  return { source: s.loanerSourceName, requestBy: requestBy?.toISOString() ?? null, requestByLocal: requestBy ? fmtLocal(requestBy, c.timezone) : null, passed: !requestBy || requestBy < t,
    arrivalIfRequestedNow: arrivalIfNow.toISOString(), arrivalIfRequestedNowLocal: fmtLocal(arrivalIfNow, c.timezone), inTime: arrivalIfNow <= need, minutesToCutoff: requestBy ? Math.round((requestBy.getTime() - t.getTime()) / 60e3) : null,
    basis: `${s.loanerSourceName}: requests by ${s.loanerCutoffLocal} (${tz.split('/')[1]?.replace('_', ' ') ?? tz} time) ship that business day; ${s.loanerTransitHours} h in transit. Set by your team in Settings; not a live quote.` };
}

async function event(db: Db, ctx: Ctx, loanerId: string, ev: string, detail: string | null) {
  await db.query(`insert into loaner_events(tenant_id, loaner_id, event, detail, actor_user_id, occurred_at) values ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, loanerId, ev, detail, ctx.userId, nowIso()]);
}

export async function requestLoaner(db: Db, ctx: Ctx, input: { caseId: string; requirementId: string; qty?: number; note?: string }) {
  requirePerm(ctx, 'loaner.manage');
  const s = await getSettings(db);
  if (!s.loanerSourceName) throw new AppError(409, 'not_configured', 'No loaner source is set up. An operations manager can add one in Settings.');
  const c = await getVisibleCase(db, ctx, input.caseId);
  if (c.status !== 'scheduled') throw new AppError(409, 'bad_state', `Case ${c.case_ref} is ${c.status}`);
  const req = await maybe(db, `select cr.*, ci.item_type, ci.ref from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.id=$1 and cr.case_id=$2 and cr.active`, [input.requirementId, input.caseId]);
  if (!req) throw new AppError(404, 'not_found', 'Requirement not found');
  const open = await maybe(db, `select ref from loaner_requests where requirement_id=$1 and status in ('requested','confirmed','shipped')`, [req.id]);
  if (open) throw new AppError(409, 'already_requested', `${open.ref} is already open for this requirement`);
  const covered = (await one(db, `select coalesce(sum(qty),0)::int n from reservations where requirement_id=$1 and status='active'`, [req.id])).n;
  const qty = Math.trunc(Number(input.qty ?? req.qty - covered));
  if (!(qty > 0)) throw new AppError(400, 'bad_qty', 'This requirement is already fully reserved');
  const nb = await neededBy(db, c, req.item_type);
  const timing = loanerTiming(s, nb.at, now(), c, nb.policy)!;
  const n = (await one(db, `select count(*)::int n from loaner_requests`)).n;
  const l = (await db.query(`insert into loaner_requests(tenant_id, ref, case_id, requirement_id, catalog_item_id, qty, status, source_name, request_by, needed_by, expected_arrival, requested_by, requested_at)
     values ($1,$2,$3,$4,$5,$6,'requested',$7,$8,$9,$10,$11,$12) returning *`,
    [ctx.tenantId, `LN-${String(n + 1).padStart(4, '0')}`, c.id, req.id, req.catalog_item_id, qty, s.loanerSourceName, timing.requestBy ?? nowIso(), nb.at.toISOString(), timing.arrivalIfRequestedNow, ctx.userId, nowIso()])).rows[0];
  await event(db, ctx, l.id, 'requested', `${qty} x ${req.ref} for ${c.case_ref}${input.note?.trim() ? `. ${input.note.trim()}` : ''}${timing.inTime ? '' : '. Estimated arrival is after the required-by time.'}`);
  await audit(db, ctx, 'loaner.request', 'loaner_request', l.id, { ref: l.ref, qty, item: req.ref, source: s.loanerSourceName, inTime: timing.inTime }, { caseId: c.id });
  await notify(db, ctx.tenantId, c.rep_user_id, { kind: 'loaner', message: `${l.ref}: ${qty} x ${req.ref} requested from ${s.loanerSourceName} for ${c.case_ref}. Estimated arrival ${timing.arrivalIfRequestedNowLocal}.`, caseId: c.id, facilityId: c.facility_id, dedupe: `ln:${l.id}` });
  return loanerDetail(db, ctx, l.id);
}

export async function advanceLoaner(db: Db, ctx: Ctx, id: string, input: { step: 'confirm' | 'ship' | 'receive' | 'return' | 'cancel' | 'note'; confirmation?: string; expectedArrival?: string; tracking?: string; lot?: string; serial?: string; expiry?: string; locationId?: string; note?: string }) {
  requirePerm(ctx, 'loaner.manage');
  const l = await maybe(db, `select l.*, ci.ref item_ref, ci.manufacturer_party_id, ci.tracking, c.case_ref, c.status case_status, c.scheduled_start, c.facility_id, f.timezone from loaner_requests l join catalog_items ci on ci.id=l.catalog_item_id join cases c on c.id=l.case_id join facilities f on f.id=c.facility_id where l.id=$1 for update of l`, [id]);
  if (!l) throw new AppError(404, 'not_found', 'Loaner not found');
  const need = (ok: string[], what: string) => { if (!ok.includes(l.status)) throw new AppError(409, 'bad_state', `${l.ref} is ${l.status}; it cannot be ${what} now`); };
  const note = input.note?.trim() || null;
  if (input.step === 'note') { if (!note) throw new AppError(400, 'note_required', 'Enter a note'); await event(db, ctx, id, 'note', note); return loanerDetail(db, ctx, id); }
  if (input.step === 'confirm') {
    need(['requested'], 'confirmed');
    if (!input.confirmation?.trim()) throw new AppError(400, 'confirmation_required', `Enter ${l.source_name}'s confirmation or order number`);
    const eta = input.expectedArrival ? new Date(input.expectedArrival) : null;
    if (eta && isNaN(eta.getTime())) throw new AppError(400, 'bad_date', 'Expected arrival is not a valid date and time');
    await db.query(`update loaner_requests set status='confirmed', source_confirmation=$2, expected_arrival=coalesce($3, expected_arrival) where id=$1`, [id, input.confirmation.trim(), eta?.toISOString() ?? null]);
    await event(db, ctx, id, 'confirmed', `${l.source_name} confirmation ${input.confirmation.trim()}${eta ? `; expected ${fmtLocal(eta, l.timezone)}` : ''}${note ? `. ${note}` : ''}`);
  } else if (input.step === 'ship') {
    need(['requested', 'confirmed'], 'marked shipped');
    if (!input.tracking?.trim()) throw new AppError(400, 'tracking_required', 'Enter the inbound tracking number');
    await db.query(`update loaner_requests set status='shipped', inbound_tracking=$2 where id=$1`, [id, input.tracking.trim()]);
    await event(db, ctx, id, 'shipped', `Inbound tracking ${input.tracking.trim()}${note ? `. ${note}` : ''}`);
  } else if (input.step === 'receive') {
    need(['requested', 'confirmed', 'shipped'], 'received');
    const serial = input.serial?.trim() || null, lot = input.lot?.trim() || null;
    if (!serial && !lot) throw new AppError(400, 'identifier_required', 'Enter the lot or serial number from the label');
    if (serial && l.qty !== 1) throw new AppError(400, 'bad_qty', 'A serial number identifies one unit; receive serialized loaners one request at a time');
    if (input.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiry)) throw new AppError(400, 'bad_date', 'Expiry must be a date');
    const loc = await maybe(db, `select * from locations where id=$1 and kind in ('warehouse','hospital_receiving')`, [input.locationId]);
    if (!loc) throw new AppError(400, 'location_required', 'Choose where the loaner was received');
    let si = await maybe(db, serial ? `select * from stock_items where catalog_item_id=$1 and serial_number=$2` : `select * from stock_items where catalog_item_id=$1 and lot_number=$2 and serial_number is null`, [l.catalog_item_id, serial ?? lot]);
    if (!si) si = (await db.query(`insert into stock_items(tenant_id, catalog_item_id, lot_number, serial_number, expiry_date, is_serial, data_source) values ($1,$2,$3,$4,$5,$6,'reviewed_entry') returning *`, [ctx.tenantId, l.catalog_item_id, lot, serial, input.expiry || null, !!serial])).rows[0];
    await applyMovement(db, ctx, { stockItemId: si.id, qty: l.qty, ownerPartyId: l.manufacturer_party_id, to: { locationId: loc.id, condition: 'sealed' }, type: 'receipt', reason: `Loaner ${l.ref} received from ${l.source_name}`, caseId: l.case_id, idempotencyKey: `loaner-recv:${id}` });
    let reservationId: string | null = null;
    if (l.case_status === 'scheduled' && l.requirement_id) {
      const have = (await one(db, `select coalesce(sum(r.qty),0)::int n, max(cr.qty) q from reservations r join case_requirements cr on cr.id=r.requirement_id where r.requirement_id=$1 and r.status='active'`, [l.requirement_id]));
      const reqQty = (await one(db, `select qty from case_requirements where id=$1`, [l.requirement_id])).qty;
      const q = Math.min(l.qty, Math.max(0, reqQty - have.n));
      if (q > 0) reservationId = (await reserve(db, ctx, { caseId: l.case_id, requirementId: l.requirement_id, stockItemId: si.id, locationId: loc.id, ownerPartyId: l.manufacturer_party_id, qty: q, idempotencyKey: `loaner-resv:${id}` })).reservation.id;
    }
    const s = await getSettings(db);
    const due = addDaysYmd(localDate(new Date(l.scheduled_start), l.timezone), s.loanerReturnDays);
    await db.query(`update loaner_requests set status='received', stock_item_id=$2, received_location_id=$3, reservation_id=$4, due_back=$5 where id=$1`, [id, si.id, loc.id, reservationId, due]);
    await event(db, ctx, id, 'received', `${l.qty} x ${l.item_ref} ${serial ? `SN ${serial}` : `lot ${lot}`} checked in at ${loc.name}${reservationId ? ` and reserved for ${l.case_ref}` : ''}. Due back ${due}.${note ? ` ${note}` : ''}`);
  } else if (input.step === 'return') {
    need(['received'], 'returned');
    if (!input.tracking?.trim()) throw new AppError(400, 'tracking_required', 'Enter the return tracking number');
    const r = l.reservation_id ? await maybe(db, `select status from reservations where id=$1`, [l.reservation_id]) : null;
    if (r?.status === 'active' && l.case_status === 'scheduled') throw new AppError(409, 'still_needed', `This loaner is still reserved for ${l.case_ref}, which has not happened yet. Cancel the case or release the reservation first.`);
    if (r?.status === 'active') await releaseReservation(db, ctx, l.reservation_id, `Loaner ${l.ref} returned`);
    const bal = await maybe(db, `select qty from stock_balances where stock_item_id=$1 and location_id=$2 and owner_party_id=$3 and condition='sealed'`, [l.stock_item_id, l.received_location_id, l.manufacturer_party_id]);
    const back = Math.min(l.qty, bal?.qty ?? 0);
    if (back > 0) { const ret = await one(db, `select id from locations where kind='returns' limit 1`); await applyMovement(db, ctx, { stockItemId: l.stock_item_id, qty: back, ownerPartyId: l.manufacturer_party_id, from: { locationId: l.received_location_id, condition: 'sealed' }, to: { locationId: ret.id, condition: 'sealed' }, type: 'return', reason: `Loaner ${l.ref} returned to ${l.source_name}`, caseId: l.case_id, idempotencyKey: `loaner-ret:${id}` }); }
    await db.query(`update loaner_requests set status='returned', return_tracking=$2 where id=$1`, [id, input.tracking.trim()]);
    await event(db, ctx, id, 'returned', `${back} of ${l.qty} sealed unit(s) sent back, tracking ${input.tracking.trim()}${back < l.qty ? `; ${l.qty - back} not returned sealed (used or moved; see the case record)` : ''}.${note ? ` ${note}` : ''}`);
  } else if (input.step === 'cancel') {
    need(['requested', 'confirmed'], 'cancelled');
    if (!note) throw new AppError(400, 'note_required', 'Say why the loaner is cancelled');
    await db.query(`update loaner_requests set status='cancelled' where id=$1`, [id]);
    await event(db, ctx, id, 'cancelled', note);
  } else throw new AppError(400, 'bad_step', 'Unknown step');
  await audit(db, ctx, `loaner.${input.step}`, 'loaner_request', id, { ref: l.ref }, { caseId: l.case_id });
  return loanerDetail(db, ctx, id);
}

const SQL = `select l.*, ci.ref item_ref, ci.description item_description, c.case_ref, c.scheduled_start, c.status case_status, f.name facility, f.timezone, f.id facility_id, u.display_name requested_by_name, loc.name received_at_name, s.lot_number, s.serial_number
  from loaner_requests l join catalog_items ci on ci.id=l.catalog_item_id join cases c on c.id=l.case_id join facilities f on f.id=c.facility_id join users u on u.id=l.requested_by
  left join locations loc on loc.id=l.received_location_id left join stock_items s on s.id=l.stock_item_id`;
export const LOANER_CHAIN = ['requested', 'confirmed', 'shipped', 'received', 'returned'];
const LABEL: Record<string, string> = { requested: 'Requested', confirmed: 'Confirmed by source', shipped: 'Shipped to us', received: 'Received', returned: 'Returned', cancelled: 'Cancelled' };

function shape(l: any, events: any[] = []) {
  const today = localYmd(now(), l.timezone);
  const due = l.due_back ? (typeof l.due_back === 'string' ? l.due_back : localYmd(l.due_back, 'UTC')) : null;
  const overdueArrival = ['requested', 'confirmed', 'shipped'].includes(l.status) && now() > new Date(l.needed_by);
  return { id: l.id, ref: l.ref, status: l.status, statusLabel: LABEL[l.status], caseId: l.case_id, caseRef: l.case_ref, caseStartLocal: fmtLocal(l.scheduled_start, l.timezone), facility: l.facility,
    item: { ref: l.item_ref, description: l.item_description, unit: l.serial_number ? `SN ${l.serial_number}` : l.lot_number ? `lot ${l.lot_number}` : null }, qty: l.qty, source: l.source_name,
    neededBy: l.needed_by, neededByLocal: fmtLocal(l.needed_by, l.timezone), expectedArrival: l.expected_arrival, expectedArrivalLocal: l.expected_arrival ? fmtLocal(l.expected_arrival, l.timezone) : null,
    arrivesInTime: l.expected_arrival ? new Date(l.expected_arrival) <= new Date(l.needed_by) : null, confirmation: l.source_confirmation, inboundTracking: l.inbound_tracking, returnTracking: l.return_tracking,
    dueBack: due, returnLate: l.status === 'received' && !!due && due < today, returnDueSoon: l.status === 'received' && !!due && due >= today && due <= addDaysYmd(today, 1), overdueArrival,
    receivedAt: l.received_at_name, requestedBy: l.requested_by_name, requestedAtLocal: fmtLocal(l.requested_at, l.timezone),
    steps: LOANER_CHAIN.map((st) => { const e = events.find((x) => x.event === st); return { name: LABEL[st], done: e ? { atLocal: fmtLocal(e.occurred_at, l.timezone), by: e.display_name, detail: e.detail } : null }; }),
    events: events.map((e) => ({ event: e.event, detail: e.detail, by: e.display_name, atLocal: fmtLocal(e.occurred_at, l.timezone) })) };
}

export async function loanerDetail(db: Db, ctx: Ctx, id: string) {
  requirePerm(ctx, 'loaner.view');
  const l = await maybe(db, `${SQL} where l.id=$1`, [id]);
  if (!l) throw new AppError(404, 'not_found', 'Loaner not found');
  const ev = await rows(db, `select e.*, u.display_name from loaner_events e join users u on u.id=e.actor_user_id where e.loaner_id=$1 order by e.occurred_at, e.id`, [id]);
  const locations = await rows(db, `select id, name from locations where kind in ('warehouse','hospital_receiving') and (facility_id=$1 or kind='warehouse') order by (facility_id=$1) desc, name`, [l.facility_id]);
  return { ...shape(l, ev), receiveLocations: locations };
}

export async function listLoaners(db: Db, ctx: Ctx, filter: { open?: boolean; caseId?: string } = {}) {
  requirePerm(ctx, 'loaner.view');
  const list = await rows(db, `${SQL} where ($1::uuid is null or l.case_id=$1) and ($2::boolean is not true or l.status in ('requested','confirmed','shipped','received')) order by l.requested_at desc limit 200`, [filter.caseId ?? null, filter.open ?? null]);
  return { source: (await getSettings(db)).loanerSourceName, loaners: list.map((l) => shape(l)) };
}
