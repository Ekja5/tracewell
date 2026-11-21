/**
 * Reviewable action drafts. A draft records WHAT would happen and WHAT IT WAS BASED ON. Nothing is
 * executed until the user confirms; confirmation re-runs the regular application services, which
 * recheck permissions, availability, reservations, holds and the facility cutoff. Outbound messages
 * remain drafts (copy-to-clipboard) in this pilot.
 */
import { AppError, Db, maybe, one, rows } from '../db.js';
import { can, requirePerm } from '../perms.js';
import { nowIso } from '../clock.js';
import { audit } from '../audit.js';
import { fmtLocal } from '../domain/cases.js';
import { previewTransfer, reserveAndTransfer, rescueSearch } from '../domain/rescue.js';
import { assignIssue } from '../domain/issues.js';
import type { AssistantCtx, Card, ConvContext } from './types.js';

function draftCard(d: any, extra: Partial<Card> = {}): Card {
  const title = d.kind === 'transfer' ? `Draft transfer: ${d.payload.unitLabel} → ${d.payload.caseRef}` : d.kind === 'message' ? `Draft message to ${d.payload.to.name}` : `Draft assignment: ${d.payload.caseRef}`;
  return { type: 'draft', title, checkedAt: nowIso(), data: { id: d.id, kind: d.kind, status: d.status, payload: d.payload, result: d.result ?? null }, sources: d.payload.caseId ? [{ label: `Case ${d.payload.caseRef}`, href: `/cases/${d.payload.caseId}`, kind: 'case' }] : [], caveats: [], ...extra };
}

async function insertDraft(db: Db, actx: AssistantCtx, kind: string, payload: any, basis: any, conversationId: string | null) {
  const t = nowIso();
  return (await db.query(`insert into assistant_drafts(tenant_id, created_by, conversation_id, kind, status, payload, basis, case_id, created_at, updated_at) values ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$8) returning *`,
    [actx.tenantId, actx.userId, conversationId, kind, payload, basis, payload.caseId ?? null, t])).rows[0];
}

async function findUserByName(db: Db, name: string) {
  const n = name.trim().toLowerCase();
  return rows(db, `select id, display_name, role, facility_id, email from users where active and (lower(display_name) = $1 or lower(split_part(display_name, ' ', 1)) = $1)`, [n]);
}

/** Message text is composed from records, not invented. The user can edit it before copying. */
async function composeMessage(db: Db, actx: AssistantCtx, about: any, to: { name: string }) {
  if (about?.kind === 'transfer') {
    const p = about.payload;
    return `Hi ${to.name.split(' ')[0]}, please send ${p.ref} ${p.unitLabel} from ${p.sourceLabel} to ${p.destination} for case ${p.caseRef} (surgery ${p.startLocal}). It must be received by ${p.requiredByLocal}.${p.shipmentRef ? ` Transfer ${p.shipmentRef}.` : ' Transfer pending approval.'} Thanks, ${actx.displayName}`;
  }
  if (about?.issueText) return `Hi ${to.name.split(' ')[0]}, for case ${about.caseRef}: ${about.issueText} Can you take this and confirm in Tracewell? Thanks, ${actx.displayName}`;
  return `Hi ${to.name.split(' ')[0]}, ${actx.displayName} here about case ${about?.caseRef ?? ''}.`;
}

export async function createDraft(db: Db, actx: AssistantCtx, kind: string, input: any, conv: ConvContext, conversationId: string | null = null) {
  if (kind === 'transfer') {
    requirePerm(actx, 'rescue.reserve');
    const caseId = input.caseId ?? conv.caseId; const requirementId = input.requirementId ?? conv.requirementId;
    const src = input.stockItemId ? input : conv.lastEligible;
    if (!caseId || !requirementId || !src?.stockItemId) throw new AppError(400, 'no_source', 'Find an eligible unit first ("where can I get one more?"), then ask for the transfer draft.');
    const p = await previewTransfer(db, actx, caseId, requirementId, { stockItemId: src.stockItemId, locationId: src.locationId, ownerPartyId: src.ownerPartyId });
    const c = await one(db, `select c.case_ref, c.scheduled_start, f.timezone, f.name facility_name from cases c join facilities f on f.id=c.facility_id where c.id=$1`, [caseId]);
    const ref = (await one(db, `select ci.ref, p.name manufacturer from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id left join parties p on p.id=ci.manufacturer_party_id where cr.id=$1`, [requirementId]));
    const holder = await maybe(db, `select u.id, u.display_name from locations l join users u on u.id=l.holder_user_id where l.id=$1`, [src.locationId]);
    const payload = { caseId, caseRef: c.case_ref, requirementId, ref: ref.ref, manufacturer: ref.manufacturer, qty: 1, stockItemId: src.stockItemId, locationId: src.locationId, ownerPartyId: src.ownerPartyId,
      unitLabel: p.candidate.label, sourceLabel: `${p.source.name}${holder ? ` (custodian ${holder.display_name})` : ''}`, custodianUserId: holder?.id ?? null, custodianName: holder?.display_name ?? null,
      destination: `${c.facility_name} receiving`, startLocal: fmtLocal(c.scheduled_start, c.timezone), requiredByLocal: fmtLocal(p.requiredBy, c.timezone),
      arrivalLocal: fmtLocal(p.candidate.estimatedArrival, c.timezone), meetsCutoff: p.candidate.meetsCutoff, travelMinutes: p.candidate.travelMinutes, affectedCases: p.affectedCases, note: input.note ?? '' };
    const d = await insertDraft(db, actx, 'transfer', payload, { available: p.candidate.available, reserved: p.candidate.reserved, checkedAt: nowIso() }, conversationId);
    const out: any = { card: draftCard(d, { caveats: ['Travel time is a seeded estimate.', 'Nothing is reserved or shipped until you confirm. Availability is rechecked at confirmation.'] }), summary: `${payload.unitLabel} from ${payload.sourceLabel} to ${payload.destination} for ${payload.caseRef}` };
    // "...and give me a text I can send Maria": a message draft about this transfer.
    if (input.to || input.alsoMessageTo) {
      const m = await createDraft(db, actx, 'message', { to: input.to ?? input.alsoMessageTo, aboutDraftId: d.id }, { ...conv, caseId }, conversationId);
      out.extra = m;
    }
    return out;
  }
  if (kind === 'message') {
    const about: any = input.aboutDraftId ? await one(db, `select * from assistant_drafts where id=$1 and created_by=$2`, [input.aboutDraftId, actx.userId])
      : conv.lastEligible && conv.caseId && input.about === 'transfer' ? null : null;
    const caseId = about?.payload?.caseId ?? input.caseId ?? conv.caseId ?? null;
    const c = caseId ? await maybe(db, `select id, case_ref, rep_user_id, facility_id from cases where id=$1`, [caseId]) : null;
    let toName = String(input.to ?? '').trim();
    let toUser: any = null; let warning: string | null = null;
    if (/^rep$/i.test(toName) || (!toName && about?.payload?.custodianUserId)) toUser = await maybe(db, `select id, display_name, role from users where id=$1`, [about?.payload?.custodianUserId ?? c?.rep_user_id]);
    else if (/receiv/i.test(toName) && c) toUser = await maybe(db, `select id, display_name, role from users where role='hospital_receiving' and facility_id=$1 and active order by created_at limit 1`, [c.facility_id]);
    else if (toName) {
      const m = await findUserByName(db, toName);
      if (m.length === 1) toUser = m[0];
      else warning = m.length > 1 ? `More than one user is named ${toName}; pick the recipient before copying.` : `No Tracewell user is named ${toName}; the draft is addressed as written. Check the phone number yourself.`;
    }
    const to = toUser ? { userId: toUser.id, name: toUser.display_name, role: toUser.role } : { userId: null, name: toName || 'recipient', role: null };
    const issue = input.issueId ? await maybe(db, `select i.message, c.case_ref from case_issues i join cases c on c.id=i.case_id where i.id=$1`, [input.issueId]) : null;
    const text = await composeMessage(db, actx, about ? { kind: about.kind, payload: about.payload } : issue ? { issueText: issue.message, caseRef: issue.case_ref } : { caseRef: c?.case_ref }, to);
    const payload = { to, channel: 'text', text, caseId, caseRef: c?.case_ref ?? about?.payload?.caseRef ?? null, aboutDraftId: about?.id ?? null, sendStatus: 'not sent: drafts only in this pilot' };
    const d = await insertDraft(db, actx, 'message', payload, {}, conversationId);
    return { card: draftCard(d, { caveats: [warning ?? '', 'Messages are drafts only: copy the text and send it yourself.'].filter(Boolean) }), summary: `Message to ${to.name}` };
  }
  if (kind === 'assign_followup') {
    requirePerm(actx, 'issue.assign');
    const issueId = input.issueId ?? input.issue_id ?? conv.lastCallList?.find((e: any) => e.owner === 'Unassigned')?.issueId;
    if (!issueId) throw new AppError(400, 'no_issue', 'Which issue should be assigned?');
    const i = await one(db, `select i.*, c.case_ref, c.rep_user_id, c.facility_id from case_issues i join cases c on c.id=i.case_id where i.id=$1`, [issueId]);
    let assignee: any = null; let warning: string | null = null;
    if (input.assignee_name || input.assigneeName) {
      const m = await findUserByName(db, input.assignee_name ?? input.assigneeName);
      if (m.length === 1) assignee = m[0]; else warning = m.length ? 'Several people match; choose below.' : `No user named ${input.assignee_name ?? input.assigneeName}; choose below.`;
    } else if (input.assigneeUserId) assignee = await maybe(db, `select id, display_name, role from users where id=$1`, [input.assigneeUserId]);
    else assignee = i.owner_role === 'rep' ? await maybe(db, `select id, display_name, role from users where id=$1`, [i.rep_user_id])
      : await maybe(db, `select id, display_name, role from users where role=$1 and active and (facility_id is null or facility_id=$2) order by created_at limit 1`, [i.owner_role, i.facility_id]);
    const choices = await rows(db, `select id, display_name, role from users where active and (facility_id is null or facility_id=$1) and role in ('ops_manager','warehouse','rep','scheduler','hospital_receiving','hospital_spd','courier') order by role, display_name`, [i.facility_id]);
    const payload = { issueId, caseId: i.case_id, caseRef: i.case_ref, issueText: i.message, assigneeUserId: assignee?.id ?? null, assigneeName: assignee?.display_name ?? null, note: input.note ?? '', choices };
    const d = await insertDraft(db, actx, 'assign_followup', payload, { issueStatus: i.status, ownerAtDraft: i.owner_user_id }, conversationId);
    return { card: draftCard(d, { caveats: [warning ?? '', 'Assignment is applied only when you confirm.'].filter(Boolean) }), summary: `Assign ${i.case_ref} issue to ${assignee?.display_name ?? '(choose)'}` };
  }
  throw new AppError(400, 'bad_kind', 'Unknown draft kind');
}

async function ownDraft(db: Db, actx: AssistantCtx, id: string, lock = false) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'not_found', 'Draft not found');
  const d = await maybe(db, `select * from assistant_drafts where id=$1 ${lock ? 'for update' : ''}`, [id]);
  if (!d || d.created_by !== actx.userId) throw new AppError(404, 'not_found', 'Draft not found');
  return d;
}

export async function getDraft(db: Db, actx: AssistantCtx, id: string) { return draftCard(await ownDraft(db, actx, id)); }

/** Edits allowed before confirmation: message text/recipient, assignee/note, transfer note or source. */
export async function updateDraft(db: Db, actx: AssistantCtx, id: string, edits: any) {
  const d = await ownDraft(db, actx, id, true);
  if (d.status !== 'draft') throw new AppError(409, 'not_draft', `Draft is ${d.status}`);
  const p = { ...d.payload };
  if (d.kind === 'message') { if (typeof edits.text === 'string') p.text = edits.text.slice(0, 2000); if (typeof edits.toName === 'string') p.to = { ...p.to, name: edits.toName }; }
  if (d.kind === 'assign_followup') {
    if (edits.assigneeUserId) { const u = await one(db, `select id, display_name from users where id=$1 and active`, [edits.assigneeUserId]); p.assigneeUserId = u.id; p.assigneeName = u.display_name; }
    if (typeof edits.note === 'string') p.note = edits.note.slice(0, 500);
  }
  if (d.kind === 'transfer') {
    if (typeof edits.note === 'string') p.note = edits.note.slice(0, 500);
    if (edits.source) {
      const pv = await previewTransfer(db, actx, p.caseId, p.requirementId, edits.source);
      Object.assign(p, { stockItemId: edits.source.stockItemId, locationId: edits.source.locationId, ownerPartyId: edits.source.ownerPartyId, unitLabel: pv.candidate.label, sourceLabel: pv.source.name, arrivalLocal: pv.candidate.estimatedArrival, meetsCutoff: pv.candidate.meetsCutoff, affectedCases: pv.affectedCases });
    }
  }
  await db.query(`update assistant_drafts set payload=$2, updated_at=$3 where id=$1`, [id, p, nowIso()]);
  return getDraft(db, actx, id);
}

export async function discardDraft(db: Db, actx: AssistantCtx, id: string) {
  const d = await ownDraft(db, actx, id, true);
  if (d.status === 'draft') await db.query(`update assistant_drafts set status='discarded', updated_at=$2 where id=$1`, [id, nowIso()]);
  return getDraft(db, actx, id);
}

/**
 * Execute a confirmed draft through the existing service. The draft row is locked, so a double tap
 * waits for the first confirmation and then returns its result (exactly one transfer). If anything
 * changed since the draft (unit reserved by someone else, hold, cutoff), nothing is written and the
 * user is told what changed, with refreshed options.
 */
export async function confirmDraft(db: Db, actx: AssistantCtx, id: string) {
  const d = await ownDraft(db, actx, id, true);
  if (d.status === 'confirmed') return { ...draftCard(d), replayed: true };
  if (d.status !== 'draft') return { ...draftCard(d), replayed: true };
  const p = d.payload;
  const stale = async (whatChanged: string, refresh: any[] = []) => {
    const result = { whatChanged, refreshOptions: refresh, checkedAt: nowIso() };
    await db.query(`update assistant_drafts set status='stale', result=$2, updated_at=$3 where id=$1`, [id, result, nowIso()]);
    await audit(db, actx, 'assistant.draft_stale', 'assistant_draft', id, result, { caseId: d.case_id });
    return { ...draftCard({ ...d, status: 'stale', result }), replayed: false };
  };
  if (d.kind === 'transfer') {
    if (!can(actx, 'rescue.reserve')) throw new AppError(403, 'forbidden', 'Your role cannot reserve stock');
    const options = async () => { try { const s = await rescueSearch(db, actx, p.caseId, p.requirementId); return s.eligible.filter((e: any) => e.stockItemId !== p.stockItemId).slice(0, 3).map((e: any) => ({ label: e.label, location: e.location, meetsCutoff: e.meetsCutoff, travelMinutes: e.travelMinutes, stockItemId: e.stockItemId, locationId: e.locationId, ownerPartyId: e.ownerPartyId })); } catch { return []; } };
    let pv: any;
    try { pv = await previewTransfer(db, actx, p.caseId, p.requirementId, { stockItemId: p.stockItemId, locationId: p.locationId, ownerPartyId: p.ownerPartyId }); }
    catch (e: any) {
      if (!(e instanceof AppError)) throw e;
      const holder = await maybe(db, `select c.case_ref, u.display_name, r.created_at, f.timezone from reservations r join cases c on c.id=r.case_id join users u on u.id=r.created_by join facilities f on f.id=c.facility_id where r.stock_item_id=$1 and r.status='active' order by r.created_at desc limit 1`, [p.stockItemId]);
      return stale(`Since this draft was created, ${p.unitLabel} is no longer eligible: ${e.message}${holder ? ` (${holder.display_name} reserved it for ${holder.case_ref} at ${fmtLocal(holder.created_at, holder.timezone)})` : ''}. No stock was moved.`, await options());
    }
    if (!pv.candidate.meetsCutoff) return stale(`${p.unitLabel} would now arrive ${fmtLocal(pv.candidate.estimatedArrival, 'America/Chicago')} (estimate), after the facility cutoff ${p.requiredByLocal}. No stock was moved.`, await options());
    try {
      const r = await reserveAndTransfer(db, actx, p.caseId, p.requirementId, { stockItemId: p.stockItemId, locationId: p.locationId, ownerPartyId: p.ownerPartyId, idempotencyKey: `draft:${id}` });
      const result = { shipmentId: r.shipment?.id ?? null, shipmentRef: r.shipment?.ref ?? null, reservationId: r.reservation?.id ?? null, checkedAt: nowIso() };
      await db.query(`update assistant_drafts set status='confirmed', result=$2, confirmed_by=$3, confirmed_at=$4, updated_at=$4, payload = payload || jsonb_build_object('shipmentRef', $5::text) where id=$1`, [id, result, actx.userId, nowIso(), result.shipmentRef]);
      await audit(db, actx, 'assistant.draft_confirmed', 'assistant_draft', id, { kind: 'transfer', ...result, note: p.note }, { caseId: p.caseId });
      return { ...draftCard({ ...d, status: 'confirmed', result }), replayed: false };
    } catch (e: any) {
      if (!(e instanceof AppError) || e.status !== 409) throw e;
      return stale(`${e.message} No stock was moved.`, e.details?.nextEligible ?? await options());
    }
  }
  if (d.kind === 'assign_followup') {
    if (!p.assigneeUserId) throw new AppError(400, 'assignee_required', 'Choose who should own this follow-up');
    const i = await maybe(db, `select status, resolved_at, resolution from case_issues where id=$1`, [p.issueId]);
    if (!i) throw new AppError(404, 'not_found', 'Issue not found');
    if (i.status === 'resolved') return stale(`The issue was resolved by the records (${i.resolution}) after this draft was created. Nothing to assign.`);
    await assignIssue(db, actx, p.issueId, { userId: p.assigneeUserId, note: p.note || 'Assigned from Ask operations' });
    const result = { assignedTo: p.assigneeName, checkedAt: nowIso() };
    await db.query(`update assistant_drafts set status='confirmed', result=$2, confirmed_by=$3, confirmed_at=$4, updated_at=$4 where id=$1`, [id, result, actx.userId, nowIso()]);
    await audit(db, actx, 'assistant.draft_confirmed', 'assistant_draft', id, { kind: 'assign_followup', ...result }, { caseId: p.caseId });
    return { ...draftCard({ ...d, status: 'confirmed', result }), replayed: false };
  }
  throw new AppError(409, 'not_executable', 'Messages are drafts only in this pilot: copy the text and send it yourself.');
}
