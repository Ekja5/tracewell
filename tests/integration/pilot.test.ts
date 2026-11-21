/**
 * Distributor pilot: from an empty tenant, through the same HTTP API the screens use.
 * The assistant runs in demo mode here (deterministic planner, same tools and database; no model call).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { httpApp, q, withTenant, one } from './helpers.js';
import { resetDb } from '../../src/server/seed/seed.js';
import { provisionPilot, stageDemo, PILOT } from '../../src/server/pilot/provision.js';
import { day1Workbook, day2Workbook, MFR } from '../../src/server/pilot/samples.js';
import { now } from '../../src/server/clock.js';

const U = PILOT.users;
let app: Awaited<ReturnType<typeof httpApp>>; let T = '';
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
const tx = (fn: (db: any) => Promise<any>): Promise<any> => withTenant(T, fn);
const count = async (sql: string, p: any[] = []) => Number((await tx((db) => db.query(sql, p))).rows[0].n);
const ago = (min: number) => new Date(now().getTime() - min * 60e3).toISOString();

async function fresh(staged: boolean) {
  process.env.ASSISTANT_MODE = 'demo';
  await resetDb();
  T = (await provisionPilot({ clockTime: '09:00' })).tenantId;
  if (staged) await stageDemo(T);
  app = await httpApp();
}
/** Upload one worksheet the way the screen does: file -> suggested/saved mapping -> preview -> commit. */
async function upload(email: string, filename: string, content: Buffer | string, worksheet: string, kind: string, opts: { exportedAt?: string; coverage?: string; mapping?: any; previewOnly?: boolean } = {}) {
  const u = await app.as(email);
  const f = await u.post('/api/uploads/file', { filename, contentBase64: b64(content) });
  expect(f.statusCode, f.body).toBe(200);
  const s = (await u.post('/api/uploads/suggest', { fileId: f.json().fileId, worksheet, kind })).json();
  const body = { fileId: f.json().fileId, worksheet, kind, mapping: opts.mapping ?? s.mapping, exportedAt: opts.exportedAt ?? now().toISOString(), coverage: opts.coverage ?? 'complete' };
  const preview = (await u.post('/api/uploads/preview', body)).json();
  if (opts.previewOnly) return { file: f.json(), suggest: s, preview, run: null as any, rows: [] as any[] };
  const c = await u.post('/api/uploads/commit', body);
  expect(c.statusCode, c.body).toBe(200);
  return { file: f.json(), suggest: s, preview, ...c.json() };
}
const csv = (rows: string[][]) => rows.map((r) => r.join(',')).join('\n') + '\n';
const INV = ['Stock Location', 'Mfr', 'Cat No', 'Item Description', 'Lot', 'Exp Date', 'Qty On Hand', 'UOM', 'Units per Box'];
const outcome = (run: any, n: number) => { const r = run.rows.find((x: any) => x.row_number === n); return `${r.outcome}:${r.reason_code}`; };
function chat(email: string, page: any = {}) {
  let conv: string | null = null;
  return async (message: string, select: any = null) => { const r = await (await app.as(email)).post('/api/assistant/ask', { conversationId: conv, message, select, page }); expect(r.statusCode, r.body).toBe(200); const b = r.json(); conv = b.conversationId; return b; };
}
const tomorrow = async (email: string) => (await (await app.as(email)).get('/api/tomorrow')).json();
const caseOf = (v: any, ref: string) => v.cases.find((c: any) => c.caseRef === ref);

describe('1. First load from an empty account', () => {
  beforeAll(() => fresh(false));

  it('starts empty: no items, stock or cases', async () => {
    expect(await count(`select count(*) n from catalog_items`)).toBe(0);
    expect(await count(`select count(*) n from cases`)).toBe(0);
    expect((await tomorrow(U.ops)).cases).toEqual([]);
  });

  it('offers downloadable examples and reads worksheets, headers and a suggested mapping', async () => {
    const u = await app.as(U.coordinator);
    const list = (await u.get('/api/uploads')).json();
    expect(list.samples.map((s: any) => s.name)).toEqual(expect.arrayContaining(['summit-day1.xlsx', 'summit-day2-inventory.xlsx', 'inventory-balances.csv', 'case-schedule.csv', 'case-requirements.csv']));
    const dl = await u.get('/api/uploads/samples/summit-day1.xlsx');
    expect(dl.statusCode).toBe(200);
    const f = (await u.post('/api/uploads/file', { filename: 'summit-day1.xlsx', contentBase64: dl.rawPayload.toString('base64') })).json();
    expect(f.sheets.map((s: any) => [s.name, s.guessKind])).toEqual([['Read me', null], ['Inventory', 'inventory'], ['Schedule', 'schedule'], ['Requirements', 'requirements']]);
    const s = (await u.post('/api/uploads/suggest', { fileId: f.fileId, worksheet: 'Inventory', kind: 'inventory' })).json();
    expect(s.mapping).toMatchObject({ location: 'Stock Location', manufacturer: 'Mfr', catalog_number: 'Cat No', lot: 'Lot', quantity: 'Qty On Hand', uom: 'UOM', units_per_package: 'Units per Box' });
    expect(s.saved).toBeNull();
  });

  it('preview equals commit and writes nothing; every row is accepted, held or skipped with file, sheet, row and a correction', async () => {
    const wb = await day1Workbook();
    const p = await upload(U.coordinator, 'summit-day1.xlsx', wb, 'Inventory', 'inventory', { exportedAt: ago(60), previewOnly: true });
    expect(await count(`select count(*) n from upload_runs`)).toBe(0);
    expect(await count(`select count(*) n from catalog_items`)).toBe(0);
    const r = await upload(U.coordinator, 'summit-day1.xlsx', wb, 'Inventory', 'inventory', { exportedAt: ago(60) });
    expect(r.run.counts).toEqual(p.preview.run.counts);
    expect(r.run.counts).toEqual({ accepted: 2, held: 2, skipped: 1 });
    expect(r.run.filename).toBe('summit-day1.xlsx'); expect(r.run.worksheet).toBe('Inventory');
    expect([2, 3, 4, 5, 6].map((n) => outcome(r, n))).toEqual(['accepted:opening_balance', 'accepted:opening_balance', 'held:unverified_package', 'held:missing_lot', 'skipped:duplicate_row']);
    expect(r.rows.find((x: any) => x.row_number === 5).message).toMatch(/add the lot number/i);
    expect(r.rows.find((x: any) => x.row_number === 6).message).toBe('Same as row 3 in this file; counted once.');
    // Leading zeros survive; the duplicate row was counted once; the box row moved no stock.
    expect((await tx((db) => db.query(`select ref from catalog_items order by ref`))).rows.map((x: any) => x.ref)).toEqual(['00233', '00417', '00550', '08810']); // 00550 exists as an item; its row is held, so it has no stock
    expect((await tx((db) => db.query(`select ci.ref, b.qty from stock_balances b join stock_items s on s.id=b.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id order by 1`))).rows).toEqual([{ ref: '00233', qty: 3 }, { ref: '00417', qty: 5 }]);
  });

  it('boxes convert only after a person verifies the conversion', async () => {
    const u = await app.as(U.coordinator);
    const run = (await u.get('/api/uploads')).json().runs.find((r: any) => r.kind === 'inventory');
    const row = (await u.get(`/api/uploads/runs/${run.id}`)).json().rows.find((x: any) => x.row_number === 4);
    expect(row.entity).toMatchObject({ proposedUnits: 5, uom: 'BX', itemRef: '08810' });
    expect((await u.post(`/api/uploads/conversions/${row.entity.conversionId}/verify`, { unitsPer: 5 })).statusCode).toBe(200);
    const again = (await u.post(`/api/uploads/runs/${run.id}/recheck`)).json();
    expect(outcome(again, 4)).toBe('accepted:opening_balance');
    expect(again.rows.find((x: any) => x.row_number === 4).message).toMatch(/2 BX × 5 = 10 units \(verified conversion\)/);
    expect(await count(`select b.qty n from stock_balances b join stock_items s on s.id=b.stock_item_id where s.lot_number='S65B'`)).toBe(10);
    // Re-checking again changes nothing.
    await u.post(`/api/uploads/runs/${run.id}/recheck`);
    expect(await count(`select count(*) n from inventory_movements`)).toBe(3);
  });

  it('schedule and requirements: ambiguous facility is held with choices; a remembered choice releases it and the dependent row', async () => {
    const wb = await day1Workbook();
    const s = await upload(U.coordinator, 'summit-day1.xlsx', wb, 'Schedule', 'schedule', { exportedAt: ago(60) });
    expect(s.run.counts).toEqual({ accepted: 5, held: 1 });
    const held = s.rows.find((x: any) => x.row_number === 7);
    expect(held.reason_code).toBe('ambiguous_facility');
    expect(held.entity.choices.map((c: any) => c.label)).toEqual(['Ridgeline Medical Center', 'Ridgeline Surgery Center East']);
    const rq = await upload(U.coordinator, 'summit-day1.xlsx', wb, 'Requirements', 'requirements', { exportedAt: ago(60) });
    expect(rq.run.counts).toEqual({ accepted: 5, held: 1 });
    expect(outcome(rq, 7)).toBe('held:unknown_case');
    const u = await app.as(U.coordinator);
    await u.post('/api/uploads/aliases', { kind: 'facility', aliasText: 'Ridgeline', targetId: held.entity.choices[0].id });
    expect(outcome((await u.post(`/api/uploads/runs/${s.run.id}/recheck`)).json(), 7)).toBe('accepted:case_created');
    expect(outcome((await u.post(`/api/uploads/runs/${rq.run.id}/recheck`)).json(), 7)).toBe('accepted:requirement_added');
    // Facility-local time: 7:30 AM at the Central hospital and 10:00 AM at the Eastern one.
    const cs = (await tx((db) => db.query(`select case_ref, scheduled_start from cases where case_ref in ('SC-24031','SC-24032') order by 1`))).rows;
    expect(new Date(cs[1].scheduled_start).getTime() - new Date(cs[0].scheduled_start).getTime()).toBe(1.5 * 3600e3);
    // The saved mapping is offered for tomorrow's file with the same columns.
    const f = (await u.post('/api/uploads/file', { filename: 'day2.xlsx', contentBase64: b64(await day2Workbook(6)) })).json();
    const sg = (await u.post('/api/uploads/suggest', { fileId: f.fileId, worksheet: 'Inventory', kind: 'inventory' })).json();
    expect(sg.saved.by).toBe('Casey Lindqvist');
  });

  it('a case with no requirements is "needs information", never ready', async () => {
    await upload(U.coordinator, 'extra.csv', csv([['Case ID', 'Hospital', 'Surgery Date', 'Start Time'], ['SC-24099', 'Ridgeline Medical Center', (await tomorrow(U.ops)).cases[0].startLocal ? new Date(now().getTime() + 86400e3).toISOString().slice(0, 10) : '', '3:00 PM']]), 'CSV', 'schedule');
    const c = caseOf(await tomorrow(U.ops), 'SC-24099');
    expect(c.status).toBe('needs_information');
    expect(c.blockers[0].type).toBe('missing_information');
  });
});

describe.each([6, 7])('2. The demo story, buyer types %i', (qty) => {
  beforeAll(() => fresh(true));
  const A = 'SC-24031', B = 'SC-24032', C = 'SC-24033';

  it('tomorrow in facility-local time: A confirmed short 1, B waiting on the hospital, C ready, each with evidence and owner', async () => {
    const v = await tomorrow(U.ops);
    expect(v.cases.map((c: any) => [c.caseRef, c.status])).toEqual([[A, 'needs_attention'], [B, 'in_progress'], [C, 'ready']]);
    expect(caseOf(v, A).startLocal).toMatch(/7:30 AM CST/); expect(caseOf(v, B).startLocal).toMatch(/10:00 AM EST/);
    const a = caseOf(v, A).blockers[0];
    expect(a.type).toBe('confirmed_shortage');
    expect(a.shortage.sentence).toBe('5 physically on hand, 4 reserved for other cases, 1 available, 2 required, short 1.');
    expect(a.owner).toBe('Dana Whitfield'); expect(a.actByLocal).toMatch(/3:00 PM CST/);
    expect(a.evidence.find((e: any) => e.kind === 'spreadsheet_row')).toMatchObject({ label: 'summit-day1.xlsx › Inventory › row 2 says 5 on hand', href: expect.stringMatching(/^\/uploads\/runs\/.+\?row=2$/) });
    expect(a.evidence.filter((e: any) => e.kind === 'reservation').map((e: any) => e.label).sort()).toEqual(['2 reserved for SC-24040 by Casey Lindqvist', '2 reserved for SC-24041 by Casey Lindqvist']);
    expect(a.lastVerified.atLocal).toBeTruthy();
    const b = caseOf(v, B).blockers[0];
    expect(b.type).toBe('awaiting_hospital'); expect(b.whoCanResolve).toEqual(['Marcus Hall']);
    expect(b.evidence[0]).toMatchObject({ kind: 'courier_scan', label: expect.stringMatching(/Lee Tran \(courier\) recorded SHP-\d+ delivered/) });
    expect(caseOf(v, C).blockers).toEqual([]);
    expect(caseOf(v, C).handoffEvidence.map((e: any) => e.kind)).toEqual(['courier_scan', 'receipt']);
    expect(caseOf(v, C).handoffEvidence[1].label).toMatch(/Priya Nair \(hospital receiving\) checked in/);
  });

  it('the four questions agree with the board and link to their evidence', async () => {
    const v = await tomorrow(U.ops);
    const ask = chat(U.ops);
    const calls = (await ask('Which cases do I need to make calls on before 3 today?')).cards[0];
    expect(calls.data.upcoming.map((e: any) => [e.caseRef, e.type])).toEqual([[B, 'awaiting_hospital'], [A, 'confirmed_shortage']]); // 2:00 PM EST is before 3:00 PM CST
    for (const e of calls.data.upcoming) { const bb = caseOf(v, e.caseRef).blockers[0]; expect([e.type, e.actBy, e.owner]).toEqual([bb.type, bb.actBy, bb.owner]); }
    const short = (await ask('The spreadsheet says five are on hand. Why are we short?')).cards[0];
    expect(short.type).toBe('shortage');
    expect(short.data.caseRef).toBe(A);
    expect(short.data.sentence).toBe(caseOf(v, A).blockers[0].shortage.sentence);
    expect(short.data.classification).toBe('confirmed_shortage');
    expect(short.sources.find((s: any) => s.kind === 'spreadsheet_row').href).toBe(caseOf(v, A).blockers[0].evidence.find((e: any) => e.kind === 'spreadsheet_row').href);
    expect(short.sources.filter((s: any) => s.kind === 'reservation').map((s: any) => s.label).sort()).toEqual(['Reservation held by SC-24040', 'Reservation held by SC-24041']);
    expect(short.data.evidence.find((e: any) => e.kind === 'spreadsheet_row').atLocal).toBeTruthy();
    const wait = (await ask('Which case still needs someone at the hospital to confirm receipt?')).cards[0];
    expect(wait.data.entries.map((e: any) => [e.caseRef, e.whoCanResolve])).toEqual([[B, ['Marcus Hall']]]);
    expect(wait.sources.some((s: any) => /^\/shipments\//.test(s.href))).toBe(true);
    const ch = (await ask('What changed since the previous upload?')).cards[0];
    expect(ch.data.gap).toMatch(/Only one inventory file/);
    // Every source link opens for this user.
    const u = await app.as(U.ops);
    for (const s of [...calls.sources, ...short.sources, ...wait.sources]) {
      const m = s.href.match(/^\/(cases|shipments)\/([0-9a-f-]{36})$/) ?? s.href.match(/^\/(uploads\/runs)\/([0-9a-f-]{36})/);
      if (m) expect((await u.get(`/api/${m[1]}/${m[2]}`)).statusCode, s.href).toBe(200);
    }
  });

  it(`second workbook says ${qty}: recorded as an observation, pending reconciliation; stock and the answers do not move yet`, async () => {
    const r = await upload(U.coordinator, 'summit-day2-inventory.xlsx', await day2Workbook(qty), 'Inventory', 'inventory', { coverage: 'complete' });
    expect(r.suggest.saved).toBeTruthy(); // yesterday's mapping reused
    expect(r.run.counts).toEqual({ accepted: 2, held: 1 });
    expect(outcome(r, 2)).toBe('held:needs_reconciliation');
    expect(r.rows.find((x: any) => x.row_number === 2).message).toMatch(new RegExp(`The file says ${qty}; the system has 5 .*difference \\+${qty - 5}.*previous file said 5.*Stock was not changed`));
    // 3 -> 1 femoral components is explained by the two recorded shipments: no discrepancy.
    expect(r.rows.find((x: any) => x.row_number === 3).message).toMatch(/Matches the system balance \(1\).*previous file said 3 \(-2\).*Recorded movements explain/);
    expect(await count(`select b.qty n from stock_balances b join stock_items s on s.id=b.stock_item_id where s.lot_number='T10A'`)).toBe(5);
    const a = caseOf(await tomorrow(U.ops), A).blockers[0];
    expect(a.type).toBe('missing_information');
    expect(a.detail).toMatch(new RegExp(`DISC-0001 \\(a newer spreadsheet says ${qty} .*the system has 5\\)`));
    const ask = chat(U.ops);
    const short = (await ask('The spreadsheet says five are on hand. Why are we short?')).cards[0];
    expect(short.data.classification).toBe('missing_information');
    expect(short.caveats.join(' ')).toMatch(/DISC-0001 is not reconciled yet/);
    const ch = (await ask('What changed since the previous upload?')).cards[0];
    expect(ch.data.changes).toHaveLength(2);
    expect(ch.data.changes[0]).toMatchObject({ ref: '00417', before: 5, after: qty, status: 'pending', discrepancyRef: 'DISC-0001' });
    expect(ch.data.changes[1]).toMatchObject({ ref: '00233', before: 3, after: 1, status: 'explained' });
  });

  it('only an authorized person reconciles; a note is required; the decision is kept', async () => {
    const list = (await (await app.as(U.coordinator)).get('/api/reconcile')).json();
    const d = list.open[0];
    expect(d).toMatchObject({ ref: 'DISC-0001', ledger_qty: 5, observed_qty: qty, difference: qty - 5, observedChange: qty - 5, explainedByMovements: 0, unexplained: qty - 5, cause: null });
    expect(d.source.label).toBe('summit-day2-inventory.xlsx › Inventory › row 2');
    expect(d.previous.label).toBe('summit-day1.xlsx › Inventory › row 2');
    expect(d.affectedCases.map((c: any) => c.case_ref)).toEqual(['SC-24031', 'SC-24040', 'SC-24041']);
    expect((await (await app.as(U.warehouse)).post(`/api/reconcile/${d.id}/decide`, { decision: 'accept_observed', cause: 'receipt', note: 'x y z' })).statusCode).toBe(403);
    const c = await app.as(U.coordinator);
    expect((await c.post(`/api/reconcile/${d.id}/decide`, { decision: 'accept_observed', cause: 'receipt' })).statusCode).toBe(400);
    const ok = await c.post(`/api/reconcile/${d.id}/decide`, { decision: 'accept_observed', cause: 'receipt', note: 'Counted the shelf with Sam; receipt PO-7781 was never keyed.', evidenceRef: 'PO-7781' });
    expect(ok.json()).toMatchObject({ status: 'resolved', qtyBefore: 5, qtyAfter: qty });
    expect((await c.post(`/api/reconcile/${d.id}/decide`, { decision: 'accept_observed', cause: 'receipt', note: 'again' })).statusCode).toBe(409);
    const after = (await c.get('/api/reconcile')).json();
    expect(after.open).toEqual([]);
    expect(after.closed[0].decisions.map((x: any) => [x.decision, x.cause, x.qty_before, x.qty_after, x.by_name])).toEqual([['accept_observed', 'receipt', 5, qty, 'Casey Lindqvist']]);
    expect(await count(`select count(*) n from inventory_movements where stock_discrepancy_id is not null and movement_type='adjustment' and qty=$1`, [qty - 5])).toBe(1);
  });

  it(`once ${qty} is accepted: ${qty - 4} available after four reservations on the board AND in the assistant; B and C unchanged; the assistant names the evidence`, async () => {
    const v = await tomorrow(U.ops);
    const a = caseOf(v, A).blockers[0];
    const sentence = `${qty} physically on hand, 4 reserved for other cases, ${qty - 4} available, 2 required, not short.`;
    expect(a.type).toBe('action_needed');
    expect(a.shortage).toMatchObject({ onHand: qty, reservedOtherCases: 4, available: qty - 4, short: 0, sentence });
    expect(v.cases.map((c: any) => [c.caseRef, c.status])).toEqual([[A, 'in_progress'], [B, 'in_progress'], [C, 'ready']]);
    expect(caseOf(v, B).blockers[0].type).toBe('awaiting_hospital');
    const ask = chat(U.ops);
    const short = (await ask('The spreadsheet says five are on hand. Why are we short?')).cards[0];
    expect(short.data.sentence).toBe(sentence);
    expect(short.data.short).toBe(0);
    expect(short.sources.map((s: any) => s.label)).toEqual(expect.arrayContaining([`summit-day2-inventory.xlsx › Inventory › row 2 says ${qty} on hand`]));
    const ch = (await ask('What changed since the previous upload?')).cards[0];
    expect(ch.data.changes[0]).toMatchObject({ ref: '00417', before: 5, after: qty, status: 'accepted' });
    expect(ch.data.changes[0].statusText).toMatch(new RegExp(`Casey Lindqvist accepted ${qty} as the current balance \\(DISC-0001`));
    expect(ch.data.effects.find((e: any) => e.caseRef === A).sentence).toBe(sentence);
    const kinds = ch.sources.map((s: any) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(['spreadsheet_row', 'reconciliation', 'case', 'upload']));
    expect(ch.sources.filter((s: any) => s.kind === 'spreadsheet_row').map((s: any) => s.label)).toEqual(expect.arrayContaining([`summit-day2-inventory.xlsx row 2 (00417: ${qty})`, 'summit-day1.xlsx row 2 (00417: 5)']));
  });

  it('uploading the same workbook again changes nothing', async () => {
    const before = { m: await count(`select count(*) n from inventory_movements`), o: await count(`select count(*) n from balance_observations`), d: await count(`select count(*) n from stock_discrepancies`), r: await count(`select count(*) n from upload_runs`) };
    const again = await upload(U.coordinator, 'renamed-copy.xlsx', await day2Workbook(qty), 'Inventory', 'inventory');
    expect(again.file.duplicate).toBe(true);
    expect(again.replayed).toBe(true);
    expect(again.replayMessage).toMatch(/already loaded/);
    expect({ m: await count(`select count(*) n from inventory_movements`), o: await count(`select count(*) n from balance_observations`), d: await count(`select count(*) n from stock_discrepancies`), r: await count(`select count(*) n from upload_runs`) }).toEqual(before);
    expect(caseOf(await tomorrow(U.ops), A).blockers[0].shortage.available).toBe(qty - 4);
  });

  it('reserving the now-available units is one click and the board follows', async () => {
    const v = await tomorrow(U.coordinator);
    const act = caseOf(v, A).blockers[0].actions[0];
    expect(act.kind).toBe('reserve_available');
    const r = await (await app.as(U.coordinator)).post(`/api/cases/${caseOf(v, A).id}/requirements/${act.requirementId}/reserve-available`);
    expect(r.json()).toMatchObject({ reserved: 2, stillNeeded: 0 });
    expect(caseOf(await tomorrow(U.ops), A).blockers.map((b: any) => b.code)).toEqual(['not_shipped']);
  });

  it('a hospital user stays inside their facility', async () => {
    const east = await app.as(U.recvEast);
    expect((await tomorrow(U.recvEast)).cases.map((c: any) => c.caseRef)).toEqual([B]);
    expect((await east.get('/api/uploads')).statusCode).toBe(403);
    expect((await east.get('/api/reconcile')).statusCode).toBe(403);
    const ask = chat(U.recvEast);
    const w = await ask('Which case still needs someone at the hospital to confirm receipt?');
    expect(w.cards[0].data.entries.map((e: any) => e.caseRef)).toEqual([B]);
    const all = JSON.stringify([w, await ask('What changed since the previous upload?'), await ask('Which cases do I need to make calls on before 3 today?'), await ask('Why is SC-24031 short?')]);
    // (The answer may echo the case number the user typed; nothing about that case is returned.)
    expect(all).not.toMatch(/SC-24033|Ridgeline Medical Center|\/uploads\/|summit-day|T10A|DISC-/);
  });
});

describe('3. Later files: partial exports, stale files, observed differences', () => {
  beforeAll(() => fresh(true));
  const bal = (lot: string) => count(`select coalesce(sum(b.qty),0) n from stock_balances b join stock_items s on s.id=b.stock_item_id join locations l on l.id=b.location_id where s.lot_number=$1 and l.code in ('WH-MAIN','RMC-CONS')`, [lot]);
  const inv = (rows: string[][]) => csv([INV, ...rows]);
  const row = (cat: string, lot: string, qty: string, loc = 'Main Warehouse', mfr = MFR) => [loc, mfr, cat, 'x', lot, '', qty, 'EA', ''];

  it('a partial export never zeroes what it does not list', async () => {
    const r = await upload(U.coordinator, 'partial.csv', inv([row('00233', 'F4L1', '1')]), 'CSV', 'inventory', { coverage: 'partial' });
    expect(outcome(r, 2)).toBe('accepted:matches_system');
    expect(r.run.summary.notes[0]).toMatch(/Partial export/);
    expect(await count(`select count(*) n from stock_discrepancies`)).toBe(0);
    expect([await bal('T10A'), await bal('S65B')]).toEqual([5, 10]);
  });

  it('a complete export that omits stock raises questions, still without changing stock', async () => {
    const r = await upload(U.coordinator, 'complete-but-short.csv', inv([row('00233', 'F4L1', '1'), row('00417', 'T10A', '5')]), 'CSV', 'inventory', { coverage: 'complete' });
    expect(r.run.counts).toEqual({ accepted: 2 });
    const d = (await (await app.as(U.coordinator)).get('/api/reconcile')).json().open;
    expect(d.map((x: any) => [x.kind, x.item_ref, x.ledger_qty, x.observed_qty])).toEqual([['not_listed', '08810', 10, 0]]);
    expect(await bal('S65B')).toBe(10);
    // The coordinator decides the file was wrong: system quantity kept, decision recorded.
    const c = await app.as(U.coordinator);
    await c.post(`/api/reconcile/${d[0].id}/decide`, { decision: 'note', note: 'Asked the warehouse to check shelf 4.' });
    expect((await c.post(`/api/reconcile/${d[0].id}/decide`, { decision: 'keep_system', cause: 'correction', note: 'Export filter excluded screws; shelf has 2 boxes.' })).json().qtyAfter).toBe(10);
    const closed = (await c.get('/api/reconcile')).json().closed.find((x: any) => x.id === d[0].id);
    expect(closed.decisions.map((x: any) => x.decision)).toEqual(['note', 'keep_system']);
    expect(await bal('S65B')).toBe(10);
  });

  it('Monday 12, Tuesday 10: shows the observed difference of two and keeps the cause open until someone decides', async () => {
    const mon = await upload(U.coordinator, 'consign-mon.csv', inv([row('00417', 'T10C', '12', 'Ridgeline Medical Center consignment')]), 'CSV', 'inventory', { exportedAt: ago(30), coverage: 'complete' });
    expect(outcome(mon, 2)).toBe('accepted:opening_balance');
    const tue = await upload(U.coordinator, 'consign-tue.csv', inv([row('00417', 'T10C', '10', 'Ridgeline Medical Center consignment')]), 'CSV', 'inventory', { exportedAt: ago(5), coverage: 'complete' });
    expect(outcome(tue, 2)).toBe('held:needs_reconciliation');
    const c = await app.as(U.coordinator);
    const d = (await c.get('/api/reconcile')).json().open.find((x: any) => x.lot_number === 'T10C');
    expect(d).toMatchObject({ ledger_qty: 12, observed_qty: 10, previous_observed_qty: 12, observedChange: -2, explainedByMovements: 0, unexplained: -2, cause: null, status: 'open' });
    expect(await bal('T10C')).toBe(12); // nothing moved on the file's say-so
    await c.post(`/api/reconcile/${d.id}/decide`, { decision: 'accept_observed', cause: 'use', note: 'Two used in Friday case; usage sheet attached to case folder.', evidenceRef: 'usage sheet 11-20' });
    expect(await bal('T10C')).toBe(10);
    expect((await c.get(`/api/uploads/runs/${tue.run.id}`)).json().rows[0]).toMatchObject({ outcome: 'accepted', reason_code: 'reconciled' });
  });

  it('an older file uploaded late does not override newer evidence', async () => {
    // Exported before Tuesday's file and before the reconciliation above.
    const late = await upload(U.coordinator, 'consign-old.csv', inv([row('00417', 'T10C', '14', 'Ridgeline Medical Center consignment')]), 'CSV', 'inventory', { exportedAt: ago(20), coverage: 'complete' });
    expect(outcome(late, 2)).toBe('skipped:stale_file');
    expect(late.rows[0].message).toMatch(/Not applied: this file was exported .* before a newer file \(consign-tue\.csv\)|before a reconciliation/);
    expect(await bal('T10C')).toBe(10);
    expect(await count(`select count(*) n from stock_discrepancies where status='open'`)).toBe(0);
    expect(await count(`select count(*) n from balance_observations where role='stale'`)).toBe(1); // kept as history
  });

  it('a file exported before a physical count does not override the count', async () => {
    const wh = await app.as(U.warehouse); const coord = await app.as(U.coordinator);
    const loc = await tx((db) => one(db, `select id from locations where code='WH-MAIN'`));
    const s = (await wh.post('/api/counts', { locationId: loc.id })).json();
    await wh.post(`/api/counts/${s.id}/lines`, { ref: '00233', lot: 'F4L1', countedQty: 1 });
    const r = await upload(U.coordinator, 'pre-count.csv', inv([row('00233', 'F4L1', '3')]), 'CSV', 'inventory', { exportedAt: ago(10), coverage: 'partial' });
    expect(outcome(r, 2)).toBe('skipped:stale_file');
    expect(r.rows[0].message).toMatch(/before a physical count/);
    expect(await bal('F4L1')).toBe(1);
    void coord;
  });

  it('a future export time is refused', async () => {
    const u = await app.as(U.coordinator);
    const f = (await u.post('/api/uploads/file', { filename: 'future.csv', contentBase64: b64(inv([row('00233', 'F4L1', '2')])) })).json();
    const s = (await u.post('/api/uploads/suggest', { fileId: f.fileId, worksheet: 'CSV', kind: 'inventory' })).json();
    expect((await u.post('/api/uploads/commit', { fileId: f.fileId, worksheet: 'CSV', kind: 'inventory', mapping: s.mapping, exportedAt: new Date(now().getTime() + 3600e3).toISOString() })).statusCode).toBe(400);
  });
});

describe('4. Catalog numbers: leading zeros and shared numbers', () => {
  beforeAll(() => fresh(true));
  const inv = (rows: string[][]) => csv([INV, ...rows]);

  it('a catalog number that lost its leading zeros is held, not created as a new item', async () => {
    const r = await upload(U.coordinator, 'zeros.csv', inv([['Main Warehouse', MFR, '417', 'Tibial insert', 'T10A', '', '5', 'EA', '']]), 'CSV', 'inventory', { coverage: 'partial' });
    expect(outcome(r, 2)).toBe('held:leading_zeros');
    expect(r.rows[0].message).toMatch(/The file has catalog number "417" but the catalog has "00417".*Format the catalog column as Text/);
    expect(await count(`select count(*) n from catalog_items where ref='417'`)).toBe(0);
  });

  it('an Excel number cell shown as 00417 by its format is read as 00417', async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Stock');
    ws.addRow(INV); const row = ws.addRow(['Main Warehouse', MFR, 417, 'Tibial insert', 'T10A', '', 5, 'EA', '']); row.getCell(3).numFmt = '00000';
    const r = await upload(U.coordinator, 'numeric.xlsx', Buffer.from(await wb.xlsx.writeBuffer()), 'Stock', 'inventory', { coverage: 'partial' });
    expect(r.rows[0].raw['Cat No']).toBe('00417');
    expect(outcome(r, 2)).toBe('accepted:matches_system');
  });

  it('the same catalog number from a second manufacturer is a different product; a row without a manufacturer is held', async () => {
    const r = await upload(U.coordinator, 'second-mfr.csv', inv([['Main Warehouse', 'Northfield Devices (synthetic)', '00417', 'Hip liner 36 mm', 'H36A', '', '2', 'EA', '']]), 'CSV', 'inventory', { coverage: 'partial' });
    expect(outcome(r, 2)).toBe('held:needs_reconciliation'); // new lot at a location that already has an opening balance: needs evidence of receipt
    expect(await count(`select count(*) n from catalog_items where ref='00417'`)).toBe(2);
    const rq = await upload(U.coordinator, 'req-no-mfr.csv', csv([['Case ID', 'Cat No', 'Qty Required'], ['SC-24033', '00417', '1']]), 'CSV', 'requirements');
    expect(outcome(rq, 2)).toBe('held:ambiguous_catalog');
    expect(rq.rows[0].message).toMatch(/Catalog number 00417 is used by .*Corvid.* and .*Northfield.*different products. Add the manufacturer/);
    expect(await count(`select count(*) n from case_requirements cr join cases c on c.id=cr.case_id where c.case_ref='SC-24033'`)).toBe(1);
    // A near-miss manufacturer name asks instead of creating a second company.
    const near = await upload(U.coordinator, 'near.csv', inv([['Main Warehouse', 'Corvid Orthopaedics', '00999', 'New item', 'N1', '', '1', 'EA', '']]), 'CSV', 'inventory', { coverage: 'partial' });
    expect(outcome(near, 2)).toBe('held:ambiguous_manufacturer');
    expect(await count(`select count(*) n from parties where kind='manufacturer'`)).toBe(2);
  });

  it('conflicting duplicate rows are held together; neither is applied', async () => {
    const r = await upload(U.coordinator, 'dups.csv', inv([['Main Warehouse', MFR, '00233', 'x', 'F4L1', '', '1', 'EA', ''], ['Main Warehouse', MFR, '00233', 'x', 'F4L1', '', '4', 'EA', '']]), 'CSV', 'inventory', { coverage: 'partial' });
    expect([outcome(r, 2), outcome(r, 3)]).toEqual(['held:conflicting_duplicate', 'held:conflicting_duplicate']);
    expect(r.rows[0].message).toMatch(/Rows 2 and 3 describe the same item, lot and location with different values/);
  });

  it('a schedule re-upload moves a changed case and skips unchanged ones', async () => {
    const d = new Date(now().getTime() + 86400e3).toISOString().slice(0, 10);
    const r = await upload(U.coordinator, 'sched2.csv', csv([['Case ID', 'Hospital', 'Surgery Date', 'Start Time'], ['SC-24031', 'Ridgeline Medical Center', d, '07:30'], ['SC-24033', 'Ridgeline Medical Center', d, '2:15 PM']]), 'CSV', 'schedule');
    expect([outcome(r, 2), outcome(r, 3)]).toEqual(['skipped:unchanged', 'accepted:case_moved']);
    expect(caseOf(await tomorrow(U.ops), 'SC-24033').startLocal).toMatch(/2:15 PM CST/);
  });
});

describe('5. Pilot evaluation', () => {
  beforeAll(() => fresh(true));
  const id = async (ref: string) => (await tx((db) => one(db, `select id from cases where case_ref=$1`, [ref]))).id;

  it('records predictions with timestamps, keeps revisions, separates problem, intervention and outcome, and reports traceable counts', async () => {
    const c = await app.as(U.coordinator);
    const [A, B, C] = [await id('SC-24031'), await id('SC-24032'), await id('SC-24033')];
    await c.post(`/api/pilot/cases/${A}/prediction`, { prediction: 'ready', detail: 'Spreadsheet shows 5 on hand' });
    await c.post(`/api/pilot/cases/${B}/prediction`, { prediction: 'problem', detail: 'Not sure it arrived' });
    await c.post(`/api/pilot/cases/${C}/prediction`, { prediction: 'unknown' });
    await c.post(`/api/pilot/cases/${C}/prediction`, { prediction: 'ready', detail: 'Rep texted that it arrived' }); // revision
    const rev = (await c.get('/api/pilot/review')).json().cases;
    const rc = rev.find((x: any) => x.id === C);
    expect(rc.history.predictions.filter((p: any) => p.source === 'existing_process').map((p: any) => [p.prediction, !!p.supersedes_id])).toEqual([['unknown', false], ['ready', true]]);
    expect(rev.find((x: any) => x.id === A).app).toMatchObject({ prediction: 'problem' });
    expect(rev.find((x: any) => x.id === A).app.detail).toMatch(/Confirmed shortage: 5 physically on hand/);
    expect(rev.find((x: any) => x.id === C).app.prediction).toBe('ready');
    expect(rc.existing.recorded_at).toBeTruthy();
    // Savings need evidence.
    expect((await c.post(`/api/pilot/cases/${A}/outcome`, { verifiedProblem: 'yes', problemDetail: 'Short one insert', caseOutcome: 'on_time', freightAvoided: '180' })).statusCode).toBe(400);
    await c.post(`/api/pilot/cases/${A}/outcome`, { verifiedProblem: 'yes', problemDetail: 'Short one tibial insert at 9 AM', problemEvidence: 'Shelf count by Sam', intervention: 'Moved one unit from Dana\'s trunk by noon', caseOutcome: 'on_time', minutesSaved: 45, freightAvoided: '180', savingsEvidence: 'Courier quote Q-5521 for same-day air' });
    await c.post(`/api/pilot/cases/${B}/outcome`, { verifiedProblem: 'no', caseOutcome: 'on_time', note: 'Receiving had it; just not keyed.' });
    const rep = (await c.get('/api/pilot/report')).json();
    const refs = (xs: any[]) => xs.map((x) => x.caseRef);
    expect(refs(rep.reviewed)).toEqual(['SC-24031', 'SC-24032', 'SC-24033']);
    expect([refs(rep.app.found), refs(rep.app.false_alarm), refs(rep.app.missed), refs(rep.app.unknown_outcome)]).toEqual([['SC-24031'], ['SC-24032'], [], ['SC-24033']]);
    expect([refs(rep.existing.found), refs(rep.existing.false_alarm), refs(rep.existing.missed), refs(rep.existing.unknown_outcome)]).toEqual([[], ['SC-24032'], ['SC-24031'], ['SC-24033']]);
    // A shortage fixed before surgery is a verified problem with an intervention and an on-time case: not a false alarm.
    expect(refs(rep.resolvedBeforeSurgery)).toEqual(['SC-24031']);
    expect(rep.verifiedProblems[0]).toMatchObject({ caseRef: 'SC-24031', intervention: expect.stringMatching(/trunk/), caseOutcome: 'Proceeded on time' });
    expect(rep.savings).toMatchObject({ minutes: 45, freightCents: 18000 });
    expect(rep.savings.items[0].evidence).toMatch(/Q-5521/);
    expect(rep.revisions.predictions).toBeGreaterThanOrEqual(1);
    // Hospital users and other roles cannot read or write pilot records.
    expect((await (await app.as(U.recvEast)).get('/api/pilot/report')).statusCode).toBe(403);
  });
});

describe.each([[5, 'no discrepancy'], [4, 'short 2 after acceptance'], [3, 'refused: fewer than the reservations']] as [number, string][])('6. Buyer types %i (%s)', (qty: number, _what: string) => {
  beforeAll(() => fresh(true));
  it('every answer follows the uploaded number and the current reservations', async () => {
    const r = await upload(U.coordinator, 'day2.xlsx', await day2Workbook(qty), 'Inventory', 'inventory');
    const c = await app.as(U.coordinator);
    const open = (await c.get('/api/reconcile')).json().open;
    if (qty === 5) {
      expect(outcome(r, 2)).toBe('accepted:matches_system'); expect(open).toEqual([]);
      expect(caseOf(await tomorrow(U.ops), 'SC-24031').blockers[0].type).toBe('confirmed_shortage');
      return;
    }
    const res = await c.post(`/api/reconcile/${open[0].id}/decide`, { decision: 'accept_observed', cause: 'loss', note: 'Shelf count confirms the file.' });
    if (qty === 3) {
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/4 unit\(s\) of 00417 lot T10A .* are reserved \(2 for SC-24040, 2 for SC-24041\), more than the 3 in the file/);
      expect(await count(`select b.qty n from stock_balances b join stock_items s on s.id=b.stock_item_id where s.lot_number='T10A'`)).toBe(5);
      return;
    }
    expect(res.statusCode).toBe(200);
    const a = caseOf(await tomorrow(U.ops), 'SC-24031').blockers[0];
    expect(a.type).toBe('confirmed_shortage');
    expect(a.shortage.sentence).toBe('4 physically on hand, 4 reserved for other cases, 0 available, 2 required, short 2.');
    const ai = (await chat(U.ops)('The spreadsheet says five are on hand. Why are we short?')).cards[0];
    expect(ai.data.sentence).toBe(a.shortage.sentence);
  });
});
