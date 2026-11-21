import { beforeAll, describe, expect, it } from 'vitest';
import { freshSeed, ctxFor, tx, caseId, reqId, stock, balanceOf, count, httpApp, T1, one } from './helpers.js';
import { setClock } from '../../src/server/clock.js';
import { zoned, addDays, GTIN } from '../../src/server/seed/seed.js';
import { readinessWithIssues, moveCase, caseReadiness } from '../../src/server/domain/cases.js';
import { reserveAndTransfer, rescueSearch } from '../../src/server/domain/rescue.js';
import { escalateOverdue, acknowledgeIssue, handoff } from '../../src/server/domain/issues.js';
import * as ship from '../../src/server/domain/shipments.js';
import * as bill from '../../src/server/domain/billing.js';
import * as rec from '../../src/server/domain/recall.js';
import { ledgerReconciliation } from '../../src/server/domain/inventory.js';
import { processOutboxForTenant } from '../../src/server/domain/erp.js';
import { buildGs1 } from '../../src/shared/gs1.js';

const D = '2026-11-21';
const OPS = 'ops@lakeshore.example', RILEY = 'riley.rep@lakeshore.example', JORDAN = 'jordan.rep@lakeshore.example', WH = 'warehouse@lakeshore.example', SCHED = 'scheduler@lakeshore.example';
const SBR_RECV = 'receiving@stbrigid.example', SBR_SPD = 'spd@stbrigid.example', FIN = 'finance@lakeshore.example', Q1 = 'quality@lakeshore.example', Q2 = 'quality2@lakeshore.example';
async function err(p: Promise<any>) { try { await p; return null; } catch (e: any) { return e; } }
const loc = async (code: string) => (await tx(async (db) => one(db, `select id from locations where code=$1`, [code]))).id;
const party = async (kind: string) => (await tx(async (db) => one(db, `select id from parties where kind=$1 limit 1`, [kind]))).id;

describe('A. 4 p.m. move: owners, deadlines and alerts follow the case', () => {
  beforeAll(freshSeed);
  it('updates stored shipment cutoffs, issue deadlines, owner alerts, and names a person as next owner', async () => {
    await setClock(zoned(D, '16:00', 'America/Chicago'));
    const ops = await ctxFor(OPS), sched = await ctxFor(SCHED);
    const c1 = await caseId('SYN-1001');
    await tx(async (db) => ship.planCaseDelivery(db, ops, c1));
    const before = await tx(async (db) => readinessWithIssues(db, T1, c1));
    const trayIssue = before.blockers.find((b: any) => b.code === 'awaiting_dispatch')!;
    expect(trayIssue.owner).toBe('Sam Okafor'); // named person, not a role
    const newStart = zoned(addDays(D, 1), '05:30', 'America/Chicago').toISOString();
    await tx(async (db) => moveCase(db, sched, c1, { scheduledStart: newStart, reason: 'OR block moved' }));
    const after = await tx(async (db) => readinessWithIssues(db, T1, c1));
    // Shipment cutoff is consistent with the recomputed tray deadline.
    const sh = await tx(async (db) => one(db, `select due_by from shipments where case_id=$1 and status='planned'`, [c1]));
    expect(new Date(sh.due_by).toISOString()).toBe(after.requiredBy.tray);
    // Deadline change is recorded on the issue and the owner's single alert was updated, not duplicated.
    const ev = await count(`select count(*) n from issue_events where issue_id=$1 and kind='deadline_changed'`, [trayIssue.issueId]);
    expect(ev).toBeGreaterThanOrEqual(1);
    const wh = await ctxFor(WH);
    const alerts = (await tx(async (db) => db.query(`select * from notifications where user_id=$1 and issue_id=$2`, [wh.userId, trayIssue.issueId]))).rows;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].repeat_count).toBeGreaterThan(1);
    expect(alerts[0].message).toMatch(/earlier|deadline/);
    // Implant deadline now falls outside St. Brigid receiving hours, so it moves back to the 8 PM close.
    const implant = after.blockers.find((b: any) => b.code === 'uncovered');
    expect(implant.explanation).toMatch(/receiving closes at 8:00 PM/);
    expect(implant.explanation).toMatch(/Riley Novak owns the follow-up/);
  });

  it('acknowledgment is distinct from resolution; escalation fires once when the act-by passes', async () => {
    const c1 = await caseId('SYN-1001');
    const wh = await ctxFor(WH);
    const r = await tx(async (db) => readinessWithIssues(db, T1, c1));
    const tray = r.blockers.find((b: any) => b.code === 'awaiting_dispatch')!;
    await tx(async (db) => acknowledgeIssue(db, wh, tray.issueId, { note: 'Picking now' }));
    const i = await tx(async (db) => one(db, `select status from case_issues where id=$1`, [tray.issueId]));
    expect(i.status).toBe('acknowledged');
    // Let the act-by pass without dispatch.
    await setClock(zoned(D, '17:00', 'America/Chicago'));
    await tx(async (db) => readinessWithIssues(db, T1, c1));
    const n1 = await tx(async (db) => escalateOverdue(db, T1));
    const n2 = await tx(async (db) => escalateOverdue(db, T1));
    expect(n1).toBeGreaterThanOrEqual(1);
    expect(n2).toBe(0);
    const ops = await ctxFor(OPS);
    expect(await count(`select count(*) n from notifications where user_id=$1 and issue_id=$2 and kind='issue_escalated'`, [ops.userId, tray.issueId])).toBe(1);
    const h = await tx(async (db) => handoff(db, ops, 12));
    const hi = h.open.find((x: any) => x.id === tray.issueId);
    expect(hi.history.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['opened', 'deadline_changed', 'acknowledged', 'escalated']));
  });
});

describe('B. Race for one unit gives the loser an actionable answer', () => {
  beforeAll(freshSeed);
  it('one succeeds; the other learns who reserved it and the next eligible unit', async () => {
    const { as } = await httpApp();
    const sched = await as(SCHED);
    const fac = await tx(async (db) => one(db, `select id from facilities where code='PVS'`));
    const card = await tx(async (db) => one(db, `select id from preference_card_versions where status='approved'`));
    const jordan = await ctxFor(JORDAN);
    const urgent = (await sched.post('/api/cases', { facilityId: fac.id, cardVersionId: card.id, scheduledStart: zoned(addDays(D, 1), '15:00', 'America/Indiana/Indianapolis').toISOString(), repUserId: jordan.userId, urgent: true })).json();
    const c1 = await caseId('SYN-1001');
    const rR = await reqId('SYN-1001', 'NP-INS-4-10');
    const rJ = (await tx(async (db) => one(db, `select cr.id from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and ci.ref='NP-INS-4-10'`, [urgent.id]))).id;
    const u = await stock('INS-0002');
    const body = (k: string) => ({ stockItemId: u.id, locationId: undefined as any, ownerPartyId: undefined as any, idempotencyKey: k });
    const trunk = await loc('TRUNK-JORDAN'); const dist = await party('distributor');
    const [a, b] = await Promise.all([
      (await as(RILEY)).post(`/api/cases/${c1}/rescue/${rR}/reserve`, { ...body('r1'), locationId: trunk, ownerPartyId: dist }),
      (await as(JORDAN)).post(`/api/cases/${urgent.id}/rescue/${rJ}/reserve`, { ...body('j1'), locationId: trunk, ownerPartyId: dist }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = (a.statusCode === 409 ? a : b).json();
    expect(loser.message).toMatch(/reserved it for SYN-/);
    expect(loser.message).toMatch(/Next eligible|No other eligible/);
    expect(loser.details.heldBy.case_ref).toMatch(/SYN-/);
    expect(await count(`select count(*) n from reservations where stock_item_id=$1 and status='active'`, [u.id])).toBe(1);
  });
});

describe('C. Tray discrepancy lifecycle and stale verification', () => {
  beforeAll(freshSeed);
  it('a verification from a previous visit does not make a returning tray ready', async () => {
    const ops = await ctxFor(OPS), wh = await ctxFor(WH), recv = await ctxFor(SBR_RECV);
    const c1 = await caseId('SYN-1001');
    const tray = await stock('TRY-K-002');
    // TRY-K-002 was verified complete at St. Brigid 12 days ago (historical case SYN-0902), then returned.
    expect(await count(`select count(*) n from tray_verifications tv join locations l on l.id=tv.location_id where tray_stock_item_id=$1 and l.facility_id=(select id from facilities where code='SBR') and result='complete'`, [tray.id])).toBeGreaterThan(0);
    const planned = await tx(async (db) => ship.planCaseDelivery(db, ops, c1));
    const sid = planned.created[0].id;
    await tx(async (db) => { const d = await ship.shipmentDetail(db, wh, sid); for (const l of d.lines) await ship.pickLine(db, wh, sid, { lineId: l.id, qty: 1 }); await ship.dispatchShipment(db, wh, sid, {}); });
    await tx(async (db) => { const d = await ship.shipmentDetail(db, recv, sid); await ship.receiveShipment(db, recv, sid, { lines: d.lines.map((l: any) => ({ lineId: l.id, qtyReceived: 1, sealIntact: true })) }); });
    const r = await tx(async (db) => caseReadiness(db, c1));
    const tb = r.blockers.find((b: any) => b.key.startsWith('unit:') && /Tray/.test(b.message));
    expect(tb?.code).toBe('tray_unverified');
    expect(tb?.message).toMatch(/predates this delivery/);
  });

  it('one issue follows the tray from missing instrument to release, with owners changing by stage', async () => {
    const ops = await ctxFor(OPS), wh = await ctxFor(WH), recv = await ctxFor(SBR_RECV), spd = await ctxFor(SBR_SPD), rep = await ctxFor(RILEY);
    const c1 = await caseId('SYN-1001');
    const tray = await stock('TRY-K-002');
    const m = await tx(async (db) => ship.trayManifest(db, tray.id));
    const sizer = (await tx(async (db) => one(db, `select id from catalog_items where ref='NP-INST-SIZER'`))).id;
    await tx(async (db) => ship.verifyTray(db, recv, tray.id, { caseId: c1, sealIntact: true, lines: m.lines.map((l: any) => ({ catalogItemId: l.catalog_item_id, actualQty: l.catalog_item_id === sizer ? 0 : 1 })) }));
    let r = await tx(async (db) => readinessWithIssues(db, T1, c1));
    const inc = r.blockers.find((b: any) => b.code === 'tray_incomplete')!;
    expect(inc.explanation).toMatch(/Tray TRY-K-002 is missing 1 required instrument/);
    expect(inc.explanation).toMatch(/Morgan Hale owns the follow-up/);
    // The rep sees the same explanation and owner (read-only).
    const repView = await tx(async (db) => readinessWithIssues(db, T1, c1));
    expect(repView.blockers.find((b: any) => b.issueId === inc.issueId)?.owner).toBe('Morgan Hale');
    expect((await err(tx(async (db) => acknowledgeIssue(db, rep, inc.issueId, {}))))?.status).toBe(403);
    await tx(async (db) => acknowledgeIssue(db, ops, inc.issueId, { note: 'Sending replacement sizer' }));
    const d = await tx(async (db) => one(db, `select id from discrepancies where kind='missing_instrument' and status='open'`));
    const rs = await tx(async (db) => ship.sendReplacement(db, ops, d.id));
    await tx(async (db) => { const x = await ship.shipmentDetail(db, wh, rs.id); await ship.pickLine(db, wh, rs.id, { lineId: x.lines[0].id, qty: 1 }); await ship.dispatchShipment(db, wh, rs.id, {}); });
    await tx(async (db) => { const x = await ship.shipmentDetail(db, recv, rs.id); await ship.receiveShipment(db, recv, rs.id, { lines: [{ lineId: x.lines[0].id, qtyReceived: 1, sealIntact: true }] }); });
    // Still not resolved: acknowledgment and a received replacement do not clear it; re-verification does.
    r = await tx(async (db) => readinessWithIssues(db, T1, c1));
    expect(r.blockers.find((b: any) => b.issueId === inc.issueId)?.code).toBe('tray_incomplete');
    await tx(async (db) => ship.verifyTray(db, recv, tray.id, { caseId: c1, sealIntact: true, lines: m.lines.map((l: any) => ({ catalogItemId: l.catalog_item_id, actualQty: 1 })) }));
    r = await tx(async (db) => readinessWithIssues(db, T1, c1));
    const rel = r.blockers.find((b: any) => b.issueId === inc.issueId)!;
    expect(rel.code).toBe('awaiting_release');
    expect(rel.owner).toBe('Robin Shah (SBR SPD)');
    expect(rel.issueStatus).toBe('open'); // new stage needs a fresh acknowledgment
    await tx(async (db) => ship.recordRelease(db, spd, c1, { trayStockItemId: tray.id, decision: 'released', evidence: { hospital_processing_record_ref: 'SBR-1' } }));
    await tx(async (db) => readinessWithIssues(db, T1, c1));
    const fin = await tx(async (db) => one(db, `select status, resolution from case_issues where id=$1`, [inc.issueId]));
    expect(fin.status).toBe('resolved');
    expect(fin.resolution).toMatch(/Condition cleared/);
    expect(await count(`select count(*) n from notifications where issue_id=$1 and status='active'`, [inc.issueId])).toBe(0);
  });
});

describe('D. Phone usage: offline, recall, duplicates, quarantine, corrections', () => {
  beforeAll(freshSeed);
  it('implanted + opened-unused offline, recall in between, reconnect: each posts exactly once; conflict reaches Quality', async () => {
    const { as } = await httpApp();
    const c1 = await caseId('SYN-1001');
    const rep = await as(RILEY);
    expect((await rep.get(`/api/offline/cases/${c1}/package`)).statusCode).toBe(200);
    const fem = await stock('FEM4L-0101'), tib = await stock('TIB4-0201');
    const evs = [
      { clientEventId: 'd-1', caseId: c1, disposition: 'implanted', entryMethod: 'simulator', occurredAt: '2026-11-21T13:50:00Z', rawScan: buildGs1({ gtin: GTIN.FEM_4L, lot: fem.lot_number, serial: fem.serial_number, expiry: fem.expiry_date }, { symbologyId: true }) },
      { clientEventId: 'd-2', caseId: c1, disposition: 'opened_unused', entryMethod: 'simulator', occurredAt: '2026-11-21T13:51:00Z', rawScan: buildGs1({ gtin: GTIN.TIB_4, lot: tib.lot_number, serial: tib.serial_number, expiry: tib.expiry_date }, { symbologyId: true }) },
    ];
    const q1 = await ctxFor(Q1), q2 = await ctxFor(Q2);
    const item = await tx(async (db) => one(db, `select id, manufacturer_party_id from catalog_items where ref='NP-FEM-4L'`));
    const r = await tx(async (db) => rec.createRecall(db, q1, { manufacturerPartyId: item.manufacturer_party_id, catalogItemId: item.id, scopeType: 'lot', scopeValues: [fem.lot_number], noticeRef: 'T-1', description: 'test' }));
    await tx(async (db) => rec.verifyRecall(db, q2, r.id, { confirmScope: [fem.lot_number] }));
    await tx(async (db) => rec.activateRecall(db, q1, r.id));
    for (let i = 0; i < 3; i++) await rep.post('/api/offline/sync', { events: evs });
    for (const id of ['d-1', 'd-2']) {
      const ue = await tx(async (db) => one(db, `select * from usage_events where client_event_id=$1`, [id]));
      expect(ue.status).toBe('recorded');
      expect(await count(`select count(*) n from inventory_movements where usage_event_id=$1`, [ue.id])).toBe(1);
      expect(await count(`select count(*) n from charges where usage_event_id=$1`, [ue.id])).toBe(1);
    }
    expect(await count(`select count(*) n from recall_tasks where task_type='late_usage_review'`)).toBe(1);
    const qh = (await (await as(Q1)).get('/api/quality')).json();
    expect(qh.tasks.some((t: any) => t.task_type === 'late_usage_review')).toBe(true);
  });

  it('an accidental rescan of a serialized unit is rejected, not posted; two scans of one lot are two units', async () => {
    const { as } = await httpApp();
    const c1 = await caseId('SYN-1001');
    const rep = await as(RILEY);
    const fem = await stock('FEM4L-0101');
    const dup = (await rep.post('/api/offline/sync', { events: [{ clientEventId: 'd-dup', caseId: c1, disposition: 'implanted', entryMethod: 'scanner', rawScan: buildGs1({ gtin: GTIN.FEM_4L, lot: fem.lot_number, serial: fem.serial_number, expiry: fem.expiry_date }) }] })).json();
    expect(dup.results[0].state).toBe('rejected');
    expect(dup.results[0].reason).toMatch(/Duplicate scan/);
    const ue = await tx(async (db) => one(db, `select id from usage_events where client_event_id='d-dup'`));
    expect(await count(`select count(*) n from inventory_movements where usage_event_id=$1`, [ue.id])).toBe(0);
    expect(await count(`select count(*) n from charges where usage_event_id=$1`, [ue.id])).toBe(0);
    const screws = await stock('S26B088');
    const label = buildGs1({ gtin: GTIN.SCR_650, lot: 'S26B088', expiry: screws.expiry_date });
    const before = (await balanceOf(screws.id)).find((b: any) => b.code === 'TRUNK-RILEY').qty;
    const two = (await rep.post('/api/offline/sync', { events: [1, 2].map((n) => ({ clientEventId: `lot-${n}`, caseId: c1, disposition: 'implanted', entryMethod: 'scanner', rawScan: label })) })).json();
    expect(two.results.map((x: any) => x.state)).toEqual(['synced', 'synced']);
    expect((await balanceOf(screws.id)).find((b: any) => b.code === 'TRUNK-RILEY').qty).toBe(before - 2);
  });

  it('an event the server cannot accept is quarantined (not lost) and reaches ops', async () => {
    const { as } = await httpApp();
    const c1 = await caseId('SYN-1001');
    const res = (await (await as(JORDAN)).post('/api/offline/sync', { events: [{ clientEventId: 'q-1', caseId: c1, disposition: 'implanted', entryMethod: 'manual', manual: { ref: 'NP-INS-4-12', serial: 'X' }, occurredAt: '2026-11-21T13:00:00Z' }] })).json();
    expect(res.results[0]).toMatchObject({ state: 'needs_review', quarantined: true });
    expect(await count(`select count(*) n from sync_quarantine where client_event_id='q-1'`)).toBe(1);
    expect(await count(`select count(*) n from exceptions where kind='sync_quarantine' and status='open'`)).toBe(1);
  });

  it('correcting a recorded line reverses stock and voids the draft charge; after the packet is sent it is refused', async () => {
    const { as } = await httpApp();
    const c1 = await caseId('SYN-1001');
    const rep = await as(RILEY);
    const ue = await tx(async (db) => one(db, `select * from usage_events where client_event_id='lot-2'`));
    const screws = await stock('S26B088');
    const before = (await balanceOf(screws.id)).find((b: any) => b.code === 'TRUNK-RILEY').qty;
    const v = await rep.post(`/api/usage/${ue.id}/void`, { reason: 'Scanned the box twice' });
    expect(v.statusCode).toBe(200);
    expect((await balanceOf(screws.id)).find((b: any) => b.code === 'TRUNK-RILEY').qty).toBe(before + 1);
    const ch = await tx(async (db) => one(db, `select status from charges where usage_event_id=$1`, [ue.id]));
    expect(ch.status).toBe('void');
    expect(await count(`select count(*) n from charge_events e join charges c on c.id=e.charge_id where c.usage_event_id=$1 and e.kind='voided'`, [ue.id])).toBe(1);
    expect((await tx(async (db) => ledgerReconciliation(db))).matches).toBe(true);
    // Packet sent -> correction must go through Finance as a credit.
    const riley = await ctxFor(RILEY), fin = await ctxFor(FIN);
    await rep.post(`/api/cases/${c1}/usage`, { clientEventId: 'ret-ins', disposition: 'returned_sealed', entryMethod: 'manual', manual: { ref: 'NP-INS-4-10', serial: 'INS-0002' } }).catch(() => null);
    await tx(async (db) => db.query(`update reservations set status='released' where case_id=$1 and status='active'`, [c1]));
    await tx(async (db) => (await import('../../src/server/domain/closeout.js')).submitCloseout(db, riley, c1, {}));
    const pk = await tx(async (db) => bill.generatePacket(db, fin, c1));
    await tx(async (db) => bill.queuePacketToErp(db, fin, pk.packet.id));
    const lot1 = await tx(async (db) => one(db, `select id from usage_events where client_event_id='lot-1'`));
    expect((await rep.post(`/api/usage/${lot1.id}/void`, { reason: 'late' })).statusCode).toBe(409);
  });
});

describe('E. Finance: missing price, partial PO, correction', () => {
  beforeAll(freshSeed);
  it('resolves a missing price with history, takes a partial then a remaining PO, and credits without touching stock', async () => {
    const fin = await ctxFor(FIN);
    const c = await caseId('SYN-0903');
    const lines = await tx(async (db) => bill.financeLines(db, fin));
    const held = lines.lines.find((l: any) => l.caseRef === 'SYN-0903' && l.category === 'cannot price')!;
    expect(held).toMatchObject({ amountCents: null, ownerName: 'Avery Brooks' });
    expect(held.missingEvidence).toMatch(/contract price for NP-TIB-4/);
    expect(lines.lines.filter((l: any) => l.caseRef === 'SYN-0903' && l.category === 'waiting on held line')).toHaveLength(2);
    await tx(async (db) => bill.resolveCharge(db, fin, held.chargeId, { decision: 'charge', unitPriceCents: 205000, reason: 'PVS amendment 2 (synthetic)' }));
    const hist = (await tx(async (db) => db.query(`select kind, from_price_cents, to_price_cents, approved_by from charge_events where charge_id=$1 order by id`, [held.chargeId]))).rows;
    expect(hist.map((h: any) => h.kind)).toEqual(['derived', 'price_set']);
    expect(hist[1]).toMatchObject({ from_price_cents: null, to_price_cents: 205000, approved_by: fin.userId });
    const pk = await tx(async (db) => bill.generatePacket(db, fin, c));
    await tx(async (db) => bill.queuePacketToErp(db, fin, pk.packet.id));
    await processOutboxForTenant(T1);
    const items = (await tx(async (db) => db.query(`select catalog_item_id, sum(qty)::int qty, max(unit_price_cents) p from charges where packet_id=$1 group by 1 order by 3 desc`, [pk.packet.id]))).rows;
    const p1 = await tx(async (db) => bill.enterPO(db, fin, pk.packet.id, { poNumber: 'SP-1', lines: items.slice(0, 2).map((l: any) => ({ catalogItemId: l.catalog_item_id, qty: l.qty, unitPriceCents: l.p })) }));
    expect(p1.status).toBe('partial');
    let f = await tx(async (db) => bill.caseFinancials(db, c));
    expect(f.packets[0].status).toBe('po_partial');
    expect(f.outstandingCents).toBe(items[2].p * items[2].qty);
    expect((await err(tx(async (db) => bill.acceptPacket(db, fin, pk.packet.id, { customerReference: 'x' }))))?.status).toBe(409);
    // Correct one charge by credit: outstanding drops, no inventory movement, implant stays consumed.
    const big = await tx(async (db) => one(db, `select ch.id, ue.stock_item_id from charges ch join usage_events ue on ue.id=ch.usage_event_id where ch.packet_id=$1 and ch.catalog_item_id=$2`, [pk.packet.id, items[2].catalog_item_id]));
    const mv = await count(`select count(*) n from inventory_movements`);
    await tx(async (db) => bill.issueCredit(db, fin, big.id, { amountCents: 5000, reason: 'Price correction', idempotencyKey: 'e-cr' }));
    f = await tx(async (db) => bill.caseFinancials(db, c));
    expect(f.outstandingCents).toBe(items[2].p * items[2].qty - 5000);
    expect(await count(`select count(*) n from inventory_movements`)).toBe(mv);
    expect((await balanceOf(big.stock_item_id))[0]).toMatchObject({ kind: 'consumed', qty: 1 });
    // Remaining PO completes coverage.
    const p2 = await tx(async (db) => bill.enterPO(db, fin, pk.packet.id, { poNumber: 'SP-2', lines: [{ catalogItemId: items[2].catalog_item_id, qty: items[2].qty, unitPriceCents: items[2].p }] }));
    expect(p2.status).toBe('matched');
    f = await tx(async (db) => bill.caseFinancials(db, c));
    expect(f.packets[0].status).toBe('po_matched');
    expect(f.outstandingCents).toBe(0);
    // Billing reconciles to dispositions and contract rules: every recorded usage has exactly one non-void charge.
    expect(await count(`select count(*) n from usage_events ue where ue.case_id=$1 and ue.status='recorded' and (select count(*) from charges ch where ch.usage_event_id=ue.id and ch.status<>'void') <> 1`, [c])).toBe(0);
  });
});

describe('F. Access boundaries added in the second pass', () => {
  beforeAll(freshSeed);
  it('hospital users cannot reach integrations, preference cards, other-facility issues, or widen export filters', async () => {
    const { as } = await httpApp();
    const sbr = await as(SBR_RECV);
    expect((await sbr.get('/api/integrations')).statusCode).toBe(403);
    const card = await tx(async (db) => one(db, `select id from preference_card_versions limit 1`));
    expect((await sbr.get(`/api/cards/${card.id}`)).statusCode).toBe(403);
    expect((await sbr.get('/api/exports/cases.csv?facility=PVS')).body).not.toContain('SYN-1002');
    // Issues from Prairie Valley are invisible to St. Brigid staff (board sync creates them first).
    await (await as(OPS)).get('/api/board');
    const pvsIssue = await tx(async (db) => one(db, `select i.id from case_issues i join cases c on c.id=i.case_id where c.case_ref='SYN-1002' limit 1`));
    expect((await sbr.post(`/api/issues/${pvsIssue.id}/ack`, {})).statusCode).toBe(404);
    expect((await sbr.post(`/api/issues/${pvsIssue.id}/note`, { note: 'x' })).statusCode).toBe(404);
    const ho = (await sbr.get('/api/handoff')).json();
    expect(JSON.stringify(ho)).not.toContain('SYN-1002');
    const notes = (await sbr.get('/api/notifications')).json();
    expect(JSON.stringify(notes)).not.toContain('SYN-1002');
  });
});
