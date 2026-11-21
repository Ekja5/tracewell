/**
 * Reconciliation of spreadsheet-vs-system differences. A discrepancy records what was OBSERVED;
 * its cause stays open until a coordinator decides, with a note. Accepting the file's number posts
 * one ledger adjustment linked to the discrepancy; keeping the system's number posts nothing.
 * Decisions are append-only.
 */
import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit } from '../audit.js';
import { applyMovement } from '../domain/inventory.js';

export const CAUSES: Record<string, string> = {
  receipt: 'Stock received but not recorded', transfer: 'Transferred to or from another location', use: 'Used in a case and not recorded',
  loss: 'Lost or damaged', correction: 'Counting or data-entry error', unknown: 'Cause not known',
};

export async function listDiscrepancies(db: Db, ctx: Ctx) {
  requirePerm(ctx, 'upload.view');
  const list = await rows(db, `select sd.*, ci.id catalog_item_id, ci.ref item_ref, ci.description, p.name manufacturer, s.lot_number, s.serial_number, l.name loc_name,
      o.exported_at, ur.row_number, r.id run_id, r.worksheet, f.filename, f.uploaded_at, o.previous_observation_id,
      (select coalesce(sum(b.qty),0)::int from stock_balances b where b.stock_item_id=sd.stock_item_id and b.location_id=sd.location_id and b.condition='sealed') system_now,
      (select coalesce(sum(x.qty),0)::int from reservations x where x.stock_item_id=sd.stock_item_id and x.location_id=sd.location_id and x.status='active') reserved_now
    from stock_discrepancies sd join stock_items s on s.id=sd.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id left join parties p on p.id=ci.manufacturer_party_id join locations l on l.id=sd.location_id
      join upload_runs r on r.id=sd.run_id join upload_files f on f.id=r.file_id left join balance_observations o on o.id=sd.observation_id left join upload_rows ur on ur.id=o.row_id
    order by (sd.status='open') desc, sd.opened_at desc limit 200`);
  const t = now();
  for (const d of list) {
    d.exported_at = d.exported_at ?? (await one(db, `select exported_at from upload_runs where id=$1`, [d.run_id])).exported_at;
    d.source = d.row_number ? { label: `${d.filename} › ${d.worksheet} › row ${d.row_number}`, href: `/uploads/runs/${d.run_id}?row=${d.row_number}` } : { label: `${d.filename} › ${d.worksheet} (not listed in this file)`, href: `/uploads/runs/${d.run_id}` };
    d.previous = null; d.movementsBetween = []; d.unexplained = null;
    if (d.previous_observation_id) {
      const p = await one(db, `select o.observed_qty, o.exported_at, ur.row_number, r.id run_id, r.worksheet, f.filename from balance_observations o join upload_rows ur on ur.id=o.row_id join upload_runs r on r.id=o.run_id join upload_files f on f.id=r.file_id where o.id=$1`, [d.previous_observation_id]);
      d.previous = { qty: p.observed_qty, exportedAt: p.exported_at, label: `${p.filename} › ${p.worksheet} › row ${p.row_number}`, href: `/uploads/runs/${p.run_id}?row=${p.row_number}` };
      // Recorded evidence between the two exports: movements in or out of this exact unit and location.
      d.movementsBetween = await rows(db, `select m.movement_type, m.qty, m.occurred_at, m.reason, (m.to_location_id=$2) inbound, u.display_name actor from inventory_movements m join users u on u.id=m.actor_user_id
         where m.stock_item_id=$1 and (m.to_location_id=$2 or m.from_location_id=$2) and m.occurred_at > $3 and m.occurred_at <= $4 and m.movement_type<>'opening_balance' order by m.occurred_at`, [d.stock_item_id, d.location_id, p.exported_at, d.exported_at]);
      const net = d.movementsBetween.reduce((a: number, m: any) => a + (m.inbound ? m.qty : -m.qty), 0);
      d.observedChange = d.observed_qty - p.observed_qty; d.explainedByMovements = net; d.unexplained = d.observedChange - net;
    }
    d.difference = d.observed_qty - d.ledger_qty;
    d.affectedCases = await rows(db, `select c.id, c.case_ref, c.scheduled_start, f.timezone, cr.qty from case_requirements cr join cases c on c.id=cr.case_id join facilities f on f.id=c.facility_id
       where cr.catalog_item_id=$1 and cr.active and c.status='scheduled' and c.scheduled_start between $2 and $3 order by c.scheduled_start`, [d.catalog_item_id, new Date(t.getTime() - 6 * 3600e3).toISOString(), new Date(t.getTime() + 7 * 86400e3).toISOString()]);
    d.decisions = await rows(db, `select dd.*, u.display_name by_name from discrepancy_decisions dd join users u on u.id=dd.decided_by where dd.discrepancy_id=$1 order by dd.decided_at, dd.id`, [d.id]);
  }
  return { causes: CAUSES, open: list.filter((d) => d.status === 'open'), closed: list.filter((d) => d.status !== 'open') };
}

export async function decide(db: Db, ctx: Ctx, id: string, input: { decision: 'accept_observed' | 'keep_system' | 'note'; cause?: string; note?: string; evidenceRef?: string }) {
  requirePerm(ctx, 'reconcile.decide');
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new AppError(404, 'not_found', 'Discrepancy not found');
  const d = await maybe(db, `select sd.*, ci.ref item_ref, s.lot_number, s.serial_number, l.name loc_name from stock_discrepancies sd join stock_items s on s.id=sd.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join locations l on l.id=sd.location_id where sd.id=$1 for update of sd`, [id]);
  if (!d) throw new AppError(404, 'not_found', 'Discrepancy not found');
  const note = String(input.note ?? '').trim();
  if (note.length < 3) throw new AppError(400, 'note_required', 'Write a short note saying what you checked; it becomes part of the record');
  const ins = async (decision: string, cause: string | null, before: number | null, after: number | null, movementId: number | null) =>
    db.query(`insert into discrepancy_decisions(tenant_id, discrepancy_id, decision, cause, note, evidence_ref, qty_before, qty_after, movement_id, decided_by, decided_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ctx.tenantId, id, decision, cause, note.slice(0, 1000), input.evidenceRef?.slice(0, 300) || null, before, after, movementId, ctx.userId, nowIso()]);
  if (input.decision === 'note') { await ins('note', null, null, null, null); return { status: d.status }; }
  if (d.status !== 'open') throw new AppError(409, 'not_open', d.status === 'superseded' ? `${d.ref} was replaced by a newer file; reconcile the newer difference instead.` : `${d.ref} was already resolved.`);
  if (!input.cause || !CAUSES[input.cause]) throw new AppError(400, 'cause_required', 'Choose the cause, or "Cause not known"');
  if (!['accept_observed', 'keep_system'].includes(input.decision)) throw new AppError(400, 'bad_decision', 'Choose to accept the file quantity or keep the system quantity');
  const bal = await one(db, `select coalesce(sum(qty),0)::int qty from stock_balances where stock_item_id=$1 and location_id=$2 and owner_party_id=$3 and condition='sealed'`, [d.stock_item_id, d.location_id, d.owner_party_id]);
  const label = `${d.item_ref} ${d.serial_number ? 'SN ' + d.serial_number : 'lot ' + d.lot_number} at ${d.loc_name}`;
  let movementId: number | null = null; let after = bal.qty; let rowMsg: string;
  if (input.decision === 'accept_observed') {
    const delta = d.observed_qty - bal.qty;
    if (delta < 0) {
      const res = await rows(db, `select c.case_ref, r.qty from reservations r join cases c on c.id=r.case_id where r.stock_item_id=$1 and r.location_id=$2 and r.status='active' order by c.scheduled_start`, [d.stock_item_id, d.location_id]);
      const reserved = res.reduce((a, r) => a + r.qty, 0);
      if (d.observed_qty < reserved) throw new AppError(409, 'reserved_exceeds', `${reserved} unit(s) of ${label} are reserved (${res.map((r) => `${r.qty} for ${r.case_ref}`).join(', ')}), more than the ${d.observed_qty} in the file. Release or move those reservations first so no case is left pointing at stock that is not there.`);
    }
    if (delta !== 0) {
      const mv = await applyMovement(db, ctx, { stockItemId: d.stock_item_id, qty: Math.abs(delta), ownerPartyId: d.owner_party_id,
        from: delta < 0 ? { locationId: d.location_id, condition: 'sealed' } : null, to: delta > 0 ? { locationId: d.location_id, condition: 'sealed' } : null,
        type: 'adjustment', reason: `Reconciliation ${d.ref}: accepted spreadsheet quantity ${d.observed_qty} (system had ${bal.qty}). Cause: ${CAUSES[input.cause]}. ${note}`, stockDiscrepancyId: id, idempotencyKey: `stockdisc:${id}` });
      movementId = mv.id;
    }
    after = d.observed_qty;
    rowMsg = `Reconciled ${d.ref} by ${ctx.displayName}: ${d.observed_qty} accepted as the current balance for ${label} (system had ${bal.qty}). Cause: ${CAUSES[input.cause]}.`;
  } else rowMsg = `Reconciled ${d.ref} by ${ctx.displayName}: system quantity ${bal.qty} kept for ${label}; the file's ${d.observed_qty} was not applied. Reason: ${CAUSES[input.cause]}.`;
  await ins(input.decision, input.cause, bal.qty, after, movementId);
  await db.query(`update stock_discrepancies set status='resolved', cause=$2, resolved_at=$3 where id=$1`, [id, input.cause, nowIso()]);
  if (d.observation_id) await db.query(`update upload_rows set outcome=$2, reason_code='reconciled', message=$3, updated_at=$4 where id=(select row_id from balance_observations where id=$1)`, [d.observation_id, input.decision === 'accept_observed' ? 'accepted' : 'skipped', rowMsg, nowIso()]);
  const counts = Object.fromEntries((await rows(db, `select outcome, count(*)::int n from upload_rows where run_id=$1 and reason_code is distinct from 'blank' group by 1`, [d.run_id])).map((x) => [x.outcome, x.n]));
  await db.query(`update upload_runs set counts=$2 where id=$1`, [d.run_id, counts]);
  await audit(db, ctx, 'reconcile.decide', 'stock_discrepancy', id, { ref: d.ref, decision: input.decision, cause: input.cause, qty_before: bal.qty, qty_after: after, movement_id: movementId }, { reason: note });
  return { status: 'resolved', ref: d.ref, qtyBefore: bal.qty, qtyAfter: after, movementId };
}
