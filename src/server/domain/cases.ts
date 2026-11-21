import { AppError, Db, maybe, one, rows } from '../db.js';
import { caseScope, Ctx, isFacilityUser, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit, notify, notifyRole } from '../audit.js';
import { localDate } from './inventory.js';
import { receivingDeadline, fmtClock } from '../time.js';
import { syncIssues, explain } from './issues.js';

export async function getPolicy(db: Db, facilityId: string, at: Date = now()) {
  return one(db, `select * from facility_policies where facility_id=$1 and effective_from <= $2 order by version desc limit 1`, [facilityId, at.toISOString()]);
}

/** Load a case only if visible to the user (tenant via RLS, facility/territory via scope). 404 otherwise, never 403, so existence is not leaked. */
export async function getVisibleCase(db: Db, ctx: Ctx, caseId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new AppError(404, 'not_found', 'Case not found');
  const [scope, sp] = caseScope(ctx, 2);
  const c = await maybe(db, `select c.*, f.name facility_name, f.code facility_code, f.timezone, f.territory_id, u.display_name rep_name
     from cases c join facilities f on f.id=c.facility_id left join users u on u.id=c.rep_user_id where c.id=$1 and ${scope}`, [caseId, ...sp]);
  if (!c) throw new AppError(404, 'not_found', 'Case not found');
  return c;
}

/** Synthetic, opaque case reference. Never a patient identifier. */
async function nextCaseRef(db: Db) {
  const r = await one(db, `select coalesce(max(substring(case_ref from 5)::int), 1000) n from cases where case_ref ~ '^SYN-[0-9]+$'`);
  return `SYN-${r.n + 1}`;
}

export async function createCase(db: Db, ctx: Ctx, input: { facilityId: string; cardVersionId: string; scheduledStart: string; repUserId: string; urgent?: boolean; caseRef?: string }) {
  requirePerm(ctx, 'case.manage');
  const cv = await one(db, `select v.*, p.surgeon_ref, p.procedure from preference_card_versions v join preference_cards p on p.id=v.card_id where v.id=$1`, [input.cardVersionId]);
  if (cv.status !== 'approved') throw new AppError(409, 'card_not_approved', 'Only a human-approved preference card version can be used for a case');
  const fac = await one(db, `select * from facilities where id=$1 and kind='hospital'`, [input.facilityId]);
  const rep = await one(db, `select * from users where id=$1 and role='rep' and active`, [input.repUserId]);
  const start = new Date(input.scheduledStart);
  if (isNaN(start.getTime())) throw new AppError(400, 'bad_date', 'scheduledStart must be an ISO timestamp');
  const ref = input.caseRef ?? (await nextCaseRef(db));
  const c = (await db.query(
    `insert into cases(tenant_id, case_ref, facility_id, procedure, surgeon_ref, scheduled_start, status, urgent, rep_user_id, preference_card_version_id, created_by, created_at)
     values ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8,$9,$10,$11) returning *`,
    [ctx.tenantId, ref, fac.id, cv.procedure, cv.surgeon_ref, start.toISOString(), !!input.urgent, rep.id, cv.id, ctx.userId, nowIso()])).rows[0];
  const lines = await rows(db, `select * from preference_card_lines where card_version_id=$1`, [cv.id]);
  for (const l of lines) {
    await db.query(`insert into case_requirements(tenant_id, case_id, catalog_item_id, qty, mandatory, source_card_line_id) values ($1,$2,$3,$4,$5,$6)`,
      [ctx.tenantId, c.id, l.catalog_item_id, l.qty, l.mandatory, l.id]);
  }
  await audit(db, ctx, input.urgent ? 'case.create_urgent' : 'case.create', 'case', c.id, { case_ref: ref, card_version: cv.version, scheduled_start: c.scheduled_start }, { caseId: c.id });
  await notify(db, ctx.tenantId, rep.id, { kind: 'case_assigned', message: `${input.urgent ? 'URGENT ' : ''}Case ${ref} assigned at ${fac.name}`, caseId: c.id, facilityId: fac.id, dedupe: `assign:${c.id}` });
  if (input.urgent) await notifyRole(db, ctx.tenantId, ['ops_manager', 'warehouse'], { kind: 'urgent_case', message: `Urgent add-on case ${ref} at ${fac.name}`, caseId: c.id, facilityId: fac.id, dedupe: `urgent:${c.id}` });
  return c;
}

/** Analyze downstream conflicts for a case's current schedule (used after moves and requirement changes). */
export async function analyzeConflicts(db: Db, caseId: string) {
  const c = await one(db, `select c.*, f.timezone, f.name facility_name from cases c join facilities f on f.id=c.facility_id where c.id=$1`, [caseId]);
  const policy = await getPolicy(db, c.facility_id);
  const start = new Date(c.scheduled_start);
  const planned = localDate(start, c.timezone);
  const conflicts: { kind: string; message: string }[] = [];
  const res = await rows(db, `select r.*, s.expiry_date, s.serial_number, s.lot_number, ci.ref, ci.item_type, l.kind loc_kind, l.facility_id loc_facility, l.name loc_name,
      te.minutes travel_min
    from reservations r join stock_items s on s.id=r.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join locations l on l.id=r.location_id
    left join travel_estimates te on te.from_location_id=r.location_id and te.to_facility_id=$2
    where r.case_id=$1 and r.status='active'`, [caseId, c.facility_id]);
  for (const r of res) {
    const due = new Date(start.getTime() - (r.item_type === 'tray' ? policy.tray_due_hours_before : policy.implant_due_hours_before) * 3600e3);
    if (r.expiry_date && r.expiry_date < planned) conflicts.push({ kind: 'expiry', message: `${r.ref} ${r.serial_number ?? r.lot_number} expires ${r.expiry_date}, before the new date ${planned}` });
    if (r.loc_facility !== c.facility_id && r.loc_kind !== 'in_transit') {
      if (r.travel_min == null) conflicts.push({ kind: 'no_route', message: `${r.ref} is at ${r.loc_name}; no travel estimate to ${c.facility_name}` });
      else if (now().getTime() + r.travel_min * 60e3 > due.getTime()) conflicts.push({ kind: 'cutoff', message: `${r.ref} at ${r.loc_name} cannot arrive by the new required-by time (${r.travel_min} min estimated travel)` });
    }
  }
  // Same tray type needed by another case inside the reprocessing window.
  const trayReqs = await rows(db, `select cr.catalog_item_id, ci.ref from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and cr.active and ci.item_type='tray'`, [caseId]);
  for (const t of trayReqs) {
    const others = await rows(db, `select c2.case_ref, c2.scheduled_start from cases c2 join case_requirements cr on cr.case_id=c2.id and cr.active
       where cr.catalog_item_id=$1 and c2.id<>$2 and c2.status='scheduled' and abs(extract(epoch from (c2.scheduled_start - $3::timestamptz))) < 24*3600`, [t.catalog_item_id, caseId, start.toISOString()]);
    const instances = (await one(db, `select count(*)::int n from stock_items s join stock_balances b on b.stock_item_id=s.id and b.qty>0 join locations l on l.id=b.location_id
       where s.catalog_item_id=$1 and l.kind not in ('consumed','wasted','missing','quarantine')`, [t.catalog_item_id])).n;
    if (others.length && instances <= others.length) {
      conflicts.push({ kind: 'tray_turnaround', message: `${t.ref} is also needed by ${others.map((o) => o.case_ref).join(', ')} within 24 h; only ${instances} tray instance(s) exist, so reprocessing time may not allow both` });
    }
  }
  const uncovered = await uncoveredRequirements(db, caseId);
  for (const u of uncovered) if (u.mandatory) conflicts.push({ kind: 'uncovered', message: `${u.ref} needs ${u.qty}, ${u.reserved} reserved` });
  return conflicts;
}

export async function uncoveredRequirements(db: Db, caseId: string) {
  return rows(db, `select cr.id, cr.qty, cr.mandatory, ci.ref, ci.description, ci.item_type,
     coalesce((select sum(r.qty) from reservations r where r.requirement_id=cr.id and r.status in ('active','consumed')),0)::int reserved
     from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and cr.active
     and cr.qty > coalesce((select sum(r.qty) from reservations r where r.requirement_id=cr.id and r.status in ('active','consumed')),0)`, [caseId]);
}

async function bumpVersion(db: Db, c: any, expectedVersion?: number) {
  const r = await db.query(`update cases set version=version+1 where id=$1 and ($2::int is null or version=$2) returning version`, [c.id, expectedVersion ?? null]);
  if (!r.rowCount) throw new AppError(409, 'stale_version', 'This case was changed by someone else; reload and try again');
}

export async function moveCase(db: Db, ctx: Ctx, caseId: string, input: { scheduledStart: string; reason: string; expectedVersion?: number }) {
  requirePerm(ctx, 'case.manage');
  const c = await getVisibleCase(db, ctx, caseId);
  if (c.status !== 'scheduled') throw new AppError(409, 'case_not_open', `Case is ${c.status}`);
  if (!input.reason?.trim()) throw new AppError(400, 'reason_required', 'A reason is required to move a case');
  await bumpVersion(db, c, input.expectedVersion);
  const newStart = new Date(input.scheduledStart).toISOString();
  await db.query(`update cases set scheduled_start=$2 where id=$1`, [caseId, newStart]);
  // Release reservations that are no longer valid at the new date (expired at use or on hold).
  const planned = localDate(new Date(newStart), c.timezone);
  const invalid = await rows(db, `select r.id, ci.ref, s.expiry_date from reservations r join stock_items s on s.id=r.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id
     where r.case_id=$1 and r.status='active' and s.expiry_date is not null and s.expiry_date < $2`, [caseId, planned]);
  for (const r of invalid) await releaseReservation(db, ctx, r.id, `Case moved to ${planned}; unit expires ${r.expiry_date}`);
  // Keep stored shipment cutoffs consistent with the new schedule (pick queue sorts by them).
  const r2 = await caseReadiness(db, caseId);
  const ships = await rows(db, `select s.id, bool_or(ci.item_type='tray') has_tray from shipments s join shipment_lines sl on sl.shipment_id=s.id join stock_items si on si.id=sl.stock_item_id join catalog_items ci on ci.id=si.catalog_item_id
     where s.case_id=$1 and s.status in ('planned','picked','packed','dispatched','delivered') group by s.id`, [caseId]);
  for (const sh of ships) await db.query(`update shipments set due_by=$2 where id=$1`, [sh.id, sh.has_tray ? r2.requiredBy.tray : r2.requiredBy.implant]);
  await syncIssues(db, ctx.tenantId, caseId, r2);
  const conflicts = await analyzeConflicts(db, caseId);
  await audit(db, ctx, 'case.move', 'case', caseId, { from: c.scheduled_start, to: newStart, conflicts }, { caseId, reason: input.reason });
  const msg = `Case ${c.case_ref} moved to ${fmtLocal(newStart, c.timezone)}. ${conflicts.length ? `${conflicts.length} conflict(s): ${conflicts.map((x) => x.message).join('; ')}` : 'No conflicts found.'}`;
  await notify(db, ctx.tenantId, c.rep_user_id, { kind: 'case_moved', message: msg, caseId, facilityId: c.facility_id, dedupe: `move:${caseId}:${newStart}` });
  await notifyRole(db, ctx.tenantId, ['ops_manager'], { kind: 'case_moved', message: msg, caseId, facilityId: c.facility_id, dedupe: `move:${caseId}:${newStart}` });
  return { case: await getVisibleCase(db, ctx, caseId), conflicts, released: invalid.length };
}

export async function cancelCase(db: Db, ctx: Ctx, caseId: string, input: { reason: string; expectedVersion?: number }) {
  requirePerm(ctx, 'case.manage');
  const c = await getVisibleCase(db, ctx, caseId);
  if (c.status !== 'scheduled') throw new AppError(409, 'case_not_open', `Case is already ${c.status}`);
  if (!input.reason?.trim()) throw new AppError(400, 'reason_required', 'A reason is required to cancel a case');
  await bumpVersion(db, c, input.expectedVersion);
  await db.query(`update cases set status='cancelled' where id=$1`, [caseId]);
  const res = await rows(db, `select id from reservations where case_id=$1 and status='active'`, [caseId]);
  for (const r of res) await releaseReservation(db, ctx, r.id, `Case ${c.case_ref} cancelled`);
  const ships = await rows(db, `select id, ref, status from shipments where case_id=$1 and status in ('planned','picked','packed')`, [caseId]);
  for (const s of ships) await db.query(`update shipments set status='cancelled' where id=$1`, [s.id]);
  const moving = await rows(db, `select ref from shipments where case_id=$1 and status in ('dispatched','delivered')`, [caseId]);
  await syncIssues(db, ctx.tenantId, caseId, { status: 'cancelled', blockers: [] });
  await audit(db, ctx, 'case.cancel', 'case', caseId, { released_reservations: res.length, cancelled_shipments: ships.map((s) => s.ref) }, { caseId, reason: input.reason });
  const msg = `Case ${c.case_ref} cancelled: ${res.length} reservation(s) released${moving.length ? `; shipments already moving need a return: ${moving.map((m) => m.ref).join(', ')}` : ''}.`;
  await notify(db, ctx.tenantId, c.rep_user_id, { kind: 'case_cancelled', message: msg, caseId, facilityId: c.facility_id, dedupe: `cancel:${caseId}` });
  await notifyRole(db, ctx.tenantId, ['ops_manager', 'warehouse'], { kind: 'case_cancelled', message: msg, caseId, facilityId: c.facility_id, dedupe: `cancel:${caseId}` });
  return { released: res.length, cancelledShipments: ships.length, inMotion: moving.map((m) => m.ref) };
}

export async function releaseReservation(db: Db, ctx: Ctx, reservationId: string, reason: string) {
  const r = await db.query(`update reservations set status='released', released_at=$2, release_reason=$3 where id=$1 and status='active' returning *`, [reservationId, nowIso(), reason]);
  if (r.rowCount) await audit(db, ctx, 'reservation.release', 'reservation', reservationId, {}, { caseId: r.rows[0].case_id, reason });
  return r.rows[0];
}

export async function updateRequirement(db: Db, ctx: Ctx, caseId: string, input: { requirementId?: string; catalogItemId?: string; qty: number; mandatory?: boolean; reason: string }) {
  requirePerm(ctx, 'case.manage');
  const c = await getVisibleCase(db, ctx, caseId);
  if (c.status !== 'scheduled') throw new AppError(409, 'case_not_open', `Case is ${c.status}`);
  if (!input.reason?.trim()) throw new AppError(400, 'reason_required', 'A reason is required');
  await bumpVersion(db, c);
  let reqId = input.requirementId;
  if (reqId) {
    const req = await one(db, `select * from case_requirements where id=$1 and case_id=$2`, [reqId, caseId]);
    if (input.qty <= 0) await db.query(`update case_requirements set active=false where id=$1`, [reqId]);
    else await db.query(`update case_requirements set qty=$2 where id=$1`, [reqId, input.qty]);
    // Release reservations beyond the new requirement.
    const res = await rows(db, `select * from reservations where requirement_id=$1 and status='active' order by created_at desc`, [reqId]);
    let covered = res.reduce((a, r) => a + r.qty, 0);
    for (const r of res) { if (covered <= Math.max(0, input.qty)) break; await releaseReservation(db, ctx, r.id, `Requirement reduced from ${req.qty} to ${input.qty}`); covered -= r.qty; }
  } else {
    if (!input.catalogItemId) throw new AppError(400, 'item_required', 'catalogItemId required for a new requirement');
    reqId = (await db.query(`insert into case_requirements(tenant_id, case_id, catalog_item_id, qty, mandatory) values ($1,$2,$3,$4,$5) returning id`,
      [ctx.tenantId, caseId, input.catalogItemId, input.qty, input.mandatory ?? true])).rows[0].id;
  }
  const conflicts = await analyzeConflicts(db, caseId);
  await audit(db, ctx, 'case.requirement_change', 'case_requirement', reqId!, { qty: input.qty, conflicts }, { caseId, reason: input.reason });
  await notify(db, ctx.tenantId, c.rep_user_id, { kind: 'requirements_changed', message: `Requirements changed for ${c.case_ref}: ${input.reason}`, caseId, facilityId: c.facility_id, dedupe: `req:${reqId}:${input.qty}` });
  return { conflicts };
}

export function fmtLocal(iso: string | Date, tz: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
}

// ---------------- Readiness ----------------

export interface Blocker { key: string; deadlineNote?: string; code: string; severity: 'critical' | 'warning'; message: string; owner: string; ownerRole: string; actBy?: string | null; requiredBy?: string | null; action: string; link?: string }

/**
 * Derive readiness strictly from persisted records. Nothing is "ready" because of a status flag:
 * a tray is ready only when it is physically at the facility (ledger), its latest contents
 * verification there is complete with no open discrepancy, and (if the facility requires it) an
 * authorized hospital user recorded a release decision. A courier scan alone never counts.
 */
/** Board-wide batch of the rows readiness needs, so a 600-case board is a handful of queries, not thousands. */
export interface Prefetch {
  cases: Map<string, any>; policies: Map<string, any>; reqsByCase: Map<string, any[]>; resvByReq: Map<string, any[]>;
  activeShipByResv: Map<string, any>; transitShipByResv: Map<string, any>; discByCase: Map<string, any[]>; feeds: Map<string, any>; issuesByCase: Map<string, any[]>;
}
const group = (xs: any[], k: string) => { const m = new Map<string, any[]>(); for (const x of xs) { const v = m.get(x[k]); if (v) v.push(x); else m.set(x[k], [x]); } return m; };

export async function prefetchReadiness(db: Db, caseIds: string[]): Promise<Prefetch> {
  const cases = await rows(db, `select c.*, f.timezone, f.name facility_name, f.code facility_code, u.display_name rep_name
    from cases c join facilities f on f.id=c.facility_id left join users u on u.id=c.rep_user_id where c.id = any($1)`, [caseIds]);
  const facIds = [...new Set(cases.map((c) => c.facility_id))];
  const policies = await rows(db, `select distinct on (facility_id) * from facility_policies where facility_id = any($1) and effective_from <= $2 order by facility_id, version desc`, [facIds, nowIso()]);
  const reqs = await rows(db, `select cr.*, ci.ref, ci.description, ci.item_type, ci.tracking from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id = any($1) and cr.active order by cr.mandatory desc, ci.item_type desc, ci.ref`, [caseIds]);
  const resv = await rows(db, `select r.*, s.serial_number, s.lot_number, s.expiry_date, l.kind loc_kind, l.facility_id loc_facility, l.name loc_name, l.code loc_code,
      te.minutes travel_min, (select h.reason from quality_holds h where h.stock_item_id=r.stock_item_id and h.status='active' limit 1) hold_reason
    from reservations r join cases c on c.id=r.case_id join stock_items s on s.id=r.stock_item_id join locations l on l.id=r.location_id
    left join travel_estimates te on te.from_location_id=r.location_id and te.to_facility_id=c.facility_id
    where r.case_id = any($1) and r.status='active'`, [caseIds]);
  const resvIds = resv.map((r) => r.id);
  const active = await rows(db, `select distinct on (sl.reservation_id) sl.reservation_id, s.* from shipment_lines sl join shipments s on s.id=sl.shipment_id where sl.reservation_id = any($1) and s.status in ('planned','picked','packed') order by sl.reservation_id, s.created_at`, [resvIds]);
  const transit = await rows(db, `select distinct on (sl.reservation_id) sl.reservation_id, s.* from shipment_lines sl join shipments s on s.id=sl.shipment_id where sl.reservation_id = any($1) and s.status in ('dispatched','delivered') order by sl.reservation_id, s.created_at desc`, [resvIds]);
  const disc = await rows(db, `select d.* from discrepancies d where d.case_id = any($1) and d.status='open' and d.tray_stock_item_id is null`, [caseIds]);
  const feeds = await rows(db, `select * from integration_feeds where code like 'sched-%'`);
  const issues = await rows(db, `select * from case_issues where case_id = any($1)`, [caseIds]);
  return {
    cases: new Map(cases.map((c) => [c.id, c])), policies: new Map(policies.map((p) => [p.facility_id, p])), reqsByCase: group(reqs, 'case_id'), resvByReq: group(resv, 'requirement_id'),
    activeShipByResv: new Map(active.map((x) => [x.reservation_id, x])), transitShipByResv: new Map(transit.map((x) => [x.reservation_id, x])), discByCase: group(disc, 'case_id'),
    feeds: new Map(feeds.map((f) => [f.code, f])), issuesByCase: group(issues, 'case_id'),
  };
}

export async function caseReadiness(db: Db, caseId: string, pf?: Prefetch) {
  const c = pf?.cases.get(caseId) ?? await one(db, `select c.*, f.timezone, f.name facility_name, f.code facility_code, u.display_name rep_name
    from cases c join facilities f on f.id=c.facility_id left join users u on u.id=c.rep_user_id where c.id=$1`, [caseId]);
  const policy = pf?.policies.get(c.facility_id) ?? await getPolicy(db, c.facility_id);
  const start = new Date(c.scheduled_start);
  // Policy lead times, then clipped to the facility's receiving hours (facility-local time).
  const trayRaw = new Date(start.getTime() - policy.tray_due_hours_before * 3600e3);
  const implantRaw = new Date(start.getTime() - policy.implant_due_hours_before * 3600e3);
  const trayD = receivingDeadline(trayRaw, c.timezone, policy.receiving_open, policy.receiving_close);
  const implantD = receivingDeadline(implantRaw, c.timezone, policy.receiving_open, policy.receiving_close);
  const trayDue = trayD.at, implantDue = implantD.at;
  const t = now();
  const planned = localDate(start, c.timezone);
  const blockers: Blocker[] = [];
  const items: any[] = [];
  const staleEvidence: any[] = [];
  const hoursNote = policy.receiving_close ? `${c.facility_name} receiving is open ${fmtClock(policy.receiving_open)}–${fmtClock(policy.receiving_close)} local time` : '';
  const dueNote = (itemType: string) => {
    const d = itemType === 'tray' ? trayD : implantD;
    return `Must be at ${c.facility_name} receiving by ${fmtLocal(d.at, c.timezone)}${d.clipped ? ` (receiving closes at ${fmtClock(policy.receiving_close)})` : ''}.`;
  };
  const opsName = 'Ops manager';
  const repName = c.rep_name ?? 'Assigned rep';

  if (c.status === 'cancelled' || c.status === 'completed' || c.status === 'closed') {
    return { caseId, status: c.status, blockers, items, staleEvidence, hoursNote, requiredBy: { tray: trayDue.toISOString(), implant: implantDue.toISOString() }, lastVerification: null, nextAction: null, policyVersion: policy.version };
  }

  const reqs = pf ? (pf.reqsByCase.get(caseId) ?? []) : await rows(db, `select cr.*, ci.ref, ci.description, ci.item_type, ci.tracking from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and cr.active order by cr.mandatory desc, ci.item_type desc, ci.ref`, [caseId]);
  let lastVer: { at: string; kind: string; what: string } | null = null;
  const bump = (at: any, kind: string, what: string) => { if (at && (!lastVer || new Date(at) > new Date(lastVer.at))) lastVer = { at: new Date(at).toISOString(), kind, what }; };

  for (const req of reqs) {
    const due = req.item_type === 'tray' ? trayDue : implantDue;
    const resv = pf ? (pf.resvByReq.get(req.id) ?? []) : await rows(db, `select r.*, s.serial_number, s.lot_number, s.expiry_date, l.kind loc_kind, l.facility_id loc_facility, l.name loc_name, l.code loc_code,
        te.minutes travel_min,
        (select h.reason from quality_holds h where h.stock_item_id=r.stock_item_id and h.status='active' limit 1) hold_reason
      from reservations r join stock_items s on s.id=r.stock_item_id join locations l on l.id=r.location_id
      left join travel_estimates te on te.from_location_id=r.location_id and te.to_facility_id=$2
      where r.requirement_id=$1 and r.status='active'`, [req.id, c.facility_id]);
    const covered = resv.reduce((a, r) => a + r.qty, 0);
    const itemState: any = { requirementId: req.id, ref: req.ref, description: req.description, itemType: req.item_type, mandatory: req.mandatory, qty: req.qty, reserved: covered, requiredBy: due.toISOString(), units: [] };
    items.push(itemState);
    if (!req.mandatory) { itemState.state = covered >= req.qty ? 'backup reserved' : 'optional backup'; continue; }
    if (covered < req.qty) {
      blockers.push({ key: `uncovered:${req.id}`, deadlineNote: dueNote(req.item_type), code: 'uncovered', severity: t > due ? 'critical' : 'warning', message: `No unit of ${req.ref} (${req.description}) is reserved for this case: ${req.qty - covered} of ${req.qty} still needed.`, owner: repName, ownerRole: 'rep', requiredBy: due.toISOString(), actBy: due.toISOString(), action: 'Run exact-item rescue search', link: `/cases/${caseId}/rescue/${req.id}` });
    }
    for (const r of resv) {
      const u: any = { reservationId: r.id, stockItemId: r.stock_item_id, serial: r.serial_number, lot: r.lot_number, expiry: r.expiry_date, location: r.loc_name, locationKind: r.loc_kind };
      itemState.units.push(u);
      const label = `${req.ref} ${r.serial_number ? 'SN ' + r.serial_number : 'lot ' + r.lot_number}`;
      if (r.hold_reason) { blockers.push({ key: `unit:${r.id}`, code: 'hold', severity: 'critical', message: `${label} is on quality hold (${r.hold_reason}). It cannot be used or shipped.`, owner: 'Quality manager', ownerRole: 'quality_manager', action: 'Find an unaffected unit', requiredBy: due.toISOString(), link: `/cases/${caseId}/rescue/${req.id}` }); u.state = 'on hold'; continue; }
      if (r.expiry_date && r.expiry_date < planned) { blockers.push({ key: `unit:${r.id}`, code: 'expired', severity: 'critical', message: `${label} expires ${r.expiry_date}, before the planned use date ${planned}.`, owner: repName, ownerRole: 'rep', action: 'Replace with an in-date unit', link: `/cases/${caseId}/rescue/${req.id}` }); u.state = 'expires before use'; continue; }
      if (r.loc_facility === c.facility_id && ['hospital_receiving', 'hospital_spd', 'consignment'].includes(r.loc_kind)) {
        const recv = await maybe(db, `select occurred_at at, movement_type from inventory_movements where stock_item_id=$1 and movement_type in ('receive','opening_balance','adjustment') and to_location_id=$2 order by occurred_at desc limit 1`, [r.stock_item_id, r.location_id]);
        if (recv) bump(recv.at, recv.movement_type === 'receive' ? 'received and checked at facility' : recv.movement_type === 'opening_balance' ? 'opening balance import (not a physical check)' : 'count adjustment', label);
        const cnt = await maybe(db, `select max(cl.counted_at) at from count_lines cl join count_sessions cs on cs.id=cl.session_id where cl.stock_item_id=$1 and cs.location_id=$2`, [r.stock_item_id, r.location_id]);
        if (cnt?.at) bump(cnt.at, 'cycle count', label);
        if (req.item_type === 'tray') {
          // Only a verification recorded after the tray's latest arrival at this facility counts.
          const arrived = await maybe(db, `select max(m.occurred_at) at from inventory_movements m join locations l on l.id=m.to_location_id where m.stock_item_id=$1 and l.facility_id=$2`, [r.stock_item_id, c.facility_id]);
          const v = await maybe(db, `select * from tray_verifications where tray_stock_item_id=$1 and location_id in (select id from locations where facility_id=$2) and verified_at >= coalesce($3::timestamptz, '-infinity') order by verified_at desc, recorded_at desc limit 1`, [r.stock_item_id, c.facility_id, arrived?.at ?? null]);
          const older = v ? null : await maybe(db, `select verified_at from tray_verifications where tray_stock_item_id=$1 order by verified_at desc limit 1`, [r.stock_item_id]);
          const openD = await rows(db, `select d.*, ci.ref, ci.description from discrepancies d left join catalog_items ci on ci.id=d.catalog_item_id where d.tray_stock_item_id=$1 and d.status='open'`, [r.stock_item_id]);
          if (v) bump(v.verified_at, 'tray contents verified', label);
          if (!v) { blockers.push({ key: `unit:${r.id}`, deadlineNote: dueNote('tray'), code: 'tray_unverified', severity: t > due ? 'critical' : 'warning', message: `Tray ${label} is at ${r.loc_name} but its contents have not been verified against the manifest since it arrived${older ? ` (the last check, ${fmtLocal(older.verified_at, c.timezone)}, predates this delivery and does not count)` : ''}.`, owner: 'Hospital receiving', ownerRole: 'hospital_receiving', requiredBy: due.toISOString(), actBy: due.toISOString(), action: 'Verify tray contents', link: `/trays/${r.stock_item_id}/verify?case=${caseId}` }); u.state = 'awaiting verification'; continue; }
          if (v.result !== 'complete' || openD.length) {
            const missing = openD.map((d) => d.ref ? `${d.description} (${d.ref})` : d.detail).join(', ');
            const nMissing = openD.filter((d) => d.kind === 'missing_instrument').length;
            blockers.push({ key: `unit:${r.id}`, deadlineNote: dueNote('tray'), code: 'tray_incomplete', severity: 'critical', message: `Tray ${r.serial_number} is missing ${nMissing || 'a'} required instrument${nMissing > 1 ? 's' : ''}: ${missing || 'required items missing'}. It stays blocked until a replacement is received and the tray is re-verified complete.`, owner: opsName, ownerRole: 'ops_manager', requiredBy: due.toISOString(), actBy: due.toISOString(), action: 'Send replacement instrument, then re-verify', link: `/cases/${caseId}` });
            u.state = 'contents incomplete'; continue;
          }
          if (policy.requires_release_decision) {
            const rel = await maybe(db, `select * from release_decisions where case_id=$1 and tray_stock_item_id=$2 order by recorded_at desc limit 1`, [caseId, r.stock_item_id]);
            if (!rel || rel.recorded_at < v.verified_at) { blockers.push({ key: `unit:${r.id}`, code: 'awaiting_release', severity: t > due ? 'critical' : 'warning', message: `Tray ${label} is verified complete. ${c.facility_name} requires its own sterile processing staff to record a release decision; none is recorded yet.`, owner: 'Hospital SPD', ownerRole: 'hospital_spd', requiredBy: start.toISOString(), action: 'Hospital records release decision', link: `/cases/${caseId}` }); u.state = 'awaiting hospital release'; continue; }
            if (rel.decision !== 'released') { blockers.push({ key: `unit:${r.id}`, code: 'not_released', severity: 'critical', message: `Hospital recorded "not released" for tray ${label}.`, owner: opsName, ownerRole: 'ops_manager', action: 'Arrange replacement tray', link: `/cases/${caseId}` }); u.state = 'not released'; continue; }
            bump(rel.recorded_at, 'hospital release recorded', label);
          }
        }
        // Stale evidence stays visible even when the unit counts as ready.
        const ev = await maybe(db, `select at, kind from (
            select m.occurred_at at, case when m.movement_type='receive' then 'received and checked here' when m.movement_type='opening_balance' then 'opening balance import (never physically scanned here)' else 'count adjustment' end kind
              from inventory_movements m where m.stock_item_id=$1 and m.to_location_id=$2 and m.movement_type in ('receive','opening_balance','adjustment')
            union all select cl.counted_at, 'cycle count here' from count_lines cl join count_sessions cs on cs.id=cl.session_id where cl.stock_item_id=$1 and cs.location_id=$2
            union all select tv.verified_at, 'tray contents verified here' from tray_verifications tv where tv.tray_stock_item_id=$1 and tv.location_id=$2) x order by at desc limit 1`, [r.stock_item_id, r.location_id]);
        const ageH = ev ? (t.getTime() - new Date(ev.at).getTime()) / 36e5 : null;
        u.evidence = ev ? { at: new Date(ev.at).toISOString(), kind: ev.kind, ageHours: Math.round(ageH!) } : null;
        if (!ev || /never physically/.test(ev.kind) || ageH! > 7 * 24) staleEvidence.push({ label, location: r.loc_name, kind: ev?.kind ?? 'no evidence', at: ev ? new Date(ev.at).toISOString() : null, ageHours: ageH == null ? null : Math.round(ageH) });
        u.state = 'ready'; continue;
      }
      if (r.loc_kind === 'in_transit') {
        const sh = pf ? (pf.transitShipByResv.get(r.id) ?? null) : await maybe(db, `select s.*, (select max(occurred_at) from custody_events e where e.shipment_id=s.id and e.event_type='dispatched') dispatched_at,
             (select max(occurred_at) from custody_events e where e.shipment_id=s.id and e.event_type in ('delivered','courier_scan')) courier_at
           from shipment_lines sl join shipments s on s.id=sl.shipment_id where sl.reservation_id=$1 and s.status in ('dispatched','delivered') order by s.created_at desc limit 1`, [r.id]);
        if (sh?.status === 'delivered') {
          blockers.push({ key: `unit:${r.id}`, deadlineNote: dueNote(req.item_type), code: 'delivered_unreceived', severity: t > due ? 'critical' : 'warning', message: `Courier reported ${label} delivered (${sh.ref}), but hospital receiving has not checked it in. A courier scan does not make the case ready.`, owner: 'Hospital receiving', ownerRole: 'hospital_receiving', requiredBy: due.toISOString(), actBy: due.toISOString(), action: 'Receive and verify shipment', link: `/shipments/${sh.id}` });
          u.state = 'courier delivered; not received';
        } else {
          blockers.push({ key: `unit:${r.id}`, deadlineNote: dueNote(req.item_type), code: 'in_transit', severity: t > due ? 'critical' : 'warning', message: `${label} is in transit on ${sh?.ref ?? 'a shipment'}.`, owner: 'Courier', ownerRole: 'courier', requiredBy: due.toISOString(), actBy: due.toISOString(), action: 'Track delivery', link: sh ? `/shipments/${sh.id}` : undefined });
          u.state = 'in transit';
        }
        continue;
      }
      // Still at a warehouse / trunk / elsewhere.
      const ship = pf ? (pf.activeShipByResv.get(r.id) ?? null) : await maybe(db, `select s.* from shipment_lines sl join shipments s on s.id=sl.shipment_id where sl.reservation_id=$1 and s.status in ('planned','picked','packed') limit 1`, [r.id]);
      const actBy = r.travel_min != null ? new Date(due.getTime() - r.travel_min * 60e3) : null;
      const late = actBy ? t > actBy : true;
      blockers.push({
        key: `unit:${r.id}`, deadlineNote: dueNote(req.item_type), code: ship ? 'awaiting_dispatch' : 'not_shipped', severity: late ? 'critical' : 'warning',
        message: `${label} is at ${r.loc_name}${ship ? ` on ${ship.ref} (${ship.status})` : ' with no shipment planned'}. ${actBy ? `Estimated travel ${r.travel_min} min, so it must leave by ${fmtLocal(actBy, c.timezone)}.` : 'No travel estimate exists for this route.'}${late && actBy ? ' That time has passed; find a closer unit.' : ''}`,
        owner: ship ? 'Warehouse' : opsName, ownerRole: ship ? 'warehouse' : 'ops_manager', requiredBy: due.toISOString(), actBy: actBy?.toISOString() ?? null,
        action: ship ? 'Pick, pack and dispatch' : 'Create delivery shipment', link: ship ? `/shipments/${ship.id}` : `/cases/${caseId}`,
      });
      u.state = ship ? `awaiting dispatch (${ship.status})` : 'not shipped';
    }
  }

  // Open discrepancies tied to the case (not tray-specific ones already reported).
  const disc = pf ? (pf.discByCase.get(caseId) ?? []) : await rows(db, `select d.* from discrepancies d where d.case_id=$1 and d.status='open' and d.tray_stock_item_id is null`, [caseId]);
  for (const d of disc) blockers.push({ key: `disc:${d.id}`, code: 'discrepancy', severity: 'warning', message: `Open ${d.kind.replace(/_/g, ' ')} discrepancy: ${d.detail}`, owner: opsName, ownerRole: 'ops_manager', action: 'Resolve discrepancy', link: d.shipment_id ? `/shipments/${d.shipment_id}` : `/cases/${caseId}` });

  // External schedule feed freshness stays visible.
  const feed = pf ? (pf.feeds.get(`sched-${c.facility_code}`) ?? null) : await maybe(db, `select * from integration_feeds where code=$1`, [`sched-${c.facility_code}`]);
  if (feed) {
    const stale = !feed.last_success_at || t.getTime() - new Date(feed.last_success_at).getTime() > feed.stale_after_minutes * 60e3;
    if (stale) blockers.push({ key: `feed:${feed.id}`, code: 'stale_feed', severity: 'warning', message: `${feed.name} last synced ${feed.last_success_at ? fmtLocal(feed.last_success_at, c.timezone) : 'never'}; the case time has not been reconfirmed with the hospital schedule.`, owner: 'Scheduler', ownerRole: 'scheduler', action: 'Confirm case time with hospital', link: '/integrations' });
  }

  const status = c.status !== 'scheduled' ? c.status : blockers.some((b) => b.severity === 'critical') ? 'blocked' : blockers.length ? 'at_risk' : 'ready';
  blockers.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1) || String(a.actBy ?? 'z').localeCompare(String(b.actBy ?? 'z')));
  return {
    caseId, status, blockers, items, staleEvidence, hoursNote, policyVersion: policy.version,
    requiredBy: { tray: trayDue.toISOString(), implant: implantDue.toISOString() },
    lastVerification: lastVer, nextAction: blockers[0] ? { action: blockers[0].action, owner: blockers[0].owner, actBy: blockers[0].actBy ?? blockers[0].requiredBy, link: blockers[0].link } : null,
  };
}

/** Readiness plus persisted issue ownership: each blocker gets its issue id, named owner, status and plain-English explanation. */
const OPEN_ISSUES_SQL = `select i.*, u.display_name owner_name, a.display_name ack_name,
      (select json_build_object('kind', e.kind, 'at', e.at, 'detail', e.detail) from issue_events e where e.issue_id=i.id order by e.at desc, e.id desc limit 1) last_event
    from case_issues i left join users u on u.id=i.owner_user_id left join users a on a.id=i.acknowledged_by where i.case_id = any($1) and i.status <> 'resolved'`;

export async function readinessWithIssues(db: Db, tenantId: string, caseId: string) {
  const r = await caseReadiness(db, caseId);
  await syncIssues(db, tenantId, caseId, r);
  const tz = (await one(db, `select f.timezone from cases c join facilities f on f.id=c.facility_id where c.id=$1`, [caseId])).timezone;
  return attachIssues(r, await rows(db, OPEN_ISSUES_SQL, [[caseId]]), tz);
}

function attachIssues(r: any, issues: any[], tz: string) {
  const byKey = new Map(issues.map((i) => [i.issue_key, i]));
  const blockers = r.blockers.map((b) => {
    const i = byKey.get(b.key);
    return { ...b, issueId: i?.id ?? null, owner: i?.owner_name ?? b.owner, ownerUserId: i?.owner_user_id ?? null, issueStatus: i?.status ?? 'open',
      acknowledgedBy: i?.ack_name ?? null, acknowledgedAt: i?.acknowledged_at ?? null, escalated: (i?.escalation_level ?? 0) > 0, lastEvent: i?.last_event ?? null,
      explanation: explain({ message: b.message, deadlineNote: b.deadlineNote }, i?.owner_name ?? null, b.actBy ?? b.requiredBy ?? null, tz) };
  });
  const top = blockers[0];
  return { ...r, blockers, nextAction: top ? { action: top.action, owner: top.owner, actBy: top.actBy ?? top.requiredBy, link: top.link, issueId: top.issueId, explanation: top.explanation, issueStatus: top.issueStatus } : null };
}

export async function readinessBoard(db: Db, ctx: Ctx, hours = 72) {
  const t = now();
  const [scope, sp] = caseScope(ctx, 3);
  const cases = await rows(db, `select c.*, f.name facility_name, f.code facility_code, f.timezone, u.display_name rep_name
     from cases c join facilities f on f.id=c.facility_id left join users u on u.id=c.rep_user_id
     where c.scheduled_start between $1 and $2 and ${scope} order by c.scheduled_start`, [new Date(t.getTime() - 6 * 3600e3).toISOString(), new Date(t.getTime() + hours * 3600e3).toISOString(), ...sp]);
  const out: any[] = [];
  const ids = cases.map((c) => c.id);
  const pf = await prefetchReadiness(db, ids);
  const results = new Map<string, any>();
  for (const c of cases) {
    const r = await caseReadiness(db, c.id, pf);
    await syncIssues(db, ctx.tenantId, c.id, r, { c: pf.cases.get(c.id), existing: pf.issuesByCase.get(c.id) ?? [] });
    results.set(c.id, r);
  }
  const openIssues = group(await rows(db, OPEN_ISSUES_SQL, [ids]), 'case_id');
  for (const c of cases) {
    const r = attachIssues(results.get(c.id), openIssues.get(c.id) ?? [], c.timezone);
    out.push({
      id: c.id, caseRef: c.case_ref, facility: c.facility_name, facilityCode: c.facility_code, facilityId: c.facility_id, timezone: c.timezone, procedure: c.procedure, surgeonRef: c.surgeon_ref,
      scheduledStart: c.scheduled_start, status: r.status, caseStatus: c.status, urgent: c.urgent, repName: c.rep_name, requiredBy: r.requiredBy, hoursNote: r.hoursNote,
      blockers: r.blockers, lastVerification: r.lastVerification, nextAction: r.nextAction, staleEvidence: r.staleEvidence,
      minutesLeft: r.nextAction?.actBy ? Math.round((new Date(r.nextAction.actBy).getTime() - t.getTime()) / 60e3) : null,
    });
  }
  // Most urgent first: blocked, then least time left.
  const rank: Record<string, number> = { blocked: 0, at_risk: 1, ready: 2 };
  out.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || (a.minutesLeft ?? 1e9) - (b.minutesLeft ?? 1e9) || String(a.scheduledStart).localeCompare(String(b.scheduledStart)));
  return { generatedAt: t.toISOString(), windowHours: hours, cases: out };
}
