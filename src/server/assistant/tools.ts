/**
 * "Ask operations" tools. Each tool is typed, permission-scoped and reuses the same domain services
 * as the regular screens (readiness/issues, rescue ranking, reservations, audit). Every database
 * query, quantity calculation, time-zone conversion and eligibility check happens here, in code.
 * Tool output has two parts: a Card (facts + clickable sources, shown to the user as-is) and a small
 * `modelData` object (the only thing a model sees).
 */
import { z } from 'zod';
import { AppError, Db, maybe, one, rows } from '../db.js';
import { can, caseScope, isFacilityUser } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { readinessBoard, readinessWithIssues, fmtLocal } from '../domain/cases.js';
import { previewTransfer, rescueSearch, evidenceTier, exactItemAvailability } from '../domain/rescue.js';
import { lastVerification, localDate } from '../domain/inventory.js';
import { zoned, localYmd, addDaysYmd, fmtClock } from '../time.js';
import type { AssistantCtx, Card, ConvContext, ToolDef, ToolOutput, Source } from './types.js';
import { createDraft } from './drafts.js';
import { enrichCases, shortageEvidence } from '../pilot/tomorrow.js';

const card = (c: Omit<Card, 'checkedAt'>): Card => ({ ...c, checkedAt: nowIso() });
const notice = (title: string, text: string, caveats: string[] = []): ToolOutput => ({ card: card({ type: 'notice', title, data: { text }, sources: [], caveats }), modelData: { notice: text } });
const caseLink = (c: { id: string; case_ref: string }): Source => ({ label: `Case ${c.case_ref}`, href: `/cases/${c.id}`, kind: 'case' });

// ---------- shared resolvers (ambiguity always becomes a question, never a guess) ----------

export async function resolveCase(db: Db, actx: AssistantCtx, ref: string | null | undefined, conv: ConvContext): Promise<{ c?: any; out?: ToolOutput }> {
  const [scope, sp] = caseScope(actx, 2);
  const base = `select c.*, f.name facility_name, f.code facility_code, f.timezone, u.display_name rep_name from cases c join facilities f on f.id=c.facility_id left join users u on u.id=c.rep_user_id`;
  if (!ref) {
    if (!conv.caseId) return { out: notice('Which case?', 'Open a case or name it (for example SYN-1001).') };
    const c = await maybe(db, `${base} where c.id=$1 and ${scope}`, [conv.caseId, ...sp]);
    return c ? { c } : { out: notice('Case not available', 'That case is not visible to you.') };
  }
  const token = String(ref).trim();
  const found = await rows(db, `${base} where (c.case_ref ilike $1 or c.case_ref ilike '%' || $1) and ${scope} order by c.scheduled_start limit 6`, [token, ...sp]);
  if (!found.length) return { out: notice('Case not found', `No case matching "${token}" is visible to you.`) };
  if (found.length > 1) {
    return { out: { modelData: { needs_choice: found.map((f) => f.case_ref) }, clarification: { question: `"${token}" matches ${found.length} cases. Which one?`, options: found.map((f) => ({ label: `${f.case_ref} · ${f.facility_name} · ${fmtLocal(f.scheduled_start, f.timezone)}`, contextPatch: { caseId: f.id, caseRef: f.case_ref, facilityId: f.facility_id } })) } } };
  }
  return { c: found[0] };
}

export async function resolveItem(db: Db, ref: string | null | undefined, conv: ConvContext, caseId?: string | null): Promise<{ item?: any; out?: ToolOutput }> {
  if (!ref && conv.catalogItemId) {
    const item = await maybe(db, `select ci.*, p.name manufacturer from catalog_items ci left join parties p on p.id=ci.manufacturer_party_id where ci.id=$1`, [conv.catalogItemId]);
    if (item) return { item };
  }
  if (!ref) return {};
  const token = String(ref).trim();
  let found = await rows(db, `select ci.*, p.name manufacturer, null::int pkg_units from catalog_items ci left join parties p on p.id=ci.manufacturer_party_id where lower(ci.ref)=lower($1) or ci.unit_gtin=$1
     union all select ci.*, p.name, pk.units_per_package from packages pk join catalog_items ci on ci.id=pk.catalog_item_id left join parties p on p.id=ci.manufacturer_party_id where pk.gtin=$1`, [token]);
  if (conv.manufacturer && found.length > 1) found = found.filter((f) => f.manufacturer === conv.manufacturer);
  if (caseId && found.length > 1) {
    const req = (await rows(db, `select catalog_item_id from case_requirements where case_id=$1 and active`, [caseId])).map((r) => r.catalog_item_id);
    const onCase = found.filter((f) => req.includes(f.id));
    if (onCase.length === 1) found = onCase;
  }
  if (!found.length) return { out: notice('No exact match', `No catalog item matches "${token}" exactly. Use the exact catalog number or GTIN; the assistant never suggests substitutes.`) };
  if (found.length > 1) {
    return { out: { modelData: { needs_choice: found.map((f) => `${f.ref} (${f.manufacturer})`) }, clarification: {
      question: `${token} is used by ${found.length} manufacturers. Which one do you mean?`,
      options: found.map((f) => ({ label: `${f.ref} · ${f.manufacturer} · ${f.description}`, contextPatch: { catalogItemId: f.id, catalogRef: f.ref, manufacturer: f.manufacturer, packageUnits: f.pkg_units ?? null } })) } } };
  }
  return { item: found[0] };
}

/** "3 today" / "15:00" in the user's home time zone (facility users: their facility). */
function localCutoff(actx: AssistantCtx, hhmm: string | null | undefined, day: string) {
  const ymd = localYmd(now(), actx.tenantTz);
  const date = day === 'tomorrow' ? addDaysYmd(ymd, 1) : ymd;
  return hhmm ? zoned(date, hhmm, actx.tenantTz) : null;
}
async function userTz(db: Db, actx: AssistantCtx) {
  if (actx.facilityId) return (await one(db, `select timezone from facilities where id=$1`, [actx.facilityId])).timezone;
  return actx.tenantTz;
}

// ---------- tool implementations ----------

const callListSchema = z.object({ day: z.enum(['today', 'tomorrow', 'upcoming']).default('tomorrow'), act_before_local_time: z.string().regex(/^\d{1,2}:\d{2}$/).nullish() });
async function callList(db: Db, actx: AssistantCtx, input: any, conv: ConvContext): Promise<ToolOutput> {
  const p = callListSchema.parse(input ?? {});
  const tz = await userTz(db, { ...actx });
  const cutoff = p.act_before_local_time ? localCutoff({ ...actx, tenantTz: tz }, p.act_before_local_time, 'today') : null;
  const t = now();
  const board = await readinessBoard(db, actx, 60);
  // "Today"/"tomorrow" are each case's own facility-local dates.
  const dayOf = (c: any) => { const d = localYmd(new Date(c.scheduledStart), c.timezone); const today = localYmd(t, c.timezone); return d === today ? 'today' : d === addDaysYmd(today, 1) ? 'tomorrow' : 'later'; };
  const cases = board.cases.filter((c: any) => c.caseStatus === 'scheduled' && (p.day === 'upcoming' ? dayOf(c) !== 'later' : dayOf(c) === p.day));
  // Same classification and evidence as the Tomorrow board.
  const enr = new Map<string, any>();
  for (const e of await enrichCases(db, actx, cases)) for (const b of e.blockers) enr.set(`${e.id}|${b.key}`, b);
  const entries: any[] = []; const noDeadline: any[] = []; const caveats: string[] = [];
  for (const c of cases) {
    for (const b of c.blockers) {
      const actBy = b.actBy ?? b.requiredBy ?? null;
      const base = { caseId: c.id, caseRef: c.caseRef, facility: c.facility, timezone: c.timezone, issue: b.message, code: b.code, owner: b.ownerUserId ? b.owner : 'Unassigned', ownerUserId: b.ownerUserId, issueId: b.issueId, issueStatus: b.issueStatus, escalated: b.escalated,
        actBy, deadlineLocal: actBy ? fmtLocal(actBy, c.timezone) : null, recordLink: b.link ?? `/cases/${c.id}`,
        type: enr.get(`${c.id}|${b.key}`)?.type ?? 'action_needed', typeLabel: enr.get(`${c.id}|${b.key}`)?.typeLabel ?? 'Action needed', detail: enr.get(`${c.id}|${b.key}`)?.detail ?? null,
        whoCanResolve: enr.get(`${c.id}|${b.key}`)?.whoCanResolve ?? [], lastVerified: enr.get(`${c.id}|${b.key}`)?.lastVerified ?? null, evidence: enr.get(`${c.id}|${b.key}`)?.evidence ?? [] };
      if (!actBy) { noDeadline.push(base); continue; }
      if (cutoff && new Date(actBy) > cutoff) continue;
      entries.push({ ...base, passed: new Date(actBy) < t });
      if (/stale|never physically/i.test(b.message)) caveats.push(`${c.caseRef}: ${b.message}`);
    }
    for (const s of c.staleEvidence ?? []) caveats.push(`${c.caseRef}: evidence for ${s.label} is ${s.kind}${s.ageHours != null ? `, ${Math.round(s.ageHours / 24)} days old` : ''}.`);
  }
  entries.sort((a, b) => String(a.actBy).localeCompare(String(b.actBy)));
  const merged = new Map<string, any>();
  for (const e of entries) {
    const k = [e.caseId, e.code, e.owner, e.actBy, e.type].join('|');
    const m = merged.get(k);
    if (!m) merged.set(k, { ...e, issueIds: [e.issueId], issues: [e.issue] });
    else { m.issueIds.push(e.issueId); m.issues.push(e.issue); m.issue = `${m.issues.length} items: ${m.issues.join(' ')}`; }
  }
  entries.splice(0, entries.length, ...merged.values());
  const upcoming = entries.filter((e) => !e.passed), passed = entries.filter((e) => e.passed);
  const sources: Source[] = [...new Map(entries.map((e) => [e.caseId, { label: `Case ${e.caseRef}`, href: `/cases/${e.caseId}`, kind: 'case' }])).values()];
  for (const e of entries) for (const ev of (e.evidence ?? []).filter((x: any) => x.href && x.kind !== 'reservation').slice(0, 4)) if (!sources.some((s) => s.href === ev.href)) sources.push({ label: ev.label, href: ev.href, kind: ev.kind });
  const unassigned = upcoming.filter((e) => e.owner === 'Unassigned' && e.issueId);
  return {
    card: card({ type: 'call_list', title: `Calls for ${p.day === 'upcoming' ? "today's and tomorrow's" : `${p.day}'s`} cases${cutoff ? ` before ${fmtLocal(cutoff, tz)}` : ''}`, data: { upcoming, passed, noDeadline, cutoff: cutoff?.toISOString() ?? null, cutoffLocal: cutoff ? fmtLocal(cutoff, tz) : null, casesChecked: cases.length, timezone: tz },
      sources, caveats: [...new Set(caveats)].slice(0, 6),
      actions: unassigned.slice(0, 3).map((e) => ({ kind: 'assign_followup' as const, label: `Draft assignment: ${e.caseRef} (${e.code.replace(/_/g, ' ')})`, params: { issueId: e.issueId, caseId: e.caseId } })) }),
    modelData: { cutoff_local: cutoff ? fmtLocal(cutoff, tz) : null, cases_checked: cases.length,
      calls: upcoming.map((e) => ({ case: e.caseRef, facility: e.facility, kind: e.typeLabel, issue: e.issue, assessment: e.detail, owner: e.owner, deadline_local: e.deadlineLocal })),
      already_past_deadline: passed.map((e) => ({ case: e.caseRef, issue: e.issue, owner: e.owner, deadline_local: e.deadlineLocal })) },
    contextPatch: { lastCallList: upcoming.map((e) => ({ issueId: e.issueId, caseId: e.caseId, caseRef: e.caseRef, owner: e.owner })) },
  };
}

async function caseReadinessTool(db: Db, actx: AssistantCtx, input: any, conv: ConvContext): Promise<ToolOutput> {
  const { c, out } = await resolveCase(db, actx, input?.case_ref, conv);
  if (out) return out;
  const r = await readinessWithIssues(db, actx.tenantId, c.id);
  const sources: Source[] = [caseLink(c), ...r.blockers.filter((b: any) => b.link && b.link !== `/cases/${c.id}`).map((b: any) => ({ label: b.action, href: b.link, kind: 'record' }))];
  return {
    card: card({ type: 'readiness', title: `${c.case_ref} readiness: ${r.status.replace('_', ' ')}`, data: { caseId: c.id, caseRef: c.case_ref, facility: c.facility_name, start: fmtLocal(c.scheduled_start, c.timezone), status: r.status,
      blockers: r.blockers.map((b: any) => ({ explanation: b.explanation, owner: b.owner, issueStatus: b.issueStatus, actByLocal: b.actBy ? fmtLocal(b.actBy, c.timezone) : null, link: b.link, issueId: b.issueId, code: b.code })), staleEvidence: r.staleEvidence },
      sources, caveats: r.staleEvidence.map((s: any) => `${s.label}: ${s.kind}`) }),
    modelData: { case: c.case_ref, facility: c.facility_name, status: r.status, blockers: r.blockers.map((b: any) => ({ issue: b.message, owner: b.owner, act_by_local: b.actBy ? fmtLocal(b.actBy, c.timezone) : null })) },
    contextPatch: { caseId: c.id, caseRef: c.case_ref, facilityId: c.facility_id },
  };
}

const GENERIC = new Set(['meridian', 'size', 'left', 'right', 'synthetic', 'these', 'this', 'item', 'items', 'unit', 'units', 'case', 'short', 'hand', 'have', 'still', 'does', 'show', 'shows', 'why', 'five', 'four']);
/** True if a significant word of the user's hint ("patella buttons") appears in the item's description. */
export function hintMatches(hint: string, text: string) {
  const norm = (w: string) => w.toLowerCase().replace(/(es|s)$/, '');
  const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4).map(norm));
  return hint.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC.has(w)).map(norm).some((w) => words.has(w));
}

/** The arithmetic behind "short": every unit of the exact item is classified once, in code. */
export async function computeShortage(db: Db, actx: AssistantCtx, c: any, req: any) {
  const planned = localDate(new Date(c.scheduled_start), c.timezone);
  const facScope = isFacilityUser(actx) ? actx.facilityId : null;
  const units = await rows(db, `select b.stock_item_id, b.location_id, b.owner_party_id, b.qty, b.condition, l.kind, l.code, l.name loc_name, l.allocatable, l.facility_id,
      s.serial_number, s.lot_number, s.expiry_date, p.kind owner_kind,
      (select h.reason from quality_holds h where h.stock_item_id=b.stock_item_id and h.status='active' limit 1) hold
    from stock_balances b join stock_items s on s.id=b.stock_item_id join locations l on l.id=b.location_id join parties p on p.id=b.owner_party_id
    where s.catalog_item_id=$1 and b.qty>0 and b.condition='sealed' and l.kind not in ('consumed','wasted','missing','in_transit','returns')
      and ($2::uuid is null or l.facility_id=$2) order by l.code`, [req.catalog_item_id, facScope]);
  const resv = await rows(db, `select r.stock_item_id, r.location_id, r.owner_party_id, r.qty, r.case_id, c2.case_ref, c2.scheduled_start, f2.timezone, f2.id facility_id
     from reservations r join cases c2 on c2.id=r.case_id join facilities f2 on f2.id=c2.facility_id join stock_items s on s.id=r.stock_item_id
     where s.catalog_item_id=$1 and r.status='active'`, [req.catalog_item_id]);
  const t = { onHand: 0, reservedThisCase: 0, reservedOtherCases: 0, onHold: 0, expiredBeforeUse: 0, notAllocatable: 0, available: 0 };
  const lines: any[] = []; const others = new Map<string, any>();
  for (const u of units) {
    let remaining = u.qty; t.onHand += u.qty;
    const take = (n: number, bucket: keyof typeof t, why: string, extra: any = {}) => { const q = Math.min(n, remaining); if (q <= 0) return; remaining -= q; (t as any)[bucket] += q; lines.push({ qty: q, bucket, why, location: u.loc_name, locationCode: u.code, stockItemId: u.stock_item_id, locationId: u.location_id, unit: u.serial_number ? `SN ${u.serial_number}` : `lot ${u.lot_number}`, ...extra }); };
    const here = resv.filter((r) => r.stock_item_id === u.stock_item_id && r.location_id === u.location_id && r.owner_party_id === u.owner_party_id);
    take(here.filter((r) => r.case_id === c.id).reduce((a, r) => a + r.qty, 0), 'reservedThisCase', 'reserved for this case');
    if (u.hold) take(remaining, 'onHold', `on quality hold: ${u.hold}`);
    for (const r of here.filter((r) => r.case_id !== c.id)) {
      const visible = !isFacilityUser(actx) || r.facility_id === actx.facilityId;
      take(r.qty, 'reservedOtherCases', visible ? `reserved for ${r.case_ref} (${fmtLocal(r.scheduled_start, r.timezone)})` : 'reserved for another case', visible ? { caseId: r.case_id, caseRef: r.case_ref } : {});
      if (visible) others.set(r.case_id, r.case_ref);
    }
    if (u.expiry_date && u.expiry_date < planned) take(remaining, 'expiredBeforeUse', `expires ${u.expiry_date}, before use on ${planned}`);
    if (!u.allocatable || (u.owner_kind === 'hospital' && u.facility_id !== c.facility_id)) take(remaining, 'notAllocatable', u.owner_kind === 'hospital' ? 'hospital-owned consignment' : `${u.kind} stock is not allocatable`);
    take(remaining, 'available', 'available');
  }
  // Units already reserved for this case that are on a shipment are not "on hand" anywhere, but they are not missing either.
  const inTransit = resv.filter((r) => r.case_id === c.id).reduce((a, r) => a + r.qty, 0) - t.reservedThisCase;
  if (inTransit > 0) { t.reservedThisCase += inTransit; lines.push({ qty: inTransit, bucket: 'reservedThisCase', why: 'reserved for this case and in transit', location: 'In transit', locationCode: 'TRANSIT', stockItemId: null, locationId: null, unit: 'on a shipment' }); }
  const required = req.qty;
  const short = Math.max(0, required - t.reservedThisCase - t.available);
  const needToReserve = Math.max(0, required - t.reservedThisCase);
  const parts = [`${t.onHand} physically on hand`];
  if (t.reservedOtherCases) parts.push(`${t.reservedOtherCases} reserved for other cases`);
  if (t.onHold) parts.push(`${t.onHold} on quality hold`);
  if (t.expiredBeforeUse) parts.push(`${t.expiredBeforeUse} ${t.expiredBeforeUse === 1 ? 'expires' : 'expire'} before use`);
  if (t.notAllocatable) parts.push(`${t.notAllocatable} not allocatable`);
  if (t.reservedThisCase) parts.push(`${t.reservedThisCase} already reserved for this case${inTransit > 0 ? ` (${inTransit} in transit)` : ''}`);
  parts.push(`${t.available} available`, `${required} required`, short ? `short ${short}` : 'not short');
  return { ...t, required, short, needToReserve, sentence: parts.join(', ') + '.', lines, otherCases: [...others].map(([id, ref]) => ({ id, ref })) };
}

async function workQueueTool(db: Db, actx: AssistantCtx, input: any): Promise<ToolOutput> {
  const { attentionQueue } = await import('../ops/queue.js'); // loaded here: the queue module itself uses this file's shortage arithmetic
  const t = typeof input?.before_local_time === 'string' && /^\d{1,2}:\d{2}$/.test(input.before_local_time) ? input.before_local_time : null;
  const q = await attentionQueue(db, actx, { byLocal: t });
  const items = q.items.map((i) => ({ priority: i.priority, caseId: i.caseId, caseRef: i.caseRef, facility: i.facility, caseStartLocal: i.caseStartLocal, title: i.title, why: i.why, recommended: i.recommended, deadlineLocal: i.deadlineLocal, minutesLeft: i.minutesLeft, waitingOn: i.waitingOn, owner: i.owner,
    actions: i.actions.filter((a) => a.href).map((a) => ({ label: a.label, href: a.href, note: a.note ?? null })), link: i.link }));
  const sources: Source[] = [{ label: 'Needs attention (the full queue, with the actions)', href: '/attention', kind: 'queue' }, ...q.items.filter((i) => i.caseId).slice(0, 8).map((i) => ({ label: `Case ${i.caseRef}`, href: `/cases/${i.caseId}`, kind: 'case' }))];
  return { card: { type: 'queue', title: q.byLocal ? `To fix before ${q.byLocal}` : 'What needs attention', checkedAt: q.generatedAt, data: { items, counts: q.counts, byLocal: q.byLocal, hiddenLater: q.hiddenLater }, sources: sources.filter((s, i, a) => a.findIndex((x) => x.href === s.href) === i),
      caveats: ['Ranked by how close the deadline is and how soon the surgery is. Actions that change anything are on the Needs attention page; nothing was changed here.'] },
    modelData: { before: q.byLocal, counts: q.counts, items: items.map((i) => ({ priority: i.priority, case: i.caseRef, facility: i.facility, title: i.title, why: i.why, safest_fix: i.recommended, act_by: i.deadlineLocal, waiting_on: i.waitingOn })) } };
}

async function shortageTool(db: Db, actx: AssistantCtx, input: any, conv: ConvContext): Promise<ToolOutput> {
  if (!input?.case_ref && !conv.caseId) {
    // No case named or open: look at upcoming cases that have an unreserved requirement.
    const board = await readinessBoard(db, actx, 60);
    const cands = board.cases.filter((x: any) => x.caseStatus === 'scheduled' && x.blockers.some((b: any) => b.code === 'uncovered'));
    if (!cands.length) return notice('Nothing short', 'No case in the next 60 hours has an unreserved requirement right now.');
    if (cands.length > 1) return { modelData: { needs_choice: cands.map((x: any) => x.caseRef) }, clarification: { question: `${cands.length} upcoming cases have an item that is not reserved. Which case?`,
      options: cands.map((x: any) => ({ label: `${x.caseRef} · ${x.facility} · ${fmtLocal(x.scheduledStart, x.timezone)}`, contextPatch: { caseId: x.id, caseRef: x.caseRef } })) } };
    conv = { ...conv, caseId: cands[0].id };
  }
  const { c, out } = await resolveCase(db, actx, input?.case_ref, conv);
  if (out) return out;
  const { item, out: o2 } = await resolveItem(db, input?.catalog_ref, conv, c.id);
  if (o2) return o2;
  const reqs = await rows(db, `select cr.*, ci.ref, ci.description, ci.manufacturer_party_id, p.name manufacturer from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id left join parties p on p.id=ci.manufacturer_party_id
     where cr.case_id=$1 and cr.active and cr.mandatory and ($2::uuid is null or cr.catalog_item_id=$2)`, [c.id, item?.id ?? null]);
  if (!reqs.length) return notice('Not required', item ? `${c.case_ref} has no mandatory requirement for ${item.ref} (${item.manufacturer}).` : `${c.case_ref} has no mandatory requirements.`);
  // Without an item, explain the requirement(s) that are actually short.
  const results: any[] = [];
  for (const r of reqs) results.push({ r, s: await computeShortage(db, actx, c, r) });
  let shown = item ? results : results.filter((x) => x.s.reservedThisCase < x.r.qty);
  if (!item && shown.length > 1 && input?.item_hint) {
    const hinted = shown.filter((x) => hintMatches(String(input.item_hint), `${x.r.ref} ${x.r.description}`));
    if (hinted.length === 1) shown = hinted;
  }
  if (!shown.length) return notice('Nothing short', `${c.case_ref}: every mandatory item has enough units reserved.`);
  if (shown.length > 1 && !item) {
    return { modelData: { short_items: shown.map((x) => x.r.ref) }, clarification: { question: `${c.case_ref} is short on ${shown.length} items. Which one?`, options: shown.map((x) => ({ label: `${x.r.ref} · ${x.r.description} (${x.s.sentence})`, contextPatch: { catalogItemId: x.r.catalog_item_id, catalogRef: x.r.ref, manufacturer: x.r.manufacturer, requirementId: x.r.id, caseId: c.id } })) } };
  }
  const { r, s } = shown[0];
  const sources: Source[] = [
    { label: `Requirement: ${r.ref} × ${r.qty} on ${c.case_ref}`, href: `/cases/${c.id}`, kind: 'requirement' },
    { label: `Balances for ${r.ref}`, href: `/inventory?q=${encodeURIComponent(r.ref)}`, kind: 'balance' },
    ...s.otherCases.map((o: any) => ({ label: `Reservation held by ${o.ref}`, href: `/cases/${o.id}`, kind: 'reservation' })),
  ];
  const caveats: string[] = [];
  const se = await shortageEvidence(db, actx, c.id, r, s);
  for (const e of se.evidence.filter((e) => e.href && e.kind !== 'reservation')) sources.push({ label: e.label, href: e.href!, kind: e.kind === 'requirement' ? 'requirement_row' : e.kind });
  for (const d of se.disc) caveats.push(`${d.ref} is not reconciled yet: ${d.kind === 'not_listed' ? `the latest complete file does not list ${d.ledger_qty} unit(s) the system holds at ${d.loc_name}` : `a newer spreadsheet says ${d.observed_qty} at ${d.loc_name}; the system has ${d.ledger_qty}`}. These numbers use the system quantity until someone decides.`);
  const evidence = se.evidence.map((e) => ({ ...e, atLocal: e.at ? fmtLocal(e.at, c.timezone) : null }));
  for (const l of s.lines.filter((l: any) => l.bucket === 'available')) {
    const ver = await lastVerification(db, l.stockItemId, l.locationId);
    const ev = evidenceTier(ver?.kind ?? null, ver?.at ?? null, now().getTime());
    if (ev.tier !== 'fresh' && ev.tier !== 'recent') caveats.push(`Available ${l.unit} at ${l.location}: ${ev.text}.`);
  }
  return {
    card: card({ type: 'shortage', title: `Why ${c.case_ref} shows short on ${r.ref}`, data: { caseId: c.id, caseRef: c.case_ref, requirementId: r.id, ref: r.ref, manufacturer: r.manufacturer, description: r.description, ...s, evidence, pendingDiscrepancies: se.disc.map((d) => d.ref), classification: se.disc.length ? 'missing_information' : s.short > 0 ? 'confirmed_shortage' : 'action_needed' }, sources, caveats,
      actions: s.short || s.needToReserve ? [{ kind: 'transfer' as const, label: 'Find a unit and draft a transfer', params: { caseId: c.id, requirementId: r.id } }] : [] }),
    modelData: { case: c.case_ref, item: `${r.ref} (${r.manufacturer})`, arithmetic: s.sentence, confirmed: !se.disc.length, spreadsheet_evidence: evidence.filter((e) => e.kind === 'spreadsheet_row').map((e) => `${e.label} (exported ${e.atLocal})`), on_hand: s.onHand, reserved_other_cases: s.reservedOtherCases, on_hold: s.onHold, available: s.available, required: s.required, reserved_this_case: s.reservedThisCase, short: s.short },
    contextPatch: { caseId: c.id, caseRef: c.case_ref, requirementId: r.id, catalogItemId: r.catalog_item_id, catalogRef: r.ref, manufacturer: r.manufacturer },
  };
}

async function findItemTool(db: Db, actx: AssistantCtx, input: any, conv: ConvContext): Promise<ToolOutput> {
  if (!can(actx, 'rescue.search')) return notice('Not available for your role', 'Finding and moving stock is done by the distributor team. Your facility contact can see readiness for your cases.');
  let caseRow: any = null;
  if (input?.case_ref || conv.caseId) { const r = await resolveCase(db, actx, input?.case_ref, conv); if (r.out && input?.case_ref) return r.out; caseRow = r.c ?? null; }
  const { item, out } = await resolveItem(db, input?.catalog_ref, conv, caseRow?.id);
  if (out) return out;
  let req: any = null;
  if (caseRow) req = await maybe(db, `select cr.* from case_requirements cr where cr.case_id=$1 and cr.active and ($2::uuid is null or cr.catalog_item_id=$2) and ($3::uuid is null or cr.id=$3) order by cr.mandatory desc limit 1`, [caseRow.id, item?.id ?? null, item ? null : conv.requirementId ?? null]);
  if (!caseRow || !req) {
    if (!item) return notice('Which item?', 'Name the exact catalog number or GTIN.');
    const a: any = await exactItemAvailability(db, actx, { q: item.ref, catalogItemId: item.id });
    return { card: card({ type: 'availability', title: `${item.ref} (${item.manufacturer}) across all locations`, data: { mode: 'stock', ...a }, sources: [{ label: `Balances for ${item.ref}`, href: `/inventory?q=${encodeURIComponent(item.ref)}`, kind: 'balance' }], caveats: a.rows.filter((r: any) => r.usable && r.evidence.tier !== 'fresh' && r.evidence.tier !== 'recent').map((r: any) => `${r.label} at ${r.location}: ${r.evidence.text}`) }),
      modelData: { item: `${item.ref} (${item.manufacturer})`, usable_total: a.usableTotal, locations: a.rows.map((r: any) => ({ location: r.location, usable: r.usable, why_not: r.whyNot })) }, contextPatch: { catalogItemId: item.id, catalogRef: item.ref, manufacturer: item.manufacturer } };
  }
  const s = await rescueSearch(db, actx, caseRow.id, req.id);
  const top = s.eligible.filter((e: any) => e.meetsCutoff);
  const best = top[0] ?? null;
  const closerExcluded = s.excluded.filter((x: any) => x.closerThanBest || !best).slice(0, 4);
  const caveats = [s.travelDisclaimer];
  for (const e of s.eligible.slice(0, 3)) if (e.evidence.tier !== 'fresh' && e.evidence.tier !== 'recent') caveats.push(`${e.label} at ${e.location}: ${e.evidence.text}.`);
  for (const e of s.eligible.slice(0, 3)) if (e.arrivalNote) caveats.push(`${e.label}: ${e.arrivalNote}.`);
  const sources: Source[] = [caseLink(caseRow), { label: `Ranked sources for ${s.requirement.ref}`, href: `/cases/${caseRow.id}/rescue/${req.id}`, kind: 'rescue' }, { label: `Balances for ${s.requirement.ref}`, href: `/inventory?q=${encodeURIComponent(s.requirement.ref)}`, kind: 'balance' }];
  return {
    card: card({ type: 'availability', title: `Exact ${s.requirement.ref} for ${caseRow.case_ref} before ${fmtLocal(s.requiredBy, s.case.timezone)}`, data: { mode: 'case', caseId: caseRow.id, requirementId: req.id, requiredByLocal: fmtLocal(s.requiredBy, s.case.timezone),
      best, eligible: s.eligible.slice(0, 5).map((e: any) => ({ ...e, arrivalLocal: e.estimatedArrival ? fmtLocal(e.estimatedArrival, s.case.timezone) : null })), excluded: closerExcluded, ranking: s.rankingRule }, sources, caveats,
      actions: best ? [{ kind: 'transfer' as const, label: `Draft transfer of ${best.label} from ${best.location}`, params: { caseId: caseRow.id, requirementId: req.id, stockItemId: best.stockItemId, locationId: best.locationId, ownerPartyId: best.ownerPartyId } }] : [] }),
    modelData: { case: caseRow.case_ref, item: s.requirement.ref, required_by_local: fmtLocal(s.requiredBy, s.case.timezone),
      best: best ? { unit: best.label, location: best.location, custodian: best.custodian, estimated_travel_min: best.travelMinutes, arrival_local: fmtLocal(best.estimatedArrival, s.case.timezone), evidence: best.evidence.text } : null,
      excluded_closer: closerExcluded.map((x: any) => ({ unit: x.label, location: x.location, travel_min: x.travelMinutes, why: x.reasons })), travel_times_are_estimates: true },
    contextPatch: { caseId: caseRow.id, caseRef: caseRow.case_ref, requirementId: req.id, catalogItemId: req.catalog_item_id, catalogRef: s.requirement.ref,
      lastEligible: best ? { stockItemId: best.stockItemId, locationId: best.locationId, ownerPartyId: best.ownerPartyId, label: best.label, location: best.location, custodian: best.custodian } : null },
  };
}

async function impactTool(db: Db, actx: AssistantCtx, input: any, conv: ConvContext): Promise<ToolOutput> {
  if (!can(actx, 'rescue.search')) return notice('Not available for your role', 'Re-allocating stock between cases is done by the distributor team.');
  const unitTok = String(input?.unit ?? '').trim();
  if (!unitTok) return notice('Which unit?', 'Name the tray or unit, for example "Tray 14" or a serial number.');
  const digits = unitTok.replace(/^tray\s*/i, '').replace(/^#/, '');
  const units = await rows(db, `select s.id, s.serial_number, s.catalog_item_id, ci.ref, ci.item_type, ci.description from stock_items s join catalog_items ci on ci.id=s.catalog_item_id
     where s.serial_number is not null and (lower(s.serial_number)=lower($1) or (ci.item_type='tray' and $2 ~ '^[0-9]+$' and s.serial_number ~ ('(^|[^0-9])0*' || $2 || '$')))`, [unitTok, digits]);
  if (!units.length) return notice('Unit not found', `No unit matching "${unitTok}".`);
  if (units.length > 1) return { modelData: { needs_choice: units.map((u) => u.serial_number) }, clarification: { question: `"${unitTok}" matches ${units.length} units. Which one?`, options: units.map((u) => ({ label: `${u.serial_number} · ${u.description}`, contextPatch: { stockItemId: u.id } })) } };
  const u = units[0];
  let target: any = null;
  if (input?.to_case_ref) { const r = await resolveCase(db, actx, input.to_case_ref, conv); if (r.out) return r.out; target = r.c; }
  else if (/urgent/i.test(String(input?.to_case_hint ?? ''))) {
    const [scope, sp] = caseScope(actx, 1);
    const urg = await rows(db, `select c.*, f.name facility_name, f.timezone from cases c join facilities f on f.id=c.facility_id where c.urgent and c.status='scheduled' and ${scope} order by c.scheduled_start`, sp);
    if (urg.length > 1) return { modelData: { needs_choice: urg.map((x) => x.case_ref) }, clarification: { question: 'Which urgent case?', options: urg.map((x) => ({ label: `${x.case_ref} · ${x.facility_name} · ${fmtLocal(x.scheduled_start, x.timezone)}`, contextPatch: { caseId: x.id, caseRef: x.case_ref } })) } };
    target = urg[0] ?? null;
  } else if (conv.caseId) target = (await resolveCase(db, actx, null, conv)).c ?? null;
  const loc = await maybe(db, `select l.*, b.owner_party_id from stock_balances b join locations l on l.id=b.location_id where b.stock_item_id=$1 and b.qty>0 limit 1`, [u.id]);
  const holders = await rows(db, `select r.*, c.case_ref, c.scheduled_start, c.facility_id, f.name facility_name, f.timezone from reservations r join cases c on c.id=r.case_id join facilities f on f.id=c.facility_id where r.stock_item_id=$1 and r.status='active'`, [u.id]);
  const atRisk: any[] = []; const sources: Source[] = [];
  for (const h of holders) {
    if (target && h.case_id === target.id) continue;
    // Would that case still have an eligible replacement in time? Use the same rescue ranking, excluding this unit.
    let replacement: any = null;
    try {
      const s = await rescueSearch(db, actx, h.case_id, h.requirement_id);
      replacement = s.eligible.find((e: any) => e.stockItemId !== u.id && e.meetsCutoff) ?? null;
    } catch { /* not visible */ }
    atRisk.push({ caseId: h.case_id, caseRef: h.case_ref, facility: h.facility_name, startLocal: fmtLocal(h.scheduled_start, h.timezone), loses: u.serial_number,
      replacement: replacement ? `${replacement.label} at ${replacement.location} (est. ${replacement.travelMinutes} min)` : null, risk: replacement ? 'covered by a replacement' : 'AT RISK: no eligible replacement before its cutoff' });
    sources.push({ label: `Case ${h.case_ref} (current holder)`, href: `/cases/${h.case_id}`, kind: 'reservation' });
  }
  // Same tray type needed by other cases inside the 24 h reprocessing window of the target.
  const turnaround: any[] = [];
  if (target && u.item_type === 'tray') {
    const others = await rows(db, `select c.id, c.case_ref, c.scheduled_start, f.timezone from cases c join facilities f on f.id=c.facility_id join case_requirements cr on cr.case_id=c.id and cr.active
       where cr.catalog_item_id=$1 and c.status='scheduled' and c.id <> $2 and abs(extract(epoch from (c.scheduled_start - $3::timestamptz))) < 24*3600`, [u.catalog_item_id, target.id, target.scheduled_start]);
    for (const o of others) if (!atRisk.find((a) => a.caseId === o.id)) turnaround.push({ caseRef: o.case_ref, startLocal: fmtLocal(o.scheduled_start, o.timezone), note: 'needs the same tray type within 24 h; reprocessing time may not allow both' });
  }
  let targetNote: string | null = null;
  if (target && loc) {
    const te = await maybe(db, `select minutes from travel_estimates where from_location_id=$1 and to_facility_id=$2`, [loc.id, target.facility_id]);
    const req = await maybe(db, `select id from case_requirements where case_id=$1 and catalog_item_id=$2 and active`, [target.id, u.catalog_item_id]);
    if (req) {
      try {
        const p = await previewTransfer(db, actx, target.id, req.id, { stockItemId: u.id, locationId: loc.id, ownerPartyId: loc.owner_party_id });
        targetNote = `${target.case_ref} would receive it by about ${fmtLocal(p.candidate.estimatedArrival, target.timezone)} (estimate) vs required ${fmtLocal(p.requiredBy, target.timezone)}: ${p.candidate.meetsCutoff ? 'meets' : 'MISSES'} the cutoff.`;
      } catch (e: any) { targetNote = `Not eligible for ${target.case_ref} as things stand: ${e.message}`; }
    } else targetNote = `${target.case_ref} does not require ${u.ref}.`;
    if (te == null) targetNote += ' No travel estimate exists for this route.';
    sources.push(caseLink(target));
  }
  sources.push({ label: `${u.serial_number} ledger`, href: `/inventory?q=${encodeURIComponent(u.serial_number)}`, kind: 'balance' });
  return {
    card: card({ type: 'impact', title: `If ${u.serial_number} moves${target ? ` to ${target.case_ref}` : ''}`, data: { unit: u.serial_number, ref: u.ref, location: loc?.name ?? 'unknown', target: target ? { id: target.id, ref: target.case_ref } : null, atRisk, turnaround, targetNote, readOnly: true }, sources, caveats: ['Travel times are seeded estimates. This is a what-if; nothing was changed.'] }),
    modelData: { unit: u.serial_number, current_location: loc?.name, target: target?.case_ref ?? null, target_note: targetNote, cases_put_at_risk: atRisk.filter((a) => !a.replacement).map((a) => ({ case: a.caseRef, start_local: a.startLocal })), covered: atRisk.filter((a) => a.replacement).map((a) => ({ case: a.caseRef, replacement: a.replacement })), tray_turnaround_conflicts: turnaround },
    contextPatch: { stockItemId: u.id, ...(target ? { caseId: target.id, caseRef: target.case_ref } : {}) },
  };
}

const SINCE = ['yesterday_afternoon', 'yesterday_morning', 'yesterday', 'today_morning', 'last_24h'] as const;
function sinceToDate(since: string, tz: string): { at: Date; label: string } {
  const today = localYmd(now(), tz); const y = addDaysYmd(today, -1);
  switch (since) {
    case 'yesterday_afternoon': return { at: zoned(y, '12:00', tz), label: `yesterday afternoon (${fmtLocal(zoned(y, '12:00', tz), tz)})` };
    case 'yesterday_morning': return { at: zoned(y, '06:00', tz), label: `yesterday morning (${fmtLocal(zoned(y, '06:00', tz), tz)})` };
    case 'yesterday': return { at: zoned(y, '00:00', tz), label: `yesterday (${fmtLocal(zoned(y, '00:00', tz), tz)})` };
    case 'today_morning': return { at: zoned(today, '06:00', tz), label: `this morning (${fmtLocal(zoned(today, '06:00', tz), tz)})` };
    case 'last_24h': return { at: new Date(now().getTime() - 864e5), label: 'the last 24 hours' };
    default: { const d = new Date(since); if (isNaN(d.getTime())) throw new AppError(400, 'bad_since', 'Unrecognized time'); return { at: d, label: fmtLocal(d, tz) }; }
  }
}

async function historyTool(db: Db, actx: AssistantCtx, input: any, conv: ConvContext): Promise<ToolOutput> {
  const { c, out } = await resolveCase(db, actx, input?.case_ref, conv);
  if (out) return out;
  const tz = await userTz(db, actx);
  const { at, label } = sinceToDate(String(input?.since ?? 'yesterday_afternoon'), tz);
  const ev = await rows(db, `select * from (
      select a.recorded_at at, a.action kind, coalesce(u.display_name,'system') actor, coalesce(a.reason, '') detail, 'audit' src, null::text href from audit_log a left join users u on u.id=a.actor_user_id where a.case_id=$1
      union all select e.at, 'issue.' || e.kind, coalesce(u.display_name,'system'), e.detail, 'issue', '/cases/' || $1 from issue_events e join case_issues i on i.id=e.issue_id left join users u on u.id=e.actor_user_id where i.case_id=$1
      union all select m.recorded_at, 'stock.' || m.movement_type, u.display_name, m.reason, 'ledger', null from inventory_movements m join users u on u.id=m.actor_user_id where m.case_id=$1
      union all select ce.recorded_at, 'custody.' || ce.event_type, u.display_name, s.ref || coalesce(': ' || ce.notes, ''), 'custody', '/shipments/' || s.id from custody_events ce join shipments s on s.id=ce.shipment_id join users u on u.id=ce.actor_user_id where s.case_id=$1
    ) x order by at`, [c.id]);
  const earliest = ev.length ? new Date(ev[0].at) : new Date(c.created_at);
  const coverageStart = new Date(Math.min(earliest.getTime(), new Date(c.created_at).getTime()));
  const gap = at < coverageStart;
  const since = ev.filter((e) => new Date(e.at) >= at).map((e) => ({ at: new Date(e.at).toISOString(), atLocal: fmtLocal(e.at, c.timezone), kind: e.kind, actor: e.actor, detail: String(e.detail).slice(0, 220), href: e.href }));
  const gapText = gap ? `No recorded history for ${c.case_ref} before ${fmtLocal(coverageStart, c.timezone)}: the case first appears then${c.created_by ? '' : ' (loaded as a snapshot)'}. I can't tell you what it looked like ${label}.` : null;
  return {
    card: card({ type: 'history', title: `${c.case_ref}: changes since ${label}`, data: { caseId: c.id, caseRef: c.case_ref, since: at.toISOString(), sinceLabel: label, coverageStart: coverageStart.toISOString(), coverageStartLocal: fmtLocal(coverageStart, c.timezone), gap, gapText, events: since },
      sources: [caseLink(c), ...[...new Set(since.filter((e) => e.href).map((e) => e.href))].map((h) => ({ label: h!.startsWith('/shipments') ? 'Shipment custody record' : 'Case issues', href: h!, kind: 'event' }))],
      caveats: [gapText ?? '', 'Only recorded events are listed; anything done by phone or text outside the app is not visible.'].filter(Boolean) }),
    modelData: { case: c.case_ref, since: label, history_gap: gapText, events: since.slice(-25).map((e) => ({ at_local: e.atLocal, what: e.kind, by: e.actor, detail: e.detail })) },
    contextPatch: { caseId: c.id, caseRef: c.case_ref },
  };
}

async function draftTool(db: Db, actx: AssistantCtx, input: any, conv: ConvContext): Promise<ToolOutput> {
  const kind = input?.kind;
  if (!['assign_followup', 'transfer', 'message'].includes(kind)) throw new AppError(400, 'bad_kind', 'kind must be assign_followup, transfer or message');
  const d = await createDraft(db, actx, kind, input ?? {}, conv);
  return { card: d.card, extraCards: d.extra ? [d.extra.card] : [], modelData: { draft: kind, status: 'draft (not executed until the user confirms)', summary: d.summary, also_drafted: d.extra?.summary ?? null } };
}


// ---------- pilot: spreadsheet changes and hospital receipt ----------

async function uploadChangesTool(db: Db, actx: AssistantCtx): Promise<ToolOutput> {
  if (!can(actx, 'upload.view')) return notice('Not available for your role', 'Spreadsheet uploads belong to the distributor team. I can tell you what changed on your own cases instead: ask "what changed on this case since yesterday?"');
  const tz = actx.tenantTz;
  const runs = await rows(db, `select r.*, f.filename, f.uploaded_at, u.display_name by_name from upload_runs r join upload_files f on f.id=r.file_id join users u on u.id=r.created_by where r.kind='inventory' order by r.created_at desc limit 2`);
  if (!runs.length) return notice('No inventory file yet', 'No inventory file has been loaded, so there is nothing to compare.');
  const meta = (r: any) => ({ runId: r.id, filename: r.filename, worksheet: r.worksheet, exportedAt: r.exported_at, exportedAtLocal: fmtLocal(r.exported_at, tz), uploadedAtLocal: fmtLocal(r.created_at, tz), by: r.by_name, coverage: r.coverage });
  const latest = runs[0], previous = runs[1] ?? null;
  const fileSrc = (r: any): Source => ({ label: `${r.filename} › ${r.worksheet}`, href: `/uploads/runs/${r.id}`, kind: 'upload' });
  if (!previous) {
    const gap = `Only one inventory file has been loaded (${latest.filename}, exported ${fmtLocal(latest.exported_at, tz)}). There is no previous upload to compare it with.`;
    return { card: card({ type: 'changes', title: 'Changes since the previous upload', data: { latest: meta(latest), previous: null, changes: [], unchangedCount: 0, notListed: [], effects: [], gap }, sources: [fileSrc(latest)], caveats: [gap] }), modelData: { gap } };
  }
  const obs = await rows(db, `select o.*, ur.row_number, ur.outcome, ur.message, ci.id catalog_item_id, ci.ref, ci.description, s.lot_number, s.serial_number, l.name loc_name,
      po.observed_qty prev_qty, pur.row_number prev_row, po.run_id prev_run, pf.filename prev_file, pr.worksheet prev_sheet,
      sd.id disc_id, sd.ref disc_ref, sd.status disc_status, sd.ledger_qty disc_ledger
    from balance_observations o join upload_rows ur on ur.id=o.row_id join stock_items s on s.id=o.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join locations l on l.id=o.location_id
      left join balance_observations po on po.id=o.previous_observation_id left join upload_rows pur on pur.id=po.row_id left join upload_runs pr on pr.id=po.run_id left join upload_files pf on pf.id=pr.file_id
      left join stock_discrepancies sd on sd.observation_id=o.id
    where o.run_id=$1 order by ur.row_number`, [latest.id]);
  const changes: any[] = []; const sources: Source[] = [fileSrc(latest), fileSrc(previous)]; let unchanged = 0; const itemIds = new Set<string>();
  for (const o of obs) {
    const before = o.prev_qty; const delta = before == null ? null : o.observed_qty - before;
    if (o.role !== 'stale' && !o.disc_id && (delta === 0 || before == null && o.observed_qty === o.ledger_qty)) { unchanged++; continue; }
    const dec = o.disc_id ? await maybe(db, `select dd.*, u.display_name by_name from discrepancy_decisions dd join users u on u.id=dd.decided_by where dd.discrepancy_id=$1 and dd.decision in ('accept_observed','keep_system') order by dd.decided_at desc limit 1`, [o.disc_id]) : null;
    let status = 'explained', statusText = `Matches the system balance; recorded movements explain the change.`;
    if (o.role === 'stale') { status = 'not_applied'; statusText = 'Not applied: the file was older than newer evidence.'; }
    else if (o.disc_id && o.disc_status === 'open') { status = 'pending'; statusText = `Waiting for reconciliation (${o.disc_ref}): the file says ${o.observed_qty}, the system has ${o.disc_ledger}. Availability still uses ${o.disc_ledger}.`; }
    else if (dec?.decision === 'accept_observed') { status = 'accepted'; statusText = `${dec.by_name} accepted ${dec.qty_after} as the current balance (${o.disc_ref}, ${fmtLocal(dec.decided_at, tz)}). Cause recorded: ${dec.cause}. Note: ${dec.note}`; }
    else if (dec?.decision === 'keep_system') { status = 'kept_system'; statusText = `${dec.by_name} kept the system quantity ${dec.qty_before} (${o.disc_ref}, ${fmtLocal(dec.decided_at, tz)}). Reason recorded: ${dec.cause}. Note: ${dec.note}`; }
    else if (o.disc_id) { status = 'superseded'; statusText = `${o.disc_ref} was replaced by a newer file.`; }
    const rowHref = `/uploads/runs/${latest.id}?row=${o.row_number}`; const prevHref = o.prev_run ? `/uploads/runs/${o.prev_run}?row=${o.prev_row}` : null;
    changes.push({ ref: o.ref, description: o.description, unit: o.serial_number ? `SN ${o.serial_number}` : `lot ${o.lot_number}`, location: o.loc_name, before, after: o.observed_qty, delta, status, statusText, discrepancyRef: o.disc_ref ?? null,
      row: { label: `${latest.filename} › ${latest.worksheet} › row ${o.row_number}`, href: rowHref }, previousRow: prevHref ? { label: `${o.prev_file} › ${o.prev_sheet} › row ${o.prev_row}`, href: prevHref } : null });
    sources.push({ label: `${latest.filename} row ${o.row_number} (${o.ref}: ${o.observed_qty})`, href: rowHref, kind: 'spreadsheet_row' });
    if (prevHref) sources.push({ label: `${o.prev_file} row ${o.prev_row} (${o.ref}: ${before})`, href: prevHref, kind: 'spreadsheet_row' });
    if (o.disc_ref) sources.push({ label: `Reconciliation ${o.disc_ref}`, href: `/reconcile?ref=${o.disc_ref}`, kind: 'reconciliation' });
    itemIds.add(o.catalog_item_id);
  }
  const notListed = await rows(db, `select sd.ref, sd.status, sd.ledger_qty, ci.ref item_ref, l.name loc_name from stock_discrepancies sd join stock_items s on s.id=sd.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join locations l on l.id=sd.location_id where sd.run_id=$1 and sd.kind='not_listed'`, [latest.id]);
  for (const n of notListed) sources.push({ label: `Reconciliation ${n.ref}`, href: `/reconcile?ref=${n.ref}`, kind: 'reconciliation' });
  // What the changes mean for upcoming cases, using the same arithmetic as the board.
  const effects: any[] = [];
  if (itemIds.size) {
    const t = now();
    const reqs = await rows(db, `select cr.*, ci.ref, c.id cid, c.case_ref, c.scheduled_start, c.facility_id, f.timezone from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id join cases c on c.id=cr.case_id join facilities f on f.id=c.facility_id
       where cr.catalog_item_id = any($1) and cr.active and cr.mandatory and c.status='scheduled' and c.scheduled_start between $2 and $3 order by c.scheduled_start`, [[...itemIds], new Date(t.getTime() - 6 * 3600e3).toISOString(), new Date(t.getTime() + 60 * 3600e3).toISOString()]);
    for (const r of reqs) {
      const s = await computeShortage(db, actx, { id: r.cid, scheduled_start: r.scheduled_start, timezone: r.timezone, facility_id: r.facility_id }, r);
      const held = (await one(db, `select coalesce(sum(qty),0)::int n from reservations where requirement_id=$1 and status='active'`, [r.id])).n;
      if (held >= r.qty) continue; // already covered (possibly in transit): the change does not affect it
      effects.push({ caseId: r.cid, caseRef: r.case_ref, ref: r.ref, startLocal: fmtLocal(r.scheduled_start, r.timezone), sentence: s.sentence, short: s.short, available: s.available });
      sources.push({ label: `Case ${r.case_ref}`, href: `/cases/${r.cid}`, kind: 'case' });
    }
  }
  const others = await rows(db, `select r.kind, r.worksheet, r.counts, r.id, f.filename from upload_runs r join upload_files f on f.id=r.file_id where r.kind<>'inventory' and r.created_at > $1 order by r.created_at`, [previous.created_at]);
  const uniq = [...new Map(sources.map((s) => [s.href, s])).values()];
  const caveats = changes.filter((c) => c.status === 'pending').map((c) => `${c.ref}: ${c.statusText}`);
  if (latest.coverage === 'partial') caveats.push('The latest file was loaded as a partial export: items it does not list were left unchanged.');
  return {
    card: card({ type: 'changes', title: `What changed: ${latest.filename} vs ${previous.filename}`, data: { latest: meta(latest), previous: meta(previous), changes, unchangedCount: unchanged, notListed, effects, otherUploads: others.map((o) => ({ kind: o.kind, filename: o.filename, worksheet: o.worksheet, counts: o.counts, href: `/uploads/runs/${o.id}` })), gap: null }, sources: uniq, caveats }),
    modelData: { latest_file: latest.filename, latest_exported_local: fmtLocal(latest.exported_at, tz), previous_file: previous.filename, unchanged_lines: unchanged,
      changes: changes.map((c) => ({ item: c.ref, unit: c.unit, location: c.location, before: c.before, after: c.after, status: c.status, detail: c.statusText })), not_listed: notListed.map((n) => `${n.item_ref} at ${n.loc_name}`),
      effect_on_cases: effects.map((e) => ({ case: e.caseRef, item: e.ref, arithmetic: e.sentence })) },
  };
}

async function awaitingReceiptTool(db: Db, actx: AssistantCtx): Promise<ToolOutput> {
  const t = now();
  const board = await readinessBoard(db, actx, 60);
  const cases = board.cases.filter((c: any) => c.caseStatus === 'scheduled' && c.blockers.some((b: any) => b.code === 'delivered_unreceived'));
  if (!cases.length) return notice('Nothing waiting', 'No delivered shipment is waiting for a hospital check-in on cases in the next 60 hours.');
  const enriched = await enrichCases(db, actx, cases);
  const entries: any[] = []; const sources: Source[] = [];
  for (const c of enriched) {
    const bs = c.blockers.filter((b: any) => b.code === 'delivered_unreceived');
    const ev = bs.flatMap((b: any) => b.evidence).filter((e: any, i: number, a: any[]) => a.findIndex((x) => x.href === e.href && x.label === e.label) === i);
    entries.push({ caseId: c.id, caseRef: c.caseRef, facility: c.facility, startLocal: c.startLocal, tomorrow: localYmd(new Date(c.scheduledStart), c.timezone) === addDaysYmd(localYmd(t, c.timezone), 1),
      items: bs.map((b: any) => b.message), whoCanResolve: bs[0].whoCanResolve, actByLocal: bs[0].actByLocal, passed: bs[0].passed, owner: bs[0].owner, evidence: ev, lastVerified: bs[0].lastVerified });
    sources.push({ label: `Case ${c.caseRef}`, href: `/cases/${c.id}`, kind: 'case' });
    for (const e of ev) if (e.href) sources.push({ label: e.label, href: e.href, kind: e.kind });
  }
  return {
    card: card({ type: 'awaiting', title: 'Delivered, waiting for the hospital to confirm receipt', data: { entries }, sources: [...new Map(sources.map((s) => [s.href + s.label, s])).values()], caveats: ['A courier scan shows the shipment was dropped off. It is not a hospital check-in.'] }),
    modelData: { waiting: entries.map((e) => ({ case: e.caseRef, facility: e.facility, surgery_local: e.startLocal, can_confirm: e.whoCanResolve, act_by_local: e.actByLocal, courier_evidence: e.evidence.map((x: any) => `${x.label} at ${x.atLocal}`) })) },
  };
}

export const TOOLS: ToolDef[] = [
  { name: 'upload_changes', perm: 'board.view', run: uploadChangesTool,
    description: 'What changed between the latest inventory spreadsheet upload and the previous one: per item before/after, whether each difference is pending, accepted or explained by recorded movements, the source rows, and the effect on upcoming cases.',
    input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'awaiting_receipt', perm: 'board.view', run: awaitingReceiptTool,
    description: 'Cases where a courier recorded delivery but the hospital has not confirmed receipt, with who at the hospital can confirm.',
    input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'work_queue', perm: 'attention.view', run: workQueueTool,
    description: "The ranked operations work queue: what needs fixing, most urgent first (critical / high / medium), each with why it is a problem, the safest fix on record and who it is waiting on. Use for 'what do I need to fix / what needs my attention / what should I work on', optionally before a local time today.",
    input_schema: { type: 'object', additionalProperties: false, properties: { before_local_time: { type: 'string', description: "24h local time like '15:00' for 'before 3 today'; omit for everything" } } } },
  { name: 'call_list', perm: 'board.view', run: callList,
    description: "List the calls to make: open readiness issues for the user's cases on a given day whose act-by time is before a local time today. Ordered by latest time to act; past deadlines listed separately; includes the responsible person or 'Unassigned'.",
    input_schema: { type: 'object', additionalProperties: false, properties: { day: { type: 'string', enum: ['today', 'tomorrow', 'upcoming'], description: "Which cases: 'upcoming' = today's and tomorrow's" }, act_before_local_time: { type: 'string', description: "24h local time like '15:00' for 'before 3 today'; omit for no cutoff" } } } },
  { name: 'case_readiness', perm: 'board.view', run: caseReadinessTool,
    description: 'Readiness of one case: status, every blocker with owner and act-by time. Omit case_ref to use the case already in context.',
    input_schema: { type: 'object', additionalProperties: false, properties: { case_ref: { type: 'string' } } } },
  { name: 'shortage_explanation', perm: 'board.view', run: shortageTool,
    description: 'Explain why a case shows short on an item, with the exact arithmetic (on hand, reserved for other cases, on hold, available, required, short) computed by the app.',
    input_schema: { type: 'object', additionalProperties: false, properties: { case_ref: { type: 'string' }, catalog_ref: { type: 'string', description: 'Exact catalog number or GTIN; omit to use context or the short item' }, item_hint: { type: 'string', description: "The user's words for the item when no catalog number is given, e.g. 'patella buttons'" } } } },
  { name: 'find_exact_item', perm: 'board.view', run: findItemTool,
    description: "Where to get the exact item for a case before the facility's receiving cutoff: eligible sources ranked by cutoff, travel estimate, scan freshness and cost, plus why closer units were excluded. Never suggests substitutes.",
    input_schema: { type: 'object', additionalProperties: false, properties: { case_ref: { type: 'string' }, catalog_ref: { type: 'string' } } } },
  { name: 'transfer_impact', perm: 'board.view', run: impactTool,
    description: 'What-if (read-only): which other cases would be put at risk if a specific unit or tray were moved to another case.',
    input_schema: { type: 'object', additionalProperties: false, properties: { unit: { type: 'string', description: "e.g. 'Tray 14' or a serial number" }, to_case_ref: { type: 'string' }, to_case_hint: { type: 'string', description: "e.g. 'urgent case' when no case number is given" } }, required: ['unit'] } },
  { name: 'case_history', perm: 'board.view', run: historyTool,
    description: 'Recorded changes to a case since a time (audit, issue events, stock movements, custody). Reports a history gap when the app has no record for that time.',
    input_schema: { type: 'object', additionalProperties: false, properties: { case_ref: { type: 'string' }, since: { type: 'string', enum: [...SINCE] } }, required: ['since'] } },
  { name: 'draft_action', perm: 'board.view', run: draftTool,
    description: 'Create a reviewable DRAFT (never executed here): assign_followup (issue_id, assignee_name), transfer (uses the last found unit unless given), or message (to: rep|receiver|a name; about: transfer|issue). The user edits and confirms in the app.',
    input_schema: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['assign_followup', 'transfer', 'message'] }, issue_id: { type: 'string' }, assignee_name: { type: 'string' }, to: { type: 'string' }, about: { type: 'string' }, note: { type: 'string' } }, required: ['kind'] } },
];

/** Permission is enforced on every call, before the tool runs, with the signed-in user's context. */
export async function runTool(db: Db, actx: AssistantCtx, name: string, input: any, conv: ConvContext): Promise<ToolOutput> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return notice('Unknown tool', `No tool named ${name}.`);
  if (t.perm && !can(actx, t.perm)) return notice('Not permitted', `Your role cannot use ${name}.`);
  try {
    return await t.run(db, actx, input ?? {}, conv);
  } catch (e: any) {
    if (e instanceof AppError) return notice('Could not complete', e.message);
    if (e instanceof z.ZodError) return notice('Invalid request', 'The request to this tool was malformed.');
    throw e;
  }
}
