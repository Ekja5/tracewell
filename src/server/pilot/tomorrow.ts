/**
 * "Tomorrow's cases": one view for the operations manager, built from the same readiness engine and
 * the same shortage arithmetic the assistant uses. This module only ADDS, per blocker:
 *   - a type: confirmed shortage / missing information / waiting on the hospital / action needed
 *   - the evidence behind it (spreadsheet row, reservation, courier scan, receipt) with timestamps
 *   - who can resolve it
 * Both /api/tomorrow and the assistant's tools call enrichCases(), so they cannot disagree.
 */
import { AppError, Db, maybe, one, rows } from '../db.js';
import { can, isFacilityUser, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit } from '../audit.js';
import { fmtLocal, getVisibleCase, readinessBoard } from '../domain/cases.js';
import { AVAILABILITY_SQL, lastVerification, localDate, reserve } from '../domain/inventory.js';
import { addDaysYmd, localYmd } from '../time.js';
import { computeShortage } from '../assistant/tools.js';
import type { AssistantCtx } from '../assistant/types.js';

export interface Evidence { kind: 'spreadsheet_row' | 'reservation' | 'courier_scan' | 'receipt' | 'physical_check' | 'reconciliation' | 'requirement'; label: string; href: string | null; at: string | null }
export const TYPE_LABEL: Record<string, string> = {
  confirmed_shortage: 'Confirmed shortage', missing_information: 'Missing information', awaiting_hospital: 'Waiting on hospital', action_needed: 'Action needed',
};

/** The spreadsheet row that last stated this unit's quantity (if the user may open uploads) and the last physical check. */
export async function unitEvidence(db: Db, actx: AssistantCtx, stockItemId: string, locationId: string): Promise<Evidence[]> {
  const out: Evidence[] = [];
  if (can(actx, 'upload.view')) {
    const o = await maybe(db, `select o.observed_qty, o.exported_at, o.role, r.id run_id, r.worksheet, f.filename, ur.row_number
       from balance_observations o join upload_runs r on r.id=o.run_id join upload_files f on f.id=r.file_id join upload_rows ur on ur.id=o.row_id
       where o.stock_item_id=$1 and o.location_id=$2 and o.role in ('opening','snapshot') order by o.exported_at desc, o.created_at desc limit 1`, [stockItemId, locationId]);
    if (o) out.push({ kind: 'spreadsheet_row', label: `${o.filename} › ${o.worksheet} › row ${o.row_number} says ${o.observed_qty} on hand`, href: `/uploads/runs/${o.run_id}?row=${o.row_number}`, at: new Date(o.exported_at).toISOString() });
    const d = await maybe(db, `select dd.decided_at, dd.decision, dd.qty_after, u.display_name, sd.ref from discrepancy_decisions dd join stock_discrepancies sd on sd.id=dd.discrepancy_id join users u on u.id=dd.decided_by
       where sd.stock_item_id=$1 and sd.location_id=$2 and dd.decision in ('accept_observed','keep_system') order by dd.decided_at desc limit 1`, [stockItemId, locationId]);
    if (d) out.push({ kind: 'reconciliation', label: `${d.ref}: ${d.display_name} ${d.decision === 'accept_observed' ? `accepted ${d.qty_after} as the current balance` : 'kept the system quantity'}`, href: `/reconcile?ref=${d.ref}`, at: new Date(d.decided_at).toISOString() });
  }
  const v = await lastVerification(db, stockItemId, locationId);
  if (v && !/opening balance|adjustment/.test(v.kind)) out.push({ kind: 'physical_check', label: `Last physical check: ${v.kind}`, href: null, at: new Date(v.at).toISOString() });
  return out;
}

/** Open spreadsheet-vs-system differences for a catalog item (within the user's scope). */
export async function openDiscrepanciesForItem(db: Db, actx: AssistantCtx, catalogItemId: string) {
  return rows(db, `select sd.id, sd.ref, sd.kind, sd.ledger_qty, sd.observed_qty, l.name loc_name from stock_discrepancies sd join stock_items s on s.id=sd.stock_item_id join locations l on l.id=sd.location_id
     where s.catalog_item_id=$1 and sd.status='open' and ($2::uuid is null or l.facility_id=$2) order by sd.opened_at`, [catalogItemId, isFacilityUser(actx) ? actx.facilityId : null]);
}

async function handoffEvidence(db: Db, caseId: string): Promise<Evidence[]> {
  const ev = await rows(db, `select ce.event_type, ce.occurred_at, u.display_name, u.role, s.ref, s.id from shipments s join custody_events ce on ce.shipment_id=s.id join users u on u.id=ce.actor_user_id
     where s.case_id=$1 and ce.event_type in ('delivered','received') order by ce.occurred_at`, [caseId]);
  return ev.map((e) => ({ kind: e.event_type === 'received' ? 'receipt' as const : 'courier_scan' as const, href: `/shipments/${e.id}`, at: new Date(e.occurred_at).toISOString(),
    label: e.event_type === 'received' ? `${e.display_name} (hospital receiving) checked in ${e.ref}` : `${e.display_name} (courier) recorded ${e.ref} delivered` }));
}

/** Everything behind a shortage figure: the requirement's source row, each unit's spreadsheet row and last check, other cases' reservations, open differences. */
export async function shortageEvidence(db: Db, actx: AssistantCtx, caseId: string, req: any, shortage: any): Promise<{ evidence: Evidence[]; disc: any[] }> {
  const evidence: Evidence[] = [];
  if (can(actx, 'upload.view')) {
    const src = await maybe(db, `select ur.row_number, ur.run_id, f.filename, r.worksheet, r.exported_at from case_requirements cr join upload_rows ur on ur.id=cr.upload_row_id join upload_runs r on r.id=ur.run_id join upload_files f on f.id=r.file_id where cr.id=$1`, [req.id]);
    if (src) evidence.push({ kind: 'requirement', label: `${src.filename} › ${src.worksheet} › row ${src.row_number} requires ${req.qty}`, href: `/uploads/runs/${src.run_id}?row=${src.row_number}`, at: new Date(src.exported_at).toISOString() });
  }
  const seen = new Set<string>();
  for (const l of shortage.lines) {
    if (!l.stockItemId) continue;
    const k = `${l.stockItemId}|${l.locationId}`; if (seen.has(k)) continue; seen.add(k);
    evidence.push(...await unitEvidence(db, actx, l.stockItemId, l.locationId));
  }
  const resv = await rows(db, `select r.created_at, r.qty, u.display_name, c2.case_ref, c2.id, c2.facility_id from reservations r join stock_items s on s.id=r.stock_item_id join cases c2 on c2.id=r.case_id join users u on u.id=r.created_by
     where s.catalog_item_id=$1 and r.status='active' and r.case_id<>$2 order by r.created_at`, [req.catalog_item_id, caseId]);
  for (const r of resv) if (!isFacilityUser(actx) || r.facility_id === actx.facilityId) evidence.push({ kind: 'reservation', label: `${r.qty} reserved for ${r.case_ref} by ${r.display_name}`, href: `/cases/${r.id}`, at: new Date(r.created_at).toISOString() });
  return { evidence, disc: await openDiscrepanciesForItem(db, actx, req.catalog_item_id) };
}

/** Adds type, evidence, last-verified and who-can-resolve to each blocker of board cases. */
export async function enrichCases(db: Db, actx: AssistantCtx, cases: any[]) {
  const t = now();
  const out: any[] = [];
  for (const c of cases) {
    const caseRow = { id: c.id, scheduled_start: c.scheduledStart, timezone: c.timezone, facility_id: c.facilityId, case_ref: c.caseRef };
    const handoff = await handoffEvidence(db, c.id);
    const blockers: any[] = [];
    for (const b of c.blockers) {
      const evidence: Evidence[] = []; let type = 'action_needed'; let shortage: any = null; let who: string[] = []; let detail: string | null = null; const actions: any[] = [];
      if (b.code === 'uncovered') {
        const req = await one(db, `select cr.*, ci.ref, ci.description, p.name manufacturer from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id left join parties p on p.id=ci.manufacturer_party_id where cr.id=$1`, [b.key.split(':')[1]]);
        shortage = { ref: req.ref, manufacturer: req.manufacturer, description: req.description, requirementId: req.id, ...(await computeShortage(db, actx, caseRow, req)) };
        const se = await shortageEvidence(db, actx, c.id, req, shortage);
        evidence.push(...se.evidence);
        const disc = se.disc;
        if (disc.length) {
          type = 'missing_information';
          detail = `Not confirmed: ${disc.map((d) => d.kind === 'not_listed' ? `${d.ref} (the latest complete file does not list ${d.ledger_qty} unit(s) the system holds at ${d.loc_name})` : `${d.ref} (a newer spreadsheet says ${d.observed_qty} at ${d.loc_name}; the system has ${d.ledger_qty})`).join('; ')} is waiting to be reconciled. Until then: ${shortage.sentence}`;
          if (can(actx, 'upload.view')) for (const d of disc) evidence.push({ kind: 'reconciliation', label: `${d.ref} is open`, href: `/reconcile?ref=${d.ref}`, at: null });
        } else if (shortage.short > 0) { type = 'confirmed_shortage'; detail = `Confirmed shortage: ${shortage.sentence}`; }
        else { detail = `Enough stock exists but none is reserved yet: ${shortage.sentence}`; if (can(actx, 'reservation.manage')) actions.push({ kind: 'reserve_available', label: `Reserve ${shortage.needToReserve} for this case`, requirementId: req.id }); }
      } else if (b.code === 'no_requirements') {
        type = 'missing_information'; detail = 'No requirements are loaded for this case. This is missing information, not a confirmed problem.';
      } else if (b.code === 'delivered_unreceived') {
        type = 'awaiting_hospital';
        who = (await rows(db, `select display_name from users where facility_id=$1 and role in ('hospital_receiving','hospital_spd') and active order by role, display_name`, [c.facilityId])).map((u) => u.display_name);
        evidence.push(...handoff.filter((e) => e.kind === 'courier_scan'));
        detail = `${c.facility} requires its own receiving staff to check deliveries in. ${who.length ? `${who.join(' or ')} can confirm receipt.` : 'No receiving user is set up at this facility.'}`;
      } else if (b.key?.startsWith('unit:')) {
        const r = await maybe(db, `select r.created_at, r.qty, r.stock_item_id, r.location_id, u.display_name from reservations r join users u on u.id=r.created_by where r.id=$1`, [b.key.split(':')[1]]);
        if (r) { evidence.push({ kind: 'reservation', label: `${r.qty} reserved for this case by ${r.display_name}`, href: `/cases/${c.id}`, at: new Date(r.created_at).toISOString() }); evidence.push(...await unitEvidence(db, actx, r.stock_item_id, r.location_id)); }
      }
      const dated = evidence.filter((e) => e.at).sort((a, b2) => String(b2.at).localeCompare(String(a.at)));
      const actBy = b.actBy ?? b.requiredBy ?? null;
      blockers.push({ key: b.key, code: b.code, type, typeLabel: TYPE_LABEL[type], message: b.message, detail, owner: b.ownerUserId ? b.owner : 'Unassigned', ownerRole: b.ownerRole, issueId: b.issueId, link: b.link ?? `/cases/${c.id}`,
        actBy, actByLocal: actBy ? fmtLocal(actBy, c.timezone) : null, passed: actBy ? new Date(actBy) < t : false, whoCanResolve: who, shortage, actions,
        evidence: evidence.map((e) => ({ ...e, atLocal: e.at ? fmtLocal(e.at, c.timezone) : null })),
        lastVerified: dated[0] ? { at: dated[0].at, atLocal: fmtLocal(dated[0].at!, c.timezone), what: dated[0].label } : null });
    }
    const status = blockers.length === 0 ? 'ready' : blockers.some((b) => b.type === 'confirmed_shortage' || (b.passed && b.type !== 'missing_information')) ? 'needs_attention' : blockers.every((b) => b.type === 'missing_information') ? 'needs_information' : 'in_progress';
    const readyEv = handoff.map((e) => ({ ...e, atLocal: e.at ? fmtLocal(e.at, c.timezone) : null }));
    out.push({ id: c.id, caseRef: c.caseRef, facility: c.facility, facilityId: c.facilityId, timezone: c.timezone, procedure: c.procedure, repName: c.repName, scheduledStart: c.scheduledStart, startLocal: fmtLocal(c.scheduledStart, c.timezone),
      engineStatus: c.status, status, statusLabel: { ready: 'Ready', needs_attention: 'Needs attention', needs_information: 'Needs information', in_progress: 'In progress' }[status],
      blockers, handoffEvidence: readyEv, lastVerification: c.lastVerification, hoursNote: c.hoursNote });
  }
  return out;
}

/** Cases whose facility-local date is tomorrow, for the signed-in user's scope. */
export async function tomorrowView(db: Db, actx: AssistantCtx) {
  const t = now();
  const board = await readinessBoard(db, actx, 60);
  const cases = board.cases.filter((c: any) => c.caseStatus === 'scheduled' && localYmd(new Date(c.scheduledStart), c.timezone) === addDaysYmd(localYmd(t, c.timezone), 1));
  const enriched = await enrichCases(db, actx, cases);
  enriched.sort((a, b) => String(a.scheduledStart).localeCompare(String(b.scheduledStart)));
  const seeUploads = can(actx, 'upload.view');
  const pending = seeUploads ? await one(db, `select (select count(*)::int from stock_discrepancies where status='open') discrepancies,
     (select count(*)::int from upload_rows where outcome='held' and reason_code<>'needs_reconciliation') held_rows,
     (select max(created_at) from upload_runs) last_upload`) : { discrepancies: 0, held_rows: 0, last_upload: null };
  return { generatedAt: t.toISOString(), cases: enriched, pending,
    counts: { total: enriched.length, ready: enriched.filter((c) => c.status === 'ready').length, needsAttention: enriched.filter((c) => c.status === 'needs_attention').length, needsInformation: enriched.filter((c) => c.status === 'needs_information').length, inProgress: enriched.filter((c) => c.status === 'in_progress').length } };
}

/** Reserve the exact item for a case from stock that is available right now (facility first, then warehouse, earliest expiry first). */
export async function reserveAvailable(db: Db, ctx: AssistantCtx, caseId: string, requirementId: string) {
  requirePerm(ctx, 'reservation.manage');
  const c = await getVisibleCase(db, ctx, caseId);
  const req = await maybe(db, `select * from case_requirements where id=$1 and case_id=$2 and active`, [requirementId, caseId]);
  if (!req) throw new AppError(404, 'not_found', 'Requirement not found');
  const have = (await one(db, `select coalesce(sum(qty),0)::int n from reservations where requirement_id=$1 and status='active'`, [requirementId])).n;
  let need = req.qty - have; let reserved = 0;
  const planned = localDate(new Date(c.scheduled_start), c.timezone);
  const cand = await rows(db, `select a.*, s.expiry_date from (${AVAILABILITY_SQL}) a join stock_items s on s.id=a.stock_item_id
     where s.catalog_item_id=$1 and a.condition='sealed' and a.allocatable and not a.on_hold and a.on_hand - a.reserved > 0 and (s.expiry_date is null or s.expiry_date >= $3)
     order by (a.location_facility_id = $2) desc nulls last, (a.location_kind='warehouse') desc, s.expiry_date nulls last, a.location_code`, [req.catalog_item_id, c.facility_id, planned]);
  for (const a of cand) {
    if (need <= 0) break;
    const q = Math.min(need, a.on_hand - a.reserved);
    await reserve(db, ctx, { caseId, requirementId, stockItemId: a.stock_item_id, locationId: a.location_id, ownerPartyId: a.owner_party_id, qty: q });
    need -= q; reserved += q;
  }
  if (!reserved) throw new AppError(409, 'none_available', 'No unit of this exact item is available to reserve right now');
  await audit(db, ctx, 'reservation.reserve_available', 'case_requirement', requirementId, { reserved, still_needed: need }, { caseId });
  return { reserved, stillNeeded: need, at: nowIso() };
}
