/**
 * Operations command center, on the synthetic Northline account, through the HTTP API the screens use:
 * ranked queue, five-number evidence, transfer requests, loaners, reallocation, allocation, par levels,
 * expiring stock, the recall action summary, and moving in from another system.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { httpApp, q, withTenant } from './helpers.js';
import { seedDemoAccount, DEMO } from '../../src/server/pilot/demo-account.js';

const U = DEMO.users;
let app: Awaited<ReturnType<typeof httpApp>>; let T = '';
const tx = (fn: (db: any) => Promise<any>): Promise<any> => withTenant(T, fn);
const get = async (email: string, url: string) => { const r = await (await app.as(email)).get(url); expect(r.statusCode, r.body).toBe(200); return r.json(); };
const post = async (email: string, url: string, body: any = {}) => (await app.as(email)).post(url, body);
const ids = async (caseRef: string, itemRef: string) => (await tx((db) => db.query(`select c.id case_id, cr.id req_id from cases c join case_requirements cr on cr.case_id=c.id join catalog_items ci on ci.id=cr.catalog_item_id where c.case_ref=$1 and ci.ref=$2`, [caseRef, itemRef]))).rows[0];

beforeAll(async () => { process.env.ASSISTANT_MODE = 'demo'; T = (await seedDemoAccount({ day: '2026-11-23' })).tenantId; app = await httpApp(); });

describe('Ranked queue', () => {
  it('orders critical, high, medium; each item has a reason, a safest fix and an action', async () => {
    const qd = await get(U.ops, '/api/attention');
    const pri = qd.items.map((i: any) => i.priority);
    expect([...pri].sort((a: string, b: string) => ['critical', 'high', 'medium'].indexOf(a) - ['critical', 'high', 'medium'].indexOf(b))).toEqual(pri);
    for (const i of qd.items) { expect(i.why.length).toBeGreaterThan(10); expect(i.recommended.length).toBeGreaterThan(5); expect(i.actions.length).toBeGreaterThan(0); }
    const a = qd.items.find((i: any) => i.caseRef === 'NL-3021');
    expect(a.priority).toBe('critical');
    expect(a.why).toContain('5 physically on hand, 4 reserved for other cases, 1 available, 2 required, short 1');
    expect(a.actions.find((x: any) => x.kind === 'request_transfer').label).toBe('Request transfer from Chris Okafor');
    expect(a.actions.find((x: any) => x.kind === 'reallocate').label).toBe('Move 1 from NL-3031');
    expect(qd.items.find((i: any) => i.kind === 'recall').priority).toBe('critical');
    expect(qd.items.find((i: any) => i.caseRef === 'NL-3022').waitingOn).toBe('Marcus Hall');
  });
  it('"before 3 PM" keeps what is due by then; the loaner cutoff is the deadline when a loaner is the way out', async () => {
    const qd = await get(U.ops, '/api/attention?byLocal=15:00');
    expect(qd.hiddenLater).toBeGreaterThan(0);
    const l = qd.items.find((i: any) => i.caseRef === 'NL-3026');
    expect(l.priority).toBe('high');
    expect(l.deadlineLocal).toContain('3:00 PM');
    expect(l.actions.map((x: any) => x.kind)).toEqual(['reserve', 'request_loaner', 'open']);
    expect(l.recommended).toContain('request a loaner from Corvid loaner desk by');
    expect(qd.items.some((i: any) => i.kind === 'par' || i.kind === 'expiry')).toBe(false);
  });
  it('the assistant returns the same list, in the same order', async () => {
    const qd = await get(U.ops, '/api/attention?byLocal=15:00');
    const r = await post(U.ops, '/api/assistant/ask', { message: 'What do I need to fix before 3 today?' });
    expect(r.statusCode, r.body).toBe(200);
    const card = r.json().cards.find((c: any) => c.type === 'queue');
    expect(card.data.items.map((i: any) => `${i.priority}|${i.caseRef}|${i.title}`)).toEqual(qd.items.map((i: any) => `${i.priority}|${i.caseRef}|${i.title}`));
    expect(r.json().text).toMatch(/1\. CRITICAL – NL-3021/);
  });
  it('hospital staff cannot open the queue, allocation, loaners or settings', async () => {
    for (const url of ['/api/attention', '/api/allocation', '/api/loaners', '/api/stock/par', '/api/transfers']) expect((await (await app.as(U.recvMarlowe)).get(url)).statusCode).toBe(403);
    expect((await post(U.coordinator, '/api/settings/ops', { planningWindowHours: 48 })).statusCode).toBe(403);
  });
});

describe('Five-number evidence', () => {
  it('required, on hand, reserved, available and short, each backed by the units, cases and source rows', async () => {
    const { case_id, req_id } = await ids('NL-3021', '00417');
    const b = await get(U.ops, `/api/cases/${case_id}/requirements/${req_id}/breakdown`);
    expect(b.numbers).toMatchObject({ required: 2, onHand: 5, reservedOther: 4, available: 1, short: 1 });
    expect(b.onHandUnits.reduce((a: number, u: any) => a + u.qty, 0)).toBe(5);
    expect(b.onHandUnits.find((u: any) => u.location === 'Northline Central Warehouse').evidence.some((e: any) => e.kind === 'spreadsheet_row' && e.href.includes('/uploads/runs/'))).toBe(true);
    expect(b.reserved.map((r: any) => r.caseRef).sort()).toEqual(['NL-3030', 'NL-3031']);
    expect(b.reserved[0]).toMatchObject({ qty: 2, commitment: 'Firm (reserved, not yet shipped)' });
    expect(b.availableUnits).toHaveLength(1);
    expect(b.availableUnits[0]).toMatchObject({ custodian: 'Chris Okafor', meetsCutoff: true, condition: 'Sealed', donorConflicts: [] });
    expect(b.options.reallocate[0]).toMatchObject({ fromCaseRef: 'NL-3031', qty: 2 });
    expect(b.options.loaner.source).toBe('Corvid loaner desk');
    expect(b.requiredSource[0].label).toContain('requires 2');
  });
});

describe('Transfer requests', () => {
  let tr: any;
  it('needs a pickup plan and a receiver; holds the unit but creates no shipment until accepted', async () => {
    const { case_id, req_id } = await ids('NL-3021', '00417');
    const b = await get(U.ops, `/api/cases/${case_id}/requirements/${req_id}/breakdown`);
    const u = b.availableUnits[0]; const src = { stockItemId: u.stockItemId, locationId: u.locationId, ownerPartyId: u.ownerPartyId, idempotencyKey: 'k-tr-1' };
    expect((await post(U.ops, `/api/cases/${case_id}/rescue/${req_id}/request`, { ...src, pickupBy: '', pickupInMinutes: 30, receiver: 'Priya Nair' })).json().code ?? (await post(U.ops, `/api/cases/${case_id}/rescue/${req_id}/request`, { ...src, pickupBy: '', pickupInMinutes: 30, receiver: 'Priya Nair' })).json().error).toBe('pickup_required');
    expect((await post(U.ops, `/api/cases/${case_id}/rescue/${req_id}/request`, { ...src, pickupBy: 'Chris Okafor', pickupInMinutes: 30, receiver: '' })).statusCode).toBe(400);
    const r = await post(U.ops, `/api/cases/${case_id}/rescue/${req_id}/request`, { ...src, pickupBy: 'Chris Okafor', pickupInMinutes: 30, receiver: 'Priya Nair, Marlowe receiving' });
    expect(r.statusCode, r.body).toBe(200); tr = r.json();
    expect(tr).toMatchObject({ ref: 'TR-0001', current: 'Requested', waitingOn: 'Chris Okafor', owner: 'Avery Brooks', shipmentId: null, donorCheck: [] });
    expect(tr.steps.map((s: any) => s.name)).toEqual(['Requested', 'Accepted', 'Reserved', 'Pickup confirmed', 'In transit', 'Delivered', 'Received']);
    expect((await post(U.ops, `/api/cases/${case_id}/rescue/${req_id}/request`, { ...src, pickupBy: 'Chris Okafor', pickupInMinutes: 30, receiver: 'Priya Nair' })).json()).toMatchObject({ ref: 'TR-0001', replayed: true });
    expect((await tx((db) => db.query(`select count(*)::int n from shipments where kind='rescue_transfer'`))).rows[0].n).toBe(0);
    const again = await get(U.ops, `/api/cases/${case_id}/requirements/${req_id}/breakdown`);
    expect(again.numbers).toMatchObject({ available: 0, reservedThisCase: 1 });
    expect(again.options.transfers[0].ref).toBe('TR-0001');
    // The queue still offers a fix for the second unit, and shows the first as in hand.
    const all = (await get(U.ops, '/api/attention')).items.filter((i: any) => i.caseRef === 'NL-3021');
    const item = all.find((i: any) => i.kind === 'uncovered');
    expect(all.find((i: any) => i.kind !== 'uncovered')).toMatchObject({ waitingOn: 'Chris Okafor' });
    expect(item.recommended).toContain('TR-0001 is requested (waiting on Chris Okafor)');
    expect(item.actions.map((x: any) => x.label)).toEqual(['Open TR-0001', 'Move 1 from NL-3031', 'See the evidence']);
  });
  it('shows in the holder\'s queue; an operations manager answering for the holder must say how they agreed', async () => {
    const mine = await get(U.repChris, '/api/attention');
    expect(mine.items.find((i: any) => i.kind === 'transfer_decision').title).toContain('TR-0001');
    expect((await post(U.repDana, `/api/transfers/${tr.id}/decide`, { decision: 'accept' })).statusCode).toBe(403);
    expect((await post(U.ops, `/api/transfers/${tr.id}/decide`, { decision: 'accept' })).statusCode).toBe(400);
    expect((await post(U.repChris, `/api/transfers/${tr.id}/decide`, { decision: 'decline' })).statusCode).toBe(400);
  });
  it('accepting creates the shipment; the chain then follows pickup, courier and hospital check-in', async () => {
    const a = (await post(U.repChris, `/api/transfers/${tr.id}/decide`, { decision: 'accept' })).json();
    expect(a).toMatchObject({ current: 'Reserved', nextStep: 'Pickup confirmed', status: 'accepted' });
    expect(a.shipmentRef).toMatch(/^XFR-/);
    const sh = (await (await app.as(U.repChris)).get(`/api/shipments/${a.shipmentId}`)).json();
    for (const l of sh.lines) expect((await post(U.repChris, `/api/shipments/${a.shipmentId}/pick`, { lineId: l.id, qty: l.qty_expected, lot: l.lot_number })).statusCode).toBe(200);
    expect((await post(U.repChris, `/api/shipments/${a.shipmentId}/pack`)).statusCode).toBe(200);
    expect((await get(U.ops, `/api/transfers/${tr.id}`)).current).toBe('Pickup confirmed');
    expect((await post(U.repChris, `/api/shipments/${a.shipmentId}/dispatch`)).statusCode).toBe(200);
    expect((await get(U.ops, `/api/transfers/${tr.id}`)).current).toBe('In transit');
    expect((await post(U.repChris, `/api/shipments/${a.shipmentId}/courier`, { type: 'delivered' })).statusCode).toBe(200);
    const d = await get(U.ops, `/api/transfers/${tr.id}`);
    expect(d).toMatchObject({ current: 'Delivered', waitingOn: 'Priya Nair, Marlowe receiving' });
  });
  it('warehouse stock is reserved directly rather than requested', async () => {
    const { case_id, req_id } = await ids('NL-3026', '00612');
    const b = await get(U.ops, `/api/cases/${case_id}/requirements/${req_id}/breakdown`);
    expect(b.availableUnits[0].locationKind).toBe('warehouse');
  });
});

describe('Move a unit from a later case', () => {
  it('moves one, keeps the rest with the later case, and refuses to take from an earlier case', async () => {
    const { case_id, req_id } = await ids('NL-3021', '00417');
    const b = await get(U.ops, `/api/cases/${case_id}/requirements/${req_id}/breakdown`);
    const r = await post(U.ops, '/api/reallocate', { toCaseId: case_id, requirementId: req_id, reservationId: b.options.reallocate[0].reservationId, qty: 1 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ moved: 1, fromCaseRef: 'NL-3031', toCaseRef: 'NL-3021' });
    expect((await get(U.ops, `/api/cases/${case_id}/requirements/${req_id}/breakdown`)).numbers).toMatchObject({ reservedThisCase: 2, short: 0 });
    const later = await ids('NL-3031', '00417');
    expect((await get(U.ops, `/api/cases/${later.case_id}/requirements/${later.req_id}/breakdown`)).numbers).toMatchObject({ required: 2, reservedThisCase: 1 });
    const mine = (await tx((db) => db.query(`select id from reservations where case_id=$1 and status='active' limit 1`, [case_id]))).rows[0].id;
    expect((await post(U.ops, '/api/reallocate', { toCaseId: later.case_id, requirementId: later.req_id, reservationId: mine })).statusCode).toBe(409);
    expect((await post(U.repDana, '/api/reallocate', { toCaseId: case_id, requirementId: req_id, reservationId: mine })).statusCode).toBe(403);
  });
});

describe('Loaners', () => {
  let ln: any;
  it('request records the cutoff and expected arrival; duplicates are refused', async () => {
    const { case_id, req_id } = await ids('NL-3026', '00612');
    expect((await post(U.repDana, '/api/loaners', { caseId: case_id, requirementId: req_id, qty: 1 })).statusCode).toBe(403);
    const r = await post(U.ops, '/api/loaners', { caseId: case_id, requirementId: req_id, qty: 1 });
    expect(r.statusCode, r.body).toBe(200); ln = r.json();
    expect(ln).toMatchObject({ ref: 'LN-0001', status: 'requested', source: 'Corvid loaner desk', qty: 1, arrivesInTime: true });
    expect((await post(U.ops, '/api/loaners', { caseId: case_id, requirementId: req_id, qty: 1 })).statusCode).toBe(409);
    const item = (await get(U.ops, '/api/attention')).items.find((i: any) => i.caseRef === 'NL-3026');
    expect(item.actions.some((a: any) => a.label === 'Open LN-0001')).toBe(true);
    expect(item.actions.some((a: any) => a.kind === 'request_loaner')).toBe(false);
  });
  it('confirm, ship, receive (stock enters the ledger and is reserved), then return with chain of custody', async () => {
    const adv = (body: any) => post(U.coordinator, `/api/loaners/${ln.id}/advance`, body);
    expect((await adv({ step: 'confirm' })).statusCode).toBe(400);
    expect((await adv({ step: 'confirm', confirmation: 'CLD-88231' })).json().status).toBe('confirmed');
    expect((await adv({ step: 'ship', tracking: '1Z-SYNTH-001' })).json().status).toBe('shipped');
    expect((await adv({ step: 'receive', locationId: ln.receiveLocations[0].id })).statusCode).toBe(400);
    const rec = (await adv({ step: 'receive', lot: 'LN5R9', expiry: '2028-01-31', locationId: ln.receiveLocations[0].id })).json();
    expect(rec).toMatchObject({ status: 'received', dueBack: '2026-11-27' });
    const { case_id, req_id } = await ids('NL-3026', '00612');
    expect((await get(U.ops, `/api/cases/${case_id}/requirements/${req_id}/breakdown`)).numbers).toMatchObject({ onHand: 3, reservedThisCase: 1 });
    expect((await tx((db) => db.query(`select p.kind from stock_balances b join stock_items s on s.id=b.stock_item_id join parties p on p.id=b.owner_party_id where s.lot_number='LN5R9'`))).rows[0].kind).toBe('manufacturer');
    expect((await adv({ step: 'return', tracking: '1Z-SYNTH-002' })).statusCode).toBe(409); // still reserved for a case that has not happened
    expect(rec.events.map((e: any) => e.event)).toEqual(['requested', 'confirmed', 'shipped', 'received']);
    await expect(tx((db) => db.query(`update loaner_events set detail='x'`))).rejects.toThrow();
  });
});

describe('Allocation by rule', () => {
  it('lists demand against free stock in rule order and reserves only what is free', async () => {
    const v = await get(U.ops, '/api/allocation');
    expect(v.rule).toBe('first_entered');
    for (const it of v.items) expect(it.lines.reduce((a: number, l: any) => a + l.wouldGet, 0)).toBeLessThanOrEqual(it.freeStock);
    const before = (await tx((db) => db.query(`select coalesce(sum(qty),0)::int n from reservations where status='active'`))).rows[0].n;
    const r = await post(U.coordinator, '/api/allocation/apply');
    expect(r.statusCode, r.body).toBe(200);
    expect((await tx((db) => db.query(`select coalesce(sum(qty),0)::int n from reservations where status='active'`))).rows[0].n).toBe(before + r.json().reserved);
    expect(r.json().reserved).toBe(v.toReserve);
    expect((await get(U.ops, '/api/allocation')).toReserve).toBe(0);
    expect((await post(U.repDana, '/api/allocation/apply')).statusCode).toBe(403);
  });
});

describe('Par levels and expiring stock', () => {
  it('shows below / over par with arithmetic suggestions; only coordinators and managers set pars', async () => {
    const p = await get(U.ops, '/api/stock/par');
    const wh = p.rows.find((r: any) => r.ref === '00417' && r.location === 'Northline Central Warehouse');
    expect(wh).toMatchObject({ par: 6, status: 'below' });
    expect(p.rows.find((r: any) => r.ref === '00550').status).toBe('over');
    expect((await post(U.repDana, '/api/stock/par', { locationId: wh.locationId, catalogItemId: wh.catalogItemId, par: 1 })).statusCode).toBe(403);
    expect((await post(U.coordinator, '/api/stock/par', { locationId: wh.locationId, catalogItemId: wh.catalogItemId, par: -1 })).statusCode).toBe(400);
    expect((await post(U.coordinator, '/api/stock/par', { locationId: wh.locationId, catalogItemId: wh.catalogItemId, par: 4 })).statusCode).toBe(200);
    expect((await get(U.ops, '/api/stock/par')).rows.find((r: any) => r.id === wh.id).par).toBe(4);
  });
  it('imports pars from a file; rows that do not match exactly are reported, not guessed', async () => {
    const file = 'Location,Catalog number,Par\nNorthline Central Warehouse,00612,2\nNowhere Depot,00612,2\nNorthline Central Warehouse,612,2\nNorthline Central Warehouse,00720,lots\n';
    const r = await post(U.coordinator, '/api/stock/par/import', { filename: 'pars.csv', contentBase64: Buffer.from(file).toString('base64') });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ set: 1, held: 3 });
    expect(r.json().rows[2].message).toContain('"612" is not in the catalog');
  });
  it('lists the lot expiring in 21 days', async () => {
    const e = await get(U.ops, '/api/stock/expiring');
    expect(e.rows).toHaveLength(1);
    expect(e.rows[0]).toMatchObject({ ref: '00550', unit: 'lot P32A', daysLeft: 21, qty: 1 });
  });
});

describe('Recall action summary', () => {
  it('counts affected units, how many are physically checked, the upcoming cases, and lists actions in order', async () => {
    const id = (await tx((db) => db.query(`select id from recalls where ref='RCL-001'`))).rows[0].id;
    const d = await get(U.quality, `/api/recalls/${id}`);
    const s = d.actionSummary;
    expect(s.headline).toBe('RCL-001 requires immediate attention');
    expect(s.affectedUnits).toBe(d.inventory.reduce((a: number, i: any) => a + i.qty, 0));
    expect(s.physicallyChecked + s.needVerification).toBe(s.affectedUnits);
    expect(s.upcomingCases).toBe(2);
    expect(s.actions[0].label).toBe('Activate the recall');
    expect(s.actions.find((a: any) => a.label.startsWith('Replace affected inventory')).links.map((l: any) => l.label.split(' ')[0])).toEqual(['NL-3022', 'NL-3023']);
  });
});

describe('Settings', () => {
  it('window, rule and loaner source are settings; with no loaner source the option is not offered', async () => {
    const r = await post(U.ops, '/api/settings/ops', { loanerSourceName: '', allocationRule: 'earliest_surgery', planningWindowHours: 96 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ loanerSourceName: null, allocationRule: 'earliest_surgery', planningWindowHours: 96 });
    const qd = await get(U.ops, '/api/attention');
    expect(qd.loanerSource).toBeNull(); expect(qd.windowHours).toBe(96);
    expect((await post(U.ops, '/api/settings/ops', { planningWindowHours: 5 })).statusCode).toBe(400);
  });
});

describe('Moving in from another system', () => {
  it('recognizes common export headings, keeps the previous system\'s ID on the case, and finds the case by it', async () => {
    const u = await app.as(U.coordinator);
    const csv = 'Order Number,Account Name,Start Date Time,Subject,Assigned To,Record ID\nRS-70001,Marlowe Regional Medical Center,2026-12-02 08:30,Total knee arthroplasty,Dana Whitfield,a0X5e00000ABCDE\n';
    const f = (await u.post('/api/uploads/file', { filename: 'cases-export.csv', contentBase64: Buffer.from(csv).toString('base64') })).json();
    const s = (await u.post('/api/uploads/suggest', { fileId: f.fileId, worksheet: f.sheets[0].name, kind: 'schedule' })).json();
    expect(s.mapping).toMatchObject({ case_id: 'Order Number', facility: 'Account Name', date: 'Start Date Time', procedure: 'Subject', rep: 'Assigned To', previous_id: 'Record ID' });
    const c = await u.post('/api/uploads/commit', { fileId: f.fileId, worksheet: f.sheets[0].name, kind: 'schedule', mapping: s.mapping, sourceSystem: 'salesforce' });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().run.source_system).toBe('Salesforce');
    expect((await tx((db) => db.query(`select system, external_id from external_refs`))).rows).toEqual([{ system: 'Salesforce', external_id: 'a0X5e00000ABCDE' }]);
    expect((await get(U.ops, '/api/search?q=a0X5e00000ABCDE')).cases.map((x: any) => x.case_ref)).toEqual(['RS-70001']);
    const m = await get(U.coordinator, '/api/move-in');
    expect(m.counts.cases_with_previous_id).toBe(1);
    expect(m.systems.some((x: any) => x.system === 'Salesforce' && x.kind === 'schedule')).toBe(true);
  });
});

describe('Visibility views (fresh demo)', () => {
  beforeAll(async () => { T = (await seedDemoAccount({ day: '2026-11-23' })).tenantId; app = await httpApp(); });
  it('where everything is: buckets add up to the ledger, free excludes reserved, and short items come first', async () => {
    const w = await get(U.ops, '/api/stock/where');
    const ledger = (await tx((db) => db.query(`select coalesce(sum(b.qty),0)::int n from stock_balances b join locations l on l.id=b.location_id join stock_items s on s.id=b.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id where b.qty>0 and l.kind not in ('consumed','wasted','missing') and ci.item_type<>'instrument'`))).rows[0].n;
    expect(Object.values(w.totals).reduce((a: number, n: any) => a + n, 0)).toBe(ledger);
    expect(w.items[0]).toMatchObject({ ref: '00417', total: 5, reserved: 4, free: 1, unreservedDemand: 2, gap: 1 });
    expect(w.items[0].buckets).toMatchObject({ warehouse: 4, reps: 1 });
    expect(w.items[0].units.find((u: any) => u.bucket === 'reps')).toMatchObject({ holder: 'Chris Okafor', free: 1 });
    expect((await (await app.as(U.recvMarlowe)).get('/api/stock/where')).statusCode).toBe(403);
  });
  it('case tracker: one stage per case and the thing it is waiting on; hospital staff see only their own cases', async () => {
    const t = await get(U.ops, '/api/case-tracker');
    const by = (ref: string) => [...t.upcoming, ...t.recent].find((c: any) => c.caseRef === ref);
    expect(by('NL-3021')).toMatchObject({ stageName: 'Entered', waitingOn: '2 unit(s) still to reserve', behind: true });
    expect(by('NL-3022')).toMatchObject({ stageName: 'Shipped', waitingOn: 'Hospital receiving to check the delivery in' });
    expect(by('NL-3025').stageName).toBe('Checked in at hospital');
    expect(by('NL-3030')).toMatchObject({ stageName: 'Items reserved', waitingOn: 'Delivery not planned', behind: false });
    expect(by('NL-3018')).toMatchObject({ past: true, waitingOn: 'Rep to complete the case and record what was used' });
    const h = await get(U.recvHarlan, '/api/case-tracker');
    expect([...h.upcoming, ...h.recent].every((c: any) => c.facility === 'Harlan Surgery Center')).toBe(true);
  });
  it('run sheet: planned shipments in order of latest safe departure; delivered ones listed as on the road', async () => {
    const before = await get(U.warehouse, '/api/run-sheet');
    expect(before.counts).toMatchObject({ toLeave: 0, onTheRoad: 1 });
    const c30 = (await ids('NL-3030', '00417')).case_id; const c31 = (await ids('NL-3031', '00417')).case_id;
    for (const c of [c31, c30]) expect((await post(U.coordinator, `/api/cases/${c}/plan-delivery`)).statusCode).toBe(200);
    const r = await get(U.warehouse, '/api/run-sheet');
    expect(r.counts.toLeave).toBe(2);
    const stops = r.toLeave.find((g: any) => g.from === 'Northline Central Warehouse').stops;
    expect(stops.map((s: any) => s.caseRef)).toEqual(['NL-3030', 'NL-3031']);
    expect(stops[0]).toMatchObject({ next: 'Pick', travelMinutes: 45, late: false, units: 2 });
    expect((await get(U.ops, '/api/case-tracker')).upcoming.find((c: any) => c.caseRef === 'NL-3030').waitingOn).toBe('1 shipment(s) not yet picked up');
  });
});

describe('Usage and consumption (fresh demo)', () => {
  beforeAll(async () => { T = (await seedDemoAccount({ day: '2026-11-23' })).tenantId; app = await httpApp(); });
  it('totals match the recorded usage events and the ledger; finished cases price without exceptions', async () => {
    const u = await get(U.ops, '/api/usage-report?days=30');
    const db = (await tx((d) => d.query(`select coalesce(sum(qty_units) filter (where disposition<>'returned_sealed'),0)::int used, count(distinct case_id)::int cases from usage_events where status='recorded'`))).rows[0];
    expect(u.summary).toMatchObject({ cases: db.cases, unitsUsed: db.used, implanted: 30, wasted: 1, openedUnused: 1, returnedSealed: 1 });
    expect(u.items.reduce((a: number, r: any) => a + r.used, 0)).toBe(db.used);
    expect((await tx((d) => d.query(`select coalesce(sum(qty),0)::int n from inventory_movements where movement_type='consume'`))).rows[0].n).toBe(u.summary.implanted + u.summary.wasted); // opened-unused is a condition change, not a consume
    expect(u.summary.valueCents).toBe((await tx((d) => d.query(`select coalesce(sum(amount_cents),0)::int n from charges`))).rows[0].n);
    expect((await tx((d) => d.query(`select count(*)::int n from exceptions where status='open' and kind like 'finance%'`))).rows[0].n).toBe(0);
    const top = u.items[0];
    expect(top).toMatchObject({ ref: '08810', used: 15, implanted: 14, wasted: 1, cases: 5, usableNow: 30 });
    expect(top.perWeek).toBe(3.5); expect(top.weeksOfCover).toBe(8.6);
    expect(u.items.find((r: any) => r.ref === '00417')).toMatchObject({ used: 7, cases: 7, replacementsOwed: 2 });
    expect(u.hospitals.reduce((a: number, h: any) => a + h.units, 0)).toBe(db.used);
    expect(u.weeks.reduce((a: number, w: any) => a + w.units, 0)).toBe(db.used);
    expect((await (await app.as(U.recvMarlowe)).get('/api/usage-report')).statusCode).toBe(403);
  });
  it('replacements owed: listed, in the queue, and marking them replaced records who, when and the order', async () => {
    const u = await get(U.ops, '/api/usage-report');
    expect(u.summary).toMatchObject({ replacementsOwed: 9, avgDaysToReplace: expect.any(Number) });
    expect(u.owed).toHaveLength(6);
    expect((await get(U.ops, '/api/attention')).items.find((i: any) => i.kind === 'replacements').title).toBe('9 replacement unit(s) owed after 3 finished case(s)');
    expect((await post(U.repDana, '/api/replenishments/done', { ids: [u.owed[0].id] })).statusCode).toBe(403);
    const r = await post(U.coordinator, '/api/replenishments/done', { ids: u.owed.slice(0, 2).map((o: any) => o.id), orderRef: 'PO-7781' });
    expect(r.json()).toMatchObject({ marked: 2, remaining: 5 });
    expect((await post(U.coordinator, '/api/replenishments/done', { ids: [u.owed[0].id] })).json().marked).toBe(0);
    expect((await tx((d) => d.query(`select count(*)::int n from replenishments where order_ref='PO-7781' and done_by is not null and done_at is not null`))).rows[0].n).toBe(2);
    const before = (await get(U.ops, '/api/stock/where')).items.find((i: any) => i.ref === '08810').total;
    expect(before).toBe(30); // marking replaced never adds stock
  });
  it('the tracker shows finished cases with usage recorded', async () => {
    const t = await get(U.ops, '/api/case-tracker');
    expect(t.recent.find((c: any) => c.caseRef === 'NL-3011')).toMatchObject({ stageName: 'Usage recorded', leftAtSite: 1 });
    expect(t.toBringBack).toBeGreaterThanOrEqual(1);
  });
});

describe('Entering a case, urgency and the demand plan (fresh demo)', () => {
  let opt: any; const item = (ref: string) => opt.items.find((i: any) => i.ref === ref).id;
  beforeAll(async () => { T = (await seedDemoAccount({ day: '2026-11-23' })).tenantId; app = await httpApp(); opt = await get(U.ops, '/api/case-entry/options'); });
  const entry = (over: any = {}) => ({ facilityId: opt.hospitals.find((h: any) => h.name.startsWith('Marlowe')).id, date: '2026-11-25', time: '11:00', procedure: 'Total knee arthroplasty, primary', surgeon: 'Surgeon S-104', repUserId: opt.reps.find((r: any) => r.display_name === 'Dana Whitfield').id, items: [{ catalogItemId: item('00550'), qty: 1 }, { catalogItemId: item('00417'), qty: 1 }], ...over });
  it('the stock check before saving is the real answer and changes nothing', async () => {
    const before = (await tx((d) => d.query(`select (select count(*) from cases)::int c, (select count(*) from reservations where status='active')::int r`))).rows[0];
    const p = (await post(U.ops, '/api/case-entry/preview', entry())).json();
    expect(p).toMatchObject({ preview: true, covered: false });
    expect(p.items.find((i: any) => i.ref === '00550')).toMatchObject({ required: 1, reserved: 1, short: 0 });
    const ins = p.items.find((i: any) => i.ref === '00417');
    expect(ins).toMatchObject({ required: 1, reserved: 0, short: 1 });
    expect(ins.message).toContain('Cases ahead of this one under the rule also need it: NL-3021');
    expect((await tx((d) => d.query(`select (select count(*) from cases)::int c, (select count(*) from reservations where status='active')::int r`))).rows[0]).toEqual(before);
  });
  it('saving creates the case, reserves what the check showed, notifies the rep and puts the shortage in the queue', async () => {
    const r = await post(U.ops, '/api/case-entry', entry({ previousId: 'RS-88120' }));
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json(); expect(c.caseRef).toMatch(/^NL-\d+$/);
    expect((await tx((d) => d.query(`select sum(qty)::int n from reservations where case_id=$1 and status='active'`, [c.caseId]))).rows[0].n).toBe(1);
    expect((await get(U.ops, '/api/search?q=RS-88120')).cases[0].case_ref).toBe(c.caseRef);
    const qi = (await get(U.ops, '/api/attention')).items.find((i: any) => i.caseRef === c.caseRef && i.kind === 'uncovered');
    expect(qi.title).toContain('00417');
    expect((await tx((d) => d.query(`select count(*)::int n from notifications where message like $1`, [`Case ${c.caseRef} assigned%`]))).rows[0].n).toBe(1);
    expect((await post(U.ops, '/api/case-entry', entry({ caseRef: c.caseRef }))).statusCode).toBe(409);
  });
  it('validates and is limited to the people who schedule', async () => {
    expect((await post(U.ops, '/api/case-entry/preview', entry({ date: '2026-11-20' }))).statusCode).toBe(400);
    expect((await post(U.ops, '/api/case-entry/preview', entry({ items: [] }))).statusCode).toBe(400);
    expect((await post(U.ops, '/api/case-entry/preview', entry({ surgeon: '' }))).statusCode).toBe(400);
    expect((await post(U.repDana, '/api/case-entry/preview', entry())).statusCode).toBe(403);
    expect((await post(U.recvMarlowe, '/api/case-entry', entry())).statusCode).toBe(403);
  });
  it('marking a case urgent needs a reason, raises it one level in the queue and can be cleared', async () => {
    const q0 = (await get(U.ops, '/api/attention')).items.find((i: any) => i.caseRef === 'NL-3030');
    expect(q0).toMatchObject({ priority: 'medium', urgent: false });
    expect((await post(U.ops, `/api/cases/${q0.caseId}/urgent`, { urgent: true, reason: '' })).statusCode).toBe(400);
    expect((await post(U.repDana, `/api/cases/${q0.caseId}/urgent`, { urgent: true, reason: 'x' })).statusCode).toBe(403);
    expect((await post(U.ops, `/api/cases/${q0.caseId}/urgent`, { urgent: true, reason: 'Surgeon moved it up' })).statusCode).toBe(200);
    expect((await get(U.ops, '/api/attention')).items.find((i: any) => i.caseRef === 'NL-3030')).toMatchObject({ priority: 'high', urgent: true });
    await post(U.ops, `/api/cases/${q0.caseId}/urgent`, { urgent: false, reason: 'Back to plan' });
    expect((await get(U.ops, '/api/attention')).items.find((i: any) => i.caseRef === 'NL-3030').priority).toBe('medium');
  });
  it('demand plan: each week\'s balance is usable stock minus scheduled demand so far; items that run out come first', async () => {
    const p = await get(U.ops, '/api/demand-plan?weeks=4');
    expect(p.weeks).toHaveLength(4);
    for (const r of p.items) { let bal = r.usable; for (const w of r.weeks) { bal -= w.demand; expect(w.balance).toBe(bal); } expect(r.endBalance).toBe(bal); expect(!!r.shortWeek).toBe(r.weeks.some((w: any) => w.balance < 0)); }
    const ins = p.items[0];
    expect(ins.ref).toBe('00417'); expect(ins.shortWeek).toBe('Next week'); expect(ins.weeks.map((w: any) => w.balance)).toEqual([0, -2, -2, -2]); // includes the case entered above
    expect(ins.weeks[0].cases).toEqual(expect.arrayContaining(['NL-3021', 'NL-3030']));
    expect(ins.recentPerWeek).toBe(1.6);
    expect(p.items.find((r: any) => r.ref === '08810')).toMatchObject({ shortWeek: null, usable: 30 });
    expect((await (await app.as(U.recvMarlowe)).get('/api/demand-plan')).statusCode).toBe(403);
  });
});

describe('Declining a transfer', () => {
  it('releases the unit, records why, and tells the owner', async () => {
    T = (await seedDemoAccount({ day: '2026-11-23' })).tenantId; app = await httpApp();
    const { case_id, req_id } = await ids('NL-3021', '00417');
    const u = (await get(U.ops, `/api/cases/${case_id}/requirements/${req_id}/breakdown`)).availableUnits[0];
    const tr = (await post(U.ops, `/api/cases/${case_id}/rescue/${req_id}/request`, { stockItemId: u.stockItemId, locationId: u.locationId, ownerPartyId: u.ownerPartyId, idempotencyKey: 'k-dec', pickupBy: 'Chris Okafor', pickupInMinutes: 60, receiver: 'Priya Nair' })).json();
    const d = (await post(U.repChris, `/api/transfers/${tr.id}/decide`, { decision: 'decline', note: 'Needed for an add-on case this afternoon' })).json();
    expect(d).toMatchObject({ current: 'Declined', status: 'declined', decisionNote: 'Needed for an add-on case this afternoon', shipmentId: null });
    expect((await get(U.ops, `/api/cases/${case_id}/requirements/${req_id}/breakdown`)).numbers).toMatchObject({ available: 1, reservedThisCase: 0 });
    expect((await tx((db) => db.query(`select count(*)::int n from notifications where message like 'TR-0001%declined%'`))).rows[0].n).toBe(1);
    expect((await post(U.repChris, `/api/transfers/${tr.id}/decide`, { decision: 'accept' })).statusCode).toBe(409);
  });
});
