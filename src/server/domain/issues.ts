import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, isFacilityUser, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit } from '../audit.js';
import type { Blocker } from './cases.js';
import { fmtLocal } from './cases.js';

/**
 * Case issues give every readiness blocker a durable identity, a named owner, an action deadline
 * and a history. Issues are derived from records (readiness), never closed by hand: acknowledgment
 * means "I own this and I'm on it"; resolution happens only when the underlying records clear the
 * blocker (or the case is cancelled/completed). Alerts are grouped per issue and closed with it.
 */

const ROLE_LABEL: Record<string, string> = { rep: 'Rep', ops_manager: 'Ops manager', warehouse: 'Warehouse', courier: 'Courier', hospital_receiving: 'Hospital receiving', hospital_spd: 'Hospital SPD', scheduler: 'Scheduler', quality_manager: 'Quality' };

async function defaultOwner(db: Db, role: string, c: any): Promise<string | null> {
  if (role === 'rep') return c.rep_user_id;
  if (role === 'hospital_receiving' || role === 'hospital_spd') {
    return (await maybe(db, `select id from users where role=$1 and facility_id=$2 and active order by created_at limit 1`, [role, c.facility_id]))?.id ?? null;
  }
  return (await maybe(db, `select id from users where role=$1 and active and facility_id is null order by created_at limit 1`, [role]))?.id ?? null;
}

async function event(db: Db, tenantId: string, issueId: string, kind: string, actor: string | null, detail: string, data: any = {}) {
  await db.query(`insert into issue_events(tenant_id, issue_id, kind, actor_user_id, at, detail, data) values ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, issueId, kind, actor, nowIso(), detail, data]);
}

/** One grouped alert per (user, issue): repeats update it in place and bump a counter. */
export async function alertIssue(db: Db, tenantId: string, userId: string | null, issue: any, message: string, kind = 'issue') {
  if (!userId) return;
  const u = await maybe(db, `select facility_id from users where id=$1`, [userId]);
  const c = await maybe(db, `select facility_id from cases where id=$1`, [issue.case_id]);
  if (!u || (u.facility_id && u.facility_id !== c?.facility_id)) return; // facility users only hear about their own facility
  await db.query(`insert into notifications(tenant_id,user_id,case_id,facility_id,kind,message,created_at,last_at,dedupe_key,issue_id,status,repeat_count)
      values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,'active',1)
    on conflict (tenant_id,user_id,dedupe_key) do update set message=excluded.message, last_at=excluded.last_at, kind=excluded.kind, read_at=null, status='active', closed_reason=null,
      repeat_count = notifications.repeat_count + 1`,
    [tenantId, userId, issue.case_id, c?.facility_id ?? null, kind, message, nowIso(), `issue:${issue.id}`, issue.id]);
}
async function closeAlerts(db: Db, issueId: string, reason: string) {
  await db.query(`update notifications set status='closed', closed_reason=$2, last_at=$3 where issue_id=$1 and status='active'`, [issueId, reason, nowIso()]);
}

export function explain(issue: { message: string; deadlineNote?: string | null }, ownerName: string | null, actBy: string | null, tz: string) {
  const dl = actBy && !/must leave by/.test(issue.message) ? ` Act by ${fmtLocal(actBy, tz)}.` : '';
  return `${issue.message}${issue.deadlineNote ? ' ' + issue.deadlineNote : ''}${dl} ${ownerName ? `${ownerName} owns the follow-up.` : 'No owner assigned.'}`.replace(/\s+/g, ' ').trim();
}

/** Reconcile persisted issues with the current blockers for one case. Idempotent. */
export async function syncIssues(db: Db, tenantId: string, caseId: string, readiness: { status: string; blockers: Blocker[] }) {
  const c = await one(db, `select c.*, f.timezone from cases c join facilities f on f.id=c.facility_id where c.id=$1`, [caseId]);
  const existing = await rows(db, `select * from case_issues where case_id=$1`, [caseId]);
  const byKey = new Map(existing.map((i) => [i.issue_key, i]));
  const live = new Set<string>();
  const closedCase = ['cancelled', 'completed', 'closed'].includes(c.status);
  if (!closedCase) {
    for (const b of readiness.blockers) {
      if (live.has(b.key)) continue; // one issue per subject; first (most severe) blocker wins
      live.add(b.key);
      const actBy = b.actBy ?? b.requiredBy ?? null;
      const prev = byKey.get(b.key);
      const msg = `${b.message}${b.deadlineNote ? ' ' + b.deadlineNote : ''}`;
      if (!prev) {
        const owner = await defaultOwner(db, b.ownerRole, c);
        const ins = (await db.query(`insert into case_issues(tenant_id, case_id, issue_key, code, severity, message, action, link, status, owner_user_id, owner_role, act_by, required_by, created_at, updated_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13,$13) on conflict (tenant_id, case_id, issue_key) do nothing returning *`,
          [tenantId, caseId, b.key, b.code, b.severity, msg, b.action, b.link ?? null, owner, b.ownerRole, actBy, b.requiredBy ?? null, nowIso()])).rows[0];
        if (!ins) continue;
        await event(db, tenantId, ins.id, 'opened', null, `Opened: ${msg}`, { code: b.code, owner_user_id: owner });
        const ownerName = owner ? (await one(db, `select display_name from users where id=$1`, [owner])).display_name : null;
        await alertIssue(db, tenantId, owner, ins, `${c.case_ref}: ${explain({ message: b.message, deadlineNote: b.deadlineNote }, ownerName, actBy, c.timezone)}`);
        continue;
      }
      const changes: string[] = [];
      let owner = prev.owner_user_id;
      let status = prev.status;
      if (prev.status === 'resolved') { status = 'open'; changes.push('reopened'); await event(db, tenantId, prev.id, 'reopened', null, `Reopened: ${msg}`); }
      if (prev.code !== b.code) {
        changes.push(`stage changed: ${prev.code} → ${b.code}`);
        if (!prev.owner_locked || prev.owner_role !== b.ownerRole) owner = await defaultOwner(db, b.ownerRole, c);
        // A new stage needs a fresh acknowledgment.
        if (status === 'acknowledged') status = 'open';
        await event(db, tenantId, prev.id, 'updated', null, `Now: ${msg}`, { from: prev.code, to: b.code, owner_user_id: owner });
      }
      const prevAct = prev.act_by ? new Date(prev.act_by).toISOString() : null;
      if (prevAct !== actBy) {
        changes.push('deadline');
        const delta = prevAct && actBy ? Math.round((new Date(actBy).getTime() - new Date(prevAct).getTime()) / 60e3) : null;
        await event(db, tenantId, prev.id, 'deadline_changed', null, `Act-by ${prevAct ? fmtLocal(prevAct, c.timezone) : 'none'} → ${actBy ? fmtLocal(actBy, c.timezone) : 'none'}${delta ? ` (${delta < 0 ? 'earlier' : 'later'} by ${Math.abs(delta)} min)` : ''}`, { from: prevAct, to: actBy });
      }
      if (!changes.length && prev.message === msg && prev.severity === b.severity) continue;
      await db.query(`update case_issues set code=$2, severity=$3, message=$4, action=$5, link=$6, status=$7, owner_user_id=$8, owner_role=$9, owner_locked = owner_locked and owner_role=$9,
          act_by=$10, required_by=$11, updated_at=$12, resolved_at=null, resolved_by=null, resolution=null,
          escalation_level = case when $10::timestamptz > $12::timestamptz then 0 else escalation_level end where id=$1`,
        [prev.id, b.code, b.severity, msg, b.action, b.link ?? null, status, owner, b.ownerRole, actBy, b.requiredBy ?? null, nowIso()]);
      if (changes.length) {
        const ownerName = owner ? (await one(db, `select display_name from users where id=$1`, [owner])).display_name : null;
        const fresh = { ...prev, owner_user_id: owner };
        await alertIssue(db, tenantId, owner, fresh, `${c.case_ref} (${changes.join('; ')}): ${explain({ message: b.message, deadlineNote: b.deadlineNote }, ownerName, actBy, c.timezone)}`);
        if (prev.owner_user_id && prev.owner_user_id !== owner) await db.query(`update notifications set status='closed', closed_reason='Handed to the next owner' where issue_id=$1 and user_id=$2 and status='active'`, [prev.id, prev.owner_user_id]);
      }
    }
  }
  for (const prev of existing) {
    if (prev.status === 'resolved' || live.has(prev.issue_key)) continue;
    const why = closedCase ? `Case ${c.status}` : `Condition cleared by records (last state: ${prev.code.replace(/_/g, ' ')})`;
    await db.query(`update case_issues set status='resolved', resolved_at=$2, resolution=$3, updated_at=$2 where id=$1`, [prev.id, nowIso(), why]);
    await event(db, tenantId, prev.id, 'resolved', null, why);
    await closeAlerts(db, prev.id, why);
  }
}

export async function issuesForCase(db: Db, caseId: string) {
  return rows(db, `select i.*, u.display_name owner_name, a.display_name ack_name,
      (select json_agg(json_build_object('kind', e.kind, 'at', e.at, 'detail', e.detail, 'actor', eu.display_name) order by e.at desc, e.id desc) from issue_events e left join users eu on eu.id=e.actor_user_id where e.issue_id=i.id) history
    from case_issues i left join users u on u.id=i.owner_user_id left join users a on a.id=i.acknowledged_by where i.case_id=$1 order by (i.status='resolved'), i.severity, i.act_by nulls last`, [caseId]);
}

async function visibleIssue(db: Db, ctx: Ctx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'not_found', 'Issue not found');
  const i = await maybe(db, `select i.*, c.facility_id, c.case_ref, c.rep_user_id, f.timezone from case_issues i join cases c on c.id=i.case_id join facilities f on f.id=c.facility_id where i.id=$1`, [id]);
  if (!i) throw new AppError(404, 'not_found', 'Issue not found');
  if (isFacilityUser(ctx) && i.facility_id !== ctx.facilityId) throw new AppError(404, 'not_found', 'Issue not found');
  return i;
}

export async function acknowledgeIssue(db: Db, ctx: Ctx, id: string, input: { note?: string }) {
  const i = await visibleIssue(db, ctx, id);
  if (i.status === 'resolved') throw new AppError(409, 'resolved', 'Already resolved by the records; nothing to acknowledge');
  const isOwner = i.owner_user_id === ctx.userId;
  if (!isOwner && !['ops_manager', 'admin'].includes(ctx.role)) throw new AppError(403, 'not_owner', 'Only the owner or an ops manager can acknowledge');
  if (!isOwner) await db.query(`update case_issues set owner_user_id=$2, owner_locked=true where id=$1`, [id, ctx.userId]);
  await db.query(`update case_issues set status='acknowledged', acknowledged_by=$2, acknowledged_at=$3, updated_at=$3 where id=$1`, [id, ctx.userId, nowIso()]);
  await event(db, ctx.tenantId, id, 'acknowledged', ctx.userId, `${ctx.displayName} acknowledged${isOwner ? '' : ' and took ownership'}${input.note ? `: ${input.note}` : ''}. Not resolved until the records clear it.`);
  await db.query(`update notifications set read_at=$2 where issue_id=$1 and user_id=$3`, [id, nowIso(), ctx.userId]);
  await audit(db, ctx, 'issue.acknowledge', 'case_issue', id, { note: input.note }, { caseId: i.case_id });
  return { ok: true };
}

export async function assignIssue(db: Db, ctx: Ctx, id: string, input: { userId: string; note?: string }) {
  requirePerm(ctx, 'issue.assign');
  const i = await visibleIssue(db, ctx, id);
  const u = await maybe(db, `select id, display_name, facility_id from users where id=$1 and active`, [input.userId]);
  if (!u) throw new AppError(400, 'bad_user', 'Unknown user');
  if (u.facility_id && u.facility_id !== i.facility_id) throw new AppError(400, 'wrong_facility', 'That user belongs to a different facility');
  await db.query(`update case_issues set owner_user_id=$2, owner_locked=true, status=case when status='resolved' then status else 'open' end, acknowledged_by=null, acknowledged_at=null, updated_at=$3 where id=$1`, [id, u.id, nowIso()]);
  await event(db, ctx.tenantId, id, 'assigned', ctx.userId, `${ctx.displayName} assigned to ${u.display_name}${input.note ? `: ${input.note}` : ''}`, { to: u.id });
  if (i.owner_user_id && i.owner_user_id !== u.id) await db.query(`update notifications set status='closed', closed_reason='Reassigned' where issue_id=$1 and user_id=$2 and status='active'`, [id, i.owner_user_id]);
  await alertIssue(db, ctx.tenantId, u.id, i, `${i.case_ref}: assigned to you by ${ctx.displayName}. ${i.message}${i.act_by ? ` Act by ${fmtLocal(i.act_by, i.timezone)}.` : ''}`, 'issue_assigned');
  await audit(db, ctx, 'issue.assign', 'case_issue', id, { to: u.id }, { caseId: i.case_id });
  return { ok: true };
}

export async function noteIssue(db: Db, ctx: Ctx, id: string, input: { note: string }) {
  const i = await visibleIssue(db, ctx, id);
  if (!input.note?.trim()) throw new AppError(400, 'note_required', 'Write what was tried or agreed');
  await event(db, ctx.tenantId, id, 'note', ctx.userId, `${ctx.displayName}: ${input.note.trim()}`);
  await db.query(`update case_issues set updated_at=$2 where id=$1`, [id, nowIso()]);
  return { ok: true, caseId: i.case_id };
}

/** Escalate issues whose act-by time passed without resolution (worker). One escalation per deadline. */
export async function escalateOverdue(db: Db, tenantId: string) {
  const t = nowIso();
  const due = await rows(db, `select i.*, c.case_ref, f.timezone, u.display_name owner_name from case_issues i join cases c on c.id=i.case_id join facilities f on f.id=c.facility_id left join users u on u.id=i.owner_user_id
     where i.status <> 'resolved' and i.act_by is not null and i.act_by < $1 and i.escalation_level = 0 and c.status='scheduled'`, [t]);
  for (const i of due) {
    await db.query(`update case_issues set escalation_level=1, escalated_at=$2, updated_at=$2 where id=$1`, [i.id, t]);
    const msg = `ESCALATED ${i.case_ref}: act-by ${fmtLocal(i.act_by, i.timezone)} passed and the issue is still ${i.status} (owner ${i.owner_name ?? 'unassigned'}). ${i.message}`;
    await event(db, tenantId, i.id, 'escalated', null, `Missed act-by ${fmtLocal(i.act_by, i.timezone)} while ${i.status}; escalated to ops managers`);
    const opsUsers = await rows(db, `select id from users where role='ops_manager' and active`);
    for (const u of opsUsers) await alertIssue(db, tenantId, u.id, i, msg, 'issue_escalated');
    await alertIssue(db, tenantId, i.owner_user_id, i, msg, 'issue_escalated');
  }
  return due.length;
}

/** Shift handoff: what is open, who has the next move, what was tried, and what closed recently. */
export async function handoff(db: Db, ctx: Ctx, hours = 12) {
  const t = now();
  const since = new Date(t.getTime() - hours * 3600e3).toISOString();
  const fac = isFacilityUser(ctx) ? ctx.facilityId : null;
  const terr = ctx.role === 'rep' ? ctx.territoryId : null;
  const base = `from case_issues i join cases c on c.id=i.case_id join facilities f on f.id=c.facility_id left join users u on u.id=i.owner_user_id
     where $1::timestamptz is not null and ($2::uuid is null or c.facility_id=$2) and ($3::uuid is null or f.territory_id=$3 or c.rep_user_id=$4)`;
  const cols = `i.*, c.case_ref, c.scheduled_start, f.name facility, f.timezone, u.display_name owner_name,
     (select json_agg(json_build_object('kind', e.kind, 'at', e.at, 'detail', e.detail, 'actor', eu.display_name) order by e.at desc, e.id desc) from issue_events e left join users eu on eu.id=e.actor_user_id where e.issue_id=i.id) history`;
  const open = await rows(db, `select ${cols} ${base} and i.status <> 'resolved' order by i.escalation_level desc, i.act_by nulls last`, [since, fac, terr, ctx.userId]);
  const resolved = await rows(db, `select ${cols} ${base} and i.status = 'resolved' and i.resolved_at >= $1 order by i.resolved_at desc`, [since, fac, terr, ctx.userId]);
  return { generatedAt: t.toISOString(), since, open, resolved };
}

export const OWNER_ROLE_LABEL = ROLE_LABEL;
