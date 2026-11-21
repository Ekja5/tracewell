import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, requirePerm } from '../perms.js';
import { nowIso } from '../clock.js';
import { audit, notify, notifyRole, raiseException } from '../audit.js';
import { applyMovement, locationByKind } from './inventory.js';
import { fmtLocal } from './cases.js';

export async function createRecall(db: Db, ctx: Ctx, input: { manufacturerPartyId: string; catalogItemId: string; scopeType: 'lot' | 'serial'; scopeValues: string[]; noticeRef: string; description: string }) {
  requirePerm(ctx, 'recall.manage');
  const values = [...new Set((input.scopeValues ?? []).map((v) => v.trim()).filter(Boolean))];
  if (!values.length) throw new AppError(400, 'scope_required', 'Enter at least one affected lot or serial');
  if (!input.noticeRef?.trim()) throw new AppError(400, 'notice_required', "Enter the manufacturer's notice reference");
  const item = await one(db, `select * from catalog_items where id=$1`, [input.catalogItemId]);
  if (item.manufacturer_party_id !== input.manufacturerPartyId) throw new AppError(400, 'mfr_mismatch', 'Catalog item is not made by the selected manufacturer');
  const n = (await one(db, `select count(*)::int n from recalls`)).n;
  const r = (await db.query(`insert into recalls(tenant_id, ref, manufacturer_party_id, catalog_item_id, scope_type, scope_values, manufacturer_notice_ref, description, status, entered_by, entered_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10) returning *`,
    [ctx.tenantId, `RCL-${String(n + 1).padStart(3, '0')}`, input.manufacturerPartyId, input.catalogItemId, input.scopeType, values, input.noticeRef, input.description, ctx.userId, nowIso()])).rows[0];
  await audit(db, ctx, 'recall.create', 'recall', r.id, { scope: values, notice: input.noticeRef });
  return r;
}

/** Second-person verification of manufacturer, device and scope (enforced by a DB check too). */
export async function verifyRecall(db: Db, ctx: Ctx, id: string, input: { confirmScope: string[] }) {
  requirePerm(ctx, 'recall.manage');
  const r = await one(db, `select * from recalls where id=$1`, [id]);
  if (r.status !== 'draft') throw new AppError(409, 'bad_state', `Recall is ${r.status}`);
  if (r.entered_by === ctx.userId) throw new AppError(409, 'same_person', 'A different authorized user must verify the recall scope');
  const a = [...r.scope_values].sort().join('|'), b = [...new Set((input.confirmScope ?? []).map((s) => s.trim()))].sort().join('|');
  if (a !== b) throw new AppError(409, 'scope_mismatch', 'Re-entered scope does not match the draft; check the manufacturer notice');
  await db.query(`update recalls set status='verified', verified_by=$2, verified_at=$3 where id=$1`, [id, ctx.userId, nowIso()]);
  await audit(db, ctx, 'recall.verify', 'recall', id, {});
  return one(db, `select * from recalls where id=$1`, [id]);
}

export async function recallMatches(db: Db, id: string) {
  const r = await one(db, `select r.*, ci.ref, ci.description, p.name manufacturer from recalls r join catalog_items ci on ci.id=r.catalog_item_id join parties p on p.id=r.manufacturer_party_id where r.id=$1`, [id]);
  const col = r.scope_type === 'lot' ? 'lot_number' : 'serial_number';
  const stock = await rows(db, `select * from stock_items where catalog_item_id=$1 and ${col} = any($2)`, [r.catalog_item_id, r.scope_values]);
  const ids = stock.map((s) => s.id);
  const inventory = await rows(db, `select b.*, s.serial_number, s.lot_number, l.code, l.name location_name, l.kind location_kind, l.holder_user_id, l.facility_id, u.display_name holder, p.name owner
     from stock_balances b join stock_items s on s.id=b.stock_item_id join locations l on l.id=b.location_id join parties p on p.id=b.owner_party_id left join users u on u.id=l.holder_user_id
     where b.stock_item_id = any($1) and b.qty>0 and l.kind not in ('consumed','wasted')`, [ids]);
  const reservations = await rows(db, `select r.*, c.case_ref, c.scheduled_start, c.status case_status, c.rep_user_id, c.facility_id, f.name facility, f.timezone, s.serial_number, s.lot_number
     from reservations r join cases c on c.id=r.case_id join facilities f on f.id=c.facility_id join stock_items s on s.id=r.stock_item_id where r.stock_item_id = any($1) and r.status='active'`, [ids]);
  const shipments = await rows(db, `select s.ref, s.kind, s.status, sl.qty_dispatched, sl.qty_received, si.serial_number, si.lot_number from shipment_lines sl join shipments s on s.id=sl.shipment_id join stock_items si on si.id=sl.stock_item_id
     where sl.stock_item_id = any($1) and s.status in ('dispatched','delivered')`, [ids]);
  const completedUsage = await rows(db, `select ue.*, c.case_ref, c.scheduled_start, c.facility_id, f.name facility, f.timezone, s.serial_number, s.lot_number from usage_events ue join cases c on c.id=ue.case_id join facilities f on f.id=c.facility_id join stock_items s on s.id=ue.stock_item_id
     where ue.stock_item_id = any($1) and ue.status='recorded' and ue.disposition <> 'returned_sealed' order by ue.occurred_at`, [ids]);
  const byKind: Record<string, number> = {};
  for (const i of inventory) byKind[i.location_kind] = (byKind[i.location_kind] ?? 0) + i.qty;
  return { recall: r, stockItems: stock, inventory, reservations, shipments, completedUsage, summary: { unitsByLocationKind: byKind, openCaseReservations: reservations.length, inTransit: shipments.length, completedCaseReferences: [...new Set(completedUsage.map((u) => u.case_ref))] } };
}

/**
 * Activate: hold every matching unit (blocks allocation, picking and dispatch everywhere), create
 * owner tasks per location, alert open-case owners, and list completed cases separately. Prior
 * usage records are not changed.
 */
export async function activateRecall(db: Db, ctx: Ctx, id: string) {
  requirePerm(ctx, 'recall.manage');
  const r = await one(db, `select * from recalls where id=$1 for update`, [id]);
  if (r.status !== 'verified') throw new AppError(409, 'not_verified', 'Recall scope must be verified by a second user before activation');
  const m = await recallMatches(db, id);
  const at = nowIso();
  for (const s of m.stockItems) {
    await db.query(`insert into quality_holds(tenant_id, stock_item_id, recall_id, reason, status, placed_by, placed_at) values ($1,$2,$3,$4,'active',$5,$6) on conflict do nothing`,
      [ctx.tenantId, s.id, id, `${r.ref}: ${r.description}`, ctx.userId, at]);
  }
  const ops = await maybe(db, `select id from users where role='ops_manager' and active order by created_at limit 1`);
  for (const i of m.inventory) {
    const owner = i.holder_user_id ?? ops?.id ?? null;
    await db.query(`insert into recall_tasks(tenant_id, recall_id, task_type, stock_item_id, location_id, owner_user_id, qty, status, detail, created_at) values ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9)`,
      [ctx.tenantId, id, i.location_kind === 'in_transit' ? 'return_in_transit' : 'acknowledge_and_quarantine', i.stock_item_id, i.location_id, owner, i.qty,
        `${i.qty} unit(s) ${i.serial_number ? 'SN ' + i.serial_number : 'lot ' + i.lot_number} at ${i.location_name} (${i.location_kind}, owner ${i.owner}). Acknowledge, then quarantine.`, at]);
    await notify(db, ctx.tenantId, owner, { kind: 'recall', message: `${r.ref}: ${i.qty} affected unit(s) at ${i.location_name}. Acknowledge and quarantine.`, facilityId: i.facility_id, dedupe: `rcl:${id}:${i.id}` });
  }
  for (const rv of m.reservations) {
    await db.query(`insert into recall_tasks(tenant_id, recall_id, task_type, stock_item_id, case_id, owner_user_id, qty, status, detail, created_at) values ($1,$2,'open_case_alert',$3,$4,$5,$6,'open',$7,$8)`,
      [ctx.tenantId, id, rv.stock_item_id, rv.case_id, rv.rep_user_id, rv.qty, `Open case ${rv.case_ref} (${fmtLocal(rv.scheduled_start, rv.timezone)}) holds an affected unit; find an unaffected replacement.`, at]);
    await notify(db, ctx.tenantId, rv.rep_user_id, { kind: 'recall', message: `${r.ref} affects case ${rv.case_ref}: reserved unit is on hold. Find a replacement.`, caseId: rv.case_id, facilityId: rv.facility_id, dedupe: `rclcase:${id}:${rv.id}` });
  }
  for (const caseRef of m.summary.completedCaseReferences) {
    const u = m.completedUsage.find((x) => x.case_ref === caseRef)!;
    await db.query(`insert into recall_tasks(tenant_id, recall_id, task_type, case_id, qty, status, detail, created_at) values ($1,$2,'completed_case_trace',$3,$4,'open',$5,$6)`,
      [ctx.tenantId, id, u.case_id, m.completedUsage.filter((x) => x.case_ref === caseRef).reduce((a, x) => a + (x.reviewed_qty_units ?? x.qty_units ?? 0), 0),
        `Completed case ${caseRef} at ${u.facility} recorded ${u.disposition} of affected ${u.serial_number ? 'SN ' + u.serial_number : 'lot ' + u.lot_number}. Usage record preserved; follow the manufacturer notice and customer procedure.`, at]);
  }
  await db.query(`update recalls set status='active', activated_by=$2, activated_at=$3 where id=$1`, [id, ctx.userId, at]);
  await notifyRole(db, ctx.tenantId, ['ops_manager', 'warehouse'], { kind: 'recall', message: `${r.ref} active: allocation and dispatch of affected units is blocked.`, dedupe: `rclact:${id}` });
  await audit(db, ctx, 'recall.activate', 'recall', id, { holds: m.stockItems.length, inventory_rows: m.inventory.length, open_cases: m.reservations.length, completed_cases: m.summary.completedCaseReferences });
  return recallDetail(db, id);
}

export async function recallDetail(db: Db, id: string) {
  const m = await recallMatches(db, id);
  const tasks = await rows(db, `select t.*, u.display_name owner_name, l.name location_name, c.case_ref, s.serial_number, s.lot_number, au.display_name ack_name
     from recall_tasks t left join users u on u.id=t.owner_user_id left join locations l on l.id=t.location_id left join cases c on c.id=t.case_id left join stock_items s on s.id=t.stock_item_id
     left join users au on au.id=t.acknowledged_by where t.recall_id=$1 order by t.task_type, t.created_at`, [id]);
  const holds = await rows(db, `select h.*, s.serial_number, s.lot_number from quality_holds h join stock_items s on s.id=h.stock_item_id where h.recall_id=$1`, [id]);
  const outstanding = m.inventory.filter((i) => i.location_kind !== 'quarantine' && i.location_kind !== 'returns').reduce((a, i) => a + i.qty, 0);
  const quarantined = m.inventory.filter((i) => i.location_kind === 'quarantine').reduce((a, i) => a + i.qty, 0);
  return { ...m, tasks, holds, outstandingUnits: outstanding, quarantinedUnits: quarantined };
}

export async function ackRecallTask(db: Db, ctx: Ctx, taskId: string) {
  requirePerm(ctx, 'recall.task');
  const t = await one(db, `select * from recall_tasks where id=$1`, [taskId]);
  if (ctx.role !== 'quality_manager' && ctx.role !== 'admin' && t.owner_user_id !== ctx.userId) throw new AppError(403, 'not_owner', 'Only the task owner or quality can acknowledge');
  if (t.status !== 'open') throw new AppError(409, 'bad_state', `Task is ${t.status}`);
  await db.query(`update recall_tasks set status='acknowledged', acknowledged_by=$2, acknowledged_at=$3 where id=$1`, [taskId, ctx.userId, nowIso()]);
  await audit(db, ctx, 'recall.task_ack', 'recall_task', taskId, {});
  return one(db, `select * from recall_tasks where id=$1`, [taskId]);
}

export async function quarantineTask(db: Db, ctx: Ctx, taskId: string) {
  requirePerm(ctx, 'recall.task');
  const t = await one(db, `select t.*, r.ref from recall_tasks t join recalls r on r.id=t.recall_id where t.id=$1`, [taskId]);
  if (t.task_type !== 'acknowledge_and_quarantine') throw new AppError(409, 'bad_task', 'Not a quarantine task');
  if (t.status !== 'acknowledged') throw new AppError(409, 'bad_state', 'Acknowledge the task first');
  const q = await locationByKind(db, 'quarantine');
  const bals = await rows(db, `select * from stock_balances where stock_item_id=$1 and location_id=$2 and qty>0`, [t.stock_item_id, t.location_id]);
  for (const b of bals) {
    await applyMovement(db, ctx, { stockItemId: b.stock_item_id, qty: b.qty, ownerPartyId: b.owner_party_id, from: { locationId: b.location_id, condition: b.condition }, to: { locationId: q.id, condition: b.condition }, type: 'quarantine', reason: `${t.ref} quarantine`, idempotencyKey: `quarantine:${taskId}:${b.id}` });
  }
  await db.query(`update reservations set status='released', released_at=$2, release_reason=$3 where stock_item_id=$1 and status='active'`, [t.stock_item_id, nowIso(), `${t.ref}: unit quarantined`]);
  await db.query(`update recall_tasks set status='quarantined' where id=$1`, [taskId]);
  await audit(db, ctx, 'recall.quarantine', 'recall_task', taskId, { units: bals.reduce((a, b) => a + b.qty, 0) });
  return one(db, `select * from recall_tasks where id=$1`, [taskId]);
}

export async function dispositionTask(db: Db, ctx: Ctx, taskId: string, input: { disposition: string; note: string }) {
  requirePerm(ctx, 'recall.manage');
  const t = await one(db, `select t.*, r.ref from recall_tasks t join recalls r on r.id=t.recall_id where t.id=$1`, [taskId]);
  if (!input.disposition?.trim() || !input.note?.trim()) throw new AppError(400, 'required', 'Disposition and note are required');
  if (t.task_type === 'acknowledge_and_quarantine' && t.status !== 'quarantined') throw new AppError(409, 'bad_state', 'Units must be quarantined before disposition');
  if (t.task_type === 'acknowledge_and_quarantine' && /return/i.test(input.disposition)) {
    const q = await locationByKind(db, 'quarantine');
    const ret = await locationByKind(db, 'returns');
    for (const b of await rows(db, `select * from stock_balances where stock_item_id=$1 and location_id=$2 and qty>0`, [t.stock_item_id, q.id])) {
      await applyMovement(db, ctx, { stockItemId: b.stock_item_id, qty: b.qty, ownerPartyId: b.owner_party_id, from: { locationId: q.id, condition: b.condition }, to: { locationId: ret.id, condition: b.condition }, type: 'disposition', reason: `${t.ref}: ${input.disposition}`, idempotencyKey: `disp:${taskId}:${b.id}` });
    }
  }
  await db.query(`update recall_tasks set status='dispositioned', disposition=$2, dispositioned_by=$3, dispositioned_at=$4, detail=detail || $5 where id=$1`, [taskId, input.disposition, ctx.userId, nowIso(), ` | Disposition: ${input.note}`]);
  if (t.usage_event_id) await db.query(`update exceptions set status='resolved', resolved_by=$2, resolved_at=$3, resolution=$4 where ref_table='usage_events' and ref_id=$1 and kind='recall_late_usage' and status='open'`, [t.usage_event_id, ctx.userId, nowIso(), input.note]);
  await audit(db, ctx, 'recall.disposition', 'recall_task', taskId, input);
  return one(db, `select * from recall_tasks where id=$1`, [taskId]);
}

export async function closeRecall(db: Db, ctx: Ctx, id: string, input: { evidence: string }) {
  requirePerm(ctx, 'recall.manage');
  const d = await recallDetail(db, id);
  if (d.recall.status !== 'active') throw new AppError(409, 'bad_state', `Recall is ${d.recall.status}`);
  const open = d.tasks.filter((t) => !['dispositioned', 'closed'].includes(t.status));
  if (open.length) throw new AppError(409, 'open_tasks', `${open.length} task(s) are not dispositioned`);
  if (d.outstandingUnits > 0) throw new AppError(409, 'outstanding_units', `${d.outstandingUnits} affected unit(s) are still outside quarantine/returns`);
  if (!input.evidence?.trim()) throw new AppError(400, 'evidence_required', 'Closure evidence is required');
  await db.query(`update recalls set status='closed', closed_by=$2, closed_at=$3, closure_evidence=$4 where id=$1`, [id, ctx.userId, nowIso(), input.evidence]);
  await audit(db, ctx, 'recall.close', 'recall', id, { evidence: input.evidence });
  return recallDetail(db, id);
}

export async function qualityHome(db: Db, ctx: Ctx) {
  const recalls = await rows(db, `select r.*, ci.ref, ci.description, (select count(*)::int from recall_tasks t where t.recall_id=r.id and t.status='open') open_tasks,
     (select count(*)::int from recall_tasks t where t.recall_id=r.id and t.status='open' and t.acknowledged_at is null) unacked from recalls r join catalog_items ci on ci.id=r.catalog_item_id order by r.entered_at desc`);
  const holds = await rows(db, `select h.*, s.serial_number, s.lot_number, ci.ref, r.ref recall_ref from quality_holds h join stock_items s on s.id=h.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id left join recalls r on r.id=h.recall_id where h.status='active' order by h.placed_at desc`);
  const myTasks = await rows(db, `select t.*, r.ref, l.name location_name, c.case_ref from recall_tasks t join recalls r on r.id=t.recall_id left join locations l on l.id=t.location_id left join cases c on c.id=t.case_id
     where t.status in ('open','acknowledged','quarantined') and (t.owner_user_id=$1 or $2) order by t.created_at`, [ctx.userId, ['quality_manager', 'admin'].includes(ctx.role)]);
  return { recalls, holds, tasks: myTasks };
}
