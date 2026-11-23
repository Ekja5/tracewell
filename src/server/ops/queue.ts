/**
 * The operations work queue: what needs doing, ranked, each with why it is a problem, the safest fix and
 * the action. Built from the same readiness engine and shortage arithmetic as the board, the Tomorrow view
 * and the assistant, so they cannot disagree. Also: the five-number breakdown behind a shortage, and
 * allocation of stock to cases by the account's priority rule.
 *
 * "Safest" is ordered: reserve stock that needs no movement; then move a unit a later case is holding
 * (when that case still has time to be resupplied); then a transfer that arrives in time and does not
 * short the giving side; then an outside loaner while its cutoff is open. Exact item only, never a substitute.
 */
import { AppError, Db, maybe, one, rows } from '../db.js';
import { can, isFacilityUser, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit } from '../audit.js';
import { fmtLocal, getVisibleCase, readinessBoard, releaseReservation } from '../domain/cases.js';
import { AVAILABILITY_SQL, localDate, reserve } from '../domain/inventory.js';
import { rescueSearch } from '../domain/rescue.js';
import { computeShortage } from '../assistant/tools.js';
import type { AssistantCtx } from '../assistant/types.js';
import { enrichCases, shortageEvidence, unitEvidence } from '../pilot/tomorrow.js';
import { localYmd, zoned } from '../time.js';
import { getSettings, OpsSettings, RULE_LABEL } from './settings.js';
import { donorCheck, listTransfers } from './transfers.js';
import { listLoaners, loanerTiming, neededBy } from './loaners.js';
import { expiringStock, parView } from './stock.js';

export type Priority = 'critical' | 'high' | 'medium';
const RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2 };
export interface QueueAction { kind: 'reserve' | 'request_transfer' | 'request_loaner' | 'reallocate' | 'plan_delivery' | 'open'; label: string; href?: string; params?: any; note?: string | null; primary?: boolean }
export interface QueueItem { id: string; priority: Priority; kind: string; caseId: string | null; caseRef: string | null; facility: string | null; caseStartLocal: string | null; title: string; why: string; deadline: string | null; deadlineLocal: string | null; minutesLeft: number | null;
  owner: string | null; waitingOn: string | null; recommended: string; actions: QueueAction[]; link: string; issueId?: string | null; urgent?: boolean }

const TITLE: Record<string, string> = { hold: 'A reserved unit is on quality hold', expired: 'A reserved unit expires before the case', in_transit: 'In transit', delivered_unreceived: 'Delivered, not yet checked in by the hospital', tray_unverified: 'Tray contents not verified', tray_incomplete: 'Tray is missing instruments',
  awaiting_release: 'Waiting on the hospital\'s sterile-processing release', not_released: 'Hospital recorded "not released"', no_requirements: 'No requirements loaded', discrepancy: 'Open delivery discrepancy', stale_feed: 'Case time not reconfirmed' };
const hrs = (ms: number) => ms / 3600e3;
function priorityFor(type: string, deadline: Date | null, start: Date | null, t: Date, waiting: boolean): Priority {
  const toDeadline = deadline ? hrs(deadline.getTime() - t.getTime()) : null, toStart = start ? hrs(start.getTime() - t.getTime()) : null;
  let p: Priority = 'medium';
  if ((toDeadline != null && toDeadline < 0) || (type === 'confirmed_shortage' && toStart != null && toStart < 30)) p = 'critical';
  else if ((toDeadline != null && toDeadline < 8) || (toStart != null && toStart < 30)) p = 'high';
  if (type === 'missing_information' && p === 'critical') p = 'high';
  if (waiting && p === 'critical' && toDeadline != null && toDeadline > 0) p = 'high'; // someone has it in hand and there is still time
  return p;
}

/** Later cases holding units of this item that an earlier case is short of, where the later case can still be resupplied. */
async function reallocationOptions(db: Db, actx: AssistantCtx, c: any, req: any, s: OpsSettings) {
  if (!can(actx, 'reservation.manage') || isFacilityUser(actx)) return [];
  const t = now();
  const held = await rows(db, `select r.id, r.qty, r.case_id, c2.case_ref, c2.scheduled_start, f2.timezone, f2.name facility, l.name loc_name, l.kind loc_kind, st.lot_number, st.serial_number
     from reservations r join cases c2 on c2.id=r.case_id join facilities f2 on f2.id=c2.facility_id join locations l on l.id=r.location_id join stock_items st on st.id=r.stock_item_id
     where st.catalog_item_id=$1 and r.status='active' and r.case_id<>$2 and c2.status='scheduled' and c2.scheduled_start > $3 and l.kind='warehouse'
       and not exists (select 1 from shipment_lines sl join shipments sh on sh.id=sl.shipment_id where sl.reservation_id=r.id and sh.status not in ('cancelled','rejected'))
       and not exists (select 1 from quality_holds h where h.stock_item_id=r.stock_item_id and h.status='active')
     order by c2.scheduled_start desc`, [req.catalog_item_id, c.id, new Date(new Date(c.scheduled_start).getTime() + 24 * 3600e3).toISOString()]);
  return held.filter((h) => hrs(new Date(h.scheduled_start).getTime() - t.getTime()) > 48).map((h) => ({ reservationId: h.id, fromCaseId: h.case_id, fromCaseRef: h.case_ref, fromCaseWhen: fmtLocal(h.scheduled_start, h.timezone), fromFacility: h.facility, qty: h.qty,
    unit: h.serial_number ? `SN ${h.serial_number}` : `lot ${h.lot_number}`, location: h.loc_name, daysOut: Math.floor(hrs(new Date(h.scheduled_start).getTime() - t.getTime()) / 24) }));
}

/** Everything the queue and the evidence panel need to say about one unreserved requirement. */
export async function shortageOptions(db: Db, actx: AssistantCtx, c: any, req: any, s: OpsSettings) {
  const t = now();
  const transfers = (await listTransfers(db, actx, { caseId: c.id })).filter((x: any) => x.requirementId === req.id && !['Received', 'Declined', 'Withdrawn'].includes(x.current));
  const loaners = can(actx, 'loaner.view') ? (await listLoaners(db, actx, { caseId: c.id, open: true })).loaners.filter((l: any) => l.item.ref === req.ref && l.status !== 'received') : [];
  let candidates: any[] = [], requiredBy: string | null = null;
  if (can(actx, 'rescue.search')) {
    const search = await rescueSearch(db, actx, c.id, req.id, { quiet: true });
    requiredBy = search.requiredBy;
    for (const e of search.eligible.slice(0, 4)) {
      const loc = await one(db, `select * from locations where id=$1`, [e.locationId]);
      const donor = e.locationKind === 'warehouse' ? [] : (await donorCheck(db, req.catalog_item_id, loc, c.id, s.planningWindowHours)).filter((d: any) => d.uncovered > 0);
      candidates.push({ stockItemId: e.stockItemId, locationId: e.locationId, ownerPartyId: e.ownerPartyId, unit: e.label, location: e.location, locationKind: e.locationKind, custodian: e.custodian, travelMinutes: e.travelMinutes, atFacility: e.travelMinutes === 0,
        arrivalLocal: e.estimatedArrival ? fmtLocal(e.estimatedArrival, c.timezone) : null, meetsCutoff: e.meetsCutoff, evidence: e.evidence?.text ?? null, condition: 'Sealed', donorConflicts: donor,
        safe: e.meetsCutoff && donor.length === 0 });
    }
  }
  const nb = await neededBy(db, c, req.item_type ?? 'implant');
  const loaner = loanerTiming(s, nb.at, t, c, nb.policy);
  const reallocate = await reallocationOptions(db, actx, c, req, s);
  return { transfers, loaners, candidates, loaner, reallocate, requiredBy: requiredBy ?? nb.at.toISOString(), requiredByLocal: fmtLocal(requiredBy ?? nb.at, c.timezone) };
}

function recommend(c: any, b: any, opt: Awaited<ReturnType<typeof shortageOptions>>, actx: AssistantCtx): { text: string; actions: QueueAction[]; waitingOn: string | null } {
  const sh = b.shortage; const actions: QueueAction[] = []; const parts: string[] = [];
  // A requested transfer already holds its unit for this case (it is inside needToReserve); a loaner is not stock until it is checked in.
  const inHand = opt.loaners.reduce((a: number, l: any) => a + l.qty, 0);
  for (const tr of opt.transfers) actions.push({ kind: 'open', label: `Open ${tr.ref}`, href: `/transfers/${tr.id}`, note: `${tr.current}; waiting on ${tr.waitingOn}` });
  for (const l of opt.loaners) actions.push({ kind: 'open', label: `Open ${l.ref}`, href: `/loaners/${l.id}`, note: `${l.statusLabel}${l.expectedArrivalLocal ? `; expected ${l.expectedArrivalLocal}` : ''}` });
  let still = Math.max(0, sh.needToReserve - inHand);
  const waitingOn = opt.transfers[0]?.waitingOn ?? (opt.loaners[0] ? opt.loaners[0].source : null);
  if (inHand || opt.transfers.length) parts.push(`${opt.transfers.map((x: any) => `${x.ref} is ${x.current.toLowerCase()} (waiting on ${x.waitingOn})`).concat(opt.loaners.map((l: any) => `${l.ref} is ${l.statusLabel.toLowerCase()}`)).join('; ')}.`);
  if (still > 0) {
    const local = opt.candidates.filter((x) => x.atFacility || x.locationKind === 'warehouse');
    const away = opt.candidates.filter((x) => !x.atFacility && x.locationKind !== 'warehouse');
    const usedHere = Math.min(still, local.length ? sh.available : 0);
    if (local.length && sh.available > 0 && can(actx, 'reservation.manage')) {
      const n = Math.min(still, local.length);
      actions.push({ kind: 'reserve', label: `Reserve ${n} for this case`, params: { caseId: c.id, requirementId: sh.requirementId }, primary: true, note: `${local[0].unit} at ${local[0].location}` });
      parts.push(`Reserve ${n} available at ${local[0].location}.`); still -= n;
    }
    void usedHere;
    for (const x of away) {
      if (still <= 0) break;
      const warn = [!x.meetsCutoff ? 'arrives after the required-by time' : null, x.donorConflicts.length ? `${x.custodian} also needs it for ${x.donorConflicts.map((d: any) => d.caseRef).join(', ')}` : null].filter(Boolean).join('; ');
      if (can(actx, 'transfer.request')) actions.push({ kind: 'request_transfer', label: `Request transfer from ${x.custodian}`, href: `/cases/${c.id}/rescue/${sh.requirementId}?unit=${x.stockItemId}&loc=${x.locationId}`, primary: x.safe && !actions.some((a) => a.primary), note: `${x.unit}, about ${x.travelMinutes} min away, arrives ${x.arrivalLocal}${warn ? `. Caution: ${warn}` : ''}` });
      parts.push(x.safe ? `A matching unit (${x.unit}) is with ${x.custodian}, ${x.travelMinutes} min away, and arrives in time: request the transfer.` : `A matching unit is with ${x.custodian}, but ${warn}.`);
      if (x.safe) still -= 1;
    }
    if (still > 0 && opt.reallocate.length) {
      const r = opt.reallocate[0];
      actions.push({ kind: 'reallocate', label: `Move ${Math.min(still, r.qty)} from ${r.fromCaseRef}`, params: { toCaseId: c.id, requirementId: sh.requirementId, reservationId: r.reservationId, qty: Math.min(still, r.qty) }, primary: !actions.some((a) => a.primary),
        note: `${r.fromCaseRef} is ${r.daysOut} days out (${r.fromCaseWhen}) and holds ${r.qty} at ${r.location}; it will then need resupply` });
      parts.push(`${r.fromCaseRef} (${r.daysOut} days out) holds ${r.qty} in the warehouse: move ${Math.min(still, r.qty)} to this case and resupply ${r.fromCaseRef}.`); still -= Math.min(still, r.qty);
    }
    if (still > 0 && opt.loaner) {
      if (opt.loaner.inTime) {
        if (can(actx, 'loaner.manage')) actions.push({ kind: 'request_loaner', label: `Request ${still} from ${opt.loaner.source}`, params: { caseId: c.id, requirementId: sh.requirementId, qty: still }, primary: !actions.some((a) => a.primary), note: `Request by ${opt.loaner.requestByLocal}; would arrive ${opt.loaner.arrivalIfRequestedNowLocal}` });
        parts.push(`No local unit covers the last ${still}: request a loaner from ${opt.loaner.source} by ${opt.loaner.requestByLocal}.`);
      } else parts.push(`A loaner from ${opt.loaner.source} would arrive ${opt.loaner.arrivalIfRequestedNowLocal}, after the required-by time.`);
    } else if (still > 0 && !opt.loaner) parts.push('No loaner source is set up for this account.');
    if (still > 0 && !actions.some((a) => a.kind !== 'open')) parts.push('No option on record arrives in time. Call the surgeon\'s office and the rep; this case may need to move.');
  }
  return { text: parts.join(' ') || 'In hand; nothing else to do right now.', actions, waitingOn: still > 0 ? null : waitingOn };
}

/** The ranked queue. `by` (ISO) keeps only what must be dealt with before that time. */
export async function attentionQueue(db: Db, actx: AssistantCtx, opts: { by?: string | null; byLocal?: string | null } = {}) {
  requirePerm(actx, 'attention.view');
  const t = now(); const s = await getSettings(db);
  if (opts.byLocal && !/^\d{1,2}:\d{2}$/.test(opts.byLocal)) throw new AppError(400, 'bad_time', 'Enter the time as HH:MM');
  const by = opts.byLocal ? zoned(localYmd(t, actx.tenantTz), opts.byLocal.padStart(5, '0'), actx.tenantTz) : opts.by ? new Date(opts.by) : null;
  if (by && isNaN(by.getTime())) throw new AppError(400, 'bad_time', 'That is not a valid time');
  const board = await readinessBoard(db, actx, s.planningWindowHours);
  const scheduled = board.cases.filter((c: any) => c.caseStatus === 'scheduled' && new Date(c.scheduledStart) > t);
  const raw = new Map<string, any>(); for (const c of scheduled) for (const b of c.blockers) raw.set(`${c.id}|${b.key}`, b);
  const enriched = await enrichCases(db, actx, scheduled);
  const items: QueueItem[] = [];
  const urgentIds = new Set<string>(scheduled.filter((c: any) => c.urgent).map((c: any) => c.id));
  const pendingTr = new Map<string, any>(); if (!isFacilityUser(actx)) for (const tr of await listTransfers(db, actx, { open: true })) if (tr.status === 'requested') pendingTr.set(tr.reservationId, tr);
  for (const c of enriched) {
    const caseRow = { id: c.id, scheduled_start: c.scheduledStart, timezone: c.timezone, facility_id: c.facilityId, case_ref: c.caseRef };
    for (const b of c.blockers) {
      const orig = raw.get(`${c.id}|${b.key}`) ?? {};
      let recommended = orig.action ?? 'Open the case'; let actions: QueueAction[] = [{ kind: 'open', label: 'Open', href: b.link }]; let waitingOn: string | null = b.whoCanResolve?.length ? b.whoCanResolve.join(' or ') : null;
      let deadline: Date | null = b.actBy ? new Date(b.actBy) : null;
      if (b.code === 'uncovered' && b.shortage) {
        const req = await one(db, `select cr.*, ci.ref, ci.item_type from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.id=$1`, [b.shortage.requirementId]);
        const opt = await shortageOptions(db, actx, caseRow, req, s);
        const r = recommend(c, b, opt, actx);
        recommended = r.text; actions = [...r.actions, { kind: 'open', label: 'See the evidence', href: `/cases/${c.id}?req=${req.id}` }]; waitingOn = r.waitingOn;
        // The real clock for a shortage is the earliest of: required-by, and the loaner cutoff when a loaner is the only way.
        if (opt.loaner?.requestBy && !opt.loaner.passed && r.actions.some((a) => a.kind === 'request_loaner')) { const lc = new Date(opt.loaner.requestBy); if (!deadline || lc < deadline) deadline = lc; }
        if (b.type === 'missing_information') recommended = `Reconcile the open difference first (the numbers may change). Then: ${recommended}`;
      } else if (b.key?.startsWith('unit:') && pendingTr.has(b.key.split(':')[1])) {
        const tr = pendingTr.get(b.key.split(':')[1]);
        recommended = `${tr.ref} is requested; nothing moves until ${tr.holder} accepts. Pickup is planned for ${tr.pickupAtLocal} by ${tr.pickupBy}.`; waitingOn = tr.holder; actions = [{ kind: 'open', label: `Open ${tr.ref}`, href: `/transfers/${tr.id}` }];
      } else if (b.code === 'delivered_unreceived') recommended = `Ask ${waitingOn ?? 'hospital receiving'} to check the delivery in.`;
      if (/no shipment planned/.test(b.message) && can(actx, 'shipment.plan') && !(b.key?.startsWith('unit:') && pendingTr.has(b.key.split(':')[1]))) { recommended = 'Plan the delivery so the warehouse can pick it.'; actions = [{ kind: 'plan_delivery', label: 'Plan delivery', params: { caseId: c.id }, primary: true }, ...actions]; }
      let priority = priorityFor(b.type, deadline, new Date(c.scheduledStart), t, !!waitingOn && b.code === 'uncovered');
      if (urgentIds.has(c.id)) priority = priority === 'medium' ? 'high' : 'critical'; // a person marked this case urgent
      items.push({ id: `${c.id}|${b.key}`, priority, kind: b.code, caseId: c.id, caseRef: c.caseRef, facility: c.facility, caseStartLocal: c.startLocal, title: b.shortage ? `${b.shortage.short > 0 ? `Short ${b.shortage.short}` : `${b.shortage.needToReserve} not reserved`}: ${b.shortage.ref} ${b.shortage.description}` : (/no shipment planned/.test(b.message) ? 'Reserved but no delivery planned' : TITLE[b.code] ?? b.typeLabel),
        why: b.detail ?? b.message, deadline: deadline?.toISOString() ?? null, deadlineLocal: deadline ? fmtLocal(deadline, c.timezone) : null, minutesLeft: deadline ? Math.round((deadline.getTime() - t.getTime()) / 60e3) : null,
        owner: b.owner, waitingOn, recommended, actions, link: b.link, issueId: b.issueId ?? null, urgent: urgentIds.has(c.id) });
    }
  }
  const tz = actx.tenantTz;
  const push = (i: Partial<QueueItem> & { id: string; priority: Priority; kind: string; title: string; why: string; recommended: string; link: string }) => items.push({ caseId: null, caseRef: null, facility: null, caseStartLocal: null, deadline: null, deadlineLocal: null, minutesLeft: null, owner: null, waitingOn: null, actions: [{ kind: 'open', label: 'Open', href: i.link }], ...i });
  if (!isFacilityUser(actx)) {
    for (const tr of await listTransfers(db, actx, { open: true })) {
      const dl = new Date(tr.requiredBy);
      if (tr.canDecide && !tr.actingForHolder) push({ id: `tr|${tr.id}`, priority: 'high', kind: 'transfer_decision', caseId: tr.caseId, caseRef: tr.caseRef, facility: tr.facility, caseStartLocal: tr.caseStartLocal, title: `${tr.ref}: you are asked to give up ${tr.item.unit}`, why: `${tr.requestedBy} needs ${tr.item.ref} from ${tr.from} for ${tr.caseRef}. ${tr.donorCheck.filter((d: any) => d.uncovered > 0).length ? `Your own upcoming case(s) ${tr.donorCheck.filter((d: any) => d.uncovered > 0).map((d: any) => d.caseRef).join(', ')} also need it.` : 'None of your upcoming cases needs it.'}`,
        deadline: tr.pickupAt, deadlineLocal: tr.pickupAtLocal, minutesLeft: Math.round((new Date(tr.pickupAt).getTime() - t.getTime()) / 60e3), recommended: 'Accept or decline so the requester can plan.', link: `/transfers/${tr.id}`, owner: tr.holder });
      else if (tr.late || (tr.status === 'accepted' && tr.nextStep === 'Pickup confirmed' && new Date(tr.pickupAt) < t)) push({ id: `tr|${tr.id}`, priority: tr.late ? 'critical' : 'high', kind: 'transfer_late', caseId: tr.caseId, caseRef: tr.caseRef, facility: tr.facility, caseStartLocal: tr.caseStartLocal, title: `${tr.ref} is behind: ${tr.current}`, why: tr.late ? `It was required at ${tr.facility} by ${tr.requiredByLocal} and has not been received.` : `Pickup by ${tr.pickupBy} was planned for ${tr.pickupAtLocal} and has not been confirmed.`,
        deadline: dl.toISOString(), deadlineLocal: tr.requiredByLocal, minutesLeft: Math.round((dl.getTime() - t.getTime()) / 60e3), recommended: `Contact ${tr.waitingOn}.`, link: `/transfers/${tr.id}`, owner: tr.owner, waitingOn: tr.waitingOn });
    }
    if (can(actx, 'loaner.view')) for (const l of (await listLoaners(db, actx, { open: true })).loaners) {
      if (l.returnLate || l.returnDueSoon) push({ id: `ln|${l.id}`, priority: l.returnLate ? 'high' : 'medium', kind: 'loaner_return', caseId: l.caseId, caseRef: l.caseRef, facility: l.facility, title: `${l.ref}: loaner ${l.returnLate ? 'is overdue for return' : 'is due back'} (${l.dueBack})`, why: `${l.qty} x ${l.item.ref} from ${l.source}, used for ${l.caseRef}. Late returns can carry a fee from the source.`, recommended: 'Arrange the return and record the tracking number.', link: `/loaners/${l.id}` });
      else if (l.overdueArrival) push({ id: `ln|${l.id}`, priority: 'critical', kind: 'loaner_late', caseId: l.caseId, caseRef: l.caseRef, facility: l.facility, title: `${l.ref}: loaner has not arrived`, why: `It was needed by ${l.neededByLocal} and is still "${l.statusLabel}".`, recommended: `Call ${l.source}${l.inboundTracking ? ` with tracking ${l.inboundTracking}` : ''}.`, link: `/loaners/${l.id}`, waitingOn: l.source });
    }
    if (can(actx, 'recall.task')) for (const r of await rows(db, `select r.id, r.ref, r.status, r.description, ci.ref item_ref,
        (select coalesce(sum(b.qty),0)::int from stock_balances b join stock_items s on s.id=b.stock_item_id join locations l on l.id=b.location_id where s.catalog_item_id=r.catalog_item_id and b.qty>0 and l.kind not in ('consumed','wasted','quarantine','returns')
           and ((r.scope_type='lot' and s.lot_number = any(r.scope_values)) or (r.scope_type='serial' and s.serial_number = any(r.scope_values)))) outstanding
      from recalls r join catalog_items ci on ci.id=r.catalog_item_id where r.status in ('verified','active')`)) {
      if (r.status === 'verified') push({ id: `rcl|${r.id}`, priority: 'critical', kind: 'recall', title: `${r.ref} requires immediate attention`, why: `${r.outstanding} unit(s) of ${r.item_ref} in the affected scope are still usable. ${r.description}`, recommended: 'Open the recall, review the action summary and activate it to hold every affected unit.', link: `/recalls/${r.id}`, owner: 'Quality manager' });
      else if (r.outstanding > 0) push({ id: `rcl|${r.id}`, priority: 'high', kind: 'recall', title: `${r.ref}: ${r.outstanding} affected unit(s) not yet quarantined`, why: r.description, recommended: 'Work the open recall tasks.', link: `/recalls/${r.id}`, owner: 'Quality manager' });
    }
    if (can(actx, 'inventory.view')) {
      const exp = await expiringStock(db, actx);
      if (exp.rows.length) push({ id: 'expiring', priority: exp.rows.some((r: any) => r.daysLeft <= 14) ? 'high' : 'medium', kind: 'expiry', title: `${exp.rows.reduce((a: number, r: any) => a + r.qty, 0)} unit(s) expire within ${exp.warningDays} days`, why: exp.rows.slice(0, 3).map((r: any) => `${r.qty} x ${r.ref} ${r.unit} at ${r.location} expires ${r.expiry}`).join('; ') + (exp.rows.length > 3 ? '; and more' : ''), recommended: exp.rows.some((r: any) => r.useOn) ? 'Some can be used on an upcoming case first; open the list.' : 'Move it where it will be used, or plan the return.', link: '/stock/expiring' });
      const par = await parView(db, actx);
      const below = par.rows.filter((r: any) => r.status === 'below');
      if (below.length) push({ id: 'par', priority: 'medium', kind: 'par', title: `${below.length} item(s) below par`, why: below.slice(0, 3).map((r: any) => `${r.ref} at ${r.location}: ${r.usable} usable against a par of ${r.par}`).join('; '), recommended: 'Replenish to par, or adjust the par if demand has changed.', link: '/stock/par' });
    }
    if (can(actx, 'inventory.view')) { const o = await one(db, `select coalesce(sum(qty),0)::int n, count(distinct case_id)::int cases, min(created_at) oldest from replenishments where action='replace' and status='open'`);
      if (o.n) push({ id: 'replace', priority: 'medium', kind: 'replacements', title: `${o.n} replacement unit(s) owed after ${o.cases} finished case(s)`, why: `The oldest has been owed since ${fmtLocal(o.oldest, tz)}. Until they are restocked, on-hand runs below what the contracts expect.`, recommended: 'Order or restock them, then mark them replaced.', link: '/usage' }); }
    if (can(actx, 'upload.view')) { const d = (await one(db, `select count(*)::int n from stock_discrepancies where status='open'`)).n; if (d) push({ id: 'reconcile', priority: 'medium', kind: 'reconcile', title: `${d} spreadsheet difference(s) waiting to be reconciled`, why: 'A newer file and the system disagree about a quantity. Readiness for affected cases is shown as "not confirmed" until someone decides.', recommended: 'Decide each difference.', link: '/reconcile' }); }
  }
  items.sort((a, b) => RANK[a.priority] - RANK[b.priority] || (a.minutesLeft ?? 1e9) - (b.minutesLeft ?? 1e9) || String(a.caseRef).localeCompare(String(b.caseRef)));
  const shown = by ? items.filter((i) => i.priority === 'critical' || (i.deadline && new Date(i.deadline) <= by)) : items;
  const ready = enriched.filter((c) => c.status === 'ready').length;
  return { generatedAt: t.toISOString(), generatedAtLocal: fmtLocal(t, tz), by: by?.toISOString() ?? null, byLocal: by ? fmtLocal(by, tz) : null, windowHours: s.planningWindowHours, rule: RULE_LABEL[s.allocationRule], loanerSource: s.loanerSourceName,
    items: shown, hiddenLater: items.length - shown.length, counts: { critical: shown.filter((i) => i.priority === 'critical').length, high: shown.filter((i) => i.priority === 'high').length, medium: shown.filter((i) => i.priority === 'medium').length, cases: enriched.length, casesReady: ready } };
}

/** Required / on hand / reserved / available / short, each expandable to the exact units, cases, timestamps and source records. */
export async function requirementBreakdown(db: Db, actx: AssistantCtx, caseId: string, requirementId: string) {
  const c = await getVisibleCase(db, actx, caseId);
  const req = await maybe(db, `select cr.*, ci.ref, ci.description, ci.item_type, p.name manufacturer from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id left join parties p on p.id=ci.manufacturer_party_id where cr.id=$1 and cr.case_id=$2 and cr.active`, [requirementId, caseId]);
  if (!req) throw new AppError(404, 'not_found', 'Requirement not found');
  const s = await getSettings(db);
  const sh = await computeShortage(db, actx, c, req);
  const ev = await shortageEvidence(db, actx, caseId, req, sh);
  const opt = await shortageOptions(db, actx, c, req, s);
  const units = new Map<string, any>();
  for (const l of sh.lines) {
    if (!l.stockItemId) continue;
    const k = `${l.stockItemId}|${l.locationId}`;
    if (!units.has(k)) units.set(k, { unit: l.unit, location: l.location, qty: 0, states: [] as string[], evidence: (await unitEvidence(db, actx, l.stockItemId, l.locationId)).map((e) => ({ ...e, atLocal: e.at ? fmtLocal(e.at, c.timezone) : null })) });
    const u = units.get(k); u.qty += l.qty; u.states.push(`${l.qty} ${l.why}`);
  }
  const resv = await rows(db, `select r.id, r.qty, r.created_at, u.display_name by_name, c2.id case_id, c2.case_ref, c2.scheduled_start, c2.created_at entered_at, f2.name facility, f2.timezone, f2.id facility_id, ru.display_name rep, l.name loc_name, st.lot_number, st.serial_number,
       exists(select 1 from shipment_lines sl join shipments x on x.id=sl.shipment_id where sl.reservation_id=r.id and x.status not in ('cancelled','rejected')) shipping
     from reservations r join stock_items st on st.id=r.stock_item_id join cases c2 on c2.id=r.case_id join facilities f2 on f2.id=c2.facility_id join users u on u.id=r.created_by left join users ru on ru.id=c2.rep_user_id join locations l on l.id=r.location_id
     where st.catalog_item_id=$1 and r.status='active' and r.case_id<>$2 order by c2.scheduled_start`, [req.catalog_item_id, caseId]);
  const visible = resv.filter((r) => !isFacilityUser(actx) || r.facility_id === actx.facilityId);
  const reserved = visible.map((r) => ({ caseId: r.case_id, caseRef: r.case_ref, whenLocal: fmtLocal(r.scheduled_start, r.timezone), facility: r.facility, rep: r.rep, qty: r.qty, unit: r.serial_number ? `SN ${r.serial_number}` : `lot ${r.lot_number}`, location: r.loc_name,
    reservedAtLocal: fmtLocal(r.created_at, c.timezone), reservedBy: r.by_name, enteredAtLocal: fmtLocal(r.entered_at, c.timezone), commitment: r.shipping ? 'Firm (already on a shipment)' : 'Firm (reserved, not yet shipped)' }));
  const why = sh.short > 0 ? `${req.qty} required. ${sh.reservedThisCase} already reserved for this case and ${sh.available} more available = ${sh.reservedThisCase + sh.available}, so ${sh.short} short.` : sh.needToReserve > 0 ? `Enough stock exists, but ${sh.needToReserve} still has to be reserved for this case.` : 'Fully reserved.';
  return { checkedAt: nowIso(), checkedAtLocal: fmtLocal(now(), c.timezone), case: { id: c.id, caseRef: c.case_ref, facility: c.facility_name, startLocal: fmtLocal(c.scheduled_start, c.timezone) },
    item: { ref: req.ref, description: req.description, manufacturer: req.manufacturer, requirementId: req.id },
    numbers: { required: req.qty, onHand: sh.onHand, reservedOther: sh.reservedOtherCases, reservedThisCase: sh.reservedThisCase, available: sh.available, short: sh.short, onHold: sh.onHold, expiredBeforeUse: sh.expiredBeforeUse, notAllocatable: sh.notAllocatable },
    sentence: sh.sentence, why, requiredSource: ev.evidence.filter((e) => e.kind === 'requirement').map((e) => ({ ...e, atLocal: e.at ? fmtLocal(e.at, c.timezone) : null })),
    onHandUnits: [...units.values()], reserved, hiddenReservations: resv.length - visible.length,
    availableUnits: opt.candidates, options: { requiredByLocal: opt.requiredByLocal, transfers: opt.transfers, loaners: opt.loaners, loaner: opt.loaner, reallocate: opt.reallocate },
    openDifferences: ev.disc.map((d: any) => ({ ref: d.ref, href: `/reconcile?ref=${d.ref}` })),
    can: { reserve: can(actx, 'reservation.manage'), requestTransfer: can(actx, 'transfer.request'), requestLoaner: can(actx, 'loaner.manage') } };
}

/** Move a warehouse unit held for a later case to a case that needs it sooner. The later case becomes uncovered and shows up in the queue. */
export async function reallocate(db: Db, actx: AssistantCtx, input: { toCaseId: string; requirementId: string; reservationId: string; qty?: number; reason?: string }) {
  requirePerm(actx, 'reservation.manage');
  const to = await getVisibleCase(db, actx, input.toCaseId);
  const req = await maybe(db, `select * from case_requirements where id=$1 and case_id=$2 and active`, [input.requirementId, input.toCaseId]);
  if (!req) throw new AppError(404, 'not_found', 'Requirement not found');
  const r = await maybe(db, `select r.*, st.catalog_item_id, c.case_ref, c.scheduled_start, l.kind loc_kind from reservations r join stock_items st on st.id=r.stock_item_id join cases c on c.id=r.case_id join locations l on l.id=r.location_id where r.id=$1 and r.status='active' for update of r`, [input.reservationId]);
  if (!r) throw new AppError(409, 'gone', 'That reservation is no longer active. Refresh and choose again.');
  if (r.catalog_item_id !== req.catalog_item_id) throw new AppError(400, 'wrong_item', 'That reservation is for a different item');
  if (new Date(r.scheduled_start) <= new Date(to.scheduled_start)) throw new AppError(409, 'not_later', `${r.case_ref} is not later than ${to.case_ref}; units are only moved from a later case`);
  if (await maybe(db, `select 1 from shipment_lines sl join shipments sh on sh.id=sl.shipment_id where sl.reservation_id=$1 and sh.status not in ('cancelled','rejected')`, [r.id])) throw new AppError(409, 'on_shipment', 'That unit is already on a shipment');
  const have = (await one(db, `select coalesce(sum(qty),0)::int n from reservations where requirement_id=$1 and status='active'`, [req.id])).n;
  const move = Math.min(r.qty, Math.max(0, req.qty - have), Math.trunc(Number(input.qty ?? r.qty)));
  if (!(move > 0)) throw new AppError(409, 'not_needed', `${to.case_ref} does not need more of this item`);
  const reason = `Moved to ${to.case_ref} (sooner)${input.reason?.trim() ? `: ${input.reason.trim()}` : ''}`;
  await releaseReservation(db, actx, r.id, reason);
  await reserve(db, actx, { caseId: to.id, requirementId: req.id, stockItemId: r.stock_item_id, locationId: r.location_id, ownerPartyId: r.owner_party_id, qty: move });
  if (r.qty - move > 0) await reserve(db, actx, { caseId: r.case_id, requirementId: r.requirement_id, stockItemId: r.stock_item_id, locationId: r.location_id, ownerPartyId: r.owner_party_id, qty: r.qty - move });
  await audit(db, actx, 'reservation.reallocate', 'case_requirement', req.id, { moved: move, from: r.case_ref, to: to.case_ref }, { caseId: to.id, reason });
  return { moved: move, fromCaseRef: r.case_ref, toCaseRef: to.case_ref, at: nowIso() };
}

/** Demand against supply for every item needed inside the planning window, served in the account's rule order. */
export async function allocationView(db: Db, actx: AssistantCtx, opts: { until?: Date } = {}) {
  requirePerm(actx, 'attention.view');
  if (isFacilityUser(actx)) throw new AppError(403, 'forbidden', 'Allocation is a distributor view');
  const s = await getSettings(db); const t = now();
  const demand = await rows(db, `select cr.id requirement_id, cr.catalog_item_id, cr.qty, ci.ref, ci.description, c.id case_id, c.case_ref, c.scheduled_start, c.created_at, c.facility_id, f.name facility, f.timezone,
       coalesce((select sum(r.qty) from reservations r where r.requirement_id=cr.id and r.status='active'),0)::int reserved
     from case_requirements cr join cases c on c.id=cr.case_id join facilities f on f.id=c.facility_id join catalog_items ci on ci.id=cr.catalog_item_id
     where cr.active and cr.mandatory and c.status='scheduled' and c.scheduled_start between $1 and $2
     order by ${s.allocationRule === 'first_entered' ? 'c.created_at, c.scheduled_start' : 'c.scheduled_start, c.created_at'}, c.case_ref`, [t.toISOString(), new Date(Math.max(t.getTime() + s.planningWindowHours * 3600e3, opts.until?.getTime() ?? 0)).toISOString()]);
  const byItem = new Map<string, any[]>(); for (const d of demand) { if (!byItem.has(d.catalog_item_id)) byItem.set(d.catalog_item_id, []); byItem.get(d.catalog_item_id)!.push(d); }
  const items: any[] = [];
  for (const [itemId, list] of byItem) {
    const sup = await rows(db, `select a.stock_item_id, a.location_id, a.owner_party_id, a.location_facility_id, a.location_kind, a.on_hand - a.reserved free, st.expiry_date from (${AVAILABILITY_SQL}) a join stock_items st on st.id=a.stock_item_id
       where st.catalog_item_id=$1 and a.condition='sealed' and a.allocatable and not a.on_hold and a.on_hand - a.reserved > 0 and a.location_kind in ('warehouse','hospital_receiving','consignment') order by st.expiry_date nulls last`, [itemId]);
    const pool = sup.map((x) => ({ ...x }));
    const lines = list.map((d, i) => {
      const need = Math.max(0, d.qty - d.reserved); let gets = 0; const picks: any[] = [];
      for (const u of pool) { if (gets >= need) break; if (u.free <= 0) continue; if (u.location_kind !== 'warehouse' && u.location_facility_id !== d.facility_id) continue; if (u.expiry_date && u.expiry_date < localDate(new Date(d.scheduled_start), d.timezone)) continue;
        const q = Math.min(need - gets, u.free); u.free -= q; gets += q; picks.push({ stockItemId: u.stock_item_id, locationId: u.location_id, ownerPartyId: u.owner_party_id, qty: q }); }
      return { order: i + 1, caseId: d.case_id, caseRef: d.case_ref, facility: d.facility, whenLocal: fmtLocal(d.scheduled_start, d.timezone), enteredLocal: fmtLocal(d.created_at, actx.tenantTz), required: d.qty, reserved: d.reserved, wouldGet: gets, uncovered: need - gets, requirementId: d.requirement_id, picks };
    });
    const totalNeed = lines.reduce((a, l) => a + (l.required - l.reserved), 0), free = sup.reduce((a, x) => a + x.free, 0);
    if (totalNeed > 0) items.push({ catalogItemId: itemId, ref: list[0].ref, description: list[0].description, required: lines.reduce((a, l) => a + l.required, 0), reserved: lines.reduce((a, l) => a + l.reserved, 0), freeStock: free, conflict: totalNeed > free, uncovered: lines.reduce((a, l) => a + l.uncovered, 0), lines });
  }
  items.sort((a, b) => Number(b.conflict) - Number(a.conflict) || a.ref.localeCompare(b.ref));
  return { generatedAt: t.toISOString(), windowHours: s.planningWindowHours, rule: s.allocationRule, ruleLabel: RULE_LABEL[s.allocationRule], items, toReserve: items.reduce((a, i) => a + i.lines.reduce((x: number, l: any) => x + l.wouldGet, 0), 0),
    note: 'Counts stock in the warehouse and at the case\'s own facility. Units in a rep\'s trunk or at another facility need a transfer request and are not allocated automatically. Existing reservations are never taken away here.' };
}

export async function applyAllocation(db: Db, actx: AssistantCtx) {
  requirePerm(actx, 'allocation.run');
  const v = await allocationView(db, actx); let reserved = 0; const cases = new Set<string>();
  for (const it of v.items) for (const l of it.lines) for (const p of l.picks) { await reserve(db, actx, { caseId: l.caseId, requirementId: l.requirementId, stockItemId: p.stockItemId, locationId: p.locationId, ownerPartyId: p.ownerPartyId, qty: p.qty }); reserved += p.qty; cases.add(l.caseRef); }
  await audit(db, actx, 'allocation.apply', 'ops_settings', null, { rule: v.rule, reserved, cases: [...cases] });
  return { reserved, cases: [...cases], uncovered: v.items.flatMap((i: any) => i.lines.filter((l: any) => l.uncovered > 0).map((l: any) => ({ caseRef: l.caseRef, ref: i.ref, uncovered: l.uncovered }))), rule: v.ruleLabel };
}
