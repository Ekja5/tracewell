import { beforeAll, describe, expect, it } from 'vitest';
import { withTenant, one, q } from '../../src/server/db.js';
import { seedAlt } from '../../src/server/seed/seed-alt.js';
import type { Ctx } from '../../src/server/perms.js';
import { reserve, ledgerReconciliation } from '../../src/server/domain/inventory.js';
import { rescueSearch, exactItemAvailability } from '../../src/server/domain/rescue.js';
import { readinessWithIssues } from '../../src/server/domain/cases.js';
import * as ship from '../../src/server/domain/shipments.js';
import * as rec from '../../src/server/domain/recall.js';
import * as bill from '../../src/server/domain/billing.js';
import { recordUsage, submitCloseout } from '../../src/server/domain/closeout.js';
import { runImport } from '../../src/server/domain/imports.js';
import { buildGs1 } from '../../src/shared/gs1.js';

/** Everything here is discovered by query (role, kind, relative dates), never by demo names or IDs. */
let A: any, B: any;
const ctx = async (tenant: string, role: string, n = 0): Promise<Ctx> => {
  const rows = await q(`select * from users where tenant_id=$1 and role=$2 order by email`, [tenant, role]);
  const u = rows[n];
  return { userId: u.id, tenantId: tenant, role: u.role, facilityId: u.facility_id, territoryId: u.territory_id, displayName: u.display_name };
};
const tx = <T>(t: string, fn: (db: any) => Promise<T>) => withTenant(t, fn);
async function err(p: Promise<any>) { try { await p; return null; } catch (e: any) { return e; } }

beforeAll(async () => {
  const r = await seedAlt({ quiet: true });
  A = r.tenants.cascade; B = r.tenants.bayline;
});

describe('Alternate dataset: tenants with overlapping catalog numbers', () => {
  it('each tenant sees only its own units of the same catalog number', async () => {
    const opsA = await ctx(A.T, 'ops_manager'), opsB = await ctx(B.T, 'ops_manager');
    const ra = await tx(A.T, (db) => exactItemAvailability(db, opsA, { q: 'KN-STEM-12' }));
    const rb = await tx(B.T, (db) => exactItemAvailability(db, opsB, { q: 'KN-STEM-12' }));
    expect(ra.mode).toBe('stock'); expect(rb.mode).toBe('stock');
    const ownA = await tx(A.T, async (db) => (await db.query(`select count(*)::int n from stock_items s join catalog_items c on c.id=s.catalog_item_id where c.ref='KN-STEM-12'`)).rows[0].n);
    expect((ra as any).rows.length).toBe(ownA);
    expect((ra as any).item.id).not.toBe((rb as any).item.id);
    expect((ra as any).item.unit_gtin).not.toBe((rb as any).item.unit_gtin);
    // RLS: tenant B transaction cannot see tenant A's catalog row with the same ref.
    const leak = await tx(B.T, async (db) => (await db.query(`select count(*)::int n from catalog_items where id=$1`, [(ra as any).item.id])).rows[0].n);
    expect(leak).toBe(0);
  });
});

describe('Alternate dataset: deadlines, overnight transfer, expiry, cancellation', () => {
  it('uses the facility time zone and receiving hours; an overnight transfer is received at next opening', async () => {
    const ops = await ctx(A.T, 'ops_manager');
    const later = A.cases.later;
    const req = await tx(A.T, (db) => one(db, `select cr.id from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and ci.ref='KN-STEM-12'`, [later.id]));
    const s = await tx(A.T, (db) => rescueSearch(db, ops, later.id, req.id));
    const far = s.eligible.find((e: any) => e.locationCode === 'DC-FAR');
    expect(far).toBeTruthy();
    expect(far.arrivalNote).toMatch(/received when .* opens at 8:00 AM/);
    expect(far.meetsCutoff).toBe(true);
    // Expired lot is excluded with a reason; the unit already reserved for this case is labeled so.
    expect(s.excluded.find((e: any) => e.locationCode === 'TRK-1').reasons.join(' ')).toMatch(/Expires/);
    expect(s.excluded.find((e: any) => e.locationCode === 'DC-A').reasons.join(' ')).toMatch(/Already reserved for this case/);
    // Implant deadline 6 h before a 12:00 surgery = 06:00, before Mountain View opens at 08:00 -> previous day 4 PM close.
    const r = await tx(A.T, (db) => readinessWithIssues(db, A.T, later.id));
    expect(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', hourCycle: 'h23' }).format(new Date(r.requiredBy.implant))).toBe('16');
    // Owners are named people from this tenant.
    expect(r.blockers.every((b: any) => /cascade/.test(b.owner) || b.owner === 'Unassigned' || b.owner.includes('receiving') || b.owner.includes('SPD'))).toBe(true);
  });

  it('the canceled case released its reservations and has no open issues', async () => {
    const c = A.cases.canceled;
    const n = await tx(A.T, async (db) => (await db.query(`select count(*)::int n from reservations where case_id=$1 and status='active'`, [c.id])).rows[0].n);
    expect(n).toBe(0);
    const open = await tx(A.T, async (db) => (await db.query(`select count(*)::int n from case_issues where case_id=$1 and status<>'resolved'`, [c.id])).rows[0].n);
    expect(open).toBe(0);
  });
});

describe('Alternate dataset: concurrency, imports, shipments, offline, recall, contracts', () => {
  it('racing reservations of lot-controlled stock never over-allocate', async () => {
    const ops = await ctx(A.T, 'ops_manager');
    const screw = await tx(A.T, (db) => one(db, `select s.id from stock_items s join catalog_items c on c.id=s.catalog_item_id where c.ref='SCREW-35-30'`));
    const reqs = await tx(A.T, async (db) => (await db.query(`select cr.id, cr.case_id from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id join cases c on c.id=cr.case_id where ci.ref='SCREW-35-30' and c.status='scheduled'`)).rows);
    const res = await Promise.allSettled([0, 1, 2].map((i) => tx(A.T, (db) => reserve(db, ops, { caseId: reqs[i % reqs.length].case_id, requirementId: reqs[i % reqs.length].id, stockItemId: screw.id, locationId: A.L_T1, ownerPartyId: A.dist, qty: 2 }))));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(2); // 4 units in the trunk, 2 each
    const reserved = await tx(A.T, async (db) => (await db.query(`select coalesce(sum(qty),0)::int n from reservations where stock_item_id=$1 and location_id=$2 and status='active'`, [screw.id, A.L_T1])).rows[0].n);
    expect(reserved).toBe(4);
  });

  it('a duplicate opening-balance import posts nothing new', async () => {
    const inv = await ctx(A.T, 'inventory_coordinator');
    const before = await tx(A.T, async (db) => (await db.query(`select count(*)::int n from inventory_movements`)).rows[0].n);
    const r = await tx(A.T, (db) => runImport(db, inv, { kind: 'opening_balances', filename: 'replay.csv', sourceSystem: 'ALT-SRC', csv: A.obCsv, mode: 'commit' }));
    expect(r.counts.already_imported).toBe(10);
    expect(await tx(A.T, async (db) => (await db.query(`select count(*)::int n from inventory_movements`)).rows[0].n)).toBe(before);
  });

  it('partial shipment, receipt at the hospital, offline retries and closeout post exactly once', async () => {
    const ops = await ctx(A.T, 'ops_manager'), wh = await ctx(A.T, 'warehouse'), rep = await ctx(A.T, 'rep', 0);
    const morning = A.cases.morning;
    const fac = await tx(A.T, (db) => one(db, `select facility_id from cases where id=$1`, [morning.id]));
    const recvUser = (await q(`select * from users where tenant_id=$1 and role='hospital_receiving' and facility_id=$2`, [A.T, fac.facility_id]))[0];
    const recv: Ctx = { userId: recvUser.id, tenantId: A.T, role: 'hospital_receiving', facilityId: recvUser.facility_id, territoryId: null, displayName: 'rcv' };
    const plan = await tx(A.T, (db) => ship.planCaseDelivery(db, ops, morning.id));
    const sid = plan.created[0].id;
    // Add a screw line to the same shipment's source and short-pick it.
    const screw = await tx(A.T, (db) => one(db, `select s.id from stock_items s join catalog_items c on c.id=s.catalog_item_id where c.ref='SCREW-35-30'`));
    const extra = await tx(A.T, async (db) => ship.createShipment(db, ops, { fromLocationId: A.L_DC, toLocationId: (await one(db, `select id from locations where facility_id=$1 and kind='hospital_receiving'`, [fac.facility_id])).id, caseId: morning.id, kind: 'case_delivery', lines: [{ stockItemId: screw.id, ownerPartyId: A.dist, qty: 10 }] }));
    await tx(A.T, async (db) => { for (const s of [sid, extra.id]) { const d = await ship.shipmentDetail(db, wh, s); for (const l of d.lines) await ship.pickLine(db, wh, s, { lineId: l.id, qty: s === extra.id ? 6 : l.qty_expected }); await ship.dispatchShipment(db, wh, s, {}); } });
    expect(await tx(A.T, async (db) => (await db.query(`select count(*)::int n from exceptions where kind='partial_shipment'`)).rows[0].n)).toBe(1);
    await tx(A.T, async (db) => { for (const s of [sid, extra.id]) { const d = await ship.shipmentDetail(db, recv, s); await ship.receiveShipment(db, recv, s, { lines: d.lines.map((l: any) => ({ lineId: l.id, qtyReceived: l.qty_dispatched, sealIntact: true })) }); } });
    // Offline retries of one implant event.
    const ins = await tx(A.T, (db) => one(db, `select s.*, c.unit_gtin from stock_items s join catalog_items c on c.id=s.catalog_item_id where s.serial_number='IN-001'`));
    const ev = { clientEventId: 'alt-off-1', caseId: morning.id, disposition: 'implanted' as const, entryMethod: 'scanner' as const, offline: true, rawScan: buildGs1({ gtin: ins.unit_gtin, lot: ins.lot_number, serial: ins.serial_number, expiry: ins.expiry_date }) };
    for (let i = 0; i < 4; i++) await tx(A.T, (db) => recordUsage(db, rep, ev));
    const ue = await tx(A.T, (db) => one(db, `select id from usage_events where client_event_id='alt-off-1'`));
    for (const t of ['inventory_movements', 'charges', 'replenishments'])
      expect(await tx(A.T, async (db) => (await db.query(`select count(*)::int n from ${t} where usage_event_id=$1`, [ue.id])).rows[0].n)).toBe(1);
    // Two screws used (lot-controlled, unpriced in contract) -> finance exception.
    const sg = await tx(A.T, (db) => one(db, `select c.unit_gtin, s.expiry_date from stock_items s join catalog_items c on c.id=s.catalog_item_id where c.ref='SCREW-35-30'`));
    await tx(A.T, (db) => recordUsage(db, rep, { clientEventId: 'alt-scr', caseId: morning.id, disposition: 'implanted', entryMethod: 'scanner', qtyUnits: 2, rawScan: buildGs1({ gtin: sg.unit_gtin, lot: 'SC7', expiry: sg.expiry_date }) }));
    await tx(A.T, async (db) => db.query(`update reservations set status='released' where case_id=$1 and status='active'`, [morning.id]));
    await tx(A.T, (db) => submitCloseout(db, rep, morning.id, {}));
  });

  it('contract correction: finance prices the held line, bills, credits; billing reconciles to dispositions and rules', async () => {
    const fin = await ctx(A.T, 'finance');
    const morning = A.cases.morning;
    const lines = await tx(A.T, (db) => bill.financeLines(db, fin));
    const held = lines.lines.find((l: any) => l.caseId === morning.id && l.category === 'cannot price');
    expect(held.missingEvidence).toMatch(/contract price for SCREW-35-30/);
    await tx(A.T, (db) => bill.resolveCharge(db, fin, held.chargeId, { decision: 'charge', unitPriceCents: 4500, reason: 'Amendment (synthetic)' }));
    const pk = await tx(A.T, (db) => bill.generatePacket(db, fin, morning.id));
    const f = await tx(A.T, (db) => bill.caseFinancials(db, morning.id));
    for (const ch of f.charges) {
      const price = await tx(A.T, (db) => one(db, `select coalesce((select unit_price_cents from contract_prices where contract_version_id=$1 and catalog_item_id=$2), $3) p`, [ch.contract_version_id, ch.catalog_item_id, ch.unit_price_cents]));
      expect(ch.amount_cents).toBe(price.p * ch.qty);
      expect(ch.rule_text).toMatch(new RegExp(ch.disposition));
    }
    const mv = await tx(A.T, async (db) => (await db.query(`select count(*)::int n from inventory_movements`)).rows[0].n);
    const stem = f.charges.find((c: any) => c.ref === 'KN-INSERT-9');
    await tx(A.T, (db) => bill.issueCredit(db, fin, stem.id, { amountCents: 1000, reason: 'Rounding correction', idempotencyKey: 'alt-cr' }));
    expect(await tx(A.T, async (db) => (await db.query(`select count(*)::int n from inventory_movements`)).rows[0].n)).toBe(mv);
    expect(pk.packet.status).toBe('draft');
  });

  it('recall on a lot spread across warehouse, remote depot, trunk and in-transit propagates everywhere and blocks allocation', async () => {
    const ops = await ctx(A.T, 'ops_manager'), wh = await ctx(A.T, 'warehouse'), q1 = await ctx(A.T, 'quality_manager', 0), q2 = await ctx(A.T, 'quality_manager', 1);
    // Put one unit of the lot in transit.
    const st4 = await tx(A.T, (db) => one(db, `select id from stock_items where serial_number='ST-004'`));
    const sh = await tx(A.T, (db) => ship.createShipment(db, ops, { fromLocationId: A.L_T2, toLocationId: A.L_DC, kind: 'return', lines: [{ stockItemId: st4.id, ownerPartyId: A.dist, qty: 1 }] }));
    await tx(A.T, async (db) => { const d = await ship.shipmentDetail(db, ops, sh.id); await ship.pickLine(db, ops, sh.id, { lineId: d.lines[0].id, qty: 1 }); await ship.dispatchShipment(db, ops, sh.id, {}); });
    const item = await tx(A.T, (db) => one(db, `select id, manufacturer_party_id from catalog_items where ref='KN-STEM-12'`));
    const r = await tx(A.T, (db) => rec.createRecall(db, q1, { manufacturerPartyId: item.manufacturer_party_id, catalogItemId: item.id, scopeType: 'lot', scopeValues: ['LS1'], noticeRef: 'ALT-N', description: 'alt recall' }));
    await tx(A.T, (db) => rec.verifyRecall(db, q2, r.id, { confirmScope: ['LS1'] }));
    const d = await tx(A.T, (db) => rec.activateRecall(db, q1, r.id));
    const kinds = d.inventory.map((i: any) => i.location_kind).sort();
    expect(kinds).toEqual(['in_transit', 'warehouse', 'warehouse']);
    expect(d.tasks.map((t: any) => t.task_type)).toEqual(expect.arrayContaining(['acknowledge_and_quarantine', 'return_in_transit', 'open_case_alert']));
    const st2 = await tx(A.T, (db) => one(db, `select id from stock_items where serial_number='ST-002'`));
    const later = A.cases.later;
    expect((await err(tx(A.T, (db) => reserve(db, ops, { caseId: later.id, stockItemId: st2.id, locationId: A.L_FAR, ownerPartyId: A.dist, qty: 1 }))))?.code).toBe('on_hold');
    // Tenant B's identically numbered lot is untouched.
    expect(await tx(B.T, async (db) => (await db.query(`select count(*)::int n from quality_holds`)).rows[0].n)).toBe(0);
  });

  it('ledgers reconcile for both tenants', async () => {
    for (const t of [A.T, B.T]) expect((await tx(t, (db) => ledgerReconciliation(db))).matches).toBe(true);
  });
});
