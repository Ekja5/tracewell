/**
 * The synthetic demo account "Northline Orthopedic Supply" (used for the buyer video and for hosted reviews).
 * Everything is fictional. Stock, cases and requirements are loaded through the spreadsheet upload services;
 * reservations, shipments, courier scans, hospital check-ins, tray verification, a trunk count and a verified
 * recall are made through the same domain services as the screens. The demo clock ends at 9:00 AM Central
 * on the demo day (default: the next Monday to Thursday), so "tomorrow's cases" is always a weekday.
 */
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { resetDb } from '../seed/seed.js';
import { q, withTenant, Db, one, rows } from '../db.js';
import { hashPassword } from '../auth.js';
import { setClock, now } from '../clock.js';
import { zoned, addDaysYmd, localYmd } from '../time.js';
import type { Ctx } from '../perms.js';
import { applyMovement } from '../domain/inventory.js';
import { planCaseDelivery, shipmentDetail, pickLine, packShipment, dispatchShipment, courierEvent, receiveShipment, verifyTray, recordRelease, trayManifest } from '../domain/shipments.js';
import * as counts from '../domain/counts.js';
import * as recall from '../domain/recall.js';
import { storeFile, suggest, runUpload, verifyConversion, recheckRun } from './uploads.js';
import { reserveAvailable } from './tomorrow.js';
import { gtinWithCheckDigit } from '../../shared/gs1.js';

const TZ = 'America/Chicago', EAST = 'America/Indiana/Indianapolis';
const MFR = 'Corvid Orthopaedics';
export const DEMO = { tenant: 'Northline Orthopedic Supply', password: 'Pilot-Demo-2026!',
  users: { ops: 'avery.brooks@northline.example', coordinator: 'casey.lindqvist@northline.example', warehouse: 'sam.ortega@northline.example', courier: 'lee.tran@northline.example',
    repDana: 'dana.whitfield@northline.example', repChris: 'chris.okafor@northline.example', quality: 'jordan.reyes@northline.example', quality2: 'mina.castell@northline.example',
    recvMarlowe: 'receiving@marlowe-regional.example', spdMarlowe: 'spd@marlowe-regional.example', recvHarlan: 'receiving@harlan-surgery.example' } };

function nextWeekday(ymd: string) { let d = ymd; for (;;) { const wd = new Date(d + 'T12:00:00Z').getUTCDay(); if (wd >= 1 && wd <= 4) return d; d = addDaysYmd(d, 1); } } // Mon-Thu so "tomorrow" is a weekday too
export const defaultDemoDay = () => nextWeekday(localYmd(new Date(), TZ));
const us = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;
const prevBiz = (ymd: string) => { let d = addDaysYmd(ymd, -1); while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = addDaysYmd(d, -1); return d; };
const nextBiz = (ymd: string, n = 1) => { let d = ymd; for (let i = 0; i < n; i++) { d = addDaysYmd(d, 1); while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = addDaysYmd(d, 1); } return d; };

async function workbook(sheet: string, head: string[], body: string[][]) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(sheet);
  ws.addRow(head).font = { bold: true };
  for (const r of body) ws.addRow(r).eachCell((c) => { c.numFmt = '@'; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface DemoOpts {
  day?: string;
  /** Review deployment: named sign-ins with their own passwords; every built-in persona gets an unguessable password. */
  reviewer?: { email: string; name: string; password: string } | null;
  owner?: { email: string; name: string; password: string } | null;
  lockPersonas?: boolean;
}
export async function seedDemoAccount(opts: DemoOpts = {}) {
  const DAY = opts.day ?? defaultDemoDay();
  await resetDb();
  const pw = await hashPassword(opts.lockPersonas ? crypto.randomBytes(24).toString('base64url') : DEMO.password);
  const [t] = await q(`insert into tenants(slug, name, timezone) values ('northline', $1, $2) returning id`, [DEMO.tenant, TZ]);
  const T = t.id as string; const tx = <R>(fn: (db: Db) => Promise<R>) => withTenant(T, fn);
  const prev = prevBiz(DAY), tomorrow = nextBiz(DAY), later1 = nextBiz(DAY, 2), later2 = nextBiz(DAY, 5); // skips the US holiday on the 26th when the demo day is Nov 23
  await setClock(zoned(prev, '15:40', TZ));

  const ids: Record<string, string> = {};
  await tx(async (db) => {
    const ins = async (sql: string, p: any[]) => (await db.query(sql, p)).rows[0].id as string;
    ids.dist = await ins(`insert into parties(tenant_id,name,kind) values ($1,$2,'distributor') returning id`, [T, DEMO.tenant]);
    const terr = await ins(`insert into territories(tenant_id,name) values ($1,'Central territory') returning id`, [T]);
    const fac = (code: string, name: string, kind: string, tz: string) => ins(`insert into facilities(tenant_id,code,name,kind,timezone,territory_id,party_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [T, code, name, kind, tz, terr, kind === 'warehouse' ? ids.dist : null]);
    ids.wh = await fac('NCW', 'Northline Central Warehouse', 'warehouse', TZ);
    ids.mrm = await fac('MRM', 'Marlowe Regional Medical Center', 'hospital', TZ);
    ids.hsc = await fac('HSC', 'Harlan Surgery Center', 'hospital', EAST);
    const pol = (f: string, implantH: number, open: string, close: string, notes: string) => db.query(`insert into facility_policies(tenant_id,facility_id,version,tray_due_hours_before,implant_due_hours_before,requires_release_decision,required_evidence,receiving_notes,effective_from,approved_by,receiving_open,receiving_close)
       values ($1,$2,1,20,$3,true,'{hospital_processing_record_ref}',$4,'2026-01-01','Account setup',$5,$6)`, [T, f, implantH, notes, open, close]);
    await pol(ids.mrm, 2, '07:00', '15:00', 'Receiving staff check in every delivery.');
    await pol(ids.hsc, 20, '06:00', '17:00', 'Implants are checked in the afternoon before surgery.');
    const user = (key: string, email: string, name: string, role: string, f: string | null = null, tr: string | null = null) => ins(`insert into users(tenant_id,email,display_name,password_hash,role,facility_id,territory_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [T, email, name, pw, role, f, tr]).then((id) => { ids[key] = id; });
    const U = DEMO.users;
    await user('ops', U.ops, 'Avery Brooks', 'ops_manager'); await user('coordinator', U.coordinator, 'Casey Lindqvist', 'inventory_coordinator');
    await user('warehouse', U.warehouse, 'Sam Ortega', 'warehouse'); await user('courier', U.courier, 'Lee Tran', 'courier');
    await user('repDana', U.repDana, 'Dana Whitfield', 'rep', null, terr); await user('repChris', U.repChris, 'Chris Okafor', 'rep', null, terr);
    await user('quality', U.quality, 'Jordan Reyes', 'quality_manager'); await user('quality2', U.quality2, 'Mina Castell', 'quality_manager');
    await user('recvMarlowe', U.recvMarlowe, 'Priya Nair', 'hospital_receiving', ids.mrm); await user('spdMarlowe', U.spdMarlowe, 'Elena Ruiz', 'hospital_spd', ids.mrm);
    await user('recvHarlan', U.recvHarlan, 'Marcus Hall', 'hospital_receiving', ids.hsc);
    // Named review sign-ins (not personas in the story): full distributor view, own passwords.
    for (const [key, u, role] of [['reviewer', opts.reviewer, 'admin'], ['owner', opts.owner, 'admin']] as const)
      if (u) ids[key] = await ins(`insert into users(tenant_id,email,display_name,password_hash,role) values ($1,$2,$3,$4,$5) returning id`, [T, u.email.toLowerCase(), u.name, await hashPassword(u.password), role]);
    const loc = (code: string, name: string, kind: string, f: string | null, alloc: boolean, holder: string | null = null) => ins(`insert into locations(tenant_id,code,name,kind,facility_id,allocatable,holder_user_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [T, code, name, kind, f, alloc, holder]);
    ids.lwh = await loc('NCW-MAIN', 'Northline Central Warehouse', 'warehouse', ids.wh, true);
    ids.lMrm = await loc('MRM-RECV', 'Marlowe Regional receiving', 'hospital_receiving', ids.mrm, true);
    ids.lHsc = await loc('HSC-RECV', 'Harlan Surgery Center receiving', 'hospital_receiving', ids.hsc, true);
    ids.lDana = await loc('TRUNK-DW', 'Dana Whitfield trunk stock', 'trunk', null, true, ids.repDana);
    ids.lChris = await loc('TRUNK-CO', 'Chris Okafor trunk stock', 'trunk', null, true, ids.repChris);
    for (const [code, name, kind] of [['TRANSIT', 'In transit', 'in_transit'], ['CONSUMED', 'Consumed', 'consumed'], ['WASTED', 'Wasted', 'wasted'], ['MISSING', 'Missing', 'missing'], ['QUAR', 'Quarantine', 'quarantine'], ['RETURNS', 'Returns', 'returns']]) await loc(code, name, kind, null, false);
    const te = (from: string, to: string, min: number, cents: number) => db.query(`insert into travel_estimates(tenant_id,from_location_id,to_facility_id,minutes,courier_cost_cents,basis) values ($1,$2,$3,$4,$5,'Estimate entered at account setup; not live traffic')`, [T, from, to, min, cents]);
    await te(ids.lwh, ids.mrm, 45, 4000); await te(ids.lwh, ids.hsc, 150, 11000); await te(ids.lChris, ids.mrm, 40, 0); await te(ids.lChris, ids.hsc, 120, 0); await te(ids.lDana, ids.mrm, 30, 0); await te(ids.lDana, ids.hsc, 140, 0);
  });
  const ctx = async (key: string): Promise<Ctx & { tenantTz: string }> => { const [u] = await q(`select * from users where id=$1`, [ids[key]]); return { userId: u.id, tenantId: T, role: u.role, facilityId: u.facility_id, territoryId: u.territory_id, displayName: u.display_name, tenantTz: TZ }; };
  const coord = await ctx('coordinator'), wh = await ctx('warehouse'), courier = await ctx('courier');

  // ---- Friday afternoon: the coordinator loads the on-hand export, the week's schedule and requirements ----
  const exp = us(addDaysYmd(DAY, 500));
  const INV = ['Stock Location', 'Mfr', 'Cat No', 'Item Description', 'Lot', 'Exp Date', 'Qty On Hand', 'UOM', 'Units per Box'];
  const inv = await workbook('On hand', INV, [
    ['Northline Central Warehouse', MFR, '00417', 'Tibial insert, size 4, 10 mm', 'T10A', exp, '4', 'EA', ''],
    ['Chris Okafor trunk stock', MFR, '00417', 'Tibial insert, size 4, 10 mm', 'T10A', exp, '1', 'EA', ''],
    ['Northline Central Warehouse', MFR, '00233', 'Femoral component, size 4, left', 'F4L1', exp, '4', 'EA', ''],
    ['Northline Central Warehouse', MFR, '00612', 'Femoral component, size 5, right', 'F5R2', exp, '2', 'EA', ''],
    ['Northline Central Warehouse', MFR, '00720', 'Tibial baseplate, size 4', 'B4K1', exp, '3', 'EA', ''],
    ['Northline Central Warehouse', MFR, '00550', 'Patella button, 32 mm', 'P32C', exp, '2', 'EA', ''],
    ['Northline Central Warehouse', MFR, '08810', 'Bone screw, 6.5 mm', 'S65B', exp, '6', 'BX', '5'],
    ['Dana Whitfield trunk stock', MFR, '00233', 'Femoral component, size 4, left', 'F4L3', exp, '1', 'EA', ''],
    ['Dana Whitfield trunk stock', MFR, '00720', 'Tibial baseplate, size 4', 'B4K1', exp, '1', 'EA', ''],
  ]);
  const P = 'Total knee arthroplasty, primary';
  const sched = await workbook('Schedule', ['Case ID', 'Hospital', 'Surgery Date', 'Start Time', 'Procedure', 'Surgeon', 'Rep'], [
    ['NL-3018', 'Marlowe Regional Medical Center', us(DAY), '7:00 AM', P, 'Surgeon S-104', 'Dana Whitfield'],
    ['NL-3021', 'Marlowe Regional Medical Center', us(tomorrow), '7:30 AM', P, 'Surgeon S-104', 'Dana Whitfield'],
    ['NL-3022', 'Harlan Surgery Center', us(tomorrow), '10:00 AM', P, 'Surgeon S-221', 'Chris Okafor'],
    ['NL-3023', 'Marlowe Regional Medical Center', us(tomorrow), '1:00 PM', 'Total knee arthroplasty, revision', 'Surgeon S-118', 'Dana Whitfield'],
    ['NL-3024', 'Marlowe Regional Medical Center', us(tomorrow), '2:30 PM', P, 'Surgeon S-104', 'Dana Whitfield'],
    ['NL-3025', 'Harlan Surgery Center', us(tomorrow), '1:00 PM', P, 'Surgeon S-221', 'Chris Okafor'],
    ['NL-3030', 'Marlowe Regional Medical Center', us(later1), '8:00 AM', P, 'Surgeon S-118', 'Dana Whitfield'],
    ['NL-3031', 'Harlan Surgery Center', us(later2), '9:00 AM', P, 'Surgeon S-221', 'Chris Okafor'],
  ]);
  const req = await workbook('Requirements', ['Case ID', 'Mfr', 'Cat No', 'Item Description', 'Qty Required', 'UOM'], [
    ['NL-3018', MFR, '00233', '', '1', 'EA'], ['NL-3018', MFR, '08810', '', '1', 'EA'],
    ['NL-3021', MFR, '00417', '', '2', 'EA'],
    ['NL-3022', MFR, '00233', '', '1', 'EA'],
    ['NL-3023', MFR, '00233', '', '1', 'EA'],
    ['NL-3024', MFR, '00720', '', '1', 'EA'], ['NL-3024', MFR, '08810', '', '4', 'EA'],
    ['NL-3025', MFR, '00612', '', '1', 'EA'],
    ['NL-3030', MFR, '00417', '', '2', 'EA'], ['NL-3031', MFR, '00417', '', '2', 'EA'],
  ]);
  const runs: Record<string, string> = {};
  for (const [name, buf, sheet, kind] of [[`on-hand-export_${prev}.xlsx`, inv, 'On hand', 'inventory'], [`or-schedule_week-of-${DAY}.xlsx`, sched, 'Schedule', 'schedule'], [`case-requirements_week-of-${DAY}.xlsx`, req, 'Requirements', 'requirements']] as const) {
    const f = await tx((db) => storeFile(db, coord, { filename: name, contentBase64: buf.toString('base64') }));
    const s = await tx((db) => suggest(db, coord, { fileId: f.fileId, worksheet: sheet, kind }));
    runs[kind] = (await tx((db) => runUpload(db, coord, { fileId: f.fileId, worksheet: sheet, kind, mapping: s.mapping, coverage: 'complete' }, 'commit'))).run.id;
    if (kind === 'inventory') { await tx(async (db) => { for (const c of await rows(db, `select id, units_per from uom_conversions where verified_at is null`)) await verifyConversion(db, coord, c.id, { unitsPer: c.units_per }); }); await tx((db) => recheckRun(db, coord, runs.inventory)); }
  }
  // Labels carry GS1 identifiers so the phone can scan them.
  await tx(async (db) => { let n = 0; for (const it of await rows(db, `select id from catalog_items order by ref`)) await db.query(`update catalog_items set unit_gtin=$2 where id=$1`, [it.id, gtinWithCheckDigit('0061414' + String(200100 + ++n))]); });

  // Loaner instrument trays (serialized), with an approved manifest.
  const trayIds = await tx(async (db) => {
    const mfr = (await one(db, `select id from parties where kind='manufacturer'`)).id;
    const item = async (ref: string, d: string, type: string, tracking: string) => (await db.query(`insert into catalog_items(tenant_id,manufacturer_party_id,ref,description,item_type,tracking) values ($1,$2,$3,$4,$5,$6) returning id`, [T, mfr, ref, d, type, tracking])).rows[0].id as string;
    const tray = await item('KT-2200', 'Knee instrument tray (loaner)', 'tray', 'serial');
    const mv = (await db.query(`insert into tray_manifest_versions(tenant_id,tray_catalog_item_id,version,status,approved_by,approved_at) values ($1,$2,1,'approved',$3,$4) returning id`, [T, tray, ids.ops, now().toISOString()])).rows[0].id;
    for (const [ref, d, n] of [['KI-101', 'Femoral sizer', 1], ['KI-114', 'Cutting block, size 4', 1], ['KI-120', 'Tibial alignment guide', 1], ['KI-133', 'Impactor', 1], ['KI-140', 'Trial insert set', 1]] as const)
      await db.query(`insert into tray_manifest_lines(tenant_id,manifest_version_id,catalog_item_id,qty,required) values ($1,$2,$3,$4,true)`, [T, mv, await item(ref, d, 'instrument', 'lot'), n]);
    const out: Record<string, string> = {};
    for (const sn of ['KT-2200-04', 'KT-2200-07']) {
      const si = (await db.query(`insert into stock_items(tenant_id,catalog_item_id,serial_number,is_serial,data_source) values ($1,$2,$3,true,'upload') returning id`, [T, tray, sn])).rows[0].id;
      await db.query(`insert into tray_instances(stock_item_id,tenant_id,manifest_version_id) values ($1,$2,$3)`, [si, T, mv]);
      await applyMovement(db, coord, { stockItemId: si, qty: 1, ownerPartyId: ids.dist, to: { locationId: ids.lwh, condition: 'sealed' }, type: 'opening_balance', reason: 'Loaner tray registered at account setup', idempotencyKey: `tray:${sn}` });
      out[sn] = si;
    }
    const c = (await one(db, `select id from cases where case_ref='NL-3023'`)).id;
    await db.query(`insert into case_requirements(tenant_id, case_id, catalog_item_id, qty, mandatory) values ($1,$2,$3,1,true)`, [T, c, tray]);
    return out;
  });

  const caseId = async (ref: string) => (await tx((db) => one(db, `select id from cases where case_ref=$1`, [ref]))).id as string;
  const reserveAll = async (ref: string) => { const cid = await caseId(ref); for (const r of await tx((db) => rows(db, `select id from case_requirements where case_id=$1 and active`, [cid]))) await tx((db) => reserveAvailable(db, coord, cid, r.id)); return cid; };
  const deliver = async (ref: string, opts: { receiveBy?: string; trayBy?: string } = {}) => {
    const cid = await caseId(ref);
    const { created } = await tx((db) => planCaseDelivery(db, coord, cid));
    for (const s of created) {
      await tx(async (db) => { const d = await shipmentDetail(db, wh, s.id); for (const l of d.lines) await pickLine(db, wh, s.id, { lineId: l.id, qty: l.qty_expected, lot: l.lot_number ?? undefined, serial: l.serial_number ?? undefined }); await packShipment(db, wh, s.id); await dispatchShipment(db, wh, s.id, {}); });
      await setClock(new Date(now().getTime() + 55 * 60e3));
      await tx((db) => courierEvent(db, courier, s.id, { type: 'delivered' }));
      if (opts.receiveBy) { const r = await ctx(opts.receiveBy); await setClock(new Date(now().getTime() + 12 * 60e3)); await tx(async (db) => { const d = await shipmentDetail(db, r, s.id); await receiveShipment(db, r, s.id, { lines: d.lines.map((l: any) => ({ lineId: l.id, qtyReceived: l.qty_expected, sealIntact: true })) }); }); }
    }
    return cid;
  };
  // Later-week cases hold the four warehouse inserts. Today's case and three of tomorrow's are delivered and checked in.
  for (const ref of ['NL-3030', 'NL-3031', 'NL-3018', 'NL-3025']) await reserveAll(ref);
  await deliver('NL-3018', { receiveBy: 'recvMarlowe' });       // Friday afternoon, for Monday 7:00 AM
  await setClock(zoned(prev, '13:10', TZ)); await deliver('NL-3025', { receiveBy: 'recvHarlan' });
  await setClock(zoned(DAY, '06:10', TZ));
  for (const ref of ['NL-3023', 'NL-3024', 'NL-3022']) await reserveAll(ref);
  const c23 = await deliver('NL-3023', { receiveBy: 'recvMarlowe' });
  // Tray for NL-3023: contents verified against the manifest, then released by the hospital's own SPD staff.
  await tx(async (db) => { const recv = await ctx('recvMarlowe'), spd = await ctx('spdMarlowe');
    const tray = (await one(db, `select r.stock_item_id from reservations r where r.case_id=$1 and r.stock_item_id = any($2)`, [c23, Object.values(trayIds)])).stock_item_id;
    const m = await trayManifest(db, tray);
    await setClock(new Date(now().getTime() + 10 * 60e3));
    await verifyTray(db, recv, tray, { caseId: c23, sealIntact: true, lines: m.lines.map((l: any) => ({ catalogItemId: l.catalog_item_id, actualQty: l.qty })) });
    await setClock(new Date(now().getTime() + 15 * 60e3));
    await recordRelease(db, spd, c23, { trayStockItemId: tray, decision: 'released', evidence: { hospital_processing_record_ref: 'MRM-LOAD-4471' } }); });
  // Chris counts his trunk first thing on the demo day; the coordinator approves it (a recent physical check).
  await setClock(zoned(DAY, '07:05', TZ));
  const chris = await ctx('repChris');
  await tx(async (db) => { const s = await counts.startCount(db, chris, { locationId: ids.lChris }); await counts.addCountLine(db, chris, s.id, { ref: '00417', lot: 'T10A', countedQty: 1 }); await counts.submitCount(db, chris, s.id); await counts.reviewCount(db, coord, s.id, { decision: 'approve', note: 'Matches the on-hand export.' }); });

  await setClock(zoned(DAY, '07:20', TZ)); await deliver('NL-3024', { receiveBy: 'recvMarlowe' });
  await setClock(zoned(DAY, '07:40', TZ)); await deliver('NL-3022');                 // courier scan at 8:30; Harlan has not checked it in
  // A manufacturer notice arrived this morning: quality entered it and a second person verified the scope.
  await setClock(zoned(DAY, '08:40', TZ));
  await tx(async (db) => { const qm = await ctx('quality'), q2 = await ctx('quality2'); const it = await one(db, `select id, manufacturer_party_id from catalog_items where ref='00233'`);
    const r = await recall.createRecall(db, qm, { manufacturerPartyId: it.manufacturer_party_id, catalogItemId: it.id, scopeType: 'lot', scopeValues: ['F4L1'], noticeRef: 'CO-FSN-2026-14', description: 'Packaging seal may be incomplete on lot F4L1. Quarantine and return.' });
    await recall.verifyRecall(db, q2, r.id, { confirmScope: ['F4L1'] }); });
  await setClock(zoned(DAY, '09:00', TZ));
  return { tenantId: T, day: DAY, tomorrow };
}
