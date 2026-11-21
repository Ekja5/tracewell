import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit, raiseException } from '../audit.js';
import { getVisibleCase, fmtLocal } from './cases.js';
import { csvCell } from './imports.js';
import { localDate } from './inventory.js';

/**
 * Derive a draft charge and, independently, a replenishment action for one recorded usage event
 * from the versioned customer contract in effect on the case date. Idempotent per usage event.
 */
export async function deriveCharge(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, usageEventId: string) {
  const existing = await maybe(db, `select * from charges where usage_event_id=$1`, [usageEventId]);
  if (existing) return existing;
  const u = await one(db, `select ue.*, c.facility_id, c.scheduled_start, c.case_ref, f.timezone, ci.ref, ci.description from usage_events ue join cases c on c.id=ue.case_id join facilities f on f.id=c.facility_id
     left join catalog_items ci on ci.id=ue.catalog_item_id where ue.id=$1`, [usageEventId]);
  const caseDate = localDate(new Date(u.scheduled_start), u.timezone);
  const cv = await maybe(db, `select cv.*, k.name contract_name from contract_versions cv join contracts k on k.id=cv.contract_id where k.facility_id=$1 and cv.effective_from <= $2 and (cv.effective_to is null or cv.effective_to >= $2) order by cv.version desc limit 1`, [u.facility_id, caseDate]);
  let status: string; let rationale: string; let rule: any = null; let price: any = null;
  if (!cv) {
    status = 'exception'; rationale = `No customer contract in effect at this facility on ${caseDate}.`;
  } else {
    rule = await maybe(db, `select * from contract_rules where contract_version_id=$1 and disposition=$2`, [cv.id, u.disposition]);
    if (!rule) { status = 'exception'; rationale = `${cv.contract_name} v${cv.version} has no rule for disposition "${u.disposition}".`; }
    else if (rule.charge_action === 'no_charge') { status = 'no_charge'; rationale = `${cv.contract_name} v${cv.version}: ${rule.rule_text}`; }
    else if (rule.charge_action === 'review') { status = 'review'; rationale = `${cv.contract_name} v${cv.version}: ${rule.rule_text} Finance review required before billing.`; }
    else {
      price = await maybe(db, `select * from contract_prices where contract_version_id=$1 and catalog_item_id=$2`, [cv.id, u.catalog_item_id]);
      if (!price) { status = 'exception'; rationale = `${cv.contract_name} v${cv.version} has no price for ${u.ref}. Missing price is a finance exception; nothing was guessed.`; }
      else { status = 'draft'; rationale = `${cv.contract_name} v${cv.version}: ${rule.rule_text} Price $${(price.unit_price_cents / 100).toFixed(2)} effective ${price.price_date}.`; }
    }
  }
  const units = u.reviewed_qty_units ?? u.qty_units;
  const amount = price ? price.unit_price_cents * units : status === 'no_charge' ? 0 : null;
  const charge = (await db.query(`insert into charges(tenant_id, case_id, usage_event_id, catalog_item_id, contract_version_id, rule_id, qty, unit_price_cents, amount_cents, price_date, status, rationale, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (usage_event_id) do nothing returning *`,
    [ctx.tenantId, u.case_id, usageEventId, u.catalog_item_id, cv?.id ?? null, rule?.id ?? null, units, price?.unit_price_cents ?? null, amount, price?.price_date ?? null, status, rationale, nowIso()])).rows[0]
    ?? (await one(db, `select * from charges where usage_event_id=$1`, [usageEventId]));
  if (!(await maybe(db, `select 1 from charge_events where charge_id=$1 and kind='derived'`, [charge.id]))) {
    await db.query(`insert into charge_events(tenant_id, charge_id, kind, to_status, to_price_cents, amount_cents, reason, actor_user_id, at) values ($1,$2,'derived',$3,$4,$5,$6,$7,$8)`,
      [ctx.tenantId, charge.id, charge.status, charge.unit_price_cents, charge.amount_cents, rationale, ctx.userId, nowIso()]);
  }
  const repl = rule?.replenish_action ?? 'review';
  await db.query(`insert into replenishments(tenant_id, case_id, usage_event_id, catalog_item_id, qty, action, status, rationale, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (usage_event_id) do nothing`,
    [ctx.tenantId, u.case_id, usageEventId, u.catalog_item_id, units, repl, repl === 'replace' ? 'open' : repl === 'none' ? 'not_required' : 'review',
      rule ? `${rule.billing_mode === 'bill_and_replace' ? 'Bill and replace' : 'Bill only'}: replenishment "${repl}" for ${u.disposition.replace('_', ' ')}` : 'No contract rule; replenishment needs review', nowIso()]);
  if (status === 'exception' || status === 'review') {
    await raiseException(db, ctx.tenantId, { kind: status === 'exception' ? 'finance_exception' : 'finance_review', severity: status === 'exception' ? 'critical' : 'warning', title: `${u.case_ref}: ${status === 'exception' ? 'charge cannot be priced' : 'charge needs review'}`, detail: rationale, caseId: u.case_id, refTable: 'charges', refId: charge.id, ownerRole: 'finance', dedupe: `charge:${charge.id}` });
  }
  return charge;
}

async function chargeEvent(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, chargeId: string, e: { kind: string; from?: string | null; to?: string | null; fromPrice?: number | null; toPrice?: number | null; amount?: number | null; reason?: string | null; approvedBy?: string | null }) {
  await db.query(`insert into charge_events(tenant_id, charge_id, kind, from_status, to_status, from_price_cents, to_price_cents, amount_cents, reason, actor_user_id, approved_by, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [ctx.tenantId, chargeId, e.kind, e.from ?? null, e.to ?? null, e.fromPrice ?? null, e.toPrice ?? null, e.amount ?? null, e.reason ?? null, ctx.userId, e.approvedBy ?? null, nowIso()]);
}

/** Finance resolves a held line from the line itself. Every price change is kept as history with its approver. */
export async function resolveCharge(db: Db, ctx: Ctx, chargeId: string, input: { decision: 'charge' | 'no_charge'; unitPriceCents?: number; reason: string }) {
  requirePerm(ctx, 'finance.manage');
  const ch = await one(db, `select * from charges where id=$1 for update`, [chargeId]);
  if (!['review', 'exception'].includes(ch.status)) throw new AppError(409, 'not_open', `Charge is ${ch.status}`);
  if (ch.packet_id) throw new AppError(409, 'in_packet', 'Charge is already on a packet; issue a credit instead');
  if (!input.reason?.trim()) throw new AppError(400, 'reason_required', 'A reason is required');
  if (input.decision === 'charge') {
    let price = input.unitPriceCents ?? ch.unit_price_cents;
    let priceDate = nowIso().slice(0, 10);
    if (price == null) {
      const p = ch.contract_version_id ? await maybe(db, `select * from contract_prices where contract_version_id=$1 and catalog_item_id=$2`, [ch.contract_version_id, ch.catalog_item_id]) : null;
      if (!p) throw new AppError(400, 'price_required', 'No contract price exists; enter the agreed unit price');
      price = p.unit_price_cents; priceDate = p.price_date;
    }
    if (!Number.isInteger(price) || price! < 0) throw new AppError(400, 'bad_price', 'Unit price must be whole cents');
    await db.query(`update charges set status='draft', unit_price_cents=$2, amount_cents=$2*qty, price_date=coalesce(price_date,$3::date), rationale=rationale || $4 where id=$1`,
      [chargeId, price, priceDate, ` Finance decision by ${ctx.displayName}: chargeable at $${(price! / 100).toFixed(2)} (${input.reason}).`]);
    await chargeEvent(db, ctx, chargeId, { kind: 'price_set', from: ch.status, to: 'draft', fromPrice: ch.unit_price_cents, toPrice: price, amount: price! * ch.qty, reason: input.reason, approvedBy: ctx.userId });
  } else {
    await db.query(`update charges set status='no_charge', amount_cents=0, rationale=rationale || $2 where id=$1`, [chargeId, ` Finance decision by ${ctx.displayName}: no charge (${input.reason}).`]);
    await chargeEvent(db, ctx, chargeId, { kind: 'resolved_no_charge', from: ch.status, to: 'no_charge', fromPrice: ch.unit_price_cents, amount: 0, reason: input.reason, approvedBy: ctx.userId });
  }
  await db.query(`update exceptions set status='resolved', resolved_by=$2, resolved_at=$3, resolution=$4 where ref_table='charges' and ref_id=$1 and status='open'`, [chargeId, ctx.userId, nowIso(), input.reason]);
  await audit(db, ctx, 'charge.resolve', 'charge', chargeId, input, { caseId: ch.case_id, reason: input.reason });
  return one(db, `select * from charges where id=$1`, [chargeId]);
}

export async function assignCharge(db: Db, ctx: Ctx, chargeId: string, input: { userId: string }) {
  requirePerm(ctx, 'finance.manage');
  const u = await one(db, `select id, display_name from users where id=$1 and role in ('finance','admin') and active`, [input.userId]);
  await db.query(`update charges set owner_user_id=$2 where id=$1`, [chargeId, u.id]);
  await chargeEvent(db, ctx, chargeId, { kind: 'assigned', reason: `Assigned to ${u.display_name}` });
  return { ok: true };
}

/** PO quantities are applied to packet lines in order; coverage is valued at the lower of PO and contract price. */
function applyPos(charges: any[], poLines: any[]) {
  const byItem = new Map<string, { qty: number; price: number }>();
  for (const l of poLines) {
    const cur = byItem.get(l.catalog_item_id) ?? { qty: 0, price: l.unit_price_cents };
    byItem.set(l.catalog_item_id, { qty: cur.qty + l.qty, price: l.unit_price_cents });
  }
  for (const ch of charges) {
    ch.po_covered_qty = 0; ch.po_covered_cents = 0; ch.po_price_cents = null;
    if (!ch.packet_id || ch.status !== 'draft') continue;
    const po = byItem.get(ch.catalog_item_id);
    if (!po) continue;
    const q = Math.min(po.qty, ch.qty);
    po.qty -= q;
    ch.po_covered_qty = q; ch.po_price_cents = po.price;
    ch.po_covered_cents = q * Math.min(po.price, ch.unit_price_cents ?? 0);
  }
  return byItem; // remaining (over-ordered) quantities
}

export async function caseFinancials(db: Db, caseId: string) {
  const all = await rows(db, `select ch.*, ci.ref, ci.description, ue.disposition, ue.client_event_id, ue.raw_scan, ue.recorded_offline, ue.occurred_at usage_at, si.serial_number, si.lot_number, cv.version contract_version, k.name contract_name, cr.rule_text, cr.billing_mode,
      coalesce((select sum(amount_cents) from credits cd where cd.charge_id=ch.id),0)::int credited_cents, rp.action replenish_action, rp.status replenish_status, ou.display_name owner_name,
      (select json_agg(json_build_object('kind', e.kind, 'at', e.at, 'from', e.from_price_cents, 'to', e.to_price_cents, 'status', e.to_status, 'reason', e.reason, 'by', eu.display_name, 'approved_by', au.display_name) order by e.at, e.id)
         from charge_events e left join users eu on eu.id=e.actor_user_id left join users au on au.id=e.approved_by where e.charge_id=ch.id) history
    from charges ch join usage_events ue on ue.id=ch.usage_event_id left join catalog_items ci on ci.id=ch.catalog_item_id left join stock_items si on si.id=ue.stock_item_id
    left join contract_versions cv on cv.id=ch.contract_version_id left join contracts k on k.id=cv.contract_id left join contract_rules cr on cr.id=ch.rule_id
    left join replenishments rp on rp.usage_event_id=ue.id left join users ou on ou.id=ch.owner_user_id where ch.case_id=$1 order by ch.created_at`, [caseId]);
  const charges = all.filter((c) => c.status !== 'void');
  const voided = all.filter((c) => c.status === 'void');
  const credits = await rows(db, `select cd.*, u.display_name by_name, ch.catalog_item_id from credits cd join charges ch on ch.id=cd.charge_id join users u on u.id=cd.created_by where ch.case_id=$1 order by cd.created_at`, [caseId]);
  const packets = await rows(db, `select * from billing_packets where case_id=$1 order by created_at`, [caseId]);
  const pos = await rows(db, `select po.*, (select json_agg(json_build_object('catalog_item_id', l.catalog_item_id, 'qty', l.qty, 'unit_price_cents', l.unit_price_cents)) from purchase_order_lines l where l.po_id=po.id) lines
     from purchase_orders po join billing_packets bp on bp.id=po.packet_id where bp.case_id=$1 order by po.entered_at`, [caseId]);
  applyPos(charges, pos.flatMap((p) => p.lines ?? []));
  for (const ch of charges) ch.outstanding_cents = ch.status === 'draft' ? Math.max(0, (ch.amount_cents ?? 0) - ch.credited_cents - ch.po_covered_cents) : null;
  const gross = charges.reduce((a, c) => a + (c.status === 'draft' ? c.amount_cents ?? 0 : 0), 0);
  const credited = credits.reduce((a, c) => a + c.amount_cents, 0);
  const covered = charges.reduce((a, c) => a + (c.po_covered_cents ?? 0), 0);
  const recorded = await one(db, `select count(*)::int n from usage_events where case_id=$1 and status='recorded'`, [caseId]);
  const lastPacket = packets.filter((p) => p.status !== 'void').slice(-1)[0];
  const stages = {
    usageRecorded: { done: recorded.n > 0, lines: recorded.n },
    packetPrepared: { done: !!lastPacket, at: lastPacket?.created_at ?? null },
    packetSent: { done: !!lastPacket?.sent_at, at: lastPacket?.sent_at ?? null, simulated: true },
    poReceived: { done: pos.length > 0, full: !!lastPacket && ['po_matched', 'accepted'].includes(lastPacket.status), partial: lastPacket?.status === 'po_partial', coveredCents: covered },
    disputed: { done: packets.some((p) => p.status === 'disputed'), issues: pos.filter((p) => p.match_status === 'mismatch').flatMap((p) => p.match_detail?.issues ?? []) },
    credited: { done: credited > 0, cents: credited },
    accepted: { done: packets.some((p) => p.status === 'accepted') },
  };
  return { charges, voided, credits, packets, purchaseOrders: pos, grossCents: gross, creditedCents: credited, netCents: gross - credited, poCoveredCents: covered,
    outstandingCents: Math.max(0, gross - credited - covered), unpricedLines: charges.filter((c) => c.status === 'review' || c.status === 'exception').length, stages };
}

export async function generatePacket(db: Db, ctx: Ctx, caseId: string) {
  requirePerm(ctx, 'finance.manage');
  const c = await getVisibleCase(db, ctx, caseId);
  if (!['completed', 'closed'].includes(c.status)) throw new AppError(409, 'case_not_completed', 'Case closeout has not been submitted');
  const charges = await rows(db, `select ch.*, cr.billing_mode from charges ch left join contract_rules cr on cr.id=ch.rule_id where ch.case_id=$1 and ch.status <> 'void'`, [caseId]);
  const blocking = charges.filter((ch) => ch.status === 'review' || ch.status === 'exception');
  if (blocking.length) throw new AppError(409, 'finance_exceptions', `${blocking.length} charge(s) need finance review or have exceptions: ${blocking.map((b) => b.rationale).join(' | ')}`);
  const unpacketed = charges.filter((ch) => ch.status === 'draft' && !ch.packet_id);
  const type = charges.some((ch) => ch.status === 'draft' && ch.billing_mode === 'bill_and_replace') ? 'bill_and_replace' : 'bill_only';
  const draft = await maybe(db, `select * from billing_packets where case_id=$1 and status='draft' order by created_at desc limit 1`, [caseId]);
  if (draft) {
    // Idempotent: the open draft absorbs any new lines; no second packet is created.
    for (const ch of unpacketed) { await db.query(`update charges set packet_id=$2 where id=$1`, [ch.id, draft.id]); await chargeEvent(db, ctx, ch.id, { kind: 'packeted', reason: `Added to draft packet ${draft.id.slice(0, 8)}` }); }
    return { packet: draft, replayed: true, added: unpacketed.length };
  }
  if (!unpacketed.length) throw new AppError(409, 'nothing_billable', 'No unbilled priced charges on this case');
  const prior = await maybe(db, `select id from billing_packets where case_id=$1 and status <> 'void' limit 1`, [caseId]);
  const p = (await db.query(`insert into billing_packets(tenant_id, case_id, packet_type, status, created_by, created_at) values ($1,$2,$3,'draft',$4,$5) returning *`, [ctx.tenantId, caseId, type, ctx.userId, nowIso()])).rows[0];
  for (const ch of unpacketed) { await db.query(`update charges set packet_id=$2 where id=$1`, [ch.id, p.id]); await chargeEvent(db, ctx, ch.id, { kind: 'packeted', reason: `${prior ? 'Supplemental packet' : 'Packet'} ${p.id.slice(0, 8)}` }); }
  await audit(db, ctx, 'packet.generate', 'billing_packet', p.id, { type, lines: unpacketed.length, supplemental: !!prior }, { caseId });
  return { packet: p, replayed: false, supplemental: !!prior };
}

export async function queuePacketToErp(db: Db, ctx: Ctx, packetId: string) {
  requirePerm(ctx, 'finance.manage');
  const p = await one(db, `select bp.*, c.case_ref from billing_packets bp join cases c on c.id=bp.case_id where bp.id=$1`, [packetId]);
  await getVisibleCase(db, ctx, p.case_id);
  if (p.status !== 'draft') return { packet: p, replayed: true };
  const fin = await caseFinancials(db, p.case_id);
  const lines = fin.charges.filter((c) => c.packet_id === p.id);
  const payload = { packet_id: p.id, case_ref: p.case_ref, packet_type: p.packet_type, lines: lines.map((c) => ({ ref: c.ref, qty: c.qty, unit_price_cents: c.unit_price_cents, amount_cents: c.amount_cents, serial: c.serial_number, lot: c.lot_number })), net_cents: lines.reduce((a, c) => a + c.amount_cents - c.credited_cents, 0) };
  await db.query(`insert into outbox(tenant_id, feed_code, topic, aggregate_id, payload, idempotency_key, status, next_attempt_at, created_at) values ($1,'erp-mock','billing_packet.created',$2,$3,$4,'pending',$5,$5) on conflict (tenant_id, idempotency_key) do nothing`,
    [ctx.tenantId, p.id, payload, `packet:${p.id}`, nowIso()]);
  await db.query(`update billing_packets set status='queued_to_erp', sent_at=$2 where id=$1`, [packetId, nowIso()]);
  await audit(db, ctx, 'packet.queue_erp', 'billing_packet', packetId, {}, { caseId: p.case_id });
  return { packet: await one(db, `select * from billing_packets where id=$1`, [packetId]), replayed: false };
}

/**
 * Record a customer PO. Several POs may cover one packet (partial then remainder). A line missing from
 * a PO is "outstanding", not a dispute; a price or quantity that exceeds what was billed is a dispute.
 */
export async function enterPO(db: Db, ctx: Ctx, packetId: string, input: { poNumber: string; lines: { catalogItemId: string; qty: number; unitPriceCents: number }[] }) {
  requirePerm(ctx, 'finance.manage');
  const p = await one(db, `select * from billing_packets where id=$1 for update`, [packetId]);
  await getVisibleCase(db, ctx, p.case_id);
  if (!input.poNumber?.trim()) throw new AppError(400, 'po_required', 'PO number is required');
  if (['draft', 'void', 'accepted'].includes(p.status)) throw new AppError(409, 'bad_state', p.status === 'draft' ? 'Send the packet before recording a PO' : `Packet is ${p.status}`);
  const dupe = await maybe(db, `select po.*, bp.case_id from purchase_orders po join billing_packets bp on bp.id=po.packet_id where po.po_number=$1`, [input.poNumber]);
  if (dupe) throw new AppError(409, 'duplicate_po', `PO ${input.poNumber} is already recorded${dupe.packet_id === packetId ? ' on this packet' : ' on another packet'}`);
  const billed = await rows(db, `select ch.catalog_item_id, ci.ref, sum(ch.qty)::int qty, max(ch.unit_price_cents) unit_price_cents from charges ch join catalog_items ci on ci.id=ch.catalog_item_id where ch.packet_id=$1 and ch.status='draft' group by 1,2`, [packetId]);
  const prior = await rows(db, `select l.* from purchase_order_lines l join purchase_orders po on po.id=l.po_id where po.packet_id=$1`, [packetId]);
  const issues: string[] = [];
  const outstanding: string[] = [];
  for (const l of input.lines) {
    const b = billed.find((x) => x.catalog_item_id === l.catalogItemId);
    if (!b) { issues.push('PO line for an item not on the packet'); continue; }
    if (l.unitPriceCents !== b.unit_price_cents) issues.push(`${b.ref}: PO price $${(l.unitPriceCents / 100).toFixed(2)} vs contract $${(b.unit_price_cents / 100).toFixed(2)}`);
  }
  for (const b of billed) {
    const total = [...prior, ...input.lines.map((l) => ({ catalog_item_id: l.catalogItemId, qty: l.qty }))].filter((l) => l.catalog_item_id === b.catalog_item_id).reduce((a, l) => a + l.qty, 0);
    if (total > b.qty) issues.push(`${b.ref}: POs total ${total} but ${b.qty} billed`);
    else if (total < b.qty) outstanding.push(`${b.ref}: ${b.qty - total} of ${b.qty} not yet on a PO`);
  }
  const status = issues.length ? 'mismatch' : outstanding.length ? 'partial' : 'matched';
  const po = (await db.query(`insert into purchase_orders(tenant_id, packet_id, po_number, entered_by, entered_at, match_status, match_detail) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [ctx.tenantId, packetId, input.poNumber, ctx.userId, nowIso(), status, { issues, outstanding }])).rows[0];
  for (const l of input.lines) await db.query(`insert into purchase_order_lines(tenant_id, po_id, catalog_item_id, qty, unit_price_cents) values ($1,$2,$3,$4,$5)`, [ctx.tenantId, po.id, l.catalogItemId, l.qty, l.unitPriceCents]);
  const anyMismatch = status === 'mismatch' || (await one(db, `select count(*)::int n from purchase_orders where packet_id=$1 and match_status='mismatch'`, [packetId])).n > 0;
  await db.query(`update billing_packets set status=$2 where id=$1 and status not in ('accepted','void')`, [packetId, anyMismatch ? 'disputed' : outstanding.length ? 'po_partial' : 'po_matched']);
  const charges = await rows(db, `select id, catalog_item_id from charges where packet_id=$1 and status='draft'`, [packetId]);
  for (const ch of charges) if (input.lines.some((l) => l.catalogItemId === ch.catalog_item_id)) await chargeEvent(db, ctx, ch.id, { kind: 'po_applied', reason: `PO ${input.poNumber} (${status})` });
  if (issues.length) await raiseException(db, ctx.tenantId, { kind: 'po_mismatch', severity: 'warning', title: `PO ${input.poNumber} does not match packet`, detail: issues.join('; '), caseId: p.case_id, refTable: 'billing_packets', refId: packetId, ownerRole: 'finance', dedupe: `po:${po.id}` });
  await audit(db, ctx, 'po.enter', 'purchase_order', po.id, { status, issues, outstanding }, { caseId: p.case_id });
  return { po, issues, outstanding, status };
}

/** Credits correct money only. They never create an inventory movement. */
export async function issueCredit(db: Db, ctx: Ctx, chargeId: string, input: { amountCents: number; reason: string; idempotencyKey: string }) {
  requirePerm(ctx, 'finance.manage');
  if (!input.idempotencyKey) throw new AppError(400, 'idempotency_required', 'idempotencyKey required');
  const ex = await maybe(db, `select * from credits where idempotency_key=$1`, [input.idempotencyKey]);
  if (ex) return { credit: ex, replayed: true };
  const ch = await one(db, `select * from charges where id=$1 for update`, [chargeId]);
  await getVisibleCase(db, ctx, ch.case_id);
  if (ch.status !== 'draft') throw new AppError(409, 'not_billed', 'Only priced charges can be credited');
  const credited = (await one(db, `select coalesce(sum(amount_cents),0)::int n from credits where charge_id=$1`, [chargeId])).n;
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > ch.amount_cents - credited) throw new AppError(400, 'bad_amount', `Credit must be between $0.01 and $${((ch.amount_cents - credited) / 100).toFixed(2)}`);
  if (!input.reason?.trim()) throw new AppError(400, 'reason_required', 'Reason is required');
  const c = (await db.query(`insert into credits(tenant_id, charge_id, amount_cents, reason, created_by, created_at, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [ctx.tenantId, chargeId, input.amountCents, input.reason, ctx.userId, nowIso(), input.idempotencyKey])).rows[0];
  await chargeEvent(db, ctx, chargeId, { kind: 'credited', amount: input.amountCents, reason: input.reason, approvedBy: ctx.userId });
  await audit(db, ctx, 'charge.credit', 'credit', c.id, { amount_cents: input.amountCents }, { caseId: ch.case_id, reason: input.reason });
  return { credit: c, replayed: false };
}

export async function acceptPacket(db: Db, ctx: Ctx, packetId: string, input: { customerReference: string }) {
  requirePerm(ctx, 'finance.manage');
  const p = await one(db, `select * from billing_packets where id=$1`, [packetId]);
  if (p.status !== 'po_matched') throw new AppError(409, 'not_matched', p.status === 'po_partial' ? 'PO coverage is partial; record the remaining PO first' : 'A packet is marked accepted only after a matching PO is recorded');
  if (!input.customerReference?.trim()) throw new AppError(400, 'reference_required', 'Record the customer acceptance reference');
  await db.query(`update billing_packets set status='accepted', accepted_at=$2, accepted_by=$3 where id=$1`, [packetId, nowIso(), ctx.userId]);
  await db.query(`update cases set status='closed' where id=$1 and status='completed' and not exists (select 1 from billing_packets where case_id=$1 and status not in ('accepted','void'))`, [p.case_id]);
  await audit(db, ctx, 'packet.accept', 'billing_packet', packetId, { customer_reference: input.customerReference }, { caseId: p.case_id });
  return one(db, `select * from billing_packets where id=$1`, [packetId]);
}

/** Case-level worklist (one row per case with money outstanding). */
export async function financeWorklist(db: Db, ctx: Ctx) {
  requirePerm(ctx, 'finance.manage');
  const cases = await rows(db, `select c.id, c.case_ref, c.scheduled_start, c.completed_at, c.status, f.name facility, f.timezone from cases c join facilities f on f.id=c.facility_id
    where c.status in ('completed','closed') order by c.scheduled_start`);
  const t = now();
  const out: any[] = [];
  for (const c of cases) {
    const fin = await caseFinancials(db, c.id);
    const open = fin.packets.filter((p) => !['accepted', 'void'].includes(p.status));
    const unpacketed = fin.charges.filter((x) => x.status === 'draft' && !x.packet_id).length;
    if (!open.length && !unpacketed && !fin.unpricedLines && fin.packets.some((p) => p.status === 'accepted')) continue;
    const reasons: string[] = [];
    const review = fin.charges.filter((x) => x.status === 'review').length;
    const exc = fin.charges.filter((x) => x.status === 'exception').length;
    if (exc) reasons.push(`${exc} line(s) cannot be priced`);
    if (review) reasons.push(`${review} line(s) need contract review`);
    if (unpacketed && !exc && !review) reasons.push(fin.packets.length ? `${unpacketed} line(s) recorded after the packet was sent` : 'Priced lines ready; packet not prepared');
    const packet = open.slice(-1)[0] ?? fin.packets.slice(-1)[0];
    if (packet?.status === 'draft') reasons.push('Packet prepared; not sent');
    if (packet?.status === 'queued_to_erp') reasons.push('Sent; awaiting simulated ERP receipt');
    if (packet?.status === 'erp_received_simulated') reasons.push('Sent; awaiting customer PO');
    if (packet?.status === 'po_partial') reasons.push(`Partial PO: $${(fin.outstandingCents / 100).toFixed(2)} not yet on a PO`);
    if (packet?.status === 'disputed') reasons.push('PO disputed (price or quantity)');
    if (packet?.status === 'po_matched') reasons.push('PO complete; awaiting customer acceptance');
    out.push({ caseId: c.id, caseRef: c.case_ref, facility: c.facility, surgery: c.scheduled_start, surgeryLocal: fmtLocal(c.scheduled_start, c.timezone),
      ageDays: Math.floor((t.getTime() - new Date(c.scheduled_start).getTime()) / 864e5), netCents: fin.netCents, outstandingCents: fin.outstandingCents, poCoveredCents: fin.poCoveredCents,
      creditedCents: fin.creditedCents, unpricedLines: fin.unpricedLines, packetStatus: packet?.status ?? 'none', stages: fin.stages, holdingUp: reasons });
  }
  out.sort((a, b) => b.ageDays - a.ageDays || b.outstandingCents - a.outstandingCents);
  return out;
}

/**
 * Line-level work queue: every held billing line with amount (if known), reason, owner, age and the
 * evidence still missing. Resolvable from the line itself.
 */
export async function financeLines(db: Db, ctx: Ctx) {
  requirePerm(ctx, 'finance.manage');
  const t = now();
  const defaultOwner = await maybe(db, `select id, display_name from users where role='finance' and active order by created_at limit 1`);
  const lines = await rows(db, `select ch.*, ci.ref, ci.description, c.case_ref, c.status case_status, c.scheduled_start, f.name facility, f.timezone, ue.disposition, si.serial_number, si.lot_number,
      k.name contract_name, cv.version contract_version, cr.rule_text, bp.status packet_status, ou.display_name owner_name,
      coalesce((select sum(amount_cents) from credits cd where cd.charge_id=ch.id),0)::int credited_cents
    from charges ch join cases c on c.id=ch.case_id join facilities f on f.id=c.facility_id join usage_events ue on ue.id=ch.usage_event_id left join stock_items si on si.id=ue.stock_item_id
    left join catalog_items ci on ci.id=ch.catalog_item_id left join contract_versions cv on cv.id=ch.contract_version_id left join contracts k on k.id=cv.contract_id
    left join contract_rules cr on cr.id=ch.rule_id left join billing_packets bp on bp.id=ch.packet_id left join users ou on ou.id=ch.owner_user_id
    where ch.status <> 'void' and (ch.status in ('review','exception') or (ch.status='draft' and ch.packet_id is null and c.status in ('completed','closed'))
      or bp.status in ('disputed','po_partial','erp_received_simulated','queued_to_erp'))
    order by ch.created_at`);
  const out: any[] = [];
  const heldCases = new Set(lines.filter((l) => l.status === 'review' || l.status === 'exception').map((l) => l.case_id));
  for (const l of lines) {
    let category = ''; let missing = '';
    if (l.status === 'exception') {
      category = 'cannot price';
      missing = !l.contract_version_id ? `A customer contract for ${l.facility} in effect on the surgery date`
        : !l.rule_id ? `A rule in ${l.contract_name} v${l.contract_version} for disposition "${l.disposition.replace('_', ' ')}"`
        : `A contract price for ${l.ref} in ${l.contract_name} v${l.contract_version}`;
    } else if (l.status === 'review') { category = 'needs decision'; missing = `Chargeable or no-charge decision for ${l.disposition.replace('_', ' ')} (${l.rule_text ?? 'contract rule'})`; }
    else if (!l.packet_id && heldCases.has(l.case_id)) { category = 'waiting on held line'; missing = `Resolution of the held line(s) on ${l.case_ref}; the packet is prepared once every line is priced`; }
    else if (!l.packet_id) { category = 'not on a packet'; missing = 'Include in a (supplemental) billing packet'; }
    else if (l.packet_status === 'disputed') { category = 'PO disputed'; missing = 'A corrected PO, or an approved credit'; }
    else if (l.packet_status === 'po_partial') { category = 'awaiting PO'; missing = `PO coverage for ${l.ref}`; }
    else { category = 'awaiting PO'; missing = 'Customer PO'; }
    out.push({ chargeId: l.id, caseId: l.case_id, caseRef: l.case_ref, facility: l.facility, ref: l.ref, description: l.description, unit: l.serial_number ? `SN ${l.serial_number}` : `Lot ${l.lot_number}`,
      disposition: l.disposition, qty: l.qty, amountCents: l.amount_cents, creditedCents: l.credited_cents, status: l.status, packetStatus: l.packet_status ?? null, category, reason: l.rationale, missingEvidence: missing,
      ownerUserId: l.owner_user_id ?? defaultOwner?.id ?? null, ownerName: l.owner_name ?? defaultOwner?.display_name ?? 'Unassigned', ageDays: Math.floor((t.getTime() - new Date(l.created_at).getTime()) / 864e5) });
  }
  // Fill PO coverage / outstanding per line for packeted lines.
  const byCase = new Map<string, any>();
  for (const l of out) if (!byCase.has(l.caseId)) byCase.set(l.caseId, await caseFinancials(db, l.caseId));
  for (const l of out) {
    const ch = byCase.get(l.caseId).charges.find((c: any) => c.id === l.chargeId);
    l.poCoveredCents = ch?.po_covered_cents ?? 0; l.outstandingCents = ch?.outstanding_cents ?? null;
    if (l.category === 'awaiting PO' && l.outstandingCents === 0) l.drop = true;
  }
  const finalLines = out.filter((l) => !l.drop);
  const order: Record<string, number> = { 'cannot price': 0, 'needs decision': 1, 'PO disputed': 2, 'not on a packet': 3, 'waiting on held line': 4, 'awaiting PO': 5 };
  finalLines.sort((a, b) => order[a.category] - order[b.category] || b.ageDays - a.ageDays);
  const finance = await rows(db, `select id, display_name from users where role in ('finance') and active order by display_name`);
  return { lines: finalLines, owners: finance, totals: {
    heldUnpricedLines: finalLines.filter((l) => l.amountCents == null).length,
    knownHeldCents: finalLines.filter((l) => l.category !== 'awaiting PO').reduce((a, l) => a + (l.amountCents ?? 0), 0),
    outstandingCents: finalLines.reduce((a, l) => a + (l.outstandingCents ?? 0), 0),
  } };
}

export async function usageReportCsv(db: Db, ctx: Ctx, caseId: string) {
  const c = await getVisibleCase(db, ctx, caseId);
  const ev = await rows(db, `select ue.*, ci.ref, ci.description, si.serial_number, si.lot_number, si.expiry_date, u.display_name actor from usage_events ue left join catalog_items ci on ci.id=ue.catalog_item_id
     left join stock_items si on si.id=ue.stock_item_id join users u on u.id=ue.actor_user_id where ue.case_id=$1 order by ue.occurred_at`, [caseId]);
  const head = ['case_ref', 'facility', 'disposition', 'ref', 'description', 'serial', 'lot', 'expiry', 'qty_units', 'package_gtin', 'units_per_package', 'entry_method', 'raw_scan', 'status', 'review_reason', 'recorded_offline', 'occurred_at', 'recorded_at', 'recorded_by'];
  const lines = ev.map((e) => [c.case_ref, c.facility_name, e.disposition, e.ref, e.description, e.serial_number, e.lot_number, e.expiry_date, e.reviewed_qty_units ?? e.qty_units, e.package_gtin, e.units_per_package, e.entry_method, e.raw_scan?.replace(/\x1d/g, '<GS>'), e.status, e.review_reason, e.recorded_offline, new Date(e.occurred_at).toISOString(), new Date(e.recorded_at).toISOString(), e.actor]);
  return [`# SYNTHETIC PILOT DATA. Usage report for ${c.case_ref}. "implanted" is the only disposition that represents an implant placed in a patient.`, head.join(','), ...lines.map((l) => l.map(csvCell).join(','))].join('\n') + '\n';
}

export async function packetDocument(db: Db, ctx: Ctx, packetId: string) {
  const p = await one(db, `select * from billing_packets where id=$1`, [packetId]);
  const c = await getVisibleCase(db, ctx, p.case_id);
  const fin = await caseFinancials(db, p.case_id);
  const lines = fin.charges.filter((x) => x.packet_id === p.id);
  const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.packet_type)} packet ${esc(c.case_ref)}</title>
<style>body{font-family:system-ui,sans-serif;margin:32px;color:#111}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:6px;text-align:left;font-size:13px}.banner{border:2px solid #a00;padding:8px;margin-bottom:16px;font-weight:600}</style></head><body>
<div class="banner">DRAFT ${p.packet_type === 'bill_and_replace' ? 'BILL-AND-REPLACE' : 'BILL-ONLY'} PACKET. SYNTHETIC PILOT DATA. Status: ${esc(p.status)}. This document is not an invoice of record and does not indicate payment or ERP acknowledgment.</div>
<h1>${esc(c.case_ref)}: ${esc(c.facility_name)}</h1>
<p>Procedure: ${esc(c.procedure)}. Surgery: ${esc(fmtLocal(c.scheduled_start, c.timezone))}. Surgeon ref: ${esc(c.surgeon_ref)}. Packet ${esc(p.id)} generated ${esc(new Date(p.created_at).toISOString())}.</p>
<table><thead><tr><th>Ref</th><th>Description</th><th>Serial / Lot</th><th>Disposition</th><th>Qty</th><th>Unit price</th><th>Amount</th><th>Contract / rule</th><th>Price date</th><th>Replenishment</th></tr></thead><tbody>
${lines.map((l) => `<tr><td>${esc(l.ref)}</td><td>${esc(l.description)}</td><td>${esc(l.serial_number ? 'SN ' + l.serial_number : 'Lot ' + l.lot_number)}</td><td>${esc(l.disposition)}</td><td>${l.qty}</td><td>${money(l.unit_price_cents)}</td><td>${money(l.amount_cents)}</td><td>${esc(l.contract_name)} v${l.contract_version}: ${esc(l.rule_text)}</td><td>${esc(l.price_date)}</td><td>${esc(l.replenish_action)}</td></tr>`).join('\n')}
</tbody></table>
<p>Gross ${money(lines.reduce((a, l) => a + l.amount_cents, 0))}. Credits ${money(fin.creditedCents)}. Net ${money(fin.netCents)}.</p>
<p>PO: ${fin.purchaseOrders.map((po) => `${esc(po.po_number)} (${esc(po.match_status)})`).join(', ') || 'not yet received'}.</p></body></html>`;
}
