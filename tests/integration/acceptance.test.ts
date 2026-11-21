import { beforeAll, describe, expect, it } from 'vitest';
import { freshSeed, ctxFor, tx, caseId, reqId, stock, balanceOf, count, httpApp, T1, T2, withTenant, one } from './helpers.js';
import { reserve, ledgerReconciliation, applyMovement, reverseMovement } from '../../src/server/domain/inventory.js';
import { rescueSearch, reserveAndTransfer } from '../../src/server/domain/rescue.js';
import { moveCase, cancelCase, caseReadiness } from '../../src/server/domain/cases.js';
import * as ship from '../../src/server/domain/shipments.js';
import { recordUsage, submitCloseout } from '../../src/server/domain/closeout.js';
import * as bill from '../../src/server/domain/billing.js';
import * as rec from '../../src/server/domain/recall.js';
import * as counts from '../../src/server/domain/counts.js';
import { runImport } from '../../src/server/domain/imports.js';
import { processOutboxForTenant, ingestAck } from '../../src/server/domain/erp.js';
import { buildGs1 } from '../../src/shared/gs1.js';
import { GTIN } from '../../src/server/seed/seed.js';

const OPS = 'ops@lakeshore.example', RILEY = 'riley.rep@lakeshore.example', JORDAN = 'jordan.rep@lakeshore.example', WH = 'warehouse@lakeshore.example';
const COURIER = 'courier@lakeshore.example', SBR_RECV = 'receiving@stbrigid.example', SBR_SPD = 'spd@stbrigid.example', PVS_RECV = 'receiving@prairievalley.example';
const FIN = 'finance@lakeshore.example', Q1 = 'quality@lakeshore.example', Q2 = 'quality2@lakeshore.example', INV = 'inventory@lakeshore.example', SCHED = 'scheduler@lakeshore.example';

async function err(p: Promise<any>) { try { await p; return null; } catch (e: any) { return e; } }

/** Drive SYN-1001 from the seeded state to "ready" exactly like the demo script, returning ids. */
async function runDemoToReady() {
  const c1 = await caseId('SYN-1001');
  const insReq = await reqId('SYN-1001', 'NP-INS-4-10');
  const ops = await ctxFor(OPS), wh = await ctxFor(WH), jordan = await ctxFor(JORDAN), courier = await ctxFor(COURIER), recv = await ctxFor(SBR_RECV), spd = await ctxFor(SBR_SPD);
  const ins2 = await stock('INS-0002');
  const trunk = await tx(async (db) => one(db, `select id from locations where code='TRUNK-JORDAN'`));
  const dist = await tx(async (db) => one(db, `select id from parties where kind='distributor'`));
  const xfr = await tx(async (db) => reserveAndTransfer(db, ops, c1, insReq, { stockItemId: ins2.id, locationId: trunk.id, ownerPartyId: dist.id, idempotencyKey: 'demo-xfr-1' }));
  const planned = await tx(async (db) => ship.planCaseDelivery(db, ops, c1));
  const trayShip = planned.created[0];
  // Warehouse picks/packs/dispatches the tray; Jordan dispatches the trunk transfer.
  await tx(async (db) => {
    const d = await ship.shipmentDetail(db, wh, trayShip.id);
    for (const l of d.lines) await ship.pickLine(db, wh, trayShip.id, { lineId: l.id, qty: 1, serial: l.serial_number });
    await ship.packShipment(db, wh, trayShip.id);
    await ship.dispatchShipment(db, wh, trayShip.id, {});
    const x = await ship.shipmentDetail(db, jordan, xfr.shipment.id);
    await ship.pickLine(db, jordan, xfr.shipment.id, { lineId: x.lines[0].id, qty: 1, serial: 'INS-0002' });
    await ship.dispatchShipment(db, jordan, xfr.shipment.id, {});
  });
  for (const s of [trayShip.id, xfr.shipment.id]) await tx(async (db) => ship.courierEvent(db, courier, s, { type: 'delivered' }));
  return { c1, insReq, ops, wh, recv, spd, trayShip, xfr };
}

describe('Concurrency: last unit', () => {
  beforeAll(freshSeed);
  it('two simultaneous reservations of the last serialized unit produce exactly one success', async () => {
    const ops = await ctxFor(OPS), jordan = await ctxFor(JORDAN);
    const ins2 = await stock('INS-0002');
    const [c1, c3] = [await caseId('SYN-1001'), await caseId('SYN-1003')];
    const trunk = await tx(async (db) => one(db, `select id from locations where code='TRUNK-JORDAN'`));
    const dist = await tx(async (db) => one(db, `select id from parties where kind='distributor'`));
    const results = await Promise.allSettled([
      tx(async (db) => reserve(db, ops, { caseId: c1, requirementId: null, stockItemId: ins2.id, locationId: trunk.id, ownerPartyId: dist.id, qty: 1 })),
      tx(async (db) => reserve(db, jordan, { caseId: c3, requirementId: null, stockItemId: ins2.id, locationId: trunk.id, ownerPartyId: dist.id, qty: 1 })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    expect(await count(`select count(*) n from reservations where stock_item_id=$1 and status='active'`, [ins2.id])).toBe(1);
  });

  it('a lot-controlled last unit raced by 5 requests yields exactly one success', async () => {
    const ops = await ctxFor(OPS);
    const screws = await stock('S26B088');
    const trunk = await tx(async (db) => one(db, `select id from locations where code='TRUNK-RILEY'`));
    const dist = await tx(async (db) => one(db, `select id from parties where kind='distributor'`));
    const c3 = await caseId('SYN-1003');
    await tx(async (db) => reserve(db, ops, { caseId: c3, stockItemId: screws.id, locationId: trunk.id, ownerPartyId: dist.id, qty: 4 }));
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => tx(async (db) => reserve(db, ops, { caseId: c3, stockItemId: screws.id, locationId: trunk.id, ownerPartyId: dist.id, qty: 1 }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count(`select coalesce(sum(qty),0) n from reservations r join locations l on l.id=r.location_id where stock_item_id=$1 and l.code='TRUNK-RILEY' and status='active'`, [screws.id])).toBe(5);
  });

  it('two users racing through the HTTP rescue endpoint for the same unit: one transfer only', async () => {
    const { as } = await httpApp();
    const c1 = await caseId('SYN-1001'); const r = await reqId('SYN-1001', 'NP-INS-4-12');
    const u = await stock('INS12-0001');
    const wh = await tx(async (db) => one(db, `select id from locations where code='WH-MAIN'`));
    const dist = await tx(async (db) => one(db, `select id from parties where kind='distributor'`));
    const body = (k: string) => ({ stockItemId: u.id, locationId: wh.id, ownerPartyId: dist.id, idempotencyKey: k });
    const [a, b] = await Promise.all([(await as(OPS)).post(`/api/cases/${c1}/rescue/${r}/reserve`, body('k-a')), (await as(RILEY)).post(`/api/cases/${c1}/rescue/${r}/reserve`, body('k-b'))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await count(`select count(*) n from shipments where kind='rescue_transfer'`)).toBe(1);
  });
});

describe('Case changes', () => {
  beforeAll(freshSeed);
  it('moving a case reveals downstream conflicts and alerts owners', async () => {
    const sched = await ctxFor(SCHED);
    const c3 = await caseId('SYN-1003');
    const c1 = await tx(async (db) => one(db, `select scheduled_start from cases where case_ref='SYN-1001'`));
    const res = await tx(async (db) => moveCase(db, sched, c3, { scheduledStart: new Date(c1.scheduled_start).toISOString(), reason: 'OR block swap' }));
    const kinds = res.conflicts.map((c: any) => c.kind);
    expect(kinds).toContain('tray_turnaround');
    expect(kinds).toContain('uncovered');
    const rep = await ctxFor(RILEY);
    expect(await count(`select count(*) n from notifications where user_id=$1 and kind='case_moved'`, [rep.userId])).toBe(1);
  });
  it('moving a case past a reserved unit expiry releases that reservation', async () => {
    const sched = await ctxFor(SCHED);
    const c3 = await caseId('SYN-1003');
    const res = await tx(async (db) => moveCase(db, sched, c3, { scheduledStart: '2028-06-01T15:00:00Z', reason: 'Surgery postponed' }));
    expect(res.released).toBe(1);
  });
  it('canceling a case releases all of its reservations', async () => {
    const sched = await ctxFor(SCHED);
    const c1 = await caseId('SYN-1001');
    const before = await count(`select count(*) n from reservations where case_id=$1 and status='active'`, [c1]);
    expect(before).toBeGreaterThan(0);
    const r = await tx(async (db) => cancelCase(db, sched, c1, { reason: 'Patient rescheduled (synthetic)' }));
    expect(r.released).toBe(before);
    expect(await count(`select count(*) n from reservations where case_id=$1 and status='active'`, [c1])).toBe(0);
    const tray = await stock('TRY-K-002');
    expect(await count(`select count(*) n from reservations where stock_item_id=$1 and status='active'`, [tray.id])).toBe(0);
  });
  it('cases can only be created from an approved preference card version', async () => {
    const { as } = await httpApp();
    const draft = await tx(async (db) => one(db, `select id from preference_card_versions where status='draft'`));
    const fac = await tx(async (db) => one(db, `select id from facilities where code='SBR'`));
    const rep = await ctxFor(RILEY);
    const r = await (await as(SCHED)).post('/api/cases', { facilityId: fac.id, cardVersionId: draft.id, scheduledStart: '2026-11-25T14:00:00Z', repUserId: rep.userId });
    expect(r.statusCode).toBe(409);
  });
});

describe('Rescue search, handoff, tray verification and hospital release', () => {
  beforeAll(freshSeed);
  it('excludes expired, held and already-reserved units with visible reasons, and never offers substitutes', async () => {
    const ops = await ctxFor(OPS);
    const s = await tx(async (db) => rescueSearch(db, ops, await caseId('SYN-1001'), await reqId('SYN-1001', 'NP-INS-4-10')));
    const byLabel = (l: string) => s.excluded.find((e: any) => e.label === l);
    expect(byLabel('SN INS-0004').reasons.join(' ')).toMatch(/Expires .* before planned use/);
    expect(byLabel('SN INS-0006').reasons.join(' ')).toMatch(/quality hold/);
    expect(byLabel('SN INS-0001').reasons.join(' ')).toMatch(/Reserved for case SYN-1003/);
    expect(byLabel('SN INS-0003').reasons.join(' ')).toMatch(/Owned by Prairie Valley/);
    expect(byLabel('SN INS-0004').closerThanBest).toBe(true);
    expect(s.eligible.map((e: any) => e.label)).toEqual(['SN INS-0002']);
    expect(s.eligible[0]).toMatchObject({ meetsCutoff: true, travelMinutes: 95 });
    // Exact item only: every candidate is the required catalog item.
    const refs = await tx(async (db) => db.query(`select distinct ci.ref from stock_items s join catalog_items ci on ci.id=s.catalog_item_id where s.id = any($1)`, [[...s.eligible, ...s.excluded].map((e: any) => e.stockItemId)]));
    expect(refs.rows.map((r: any) => r.ref)).toEqual(['NP-INS-4-10']);
  });

  let ids: any;
  it('a courier delivery scan alone does not make the case ready', async () => {
    ids = await runDemoToReady();
    const r = await tx(async (db) => caseReadiness(db, ids.c1));
    expect(r.status).not.toBe('ready');
    expect(r.blockers.map((b: any) => b.code)).toContain('delivered_unreceived');
  });

  it('a delivered tray with a missing required instrument stays blocked; a rep cannot record hospital release', async () => {
    const { recv, c1, trayShip, xfr } = ids;
    for (const s of [trayShip.id, xfr.shipment.id]) {
      await tx(async (db) => { const d = await ship.shipmentDetail(db, recv, s); await ship.receiveShipment(db, recv, s, { lines: d.lines.map((l: any) => ({ lineId: l.id, qtyReceived: l.qty_dispatched, sealIntact: true })) }); });
    }
    const tray = await stock('TRY-K-002');
    const sizer = await tx(async (db) => one(db, `select id from catalog_items where ref='NP-INST-SIZER'`));
    const m = await tx(async (db) => ship.trayManifest(db, tray.id));
    const v = await tx(async (db) => ship.verifyTray(db, recv, tray.id, { caseId: c1, sealIntact: true, lines: m.lines.map((l: any) => ({ catalogItemId: l.catalog_item_id, actualQty: l.catalog_item_id === sizer.id ? 0 : l.qty })) }));
    expect(v.result).toBe('incomplete');
    const r = await tx(async (db) => caseReadiness(db, c1));
    expect(r.status).toBe('blocked');
    expect(r.blockers.find((b: any) => b.code === 'tray_incomplete')?.message).toMatch(/Femoral sizer/);
    // Rep cannot record hospital release (role), nor can the other hospital's staff, nor can ops resolve the discrepancy by note.
    const rep = await ctxFor(RILEY);
    expect((await err(tx(async (db) => ship.recordRelease(db, rep, c1, { trayStockItemId: tray.id, decision: 'released', evidence: { hospital_processing_record_ref: 'X' } }))))?.status).toBe(403);
    const pvs = await ctxFor(PVS_RECV);
    expect([403, 404]).toContain((await err(tx(async (db) => ship.recordRelease(db, pvs, c1, { trayStockItemId: tray.id, decision: 'released', evidence: { hospital_processing_record_ref: 'X' } }))))?.status);
    const spd = await ctxFor(SBR_SPD);
    expect((await err(tx(async (db) => ship.recordRelease(db, spd, c1, { trayStockItemId: tray.id, decision: 'released', evidence: { hospital_processing_record_ref: 'X' } }))))?.status).toBe(409);
    const d = await tx(async (db) => one(db, `select id from discrepancies where kind='missing_instrument' and status='open'`));
    expect((await err(tx(async (db) => ship.resolveDiscrepancy(db, ids.ops, d.id, { resolution: 'found it' }))))?.status).toBe(409);
    // HTTP layer: the rep is refused too.
    const { as } = await httpApp();
    const res = await (await as(RILEY)).post(`/api/cases/${c1}/release`, { trayStockItemId: tray.id, decision: 'released', evidence: { hospital_processing_record_ref: 'X' } });
    expect(res.statusCode).toBe(403);
  });

  it('after a replacement is received and the tray re-verified, SBR SPD records release and the case becomes ready', async () => {
    const { ops, wh, recv, spd, c1 } = ids;
    const sizerUnit = await stock('SZ-0207');
    const locs = await tx(async (db) => db.query(`select code, id from locations`).then((r) => Object.fromEntries(r.rows.map((x: any) => [x.code, x.id]))));
    const mfr = await tx(async (db) => one(db, `select id from parties where kind='manufacturer'`));
    const rs = await tx(async (db) => ship.createShipment(db, ops, { fromLocationId: locs['WH-MAIN'], toLocationId: locs['SBR-RECV'], caseId: c1, kind: 'case_delivery', lines: [{ stockItemId: sizerUnit.id, ownerPartyId: mfr.id, qty: 1 }] }));
    await tx(async (db) => { const d = await ship.shipmentDetail(db, wh, rs.id); await ship.pickLine(db, wh, rs.id, { lineId: d.lines[0].id, qty: 1 }); await ship.dispatchShipment(db, wh, rs.id, {}); });
    await tx(async (db) => { const d = await ship.shipmentDetail(db, recv, rs.id); await ship.receiveShipment(db, recv, rs.id, { lines: [{ lineId: d.lines[0].id, qtyReceived: 1, sealIntact: true }] }); });
    const tray = await stock('TRY-K-002');
    const m = await tx(async (db) => ship.trayManifest(db, tray.id));
    expect((await tx(async (db) => ship.verifyTray(db, recv, tray.id, { caseId: c1, sealIntact: true, lines: m.lines.map((l: any) => ({ catalogItemId: l.catalog_item_id, actualQty: l.qty })) }))).result).toBe('complete');
    let r = await tx(async (db) => caseReadiness(db, c1));
    expect(r.blockers.map((b: any) => b.code)).toEqual(['awaiting_release']);
    expect((await err(tx(async (db) => ship.recordRelease(db, spd, c1, { trayStockItemId: tray.id, decision: 'released', evidence: {} }))))?.status).toBe(400);
    await tx(async (db) => ship.recordRelease(db, spd, c1, { trayStockItemId: tray.id, decision: 'released', evidence: { hospital_processing_record_ref: 'SBR-LOAD-7781' } }));
    r = await tx(async (db) => caseReadiness(db, c1));
    expect(r.status).toBe('ready');
    expect(await count(`select count(*) n from discrepancies where kind='missing_instrument' and status='resolved'`)).toBe(1);
  });

  it('receiving handles partial shipments, unexpected units, broken seals and rejected deliveries', async () => {
    const ops = await ctxFor(OPS), wh = await ctxFor(WH), recv = await ctxFor(SBR_RECV);
    const locs = await tx(async (db) => db.query(`select code, id from locations`).then((r) => Object.fromEntries(r.rows.map((x: any) => [x.code, x.id]))));
    const dist = await tx(async (db) => one(db, `select id from parties where kind='distributor'`));
    const screws = await stock('S26B088');
    const fem5 = await stock('FEM5L-0301');
    const s = await tx(async (db) => ship.createShipment(db, ops, { fromLocationId: locs['WH-MAIN'], toLocationId: locs['SBR-RECV'], kind: 'replenishment', lines: [{ stockItemId: screws.id, ownerPartyId: dist.id, qty: 10 }, { stockItemId: fem5.id, ownerPartyId: dist.id, qty: 1 }] }));
    await tx(async (db) => { const d = await ship.shipmentDetail(db, wh, s.id); const sl = d.lines.find((l: any) => l.ref === 'NP-SCR-650'); const fl = d.lines.find((l: any) => l.ref === 'NP-FEM-5L');
      await ship.pickLine(db, wh, s.id, { lineId: sl.id, qty: 6 }); await ship.pickLine(db, wh, s.id, { lineId: fl.id, qty: 1 }); await ship.dispatchShipment(db, wh, s.id, {}); });
    expect(await count(`select count(*) n from exceptions where kind='partial_shipment'`)).toBe(1);
    await tx(async (db) => { const d = await ship.shipmentDetail(db, recv, s.id); const sl = d.lines.find((l: any) => l.ref === 'NP-SCR-650'); const fl = d.lines.find((l: any) => l.ref === 'NP-FEM-5L');
      await ship.receiveShipment(db, recv, s.id, { lines: [{ lineId: sl.id, qtyReceived: 5, sealIntact: true }, { lineId: fl.id, qtyReceived: 1, sealIntact: false }], unexpected: [{ description: 'NP-INS-4-12 SN INS12-9999', serial: 'INS12-9999' }] }); });
    const kinds = (await tx(async (db) => db.query(`select kind from discrepancies where shipment_id=$1 order by kind`, [s.id]))).rows.map((r: any) => r.kind);
    expect(kinds).toEqual(['broken_seal', 'short', 'unexpected_unit']);
    expect(await balanceOf(fem5.id)).toEqual([{ code: 'SBR-RECV', kind: 'hospital_receiving', condition: 'damaged', qty: 1 }]);
    expect((await balanceOf(screws.id)).find((b: any) => b.code === 'IN-TRANSIT')?.qty).toBe(1);
    expect(await count(`select count(*) n from stock_items where serial_number='INS12-9999'`)).toBe(0);
    expect((await err(tx(async (db) => ship.closeHandoff(db, recv, s.id))))?.status).toBe(409);
    // Rejected delivery
    const s2 = await tx(async (db) => ship.createShipment(db, ops, { fromLocationId: locs['WH-MAIN'], toLocationId: locs['SBR-RECV'], kind: 'replenishment', lines: [{ stockItemId: screws.id, ownerPartyId: dist.id, qty: 2 }] }));
    await tx(async (db) => { const d = await ship.shipmentDetail(db, wh, s2.id); await ship.pickLine(db, wh, s2.id, { lineId: d.lines[0].id, qty: 2 }); await ship.dispatchShipment(db, wh, s2.id, {}); });
    await tx(async (db) => ship.rejectShipment(db, recv, s2.id, { reason: 'Arrived outside receiving hours without notice' }));
    expect((await tx(async (db) => one(db, `select status from shipments where id=$1`, [s2.id]))).status).toBe('rejected');
    const custody = (await tx(async (db) => db.query(`select event_type, actor_user_id, occurred_at, recorded_at, ack_state from custody_events where shipment_id=$1 order by recorded_at`, [s2.id]))).rows;
    expect(custody.map((c: any) => c.event_type)).toEqual(['dispatched', 'rejected']);
    for (const c of custody) expect(c.actor_user_id && c.occurred_at && c.recorded_at && c.ack_state).toBeTruthy();
  });
});

describe('Closeout, packages, offline sync, billing and ERP', () => {
  beforeAll(freshSeed);
  it('a scan of a package of five never silently changes stock by one or by twenty-five', async () => {
    const rep = await ctxFor(RILEY);
    const c1 = await caseId('SYN-1001');
    const screws = await stock('S26B088');
    const before = await balanceOf(screws.id);
    const box = buildGs1({ gtin: GTIN.SCR_650_BOX5, lot: 'S26B088', expiry: screws.expiry_date }, { symbologyId: true });
    const r1 = await tx(async (db) => recordUsage(db, rep, { clientEventId: 'pkg-1', caseId: c1, disposition: 'implanted', entryMethod: 'scanner', rawScan: box }));
    expect(r1.status).toBe('needs_review');
    expect(r1.reviewReason).toMatch(/Package-level label \(5 units per package\)/);
    expect(r1.usageEvent.qty_units).toBeNull();
    expect(await balanceOf(screws.id)).toEqual(before);
    const r2 = await tx(async (db) => recordUsage(db, rep, { clientEventId: 'pkg-2', caseId: c1, disposition: 'implanted', entryMethod: 'scanner', rawScan: box, qtyUnits: 2 }));
    expect(r2.status).toBe('recorded');
    expect(r2.usageEvent).toMatchObject({ qty_units: 2, units_per_package: 5, package_gtin: GTIN.SCR_650_BOX5 });
    const trunkBefore = before.find((b: any) => b.code === 'TRUNK-RILEY').qty;
    expect((await balanceOf(screws.id)).find((b: any) => b.code === 'TRUNK-RILEY').qty).toBe(trunkBefore - 2);
    // Import at package level converts with the configured units per package (1 box = 5), never 1 or 25.
    const inv = await ctxFor(INV);
    const rep2 = await tx(async (db) => runImport(db, inv, { kind: 'opening_balances', filename: 'pkg.csv', sourceSystem: 'TEST', mode: 'commit',
      csv: `source_id,owner,location_code,item_ref,lot,serial,expiry,package_level,quantity,uom\nPK-T1,Lakeshore Orthopedic Partners (synthetic),WH-MAIN,NP-SCR-650,S26B088,,${screws.expiry_date},inner,1,BX\nPK-T2,Lakeshore Orthopedic Partners (synthetic),WH-MAIN,NP-SCR-650,S26B088,,${screws.expiry_date},case,1,CS\nPK-T3,Lakeshore Orthopedic Partners (synthetic),WH-MAIN,NP-SCR-650,S26B088,,2030-01-01,each,1,EA\n` }));
    expect(rep2.rows[0]).toMatchObject({ status: 'accepted', units: 5 });
    expect(rep2.rows[1].status).toBe('error');
    expect(rep2.rows[1].errors.join(' ')).toMatch(/not guessed/);
    expect(rep2.rows[2].errors.join(' ')).toMatch(/conflicts with recorded expiry/);
  });

  it('replaying an import creates no duplicate stock and reports already-imported rows', async () => {
    const inv = await ctxFor(INV);
    const csv = 'source_id,owner,location_code,item_ref,lot,serial,expiry,package_level,quantity,uom\nRP-1,Lakeshore Orthopedic Partners (synthetic),WH-MAIN,NP-SCR-650,S26B099,,2029-01-31,each,3,EA\nRP-2,Lakeshore Orthopedic Partners (synthetic),WH-MAIN,NP-INS-4-12,L26C020,INS12-0777,2028-01-31,each,1,EA\nRP-2,Lakeshore Orthopedic Partners (synthetic),WH-MAIN,NP-INS-4-12,L26C020,INS12-0777,2028-01-31,each,1,EA\n';
    const dry = await tx(async (db) => runImport(db, inv, { kind: 'opening_balances', filename: 'r.csv', sourceSystem: 'REPLAY', csv, mode: 'dry_run' }));
    expect(dry.counts).toMatchObject({ accepted: 2, duplicate_in_file: 1 });
    expect(dry.reconciliation.units_posted_to_ledger).toBe(0);
    const first = await tx(async (db) => runImport(db, inv, { kind: 'opening_balances', filename: 'r.csv', sourceSystem: 'REPLAY', csv, mode: 'commit' }));
    expect(first.reconciliation).toMatchObject({ units_posted_to_ledger: 4, ledger_matches: true });
    const movesBefore = await count(`select count(*) n from inventory_movements`);
    const second = await tx(async (db) => runImport(db, inv, { kind: 'opening_balances', filename: 'r.csv', sourceSystem: 'REPLAY', csv, mode: 'commit' }));
    expect(second.counts.already_imported).toBe(2);
    expect(await count(`select count(*) n from inventory_movements`)).toBe(movesBefore);
    const changed = csv.replace('S26B099,,2029-01-31,each,3', 'S26B099,,2029-01-31,each,4');
    const third = await tx(async (db) => runImport(db, inv, { kind: 'opening_balances', filename: 'r2.csv', sourceSystem: 'REPLAY', csv: changed, mode: 'commit' }));
    expect(third.counts.conflict).toBe(1);
    const prov = await tx(async (db) => one(db, `select s.data_source, s.import_batch_id from stock_items s where s.serial_number='INS12-0777'`));
    expect(prov).toMatchObject({ data_source: 'import', import_batch_id: first.batch_id });
  });

  it('offline sync replay and ERP ack replay create no duplicate movement, charge or replenishment', async () => {
    const { as } = await httpApp();
    const c1 = await caseId('SYN-1001');
    const rep = await as(RILEY);
    const pkg = await rep.get(`/api/offline/cases/${c1}/package`);
    expect(pkg.statusCode).toBe(200);
    expect((await (await as(JORDAN)).get(`/api/offline/cases/${c1}/package`)).statusCode).toBe(404);
    const fem = await stock('FEM4L-0101');
    const ev = { clientEventId: 'off-fem-1', caseId: c1, disposition: 'implanted', entryMethod: 'simulator', occurredAt: '2026-11-21T13:00:00Z',
      rawScan: buildGs1({ gtin: GTIN.FEM_4L, lot: fem.lot_number, serial: 'FEM4L-0101', expiry: fem.expiry_date }, { symbologyId: true }) };
    const s1 = await rep.post('/api/offline/sync', { events: [ev] });
    const s2 = await rep.post('/api/offline/sync', { events: [ev, ev] });
    expect(s1.json().results[0].state).toBe('synced');
    expect(s2.json().results.every((r: any) => r.replayed)).toBe(true);
    const ue = await tx(async (db) => one(db, `select * from usage_events where client_event_id='off-fem-1'`));
    expect(new Date(ue.occurred_at).toISOString()).toBe('2026-11-21T13:00:00.000Z');
    expect(ue.recorded_offline).toBe(true);
    expect(await count(`select count(*) n from inventory_movements where usage_event_id=$1`, [ue.id])).toBe(1);
    expect(await count(`select count(*) n from charges where usage_event_id=$1`, [ue.id])).toBe(1);
    expect(await count(`select count(*) n from replenishments where usage_event_id=$1`, [ue.id])).toBe(1);
  });

  it('opened-unused is chargeable under one agreement and needs review under another; neither is recorded as implanted', async () => {
    // SBR: opened-unused charge. PVS: review.
    const riley = await ctxFor(RILEY), jordan = await ctxFor(JORDAN);
    const c1 = await caseId('SYN-1001'), c2 = await caseId('SYN-1002');
    const tib = await stock('TIB4-0201');
    const a = await tx(async (db) => recordUsage(db, riley, { clientEventId: 'ou-sbr', caseId: c1, disposition: 'opened_unused', entryMethod: 'scanner', rawScan: buildGs1({ gtin: GTIN.TIB_4, lot: tib.lot_number, serial: 'TIB4-0201', expiry: tib.expiry_date }) }));
    expect(a.status).toBe('recorded');
    const fem = await stock('FEM4L-0104');
    const b = await tx(async (db) => recordUsage(db, jordan, { clientEventId: 'ou-pvs', caseId: c2, disposition: 'opened_unused', entryMethod: 'scanner', rawScan: buildGs1({ gtin: GTIN.FEM_4L, lot: fem.lot_number, serial: 'FEM4L-0104', expiry: fem.expiry_date }) }));
    expect(b.status).toBe('recorded');
    const ca = await tx(async (db) => one(db, `select * from charges where usage_event_id=$1`, [a.usageEvent.id]));
    const cb = await tx(async (db) => one(db, `select * from charges where usage_event_id=$1`, [b.usageEvent.id]));
    expect(ca).toMatchObject({ status: 'draft', amount_cents: 215000 });
    expect(ca.rationale).toMatch(/v3/);
    expect(cb.status).toBe('review');
    for (const id of [tib.id, fem.id]) {
      expect(await count(`select count(*) n from inventory_movements m join locations l on l.id=m.to_location_id where m.stock_item_id=$1 and l.kind='consumed'`, [id])).toBe(0);
      expect((await balanceOf(id))[0].condition).toBe('opened');
    }
    expect(await count(`select count(*) n from usage_events where client_event_id in ('ou-sbr','ou-pvs') and disposition='implanted'`)).toBe(0);
    const csv = await tx(async (db) => bill.usageReportCsv(db, riley, c1));
    expect(csv).toMatch(/opened_unused,NP-TIB-4/);
  });

  it('a finance credit corrects the charge without returning the consumed implant to stock; duplicate packets are prevented', async () => {
    const rep = await ctxFor(RILEY), fin = await ctxFor(FIN);
    const c1 = await caseId('SYN-1001');
    // Finish closeout: tray/screws/insert reservations need dispositions; insert was never reserved in this seed state, so return the tray only.
    await tx(async (db) => submitCloseout(db, rep, c1, {}));
    const pk = await tx(async (db) => bill.generatePacket(db, fin, c1));
    const again = await tx(async (db) => bill.generatePacket(db, fin, c1));
    expect(again.replayed).toBe(true);
    expect(again.packet.id).toBe(pk.packet.id);
    expect(pk.packet.packet_type).toBe('bill_and_replace');
    const fem = await stock('FEM4L-0101');
    const ch = await tx(async (db) => one(db, `select ch.* from charges ch join usage_events ue on ue.id=ch.usage_event_id where ue.stock_item_id=$1`, [fem.id]));
    const movesBefore = await count(`select count(*) n from inventory_movements`);
    await tx(async (db) => bill.issueCredit(db, fin, ch.id, { amountCents: 20000, reason: 'Contract price correction (synthetic)', idempotencyKey: 'cr-1' }));
    await tx(async (db) => bill.issueCredit(db, fin, ch.id, { amountCents: 20000, reason: 'Contract price correction (synthetic)', idempotencyKey: 'cr-1' }));
    expect(await count(`select count(*) n from credits where charge_id=$1`, [ch.id])).toBe(1);
    expect(await count(`select count(*) n from inventory_movements`)).toBe(movesBefore);
    expect(await balanceOf(fem.id)).toEqual([{ code: 'CONSUMED', kind: 'consumed', condition: 'used', qty: 1 }]);
    const f = await tx(async (db) => bill.caseFinancials(db, c1));
    expect(f.netCents).toBe(f.grossCents - 20000);
    // ERP: queue, deliver via worker (with one injected failure + retry), replay ack -> no duplicates. Never "paid".
    await tx(async (db) => db.query(`update integration_feeds set mock_fail_next=1 where code='erp-mock'`));
    await tx(async (db) => bill.queuePacketToErp(db, fin, pk.packet.id));
    await tx(async (db) => bill.queuePacketToErp(db, fin, pk.packet.id));
    expect(await count(`select count(*) n from outbox where aggregate_id=$1`, [pk.packet.id])).toBe(1);
    const r1 = await processOutboxForTenant(T1);
    expect(r1.delivered).toBe(0);
    await tx(async (db) => db.query(`update outbox set next_attempt_at='2000-01-01' where aggregate_id=$1`, [pk.packet.id]));
    await processOutboxForTenant(T1);
    const ob = await tx(async (db) => one(db, `select * from outbox where aggregate_id=$1`, [pk.packet.id]));
    expect(ob).toMatchObject({ status: 'acknowledged', attempts: 2 });
    const ack = await tx(async (db) => one(db, `select * from erp_acks where outbox_id=$1`, [ob.id]));
    const dup = await tx(async (db) => ingestAck(db, T1, { outboxId: ack.outbox_id, externalDocRef: ack.external_doc_ref, ackType: ack.ack_type, payload: ack.payload }));
    expect(dup.duplicate).toBe(true);
    expect(await count(`select count(*) n from erp_acks where outbox_id=$1`, [ob.id])).toBe(1);
    const p = await tx(async (db) => one(db, `select status from billing_packets where id=$1`, [pk.packet.id]));
    expect(p.status).toBe('erp_received_simulated');
    // PO mismatch flagged, duplicate PO number refused.
    const lines = (await tx(async (db) => db.query(`select catalog_item_id, sum(qty)::int qty, max(unit_price_cents) p from charges where packet_id=$1 group by 1`, [pk.packet.id]))).rows;
    const mis = await tx(async (db) => bill.enterPO(db, fin, pk.packet.id, { poNumber: 'SYN-PO-1', lines: lines.map((l: any) => ({ catalogItemId: l.catalog_item_id, qty: l.qty + 1, unitPriceCents: l.p })) }));
    expect(mis.issues.length).toBeGreaterThan(0);
    expect((await err(tx(async (db) => bill.enterPO(db, fin, pk.packet.id, { poNumber: 'SYN-PO-1', lines: [] }))))?.status).toBe(409);
  });
});

describe('Recall while a device is offline', () => {
  beforeAll(freshSeed);
  it('blocks new allocation, preserves later-reported prior use, and creates a review task', async () => {
    const { as } = await httpApp();
    const c1 = await caseId('SYN-1001');
    const ops = await ctxFor(OPS), q1 = await ctxFor(Q1), q2 = await ctxFor(Q2);
    // Rep has the case downloaded and the trunk unit reserved for it (rescue), then goes offline.
    const ins2 = await stock('INS-0002');
    const trunk = await tx(async (db) => one(db, `select id from locations where code='TRUNK-JORDAN'`));
    const dist = await tx(async (db) => one(db, `select id from parties where kind='distributor'`));
    const x = await tx(async (db) => reserveAndTransfer(db, ops, c1, await reqId('SYN-1001', 'NP-INS-4-10'), { stockItemId: ins2.id, locationId: trunk.id, ownerPartyId: dist.id, idempotencyKey: 'rc-x' }));
    const jordan = await ctxFor(JORDAN), sbr = await ctxFor(SBR_RECV);
    await tx(async (db) => { const d = await ship.shipmentDetail(db, jordan, x.shipment.id); await ship.pickLine(db, jordan, x.shipment.id, { lineId: d.lines[0].id, qty: 1 }); await ship.dispatchShipment(db, jordan, x.shipment.id, {}); });
    await tx(async (db) => { const d = await ship.shipmentDetail(db, sbr, x.shipment.id); await ship.receiveShipment(db, sbr, x.shipment.id, { lines: [{ lineId: d.lines[0].id, qtyReceived: 1, sealIntact: true }] }); });
    const rep = await as(RILEY);
    expect((await rep.get(`/api/offline/cases/${c1}/package`)).statusCode).toBe(200);
    const usedAt = '2026-11-21T13:59:00.000Z'; // captured on the device before the recall existed
    // While the device is offline, quality enters, verifies (second person) and activates a recall on lot L26C014.
    const item = await tx(async (db) => one(db, `select id, manufacturer_party_id from catalog_items where ref='NP-INS-4-10'`));
    const r = await tx(async (db) => rec.createRecall(db, q1, { manufacturerPartyId: item.manufacturer_party_id, catalogItemId: item.id, scopeType: 'lot', scopeValues: ['L26C014'], noticeRef: 'NP-FSN-2026-11 (synthetic)', description: 'Insert locking-feature dimension out of tolerance (synthetic)' }));
    expect((await err(tx(async (db) => rec.verifyRecall(db, q1, r.id, { confirmScope: ['L26C014'] }))))?.status).toBe(409);
    expect((await err(tx(async (db) => rec.activateRecall(db, q1, r.id))))?.status).toBe(409);
    await tx(async (db) => rec.verifyRecall(db, q2, r.id, { confirmScope: ['L26C014'] }));
    const detail = await tx(async (db) => rec.activateRecall(db, q1, r.id));
    expect(detail.inventory.map((i: any) => i.serial_number).sort()).toEqual(['INS-0001', 'INS-0002', 'INS-0003']);
    expect(detail.summary.unitsByLocationKind).toMatchObject({ warehouse: 1, hospital_receiving: 1, consignment: 1 });
    expect(detail.tasks.filter((t: any) => t.task_type === 'open_case_alert').length).toBeGreaterThanOrEqual(2);
    // New allocation is blocked: direct reservation, rescue search, and dispatch.
    const c3 = await caseId('SYN-1003');
    const ins1 = await stock('INS-0001');
    await tx(async (db) => db.query(`update reservations set status='released' where stock_item_id=$1`, [ins1.id]));
    const wh = await tx(async (db) => one(db, `select id from locations where code='WH-MAIN'`));
    expect((await err(tx(async (db) => reserve(db, ops, { caseId: c3, stockItemId: ins1.id, locationId: wh.id, ownerPartyId: dist.id, qty: 1 }))))?.code).toBe('on_hold');
    const s = await tx(async (db) => rescueSearch(db, ops, c3, await reqId('SYN-1003', 'NP-INS-4-10')));
    expect(s.eligible.find((e: any) => e.lot === 'L26C014')).toBeUndefined();
    const sbrRecv = await tx(async (db) => one(db, `select id from locations where code='SBR-RECV'`));
    const sh = await tx(async (db) => ship.createShipment(db, ops, { fromLocationId: wh.id, toLocationId: sbrRecv.id, kind: 'replenishment', lines: [{ stockItemId: ins1.id, ownerPartyId: dist.id, qty: 1 }] }));
    const whc = await ctxFor(WH);
    expect((await err(tx(async (db) => { const d = await ship.shipmentDetail(db, whc, sh.id); await ship.pickLine(db, whc, sh.id, { lineId: d.lines[0].id, qty: 1 }); })))?.code).toBe('on_hold');
    // Device reconnects and reports actual prior use (scanned before the hold).
    const sync = await rep.post('/api/offline/sync', { events: [{ clientEventId: 'late-ins', caseId: c1, disposition: 'implanted', entryMethod: 'scanner', occurredAt: usedAt,
      rawScan: buildGs1({ gtin: GTIN.INS_4_10, lot: 'L26C014', serial: 'INS-0002', expiry: ins2.expiry_date }, { symbologyId: true }) }] });
    expect(sync.statusCode).toBe(200);
    const ue = await tx(async (db) => one(db, `select * from usage_events where client_event_id='late-ins'`));
    expect(ue).toMatchObject({ status: 'recorded', recorded_offline: true, disposition: 'implanted' });
    expect(await count(`select count(*) n from audit_log where action='usage.sync_offline' and entity_id=$1`, [ue.id])).toBe(1);
    expect(await count(`select count(*) n from recall_tasks where task_type='late_usage_review' and usage_event_id=$1`, [ue.id])).toBe(1);
    expect(await count(`select count(*) n from exceptions where kind='recall_late_usage' and status='open'`)).toBe(1);
    const task = await tx(async (db) => one(db, `select detail from recall_tasks where usage_event_id=$1`, [ue.id]));
    expect(task.detail).toMatch(/BEFORE the hold/);
    // The recall now traces the completed-case reference separately and still shows remaining units.
    const after = await tx(async (db) => rec.recallDetail(db, r.id));
    expect(after.completedUsage.map((u: any) => u.case_ref)).toEqual(['SYN-1001']);
    expect(after.inventory.map((i: any) => i.serial_number).sort()).toEqual(['INS-0001', 'INS-0003']);
  });
});

describe('Facility and tenant isolation', () => {
  beforeAll(freshSeed);
  it('a facility user cannot discover another facility case through search, URLs, exports or notifications', async () => {
    const { as } = await httpApp();
    const sbr = await as(SBR_RECV);
    const c2 = await caseId('SYN-1002');
    expect((await sbr.get(`/api/cases/${c2}`)).statusCode).toBe(404);
    expect((await sbr.get(`/api/cases/${c2}/rescue/x`)).statusCode).toBe(403);
    expect((await sbr.get(`/api/search?q=SYN-1002`)).json().cases).toEqual([]);
    expect((await sbr.get(`/api/search?q=SYN`)).json().cases.map((c: any) => c.case_ref)).not.toContain('SYN-1002');
    expect((await sbr.get(`/api/search?q=INS-0003`)).json().stock).toEqual([]);
    const board = (await sbr.get('/api/board')).json();
    expect(board.cases.map((c: any) => c.caseRef)).not.toContain('SYN-1002');
    const exp = (await sbr.get('/api/exports/cases.csv')).body;
    expect(exp).toContain('SYN-1001'); expect(exp).not.toContain('SYN-1002');
    expect((await sbr.get('/api/exports/ledger.csv')).statusCode).toBe(404);
    const ships = (await sbr.get('/api/shipments')).json();
    for (const s of ships) expect(s.to_name + s.from_name).toMatch(/St\. Brigid/);
    // Notifications: a PVS-only event never reaches SBR staff.
    const pvsShip = await tx(async (db) => db.query(`select s.id from shipments s join locations l on l.id=s.to_location_id where l.code='PVS-RECV' limit 1`).then((r) => r.rows[0]));
    expect((await sbr.get(`/api/shipments/${pvsShip.id}`)).statusCode).toBe(404);
    const sbrUser = await ctxFor(SBR_RECV);
    const leaked = await count(`select count(*) n from notifications n join cases c on c.id=n.case_id where n.user_id=$1 and c.facility_id <> $2`, [sbrUser.userId, sbrUser.facilityId]);
    expect(leaked).toBe(0);
    expect(await count(`select count(*) n from notifications where user_id=$1 and facility_id is distinct from $2`, [sbrUser.userId, sbrUser.facilityId])).toBe(0);
  });

  it('another tenant cannot read Lakeshore data through API, search, guessed IDs, exports or background jobs', async () => {
    const { as } = await httpApp();
    const rw = await as('ops@ridgeway.example');
    const c1 = await caseId('SYN-1001');
    expect((await rw.get(`/api/cases/${c1}`)).statusCode).toBe(404);
    expect((await rw.get('/api/search?q=SYN-1001')).json().cases).toEqual([]);
    expect((await rw.get('/api/board')).json().cases.map((c: any) => c.caseRef)).toEqual(['RDG-2001']);
    const exp = (await rw.get('/api/exports/cases.csv')).body;
    expect(exp).not.toContain('SYN-'); expect(exp).toContain('RDG-2001');
    expect((await rw.get('/api/inventory?q=INS-0002')).json()).toEqual([]);
    // Database row-level security: a tenant-2 transaction sees no tenant-1 rows even without a WHERE clause.
    const leaked = await withTenant(T2, async (db) => (await db.query(`select count(*)::int n from cases where case_ref like 'SYN-%'`)).rows[0].n);
    expect(leaked).toBe(0);
    const unscoped = await (await import('../../src/server/db.js')).q(`select count(*)::int n from cases`);
    expect(unscoped[0].n).toBe(0); // no tenant set => no rows
    // Background job for tenant 2 never touches tenant 1's outbox.
    await tx(async (db) => db.query(`insert into outbox(tenant_id,feed_code,topic,aggregate_id,payload,idempotency_key,status,next_attempt_at,created_at) values ($1,'erp-mock','test',gen_random_uuid(),'{}','iso-1','pending',now(),now())`, [T1]));
    const r = await processOutboxForTenant(T2);
    expect(r.processed).toBe(0);
    // CSRF header is required on state-changing calls.
    const { app } = await httpApp();
    const noCsrf = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OPS, password: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('Ledger integrity and cycle counts', () => {
  beforeAll(freshSeed);
  it('a ledger rebuild matches displayed balances after transfers, returns, adjustments and corrections; history cannot be rewritten', async () => {
    const ops = await ctxFor(OPS), wh = await ctxFor(WH), inv = await ctxFor(INV);
    const screws = await stock('S26B088');
    const locs = await tx(async (db) => db.query(`select code, id from locations`).then((r) => Object.fromEntries(r.rows.map((x: any) => [x.code, x.id]))));
    const dist = await tx(async (db) => one(db, `select id from parties where kind='distributor'`));
    const mv = await tx(async (db) => applyMovement(db, ops, { stockItemId: screws.id, qty: 3, ownerPartyId: dist.id, from: { locationId: locs['WH-MAIN'], condition: 'sealed' }, to: { locationId: locs['TRUNK-RILEY'], condition: 'sealed' }, type: 'transfer', reason: 'Trunk top-up' }));
    await tx(async (db) => applyMovement(db, ops, { stockItemId: screws.id, qty: 1, ownerPartyId: dist.id, from: { locationId: locs['TRUNK-RILEY'], condition: 'sealed' }, to: { locationId: locs['WH-MAIN'], condition: 'sealed' }, type: 'return', reason: 'Return from trunk' }));
    await tx(async (db) => reverseMovement(db, ops, mv.id, 'Keyed against wrong trunk'));
    expect((await err(tx(async (db) => reverseMovement(db, ops, mv.id, 'again'))))?.status).toBe(409);
    const s = await tx(async (db) => counts.startCount(db, wh, { locationId: locs['TRUNK-RILEY'] }));
    await tx(async (db) => counts.addCountLine(db, wh, s.id, { ref: 'NP-SCR-650', lot: 'S26B088', countedQty: 3 }));
    const sub = await tx(async (db) => counts.submitCount(db, wh, s.id));
    // Blind while open; variance visible after submission.
    expect(sub.blind).toBe(false);
    expect((await err(tx(async (db) => counts.reviewCount(db, wh, s.id, { decision: 'approve', note: 'self' }))))?.status).toBe(403);
    await tx(async (db) => counts.reviewCount(db, inv, s.id, { decision: 'approve', note: 'Recounted' }));
    const recon = await tx(async (db) => ledgerReconciliation(db));
    expect(recon.matches).toBe(true);
    expect(recon.differences).toEqual([]);
    // Append-only enforcement at the database.
    expect((await err(tx(async (db) => db.query(`update inventory_movements set qty=99 where id=$1`, [mv.id])))).message).toMatch(/append-only/);
    expect((await err(tx(async (db) => db.query(`delete from audit_log`))))?.message).toMatch(/append-only/);
    // Displayed balances (API) equal the rebuilt ledger.
    const { as } = await httpApp();
    const api = (await (await as(OPS)).get('/api/ledger/reconcile')).json();
    expect(api.matches).toBe(true);
  });

  it('blind count hides expected quantities while open', async () => {
    const wh = await ctxFor(WH);
    const loc = await tx(async (db) => one(db, `select id from locations where code='WH-MAIN'`));
    const s = await tx(async (db) => counts.startCount(db, wh, { locationId: loc.id }));
    const v = await tx(async (db) => counts.addCountLine(db, wh, s.id, { ref: 'NP-FEM-5L', serial: 'FEM5L-0301', countedQty: 1 }));
    expect(v.blind).toBe(true);
    expect(v.lines[0].expected_qty).toBeNull();
  });
});
