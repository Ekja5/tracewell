/**
 * Transfer requests. Asking for a unit holds it for the case straight away (so it cannot be promised twice),
 * but nothing is treated as moving until whoever holds the unit accepts. Each request names an owner, who
 * collects it and when, who receives it, and the required-by time, and records the giving side's own
 * upcoming cases as they stood when it was asked for.
 */
import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, can, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit, notify, notifyRole } from '../audit.js';
import { reserve } from '../domain/inventory.js';
import { fmtLocal, getVisibleCase, releaseReservation } from '../domain/cases.js';
import { previewTransfer, nextShipmentRef } from '../domain/rescue.js';

export const CHAIN = ['Requested', 'Accepted', 'Reserved', 'Pickup confirmed', 'In transit', 'Delivered', 'Received'] as const;

/** Cases the giving side has coming up that need this same item (so a transfer does not create a new shortage). */
export async function donorCheck(db: Db, catalogItemId: string, loc: any, excludeCaseId: string, windowHours: number) {
  const t = now();
  const cases = await rows(db, `select c.id, c.case_ref, c.scheduled_start, f.name facility, f.timezone, cr.qty,
      coalesce((select sum(r.qty) from reservations r where r.requirement_id=cr.id and r.status='active'),0)::int reserved
    from case_requirements cr join cases c on c.id=cr.case_id join facilities f on f.id=c.facility_id
    where cr.catalog_item_id=$1 and cr.active and c.status='scheduled' and c.id<>$2 and c.scheduled_start between $3 and $4
      and (($5::uuid is not null and c.rep_user_id=$5) or ($5::uuid is null and $6::uuid is not null and c.facility_id=$6) or ($5::uuid is null and $6::uuid is null))
    order by c.scheduled_start`, [catalogItemId, excludeCaseId, t.toISOString(), new Date(t.getTime() + windowHours * 3600e3).toISOString(), loc.holder_user_id, loc.kind === 'warehouse' ? null : loc.facility_id]);
  return cases.map((c) => ({ caseId: c.id, caseRef: c.case_ref, when: fmtLocal(c.scheduled_start, c.timezone), facility: c.facility, required: c.qty, reserved: c.reserved, uncovered: Math.max(0, c.qty - c.reserved) }));
}

export interface TransferInput { stockItemId: string; locationId: string; ownerPartyId: string; ownerUserId?: string; pickupBy: string; pickupAt?: string; pickupInMinutes?: number; receiver: string; note?: string; idempotencyKey: string }

export async function requestTransfer(db: Db, ctx: Ctx, caseId: string, requirementId: string, input: TransferInput, windowHours = 72) {
  requirePerm(ctx, 'transfer.request');
  if (!input.idempotencyKey) throw new AppError(400, 'idempotency_required', 'idempotencyKey is required');
  const again = await maybe(db, `select tr.id from transfer_requests tr join reservations r on r.id=tr.reservation_id where r.idempotency_key=$1`, [`${input.idempotencyKey}:resv`]);
  if (again) return { ...(await transferDetail(db, ctx, again.id)), replayed: true };
  const pickupBy = String(input.pickupBy ?? '').trim(), receiver = String(input.receiver ?? '').trim();
  if (!pickupBy) throw new AppError(400, 'pickup_required', 'Say who will collect the unit');
  if (!receiver) throw new AppError(400, 'receiver_required', 'Say who will receive it at the destination');
  const mins = Number(input.pickupInMinutes);
  const pickupAt = input.pickupAt ? new Date(input.pickupAt) : Number.isFinite(mins) && mins >= 0 && mins <= 7 * 1440 ? new Date(now().getTime() + mins * 60e3) : new Date(NaN);
  if (isNaN(pickupAt.getTime())) throw new AppError(400, 'pickup_time_required', 'Enter when the unit will be collected');
  const c = await getVisibleCase(db, ctx, caseId);
  const owner = await maybe(db, `select id, display_name from users where id=$1 and active and facility_id is null`, [input.ownerUserId ?? ctx.userId]);
  if (!owner) throw new AppError(400, 'owner_required', 'Choose who owns this transfer');
  const preview = await previewTransfer(db, ctx, caseId, requirementId, input);
  const loc = await one(db, `select * from locations where id=$1`, [input.locationId]);
  const dest = await one(db, `select id from locations where facility_id=$1 and kind='hospital_receiving' limit 1`, [c.facility_id]);
  const { reservation } = await reserve(db, ctx, { caseId, requirementId, stockItemId: input.stockItemId, locationId: input.locationId, ownerPartyId: input.ownerPartyId, qty: 1, idempotencyKey: `${input.idempotencyKey}:resv` });
  if (input.locationId === dest.id) { await audit(db, ctx, 'reservation.on_site', 'reservation', reservation.id, {}, { caseId }); return { onSite: true, reservation }; }
  const req = await one(db, `select catalog_item_id from case_requirements where id=$1`, [requirementId]);
  const donor = await donorCheck(db, req.catalog_item_id, loc, caseId, windowHours);
  const n = (await one(db, `select count(*)::int n from transfer_requests`)).n;
  const travel = (preview.candidate.travelMinutes ?? 0) + (preview.candidate.handlingMinutes ?? 0);
  const arrives = new Date(pickupAt.getTime() + (preview.candidate.travelMinutes ?? 0) * 60e3);
  const tr = (await db.query(`insert into transfer_requests(tenant_id, ref, case_id, requirement_id, stock_item_id, from_location_id, owner_party_id, to_facility_id, status, owner_user_id, approver_user_id, pickup_by, pickup_at, receiver, required_by, donor_check, note, requested_by, requested_at, reservation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'requested',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning *`,
    [ctx.tenantId, `TR-${String(n + 1).padStart(4, '0')}`, caseId, requirementId, input.stockItemId, input.locationId, input.ownerPartyId, c.facility_id, owner.id, loc.holder_user_id, pickupBy, pickupAt.toISOString(), receiver, preview.requiredBy,
      JSON.stringify(donor), input.note?.trim() || null, ctx.userId, nowIso(), reservation.id])).rows[0];
  await audit(db, ctx, 'transfer.request', 'transfer_request', tr.id, { ref: tr.ref, unit: preview.candidate.label, from: loc.name, pickupBy, pickupAt: tr.pickup_at, receiver, donor, travelMinutes: travel }, { caseId });
  const msg = { kind: 'transfer_request', message: `${tr.ref}: ${ctx.displayName} asks for ${preview.candidate.label} from ${loc.name} for case ${c.case_ref}. Needed at ${c.facility_name} by ${fmtLocal(preview.requiredBy, c.timezone)}. Accept or decline.`, caseId, facilityId: c.facility_id, dedupe: `tr:${tr.id}` };
  if (loc.holder_user_id) await notify(db, ctx.tenantId, loc.holder_user_id, msg); else await notifyRole(db, ctx.tenantId, ['warehouse', 'ops_manager'], msg);
  return { ...(await transferDetail(db, ctx, tr.id)), replayed: false, arrivalWarning: arrives > new Date(preview.requiredBy) ? `Collected at ${fmtLocal(pickupAt, c.timezone)}, it would arrive about ${fmtLocal(arrives, c.timezone)}, after the required-by time.` : null };
}

function mayDecide(ctx: Ctx, tr: any) {
  if (tr.approver_user_id) return ctx.userId === tr.approver_user_id || ctx.role === 'ops_manager' || ctx.role === 'admin';
  return can(ctx, 'shipment.pick') || ctx.role === 'ops_manager';
}

export async function decideTransfer(db: Db, ctx: Ctx, id: string, input: { decision: 'accept' | 'decline'; note?: string }) {
  requirePerm(ctx, 'transfer.decide');
  const tr = await maybe(db, `select tr.*, l.name from_name, l.holder_user_id, hu.display_name holder_name from transfer_requests tr join locations l on l.id=tr.from_location_id left join users hu on hu.id=l.holder_user_id where tr.id=$1 for update of tr`, [id]);
  if (!tr) throw new AppError(404, 'not_found', 'Transfer request not found');
  if (tr.status !== 'requested') throw new AppError(409, 'bad_state', `This request is already ${tr.status}`);
  if (!mayDecide(ctx, tr)) throw new AppError(403, 'forbidden', `Only ${tr.holder_name ?? 'the warehouse team'} or an operations manager can answer this request`);
  const note = input.note?.trim() || null;
  const onBehalf = tr.approver_user_id && ctx.userId !== tr.approver_user_id;
  if (onBehalf && !note) throw new AppError(400, 'note_required', `You are answering for ${tr.holder_name}. Say how they agreed (for example "confirmed by phone at 9:12").`);
  if (input.decision === 'decline' && !note) throw new AppError(400, 'note_required', 'Say why the unit cannot be given up');
  const c = await one(db, `select c.*, f.name facility_name, f.timezone from cases c join facilities f on f.id=c.facility_id where c.id=$1`, [tr.case_id]);
  if (input.decision === 'decline') {
    await releaseReservation(db, ctx, tr.reservation_id, `Transfer ${tr.ref} declined: ${note}`);
    await db.query(`update transfer_requests set status='declined', decided_by=$2, decided_at=$3, decision_note=$4 where id=$1`, [id, ctx.userId, nowIso(), note]);
    await audit(db, ctx, 'transfer.decline', 'transfer_request', id, { ref: tr.ref, note }, { caseId: tr.case_id });
    await notify(db, ctx.tenantId, tr.owner_user_id, { kind: 'transfer_request', message: `${tr.ref} for ${c.case_ref} was declined by ${ctx.displayName}: ${note}. The unit is no longer held; choose another option.`, caseId: tr.case_id, facilityId: c.facility_id, dedupe: `tr-dec:${id}` });
    return transferDetail(db, ctx, id);
  }
  if (input.decision !== 'accept') throw new AppError(400, 'bad_decision', 'Choose accept or decline');
  const dest = await one(db, `select id from locations where facility_id=$1 and kind='hospital_receiving' limit 1`, [tr.to_facility_id]);
  const sh = (await db.query(`insert into shipments(tenant_id, ref, case_id, from_location_id, to_location_id, kind, status, due_by, created_by, created_at, idempotency_key)
     values ($1,$2,$3,$4,$5,'rescue_transfer','planned',$6,$7,$8,$9) returning *`, [ctx.tenantId, await nextShipmentRef(db, 'XFR'), tr.case_id, tr.from_location_id, dest.id, tr.required_by, ctx.userId, nowIso(), `tr:${id}`])).rows[0];
  await db.query(`insert into shipment_lines(tenant_id, shipment_id, stock_item_id, owner_party_id, reservation_id, qty_expected) values ($1,$2,$3,$4,$5,1)`, [ctx.tenantId, sh.id, tr.stock_item_id, tr.owner_party_id, tr.reservation_id]);
  await db.query(`update transfer_requests set status='accepted', decided_by=$2, decided_at=$3, decision_note=$4, shipment_id=$5 where id=$1`, [id, ctx.userId, nowIso(), note, sh.id]);
  await audit(db, ctx, 'transfer.accept', 'transfer_request', id, { ref: tr.ref, shipment: sh.ref, onBehalfOf: onBehalf ? tr.holder_name : null, note }, { caseId: tr.case_id });
  await notify(db, ctx.tenantId, tr.owner_user_id, { kind: 'transfer_request', message: `${tr.ref} for ${c.case_ref} was accepted${onBehalf ? ` (recorded by ${ctx.displayName} for ${tr.holder_name})` : ` by ${ctx.displayName}`}. Shipment ${sh.ref} is planned; ${tr.pickup_by} collects at ${fmtLocal(tr.pickup_at, c.timezone)}.`, caseId: tr.case_id, facilityId: c.facility_id, dedupe: `tr-acc:${id}` });
  return transferDetail(db, ctx, id);
}

export async function cancelTransfer(db: Db, ctx: Ctx, id: string, input: { reason: string }) {
  requirePerm(ctx, 'transfer.request');
  const tr = await maybe(db, `select * from transfer_requests where id=$1 for update`, [id]);
  if (!tr) throw new AppError(404, 'not_found', 'Transfer request not found');
  if (tr.status !== 'requested') throw new AppError(409, 'bad_state', `This request is already ${tr.status}; it can no longer be withdrawn here`);
  if (!input.reason?.trim()) throw new AppError(400, 'reason_required', 'Say why the request is withdrawn');
  await releaseReservation(db, ctx, tr.reservation_id, `Transfer ${tr.ref} withdrawn: ${input.reason.trim()}`);
  await db.query(`update transfer_requests set status='cancelled', decided_by=$2, decided_at=$3, decision_note=$4 where id=$1`, [id, ctx.userId, nowIso(), input.reason.trim()]);
  await audit(db, ctx, 'transfer.cancel', 'transfer_request', id, { ref: tr.ref }, { caseId: tr.case_id, reason: input.reason.trim() });
  return transferDetail(db, ctx, id);
}

const SQL = `select tr.*, c.case_ref, c.scheduled_start, f.name facility, f.timezone, l.name from_name, l.kind from_kind, hu.display_name holder_name, ou.display_name owner_name, ru.display_name requested_by_name, du.display_name decided_by_name,
    ci.ref item_ref, ci.description item_description, s.lot_number, s.serial_number, sh.ref shipment_ref, sh.status shipment_status
  from transfer_requests tr join cases c on c.id=tr.case_id join facilities f on f.id=tr.to_facility_id join locations l on l.id=tr.from_location_id left join users hu on hu.id=l.holder_user_id
    join users ou on ou.id=tr.owner_user_id join users ru on ru.id=tr.requested_by left join users du on du.id=tr.decided_by
    join stock_items s on s.id=tr.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id left join shipments sh on sh.id=tr.shipment_id`;

async function shape(db: Db, ctx: Ctx, t: any) {
  const ev = t.shipment_id ? await rows(db, `select ce.event_type, ce.occurred_at, u.display_name from custody_events ce join users u on u.id=ce.actor_user_id where ce.shipment_id=$1 order by ce.occurred_at`, [t.shipment_id]) : [];
  const at = (types: string[]) => { const e = ev.find((x) => types.includes(x.event_type)); return e ? { at: new Date(e.occurred_at).toISOString(), atLocal: fmtLocal(e.occurred_at, t.timezone), by: e.display_name } : null; };
  const accepted = t.status === 'accepted' ? { at: new Date(t.decided_at).toISOString(), atLocal: fmtLocal(t.decided_at, t.timezone), by: t.decided_by_name } : null;
  const steps = [
    { name: 'Requested', done: { at: new Date(t.requested_at).toISOString(), atLocal: fmtLocal(t.requested_at, t.timezone), by: t.requested_by_name } },
    { name: 'Accepted', done: accepted }, { name: 'Reserved', done: accepted && { ...accepted, by: `shipment ${t.shipment_ref}` } },
    { name: 'Pickup confirmed', done: at(['picked', 'packed']) }, { name: 'In transit', done: at(['dispatched']) }, { name: 'Delivered', done: at(['delivered']) }, { name: 'Received', done: at(['received']) },
  ];
  const ended = t.status === 'declined' || t.status === 'cancelled';
  const current = ended ? (t.status === 'declined' ? 'Declined' : 'Withdrawn') : [...steps].reverse().find((s) => s.done)!.name;
  const nextStep = ended ? null : steps.find((s) => !s.done)?.name ?? null;
  const waitingOn = ended ? null : t.status === 'requested' ? (t.holder_name ?? 'Warehouse team') : nextStep === 'Pickup confirmed' ? t.pickup_by : nextStep === 'In transit' ? t.pickup_by : nextStep === 'Delivered' ? 'Courier' : nextStep === 'Received' ? t.receiver : null;
  return { id: t.id, ref: t.ref, status: t.status, current, nextStep, waitingOn, steps, caseId: t.case_id, caseRef: t.case_ref, requirementId: t.requirement_id, reservationId: t.reservation_id, facility: t.facility, caseStartLocal: fmtLocal(t.scheduled_start, t.timezone),
    item: { ref: t.item_ref, description: t.item_description, unit: t.serial_number ? `SN ${t.serial_number}` : `lot ${t.lot_number}` }, from: t.from_name, fromKind: t.from_kind, holder: t.holder_name ?? 'Warehouse team',
    owner: t.owner_name, pickupBy: t.pickup_by, pickupAt: t.pickup_at, pickupAtLocal: fmtLocal(t.pickup_at, t.timezone), receiver: t.receiver, requiredBy: t.required_by, requiredByLocal: fmtLocal(t.required_by, t.timezone),
    late: !ended && !steps[6].done && now() > new Date(t.required_by), donorCheck: t.donor_check ?? [], note: t.note, requestedBy: t.requested_by_name, decidedBy: t.decided_by_name, decisionNote: t.decision_note,
    shipmentId: t.shipment_id, shipmentRef: t.shipment_ref, shipmentStatus: t.shipment_status, canDecide: t.status === 'requested' && can(ctx, 'transfer.decide') && mayDecide(ctx, t), actingForHolder: !!t.approver_user_id && ctx.userId !== t.approver_user_id,
    canCancel: t.status === 'requested' && can(ctx, 'transfer.request') };
}

export async function transferDetail(db: Db, ctx: Ctx, id: string) {
  const t = await maybe(db, `${SQL} where tr.id=$1`, [id]);
  if (!t) throw new AppError(404, 'not_found', 'Transfer request not found');
  if (ctx.facilityId && t.to_facility_id !== ctx.facilityId) throw new AppError(404, 'not_found', 'Transfer request not found');
  return shape(db, ctx, t);
}

export async function listTransfers(db: Db, ctx: Ctx, filter: { open?: boolean; caseId?: string } = {}) {
  const list = await rows(db, `${SQL} where ($1::uuid is null or tr.to_facility_id=$1) and ($2::uuid is null or tr.case_id=$2) order by tr.requested_at desc limit 200`, [ctx.facilityId, filter.caseId ?? null]);
  const out: any[] = []; for (const t of list) out.push(await shape(db, ctx, t));
  return filter.open ? out.filter((t) => t.current !== 'Received' && t.current !== 'Declined' && t.current !== 'Withdrawn') : out;
}
