/**
 * Entering a case on screen (with an immediate stock check under the account's allocation rule), marking a
 * case urgent, and the demand plan: scheduled demand week by week against usable stock.
 */
import { AppError, Db, maybe, one, rows } from '../db.js';
import { can, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit, notify, notifyRole } from '../audit.js';
import { fmtLocal } from '../domain/cases.js';
import { reserve } from '../domain/inventory.js';
import { addDaysYmd, localYmd, zoned } from '../time.js';
import type { AssistantCtx } from '../assistant/types.js';
import { allocationView } from './queue.js';
import { getSettings, RULE_LABEL } from './settings.js';

export interface CaseEntry { facilityId: string; date: string; time: string; procedure: string; surgeon: string; repUserId?: string | null; urgent?: boolean; caseRef?: string; previousId?: string; items: { catalogItemId: string; qty: number }[] }

export async function entryOptions(db: Db) {
  return { hospitals: await rows(db, `select id, name, timezone from facilities where kind='hospital' order by name`), reps: await rows(db, `select id, display_name from users where role='rep' and active order by display_name`),
    items: await rows(db, `select ci.id, ci.ref, ci.description, ci.item_type, p.name manufacturer from catalog_items ci left join parties p on p.id=ci.manufacturer_party_id where ci.item_type <> 'instrument' order by ci.ref`),
    procedures: (await rows(db, `select procedure, count(*)::int n from cases group by 1 order by n desc limit 12`)).map((r) => r.procedure), rule: RULE_LABEL[(await getSettings(db)).allocationRule] };
}

/**
 * Create the case and its requirements, then give it whatever free stock the allocation rule allows.
 * `preview` runs exactly the same steps and rolls them back, so the answer shown before saving is the real one.
 */
export async function enterCase(db: Db, actx: AssistantCtx, input: CaseEntry, mode: 'preview' | 'commit') {
  requirePerm(actx, 'case.enter');
  const fac = await maybe(db, `select * from facilities where id=$1 and kind='hospital'`, [input.facilityId]);
  if (!fac) throw new AppError(400, 'facility_required', 'Choose the hospital');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') || !/^\d{2}:\d{2}$/.test(input.time ?? '')) throw new AppError(400, 'when_required', 'Enter the surgery date and start time');
  const start = zoned(input.date, input.time, fac.timezone);
  if (start < now()) throw new AppError(400, 'past', `That start time has already passed at ${fac.name}`);
  const procedure = String(input.procedure ?? '').trim(); const surgeon = String(input.surgeon ?? '').trim();
  if (!procedure) throw new AppError(400, 'procedure_required', 'Enter the procedure');
  if (!surgeon) throw new AppError(400, 'surgeon_required', 'Enter the surgeon code (not a patient identifier)');
  const rep = input.repUserId ? await maybe(db, `select id, display_name from users where id=$1 and role='rep' and active`, [input.repUserId]) : null;
  if (input.repUserId && !rep) throw new AppError(400, 'bad_rep', 'That rep is not active');
  const lines = new Map<string, number>();
  for (const l of input.items ?? []) { const n = Number(l.qty); if (!l.catalogItemId) continue; if (!Number.isInteger(n) || n < 1 || n > 99) throw new AppError(400, 'bad_qty', 'Each quantity must be a whole number from 1 to 99'); lines.set(l.catalogItemId, (lines.get(l.catalogItemId) ?? 0) + n); }
  if (!lines.size) throw new AppError(400, 'items_required', 'Add at least one required item');
  let ref = String(input.caseRef ?? '').trim();
  if (ref && await maybe(db, `select 1 from cases where lower(case_ref)=lower($1)`, [ref])) throw new AppError(409, 'duplicate_ref', `Case ${ref} already exists`);
  if (!ref) { const n = (await one(db, `select coalesce(max(substring(case_ref from '[0-9]+$')::int), 4000) n from cases where case_ref ~ '^[A-Z]+-[0-9]+$'`)).n; const prefix = (await maybe(db, `select substring(case_ref from '^[A-Z]+') p from cases where case_ref ~ '^[A-Z]+-[0-9]+$' order by created_at desc limit 1`))?.p ?? 'CASE'; ref = `${prefix}-${n + 1}`; }

  await db.query('savepoint enter_case');
  const c = (await db.query(`insert into cases(tenant_id, case_ref, facility_id, procedure, surgeon_ref, scheduled_start, status, urgent, rep_user_id, created_by, created_at) values ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8,$9,$10) returning *`,
    [actx.tenantId, ref, fac.id, procedure, surgeon, start.toISOString(), !!input.urgent, rep?.id ?? null, actx.userId, nowIso()])).rows[0];
  for (const [item, qty] of lines) {
    if (!(await maybe(db, `select 1 from catalog_items where id=$1`, [item]))) throw new AppError(400, 'bad_item', 'One of the items is not in the catalog');
    await db.query(`insert into case_requirements(tenant_id, case_id, catalog_item_id, qty, mandatory) values ($1,$2,$3,$4,true)`, [actx.tenantId, c.id, item, qty]);
  }
  // The rule decides: stock goes to cases ahead of this one first; this case gets what is left.
  const v = await allocationView(db, actx, { until: new Date(start.getTime() + 3600e3) });
  const result: any[] = [];
  for (const [item, qty] of lines) {
    const it = v.items.find((x: any) => x.lines.some((l: any) => l.caseId === c.id && x.catalogItemId === item)) ?? v.items.find((x: any) => x.lines.some((l: any) => l.caseId === c.id) && x.ref === (v.items.find((y: any) => y.catalogItemId === item)?.ref));
    const mine = it?.lines.find((l: any) => l.caseId === c.id);
    const ci = await one(db, `select ref, description from catalog_items where id=$1`, [item]);
    let reserved = 0;
    for (const p of mine?.picks ?? []) { await reserve(db, actx, { caseId: c.id, requirementId: mine.requirementId, stockItemId: p.stockItemId, locationId: p.locationId, ownerPartyId: p.ownerPartyId, qty: p.qty }); reserved += p.qty; }
    const ahead = (it?.lines ?? []).filter((l: any) => l.caseId !== c.id && l.order < (mine?.order ?? 1e9) && l.required - l.reserved > 0).map((l: any) => ({ caseRef: l.caseRef, whenLocal: l.whenLocal, takes: l.wouldGet, uncovered: l.uncovered }));
    result.push({ ref: ci.ref, description: ci.description, required: qty, reserved, short: qty - reserved, freeBefore: it?.freeStock ?? 0, aheadOfThis: ahead,
      message: qty - reserved === 0 ? `Covered: ${reserved} reserved from free stock.` : `${reserved ? `${reserved} reserved; ` : ''}${qty - reserved} not covered.${ahead.length ? ` Cases ahead of this one under the rule also need it: ${ahead.map((a: any) => a.caseRef).join(', ')}.` : ' No free stock in the warehouse or at this hospital.'} It will appear in Needs attention with the options (transfer, a later case, loaner).` });
  }
  const summary = { caseId: c.id, caseRef: ref, facility: fac.name, startLocal: fmtLocal(start, fac.timezone), rule: v.ruleLabel, covered: result.every((r) => r.short === 0), items: result, preview: mode === 'preview' };
  if (mode === 'preview') { await db.query('rollback to savepoint enter_case'); return summary; }
  await db.query('release savepoint enter_case');
  if (input.previousId?.trim()) await db.query(`insert into external_refs(tenant_id, entity_type, entity_id, system, external_id) values ($1,'case',$2,'Previous system',$3) on conflict do nothing`, [actx.tenantId, c.id, input.previousId.trim()]);
  await audit(db, actx, input.urgent ? 'case.create_urgent' : 'case.create', 'case', c.id, { case_ref: ref, scheduled_start: c.scheduled_start, entered_on_screen: true, coverage: result.map((r) => ({ ref: r.ref, reserved: r.reserved, short: r.short })) }, { caseId: c.id });
  if (rep) await notify(db, actx.tenantId, rep.id, { kind: 'case_assigned', message: `${input.urgent ? 'URGENT ' : ''}Case ${ref} assigned at ${fac.name}, ${summary.startLocal}`, caseId: c.id, facilityId: fac.id, dedupe: `assign:${c.id}` });
  if (input.urgent) await notifyRole(db, actx.tenantId, ['ops_manager', 'warehouse'], { kind: 'urgent_case', message: `Urgent case ${ref} at ${fac.name}, ${summary.startLocal}`, caseId: c.id, facilityId: fac.id, dedupe: `urgent:${c.id}` });
  return summary;
}

/** A person's call that a case jumps the line. Raises its items one level in the queue; says who and why. */
export async function setUrgent(db: Db, actx: AssistantCtx, caseId: string, input: { urgent: boolean; reason: string }) {
  if (!can(actx, 'case.manage') && !can(actx, 'case.enter')) requirePerm(actx, 'case.manage');
  const c = await maybe(db, `select c.*, f.name facility from cases c join facilities f on f.id=c.facility_id where c.id=$1`, [caseId]);
  if (!c) throw new AppError(404, 'not_found', 'Case not found');
  if (c.status !== 'scheduled') throw new AppError(409, 'bad_state', `Case ${c.case_ref} is ${c.status}`);
  if (!input.reason?.trim()) throw new AppError(400, 'reason_required', 'Say why (it is shown to the team)');
  await db.query(`update cases set urgent=$2, version=version+1 where id=$1`, [caseId, !!input.urgent]);
  await audit(db, actx, input.urgent ? 'case.mark_urgent' : 'case.clear_urgent', 'case', caseId, {}, { caseId, reason: input.reason.trim() });
  if (input.urgent) { await notify(db, actx.tenantId, c.rep_user_id, { kind: 'urgent_case', message: `${c.case_ref} at ${c.facility} was marked urgent by ${actx.displayName}: ${input.reason.trim()}`, caseId, facilityId: c.facility_id, dedupe: `urgent:${caseId}:${nowIso()}` }); }
  return { caseRef: c.case_ref, urgent: !!input.urgent };
}

/** Scheduled demand week by week against usable stock. Known cases only; the recent average is shown beside it for comparison. */
export async function demandPlan(db: Db, actx: AssistantCtx, opts: { weeks?: number } = {}) {
  requirePerm(actx, 'inventory.view');
  const W = Math.min(8, Math.max(2, Number(opts.weeks) || 4)); const t = now(); const tz = actx.tenantTz;
  const today = localYmd(t, tz); const dow = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7; const monday = addDaysYmd(today, -dow);
  const weekOf = (ymd: string) => Math.floor((new Date(ymd + 'T12:00:00Z').getTime() - new Date(monday + 'T12:00:00Z').getTime()) / (7 * 86400e3));
  const end = addDaysYmd(monday, W * 7);
  const dem = await rows(db, `select cr.catalog_item_id, cr.qty, c.id case_id, c.case_ref, (c.scheduled_start at time zone f.timezone)::date::text d,
      coalesce((select sum(r.qty) from reservations r where r.requirement_id=cr.id and r.status='active'),0)::int reserved
    from case_requirements cr join cases c on c.id=cr.case_id join facilities f on f.id=c.facility_id where cr.active and cr.mandatory and c.status='scheduled' and c.scheduled_start > $1 and (c.scheduled_start at time zone f.timezone)::date < $2::date`, [t.toISOString(), end]);
  const items = await rows(db, `select ci.id, ci.ref, ci.description,
      coalesce((select sum(b.qty) from stock_balances b join stock_items st on st.id=b.stock_item_id join locations l on l.id=b.location_id where st.catalog_item_id=ci.id and b.qty>0 and b.condition='sealed' and l.kind in ('warehouse','trunk','consignment','hospital_receiving')
         and not exists (select 1 from quality_holds h where h.stock_item_id=b.stock_item_id and h.status='active') and (st.expiry_date is null or st.expiry_date >= $1::date)),0)::int usable,
      coalesce((select sum(p.par_qty) from par_levels p where p.catalog_item_id=ci.id),0)::int par,
      coalesce((select sum(rp.qty) from replenishments rp where rp.catalog_item_id=ci.id and rp.action='replace' and rp.status='open'),0)::int owed,
      coalesce((select sum(coalesce(ue.reviewed_qty_units, ue.qty_units)) from usage_events ue where ue.catalog_item_id=ci.id and ue.status='recorded' and ue.disposition <> 'returned_sealed' and ue.occurred_at >= $2),0)::int used30
    from catalog_items ci where ci.item_type not in ('instrument','tray') order by ci.ref`, [today, new Date(t.getTime() - 30 * 86400e3).toISOString()]);
  const weeks = Array.from({ length: W }, (_, i) => ({ index: i, start: addDaysYmd(monday, i * 7), label: i === 0 ? 'This week' : i === 1 ? 'Next week' : `Week of ${addDaysYmd(monday, i * 7).slice(5)}` }));
  const out = items.map((it) => {
    const per = weeks.map(() => ({ demand: 0, cases: [] as string[] }));
    for (const d of dem.filter((x) => x.catalog_item_id === it.id)) { const w = weekOf(d.d); if (w >= 0 && w < W) { per[w].demand += d.qty; per[w].cases.push(d.case_ref); } }
    let bal = it.usable; let shortWeek: string | null = null;
    const cols = per.map((p, i) => { bal -= p.demand; if (bal < 0 && !shortWeek) shortWeek = weeks[i].label; return { demand: p.demand, cases: p.cases, balance: bal }; });
    const total = per.reduce((a, p) => a + p.demand, 0); const avg = Math.round((it.used30 / (30 / 7)) * 10) / 10;
    const toPar = Math.max(0, it.par - cols[W - 1].balance);
    return { catalogItemId: it.id, ref: it.ref, description: it.description, usable: it.usable, par: it.par, owed: it.owed, recentPerWeek: avg, scheduled: total, weeks: cols, endBalance: cols[W - 1].balance, shortWeek, orderToPar: it.par ? toPar : null,
      vsAverage: avg > 0 && total / W < avg * 0.5 ? 'The schedule so far is well below the recent average; more cases are likely still to be booked.' : null,
      suggestion: shortWeek ? `Runs out ${String(shortWeek).toLowerCase()}: ${-cols[W - 1].balance} short by the end of the plan${it.owed ? `; ${it.owed} replacement unit(s) already owed would cover ${Math.min(it.owed, -cols[W - 1].balance)}` : ''}.` : it.par && toPar > 0 ? `Enough for the scheduled cases. To be back at par afterwards, bring in ${toPar}${it.owed ? ` (${it.owed} already owed)` : ''}.` : 'Enough for the scheduled cases.' };
  }).filter((r) => r.usable > 0 || r.scheduled > 0 || r.par > 0).sort((a, b) => Number(!!b.shortWeek) - Number(!!a.shortWeek) || a.endBalance - b.endBalance || a.ref.localeCompare(b.ref));
  return { asOfLocal: fmtLocal(t, tz), weeks, items: out, short: out.filter((r) => r.shortWeek).length,
    note: 'Built from cases already on the schedule: usable stock minus what each week\'s cases require. Cases not yet booked are not in it; the recent weekly average is shown beside each item so you can judge how much more to expect. This is arithmetic on the schedule, not a statistical forecast.' };
}
