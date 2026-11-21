/**
 * Synthetic seed. All organizations, people, devices, contracts, prices and cases are fictional.
 * Dates are deterministic relative to the demo date (DEMO_DATE=YYYY-MM-DD, default: today in
 * America/Chicago). Historical cases are created by running the real domain workflows with the
 * application clock set to past times, so the ledger and audit history are internally consistent.
 *
 *   npm run seed            # reset and seed the database in DATABASE_URL
 */
import { config } from '../config.js';
import { pool, q, withTenant, Db, one } from '../db.js';
import { migrate } from '../migrate.js';
import { setClock, nowIso } from '../clock.js';
import { hashPassword } from '../auth.js';
import { gtinWithCheckDigit, buildGs1 } from '../../shared/gs1.js';
import type { Ctx, Role } from '../perms.js';
import { runImport, csvCell } from '../domain/imports.js';
import { createCase } from '../domain/cases.js';
import { reserve } from '../domain/inventory.js';
import * as ship from '../domain/shipments.js';
import { recordUsage, submitCloseout } from '../domain/closeout.js';
import * as bill from '../domain/billing.js';
import * as counts from '../domain/counts.js';
import { processOutboxForTenant } from '../domain/erp.js';

export const DEMO_PASSWORD = 'Pilot-Demo-2026!';
const CHI = 'America/Chicago';
const IND = 'America/Indiana/Indianapolis';

/** Wall-clock time in a zone -> UTC Date. */
export function zoned(dateYmd: string, hhmm: string, tz: string): Date {
  const [y, m, d] = dateYmd.split('-').map(Number); const [hh, mm] = hhmm.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    guess += Date.UTC(y, m - 1, d, hh, mm) - asUtc;
  }
  return new Date(guess);
}
export function addDays(ymd: string, n: number) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function demoDate() {
  return process.env.DEMO_DATE ?? new Intl.DateTimeFormat('en-CA', { timeZone: CHI, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const G = (n: number) => gtinWithCheckDigit('0061414' + String(n).padStart(6, '0'));
export const GTIN = {
  INS_4_10: G(100101), INS_4_12: G(100102), FEM_4L: G(100201), FEM_5L: G(100202), TIB_4: G(100301), SCR_650: G(100401), SCR_650_BOX5: gtinWithCheckDigit('1061414100401'),
  TRAY_KNEE: G(100901), SIZER: G(100501), CUT4: G(100502), TIBGUIDE: G(100503), IMPACT: G(100504), TRIAL4: G(100505),
};

export async function resetDb() {
  await pool.query(`drop schema public cascade; create schema public;`);
  await migrate(config.databaseUrl);
}

export async function seed(opts: { quiet?: boolean } = {}) {
  const log = (s: string) => { if (!opts.quiet) console.log(`[seed] ${s}`); };
  const D = demoDate();
  const anchor = zoned(D, '08:00', CHI);
  await resetDb();
  const pw = await hashPassword(DEMO_PASSWORD);

  // ---------- Tenant 1 ----------
  const [t1] = await q(`insert into tenants(slug,name) values ('lakeshore','Lakeshore Orthopedic Partners (synthetic)') returning id`);
  const T = t1.id;
  const ids: Record<string, any> = {};
  await withTenant(T, async (db) => {
    const ins = async (sql: string, p: any[]) => (await db.query(sql, p)).rows[0];
    ids.terrN = (await ins(`insert into territories(tenant_id,name) values ($1,'North (Chicago metro)') returning id`, [T])).id;
    ids.terrE = (await ins(`insert into territories(tenant_id,name) values ($1,'East (Indiana)') returning id`, [T])).id;
    ids.dist = (await ins(`insert into parties(tenant_id,name,kind) values ($1,'Lakeshore Orthopedic Partners (synthetic)','distributor') returning id`, [T])).id;
    ids.mfr = (await ins(`insert into parties(tenant_id,name,kind) values ($1,'Northpoint Ortho Devices (synthetic)','manufacturer') returning id`, [T])).id;
    ids.pSBR = (await ins(`insert into parties(tenant_id,name,kind) values ($1,'St. Brigid Regional Medical Center (synthetic)','hospital') returning id`, [T])).id;
    ids.pPVS = (await ins(`insert into parties(tenant_id,name,kind) values ($1,'Prairie Valley Surgical Hospital (synthetic)','hospital') returning id`, [T])).id;
    ids.WH = (await ins(`insert into facilities(tenant_id,code,name,kind,timezone,territory_id,party_id) values ($1,'WH','Lakeshore Central Warehouse','warehouse',$2,$3,$4) returning id`, [T, CHI, ids.terrN, ids.dist])).id;
    ids.SBR = (await ins(`insert into facilities(tenant_id,code,name,kind,timezone,territory_id,party_id) values ($1,'SBR','St. Brigid Regional Medical Center (synthetic)','hospital',$2,$3,$4) returning id`, [T, CHI, ids.terrN, ids.pSBR])).id;
    ids.PVS = (await ins(`insert into facilities(tenant_id,code,name,kind,timezone,territory_id,party_id) values ($1,'PVS','Prairie Valley Surgical Hospital (synthetic)','hospital',$2,$3,$4) returning id`, [T, IND, ids.terrE, ids.pPVS])).id;
    await db.query(`insert into facility_policies(tenant_id,facility_id,version,tray_due_hours_before,implant_due_hours_before,requires_release_decision,required_evidence,receiving_notes,effective_from,approved_by) values
      ($1,$2,3,12,2,true,'{hospital_processing_record_ref}','Loaner trays due by 19:30 the evening before; SPD records release after decontamination and processing per hospital procedure.','2026-01-01','SBR Perioperative Services (synthetic)'),
      ($1,$3,1,24,12,true,'{hospital_processing_record_ref,loaner_count_sheet_ref}','Loaner trays and implants must arrive one full day before surgery; hospital count sheet reference required.','2026-01-01','PVS Materials Management (synthetic)')`, [T, ids.SBR, ids.PVS]);

    const users: [string, string, Role, string | null, string | null][] = [
      ['ops@lakeshore.example', 'Morgan Hale', 'ops_manager', null, null],
      ['inventory@lakeshore.example', 'Casey Lin', 'inventory_coordinator', null, null],
      ['scheduler@lakeshore.example', 'Pat Rivera', 'scheduler', null, null],
      ['riley.rep@lakeshore.example', 'Riley Novak', 'rep', null, ids.terrN],
      ['jordan.rep@lakeshore.example', 'Jordan Ames', 'rep', null, ids.terrE],
      ['warehouse@lakeshore.example', 'Sam Okafor', 'warehouse', null, null],
      ['courier@lakeshore.example', 'Dana Ruiz (courier)', 'courier', null, null],
      ['receiving@stbrigid.example', 'Alex Byrne (SBR receiving)', 'hospital_receiving', ids.SBR, null],
      ['spd@stbrigid.example', 'Robin Shah (SBR SPD)', 'hospital_spd', ids.SBR, null],
      ['receiving@prairievalley.example', 'Taylor Quinn (PVS receiving)', 'hospital_receiving', ids.PVS, null],
      ['spd@prairievalley.example', 'Jamie Cole (PVS SPD)', 'hospital_spd', ids.PVS, null],
      ['finance@lakeshore.example', 'Avery Brooks', 'finance', null, null],
      ['quality@lakeshore.example', 'Quinn Mercer', 'quality_manager', null, null],
      ['quality2@lakeshore.example', 'Val Ortega', 'quality_manager', null, null],
      ['admin@lakeshore.example', 'Lee Admin', 'admin', null, null],
    ];
    for (const [email, name, role, fac, terr] of users) {
      const u = await ins(`insert into users(tenant_id,email,display_name,password_hash,role,facility_id,territory_id) values ($1,$2,$3,$4,$5,$6,$7) returning *`, [T, email, name, pw, role, fac, terr]);
      ids['u:' + email.split('@')[0] + (fac ? '@' + email.split('@')[1].split('.')[0] : '')] = u;
    }
    const L = async (code: string, name: string, kind: string, fac: string | null, holder: string | null, alloc: boolean) => (await ins(`insert into locations(tenant_id,code,name,kind,facility_id,holder_user_id,allocatable) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [T, code, name, kind, fac, holder, alloc])).id;
    ids.L_WH = await L('WH-MAIN', 'Central warehouse, main stock', 'warehouse', ids.WH, null, true);
    ids.L_QUAR = await L('WH-QUAR', 'Warehouse quarantine cage', 'quarantine', ids.WH, null, false);
    ids.L_RET = await L('RETURNS', 'Returns to manufacturer', 'returns', ids.WH, null, false);
    ids.L_TRANSIT = await L('IN-TRANSIT', 'In transit (courier / rep custody)', 'in_transit', null, null, false);
    ids.L_CONS = await L('CONSUMED', 'Implanted / consumed', 'consumed', null, null, false);
    ids.L_WASTE = await L('WASTED', 'Wasted (opened, not implanted)', 'wasted', null, null, false);
    ids.L_MISS = await L('MISSING', 'Missing - under investigation', 'missing', null, null, false);
    ids.L_TR_RILEY = await L('TRUNK-RILEY', 'Riley Novak trunk stock', 'trunk', null, ids['u:riley.rep'].id, true);
    ids.L_TR_JORDAN = await L('TRUNK-JORDAN', 'Jordan Ames trunk stock', 'trunk', null, ids['u:jordan.rep'].id, true);
    ids.L_SBR_RECV = await L('SBR-RECV', 'St. Brigid receiving / SPD intake', 'hospital_receiving', ids.SBR, null, true);
    ids.L_SBR_CONS = await L('SBR-CONSIGN', 'St. Brigid consignment cabinet', 'consignment', ids.SBR, null, true);
    ids.L_PVS_RECV = await L('PVS-RECV', 'Prairie Valley receiving', 'hospital_receiving', ids.PVS, null, true);
    ids.L_PVS_CONS = await L('PVS-CONSIGN', 'Prairie Valley consignment (hospital-owned)', 'consignment', ids.PVS, null, true);
    const te = async (from: string, fac: string, min: number, cents: number) => db.query(`insert into travel_estimates(tenant_id,from_location_id,to_facility_id,minutes,courier_cost_cents) values ($1,$2,$3,$4,$5)`, [T, from, fac, min, cents]);
    await te(ids.L_WH, ids.SBR, 55, 4500); await te(ids.L_WH, ids.PVS, 150, 12000);
    await te(ids.L_TR_RILEY, ids.SBR, 25, 1800); await te(ids.L_TR_RILEY, ids.PVS, 170, 9500);
    await te(ids.L_TR_JORDAN, ids.SBR, 95, 3500); await te(ids.L_TR_JORDAN, ids.PVS, 30, 1200);
    await te(ids.L_SBR_CONS, ids.PVS, 160, 12500); await te(ids.L_PVS_CONS, ids.SBR, 140, 11500);
    await te(ids.L_SBR_RECV, ids.PVS, 160, 12500); await te(ids.L_PVS_RECV, ids.SBR, 140, 11500);

    await db.query(`insert into integration_feeds(tenant_id,code,name,simulated,live_enabled,stale_after_minutes,last_success_at,field_ownership) values
      ($1,'erp-mock','Mock ERP adapter (SIMULATED)',true,false,1440,null,$2),
      ($1,'sched-SBR','St. Brigid OR schedule feed (SIMULATED)',true,false,240,$3,$4),
      ($1,'sched-PVS','Prairie Valley OR schedule feed (SIMULATED)',true,false,240,$5,$4),
      ($1,'sap-future','SAP ERP adapter (NOT CONNECTED - future)',false,false,1440,null,'{}'),
      ($1,'sfdc-future','Salesforce adapter (NOT CONNECTED - future)',false,false,1440,null,'{}')`,
      [T, { 'billing_packet.lines': 'Tracewell (draft)', 'invoice_number': 'ERP', 'payment_status': 'ERP (never set by Tracewell)', 'customer_master': 'ERP', 'po_number': 'Customer / entered by finance' },
        new Date(anchor.getTime() - 20 * 60e3).toISOString(), { 'case.scheduled_start': 'Hospital scheduling system', 'case.requirements': 'Tracewell (approved preference card)', 'case.rep': 'Tracewell' },
        new Date(anchor.getTime() - 9 * 3600e3).toISOString()]);
  });

  const ctxOf = (key: string): Ctx => { const u = ids[key]; return { userId: u.id, tenantId: T, role: u.role, facilityId: u.facility_id, territoryId: u.territory_id, displayName: u.display_name }; };
  const inv = ctxOf('u:inventory'), ops = ctxOf('u:ops'), sched = ctxOf('u:scheduler'), wh = ctxOf('u:warehouse'), courier = ctxOf('u:courier');
  const riley = ctxOf('u:riley.rep'), jordan = ctxOf('u:jordan.rep'), fin = ctxOf('u:finance');
  const sbrRecv = ctxOf('u:receiving@stbrigid'), sbrSpd = ctxOf('u:spd@stbrigid'), pvsRecv = ctxOf('u:receiving@prairievalley'), pvsSpd = ctxOf('u:spd@prairievalley');

  // ---------- Catalog & opening balances via the real CSV import path (day -40) ----------
  await setClock(zoned(addDays(D, -40), '09:00', CHI));
  const MFR = 'Northpoint Ortho Devices (synthetic)', DIST = 'Lakeshore Orthopedic Partners (synthetic)', LINE = 'Meridian Knee System (synthetic)';
  const catalogRows = [
    ['NP-MAT-1001', MFR, 'NP-INS-4-10', 'Meridian tibial insert, size 4, 10 mm', 'implant', 'serial', GTIN.INS_4_10, '4 / 10mm', LINE, 'EA'],
    ['NP-MAT-1002', MFR, 'NP-INS-4-12', 'Meridian tibial insert, size 4, 12 mm', 'implant', 'serial', GTIN.INS_4_12, '4 / 12mm', LINE, 'EA'],
    ['NP-MAT-1003', MFR, 'NP-FEM-4L', 'Meridian femoral component, size 4, left', 'implant', 'serial', GTIN.FEM_4L, '4 L', LINE, 'EA'],
    ['NP-MAT-1004', MFR, 'NP-FEM-5L', 'Meridian femoral component, size 5, left', 'implant', 'serial', GTIN.FEM_5L, '5 L', LINE, 'EA'],
    ['NP-MAT-1005', MFR, 'NP-TIB-4', 'Meridian tibial baseplate, size 4', 'implant', 'serial', GTIN.TIB_4, '4', LINE, 'EA'],
    ['NP-MAT-1006', MFR, 'NP-SCR-650', 'Cancellous bone screw 6.5 x 40 mm', 'implant', 'lot', GTIN.SCR_650, '6.5x40', LINE, 'EA'],
    ['NP-MAT-1101', MFR, 'NP-TRAY-KNEE', 'Meridian knee instrument tray (loaner)', 'tray', 'serial', GTIN.TRAY_KNEE, '', LINE, 'EA'],
    ['NP-MAT-1201', MFR, 'NP-INST-SIZER', 'Femoral sizer', 'instrument', 'serial', GTIN.SIZER, '', LINE, 'EA'],
    ['NP-MAT-1202', MFR, 'NP-INST-CUT4', 'Femoral 4-in-1 cutting block, size 4', 'instrument', 'serial', GTIN.CUT4, '4', LINE, 'EA'],
    ['NP-MAT-1203', MFR, 'NP-INST-TIBGUIDE', 'Tibial resection guide', 'instrument', 'serial', GTIN.TIBGUIDE, '', LINE, 'EA'],
    ['NP-MAT-1204', MFR, 'NP-INST-IMPACT', 'Femoral impactor', 'instrument', 'serial', GTIN.IMPACT, '', LINE, 'EA'],
    ['NP-MAT-1205', MFR, 'NP-INST-TRIAL4', 'Trial set, size 4', 'instrument', 'serial', GTIN.TRIAL4, '4', LINE, 'EA'],
  ];
  const csv = (head: string[], rows: any[][]) => [head.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
  await withTenant(T, (db) => runImport(db, inv, { kind: 'catalog', filename: 'northpoint_catalog_synthetic.csv', sourceSystem: 'NORTHPOINT-PRICEFILE-SIM', mode: 'commit',
    csv: csv(['source_id', 'manufacturer', 'ref', 'description', 'item_type', 'tracking', 'unit_gtin', 'size', 'product_line', 'uom'], catalogRows) }));
  await withTenant(T, (db) => runImport(db, inv, { kind: 'packages', filename: 'northpoint_packages_synthetic.csv', sourceSystem: 'NORTHPOINT-PRICEFILE-SIM', mode: 'commit',
    csv: csv(['source_id', 'item_ref', 'package_gtin', 'level', 'units_per_package', 'uom'], [['PK-1006-5', 'NP-SCR-650', GTIN.SCR_650_BOX5, 'inner', '5', 'BX']]) }));
  const exp = (days: number) => addDays(D, days);
  const ob = [
    ['OB-001', DIST, 'WH-MAIN', 'NP-INS-4-10', 'L26C014', 'INS-0001', exp(400), 'each', '1', 'EA'],
    ['OB-002', DIST, 'TRUNK-JORDAN', 'NP-INS-4-10', 'L26C014', 'INS-0002', exp(400), 'each', '1', 'EA'],
    ['OB-003', 'Prairie Valley Surgical Hospital (synthetic)', 'PVS-CONSIGN', 'NP-INS-4-10', 'L26C014', 'INS-0003', exp(400), 'each', '1', 'EA'],
    ['OB-004', DIST, 'TRUNK-RILEY', 'NP-INS-4-10', 'L25K201', 'INS-0004', exp(-1), 'each', '1', 'EA'],
    ['OB-005', DIST, 'WH-MAIN', 'NP-INS-4-10', 'L26A003', 'INS-0006', exp(300), 'each', '1', 'EA'],
    ['OB-006', DIST, 'WH-MAIN', 'NP-INS-4-10', 'L26A003', 'INS-0007', exp(300), 'each', '1', 'EA'],
    ['OB-007', DIST, 'WH-MAIN', 'NP-INS-4-12', 'L26C020', 'INS12-0001', exp(420), 'each', '1', 'EA'],
    ['OB-008', MFR, 'SBR-CONSIGN', 'NP-FEM-4L', 'L26B110', 'FEM4L-0101', exp(500), 'each', '1', 'EA'],
    ['OB-009', MFR, 'SBR-CONSIGN', 'NP-TIB-4', 'L26B210', 'TIB4-0201', exp(500), 'each', '1', 'EA'],
    ['OB-010', DIST, 'WH-MAIN', 'NP-FEM-4L', 'L26B110', 'FEM4L-0102', exp(500), 'each', '1', 'EA'],
    ['OB-011', DIST, 'WH-MAIN', 'NP-FEM-5L', 'L26B111', 'FEM5L-0301', exp(500), 'each', '1', 'EA'],
    ['OB-012', DIST, 'WH-MAIN', 'NP-FEM-5L', 'L26B111', 'FEM5L-0302', exp(500), 'each', '1', 'EA'],
    ['OB-013', DIST, 'WH-MAIN', 'NP-TIB-4', 'L26B210', 'TIB4-0202', exp(500), 'each', '1', 'EA'],
    ['OB-014', DIST, 'WH-MAIN', 'NP-TIB-4', 'L26B210', 'TIB4-0203', exp(500), 'each', '1', 'EA'],
    ['OB-015', DIST, 'WH-MAIN', 'NP-SCR-650', 'S26B088', '', exp(700), 'inner', '4', 'BX'],
    ['OB-016', DIST, 'TRUNK-RILEY', 'NP-SCR-650', 'S26B088', '', exp(700), 'each', '5', 'EA'],
    ['OB-017', MFR, 'WH-MAIN', 'NP-TRAY-KNEE', 'T-LOANER', 'TRY-K-001', '', 'each', '1', 'EA'],
    ['OB-018', MFR, 'WH-MAIN', 'NP-TRAY-KNEE', 'T-LOANER', 'TRY-K-002', '', 'each', '1', 'EA'],
    ['OB-019', MFR, 'WH-MAIN', 'NP-INST-SIZER', 'I-LOOSE', 'SZ-0207', '', 'each', '1', 'EA'],
    ['OB-020', DIST, 'WH-MAIN', 'NP-INS-4-10', 'L26C030', 'INS-0010', exp(450), 'each', '1', 'EA'],
    ['OB-021', DIST, 'WH-MAIN', 'NP-INS-4-10', 'L26C030', 'INS-0011', exp(450), 'each', '1', 'EA'],
    ['OB-022', DIST, 'WH-MAIN', 'NP-FEM-4L', 'L26B110', 'FEM4L-0103', exp(500), 'each', '1', 'EA'],
    ['OB-023', DIST, 'WH-MAIN', 'NP-TIB-4', 'L26B210', 'TIB4-0204', exp(500), 'each', '1', 'EA'],
    ['OB-024', DIST, 'TRUNK-JORDAN', 'NP-FEM-4L', 'L26B110', 'FEM4L-0104', exp(500), 'each', '1', 'EA'],
    ['OB-025', DIST, 'TRUNK-JORDAN', 'NP-TIB-4', 'L26B210', 'TIB4-0205', exp(500), 'each', '1', 'EA'],
    ['OB-026', DIST, 'WH-MAIN', 'NP-FEM-4L', 'L26B110', 'FEM4L-0105', exp(500), 'each', '1', 'EA'],
  ];
  const obRep = await withTenant(T, (db) => runImport(db, inv, { kind: 'opening_balances', filename: 'opening_balances_synthetic.csv', sourceSystem: 'LEGACY-SPREADSHEET-SIM', mode: 'commit',
    csv: csv(['source_id', 'owner', 'location_code', 'item_ref', 'lot', 'serial', 'expiry', 'package_level', 'quantity', 'uom'], ob) }));
  if ((obRep.counts.error ?? 0) > 0) throw new Error('Seed opening balances had errors: ' + JSON.stringify(obRep.rows.filter((r: any) => r.status === 'error')));
  log(`imported catalog + ${obRep.counts.accepted} opening balance rows (${obRep.reconciliation?.units_posted_to_ledger} units)`);

  // Tray manifests, preference cards, contracts.
  await withTenant(T, async (db) => {
    const item = async (ref: string) => (await one(db, `select id from catalog_items where ref=$1`, [ref])).id;
    const tray = await item('NP-TRAY-KNEE');
    const mv1 = (await db.query(`insert into tray_manifest_versions(tenant_id,tray_catalog_item_id,version,status,approved_by,approved_at) values ($1,$2,1,'retired',$3,$4) returning id`, [T, tray, ops.userId, nowIso()])).rows[0].id;
    const mv2 = (await db.query(`insert into tray_manifest_versions(tenant_id,tray_catalog_item_id,version,status,approved_by,approved_at) values ($1,$2,2,'approved',$3,$4) returning id`, [T, tray, ops.userId, nowIso()])).rows[0].id;
    for (const [mv, list] of [[mv1, ['NP-INST-SIZER', 'NP-INST-CUT4', 'NP-INST-TIBGUIDE', 'NP-INST-IMPACT']], [mv2, ['NP-INST-SIZER', 'NP-INST-CUT4', 'NP-INST-TIBGUIDE', 'NP-INST-IMPACT', 'NP-INST-TRIAL4']]] as const) {
      for (const ref of list) await db.query(`insert into tray_manifest_lines(tenant_id,manifest_version_id,catalog_item_id,qty,required) values ($1,$2,$3,1,true)`, [T, mv, await item(ref)]);
    }
    for (const sn of ['TRY-K-001', 'TRY-K-002']) {
      const si = await one(db, `select id from stock_items where serial_number=$1`, [sn]);
      await db.query(`insert into tray_instances(stock_item_id,tenant_id,manifest_version_id) values ($1,$2,$3)`, [si.id, T, mv2]);
    }
    const card = (await db.query(`insert into preference_cards(tenant_id,code,surgeon_ref,procedure) values ($1,'PC-KNEE-S104','Surgeon S-104 (synthetic)','Total knee arthroplasty, primary, left') returning id`, [T])).rows[0].id;
    const v1 = (await db.query(`insert into preference_card_versions(tenant_id,card_id,version,status,approved_by,approved_at,change_note) values ($1,$2,1,'superseded',$3,$4,'Initial card') returning id`, [T, card, ops.userId, nowIso()])).rows[0].id;
    const v2 = (await db.query(`insert into preference_card_versions(tenant_id,card_id,version,status,approved_by,approved_at,change_note) values ($1,$2,2,'approved',$3,$4,'Surgeon office confirmed 10 mm insert as primary; 12 mm as backup') returning id`, [T, card, ops.userId, nowIso()])).rows[0].id;
    ids.cardV2 = v2;
    const line = async (v: string, ref: string, qty: number, mand: boolean, backup?: string) => (await db.query(`insert into preference_card_lines(tenant_id,card_version_id,catalog_item_id,qty,mandatory,backup_for_line_id) values ($1,$2,$3,$4,$5,$6) returning id`, [T, v, await item(ref), qty, mand, backup ?? null])).rows[0].id;
    await line(v1, 'NP-INS-4-12', 1, true); await line(v1, 'NP-FEM-4L', 1, true); await line(v1, 'NP-TIB-4', 1, true); await line(v1, 'NP-TRAY-KNEE', 1, true);
    const ins10 = await line(v2, 'NP-INS-4-10', 1, true); const fem = await line(v2, 'NP-FEM-4L', 1, true);
    await line(v2, 'NP-TIB-4', 1, true); await line(v2, 'NP-TRAY-KNEE', 1, true);
    await line(v2, 'NP-INS-4-12', 1, false, ins10); await line(v2, 'NP-FEM-5L', 1, false, fem);
    // A draft (unapproved) v3 exists to show cases cannot use unapproved cards.
    await db.query(`insert into preference_card_versions(tenant_id,card_id,version,status,change_note) values ($1,$2,3,'draft','Proposed: add 2 bone screws (awaiting approval)')`, [T, card]);

    const k1 = (await db.query(`insert into contracts(tenant_id,facility_id,name) values ($1,$2,'St. Brigid Implant Consignment Agreement (synthetic)') returning id`, [T, ids.SBR])).rows[0].id;
    const k1v = (await db.query(`insert into contract_versions(tenant_id,contract_id,version,effective_from,approved_by) values ($1,$2,3,'2026-01-01','Contracts desk (synthetic)') returning id`, [T, k1])).rows[0].id;
    const k2 = (await db.query(`insert into contracts(tenant_id,facility_id,name) values ($1,$2,'Prairie Valley Purchase Agreement (synthetic)') returning id`, [T, ids.PVS])).rows[0].id;
    const k2v = (await db.query(`insert into contract_versions(tenant_id,contract_id,version,effective_from,approved_by) values ($1,$2,1,'2026-01-01','Contracts desk (synthetic)') returning id`, [T, k2])).rows[0].id;
    const prices: [string, string, number][] = [[k1v, 'NP-INS-4-10', 118000], [k1v, 'NP-INS-4-12', 118000], [k1v, 'NP-FEM-4L', 345000], [k1v, 'NP-FEM-5L', 345000], [k1v, 'NP-TIB-4', 215000], [k1v, 'NP-SCR-650', 8500],
      [k2v, 'NP-INS-4-10', 112500], [k2v, 'NP-FEM-4L', 331000], [k2v, 'NP-FEM-5L', 331000], [k2v, 'NP-SCR-650', 8000]]; // PVS has no price for NP-TIB-4 (finance exception path)
    for (const [v, ref, cents] of prices) await db.query(`insert into contract_prices(tenant_id,contract_version_id,catalog_item_id,unit_price_cents,price_date) values ($1,$2,$3,$4,'2026-01-01')`, [T, v, await item(ref), cents]);
    const rule = (v: string, d: string, c: string, r: string, m: string, txt: string) => db.query(`insert into contract_rules(tenant_id,contract_version_id,disposition,charge_action,replenish_action,billing_mode,rule_text) values ($1,$2,$3,$4,$5,$6,$7)`, [T, v, d, c, r, m, txt]);
    await rule(k1v, 'implanted', 'charge', 'replace', 'bill_and_replace', 'Consigned implant placed: bill at contract price and replace to consignment (s.2.1).');
    await rule(k1v, 'opened_unused', 'charge', 'replace', 'bill_and_replace', 'Opened but unused implant is chargeable and replaced (s.2.4).');
    await rule(k1v, 'wasted', 'charge', 'replace', 'bill_and_replace', 'Wasted implant is chargeable (s.2.4).');
    await rule(k1v, 'damaged', 'review', 'review', 'bill_and_replace', 'Damaged product requires joint review (s.2.6).');
    await rule(k1v, 'returned_sealed', 'no_charge', 'none', 'bill_and_replace', 'Returned sealed: no charge (s.2.2).');
    await rule(k1v, 'missing', 'review', 'review', 'bill_and_replace', 'Missing product requires investigation before billing (s.2.7).');
    await rule(k2v, 'implanted', 'charge', 'none', 'bill_only', 'Purchased stock used: bill only; no replenishment (s.3.1).');
    await rule(k2v, 'opened_unused', 'review', 'review', 'bill_only', 'Opened-unused requires distributor and hospital review before any charge (s.4.2).');
    await rule(k2v, 'wasted', 'review', 'review', 'bill_only', 'Waste requires review (s.4.2).');
    await rule(k2v, 'damaged', 'review', 'review', 'bill_only', 'Damage requires review (s.4.3).');
    await rule(k2v, 'returned_sealed', 'no_charge', 'none', 'bill_only', 'Returned sealed: no charge.');
    await rule(k2v, 'missing', 'review', 'review', 'bill_only', 'Missing requires review.');
  });

  // ---------- Historical completed cases (run real workflows at past clock times) ----------
  const stockId = async (db: Db, sn: string) => (await one(db, `select id from stock_items where serial_number=$1`, [sn])).id;
  const reqId = async (db: Db, caseId: string, ref: string) => (await one(db, `select cr.id from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and ci.ref=$2`, [caseId, ref])).id;
  async function historical(n: number, dayOffset: number, fac: 'SBR' | 'PVS', units: { ins: string; fem: string; tib: string; tray: string }, ref: string, opts: { accept: boolean; lateTray?: boolean }) {
    const tz = fac === 'SBR' ? CHI : IND;
    const day = addDays(D, dayOffset);
    const start = zoned(day, '07:30', tz);
    const rep = fac === 'SBR' ? riley : jordan;
    const recv = fac === 'SBR' ? sbrRecv : pvsRecv; const spd = fac === 'SBR' ? sbrSpd : pvsSpd;
    await setClock(new Date(start.getTime() - 50 * 3600e3));
    const c = await withTenant(T, (db) => createCase(db, sched, { facilityId: ids[fac], cardVersionId: ids.cardV2, scheduledStart: start.toISOString(), repUserId: rep.userId, caseRef: ref }));
    await withTenant(T, async (db) => {
      for (const [r, sn] of [['NP-INS-4-10', units.ins], ['NP-FEM-4L', units.fem], ['NP-TIB-4', units.tib], ['NP-TRAY-KNEE', units.tray]]) {
        const sid = await stockId(db, sn);
        const bal = await one(db, `select location_id, owner_party_id from stock_balances where stock_item_id=$1 and qty>0`, [sid]);
        await reserve(db, ops, { caseId: c.id, requirementId: await reqId(db, c.id, r), stockItemId: sid, locationId: bal.location_id, ownerPartyId: bal.owner_party_id, qty: 1 });
      }
      await ship.planCaseDelivery(db, ops, c.id);
    });
    const shipments = await withTenant(T, (db) => db.query(`select id from shipments where case_id=$1`, [c.id]).then((r) => r.rows));
    const leadH = opts.lateTray ? (fac === 'SBR' ? 9 : 20) : (fac === 'SBR' ? 20 : 30);
    await setClock(new Date(start.getTime() - (leadH + 2) * 3600e3));
    for (const s of shipments) {
      await withTenant(T, async (db) => {
        const d = await ship.shipmentDetail(db, wh, s.id);
        for (const l of d.lines) await ship.pickLine(db, wh, s.id, { lineId: l.id, qty: l.qty_expected });
        await ship.packShipment(db, wh, s.id);
        await ship.dispatchShipment(db, wh, s.id, { courierName: 'Synthetic Courier Co.' });
      });
    }
    await setClock(new Date(start.getTime() - leadH * 3600e3));
    for (const s of shipments) await withTenant(T, (db) => ship.courierEvent(db, courier, s.id, { type: 'delivered' }));
    await setClock(new Date(start.getTime() - (leadH - 0.5) * 3600e3));
    for (const s of shipments) {
      await withTenant(T, async (db) => {
        const d = await ship.shipmentDetail(db, recv, s.id);
        await ship.receiveShipment(db, recv, s.id, { lines: d.lines.map((l: any) => ({ lineId: l.id, qtyReceived: l.qty_dispatched, sealIntact: true })) });
      });
    }
    await withTenant(T, async (db) => {
      const trayId = await stockId(db, units.tray);
      const m = await ship.trayManifest(db, trayId);
      await ship.verifyTray(db, recv, trayId, { caseId: c.id, sealIntact: true, lines: m.lines.map((l: any) => ({ catalogItemId: l.catalog_item_id, actualQty: l.qty })) });
    });
    await setClock(new Date(start.getTime() - (leadH - 3) * 3600e3));
    await withTenant(T, async (db) => {
      const trayId = await stockId(db, units.tray);
      await ship.recordRelease(db, spd, c.id, { trayStockItemId: trayId, decision: 'released', evidence: { hospital_processing_record_ref: `SYN-LOAD-${n}0${n}`, loaner_count_sheet_ref: `SYN-CS-${n}` } });
      for (const s of shipments) await ship.closeHandoff(db, recv, s.id);
    });
    await setClock(new Date(start.getTime() + 3 * 3600e3));
    await withTenant(T, async (db) => {
      for (const [g, sn, lot] of [[GTIN.INS_4_10, units.ins, null], [GTIN.FEM_4L, units.fem, null], [GTIN.TIB_4, units.tib, null]] as const) {
        const st = await one(db, `select * from stock_items where serial_number=$1`, [sn]);
        await recordUsage(db, rep, { clientEventId: `seed-${ref}-${sn}`, caseId: c.id, disposition: 'implanted', entryMethod: 'scanner', rawScan: buildGs1({ gtin: g, expiry: st.expiry_date, lot: st.lot_number, serial: sn }, { symbologyId: true }) });
      }
    });
    await setClock(new Date(start.getTime() + 3.4 * 3600e3));
    await withTenant(T, (db) => submitCloseout(db, rep, c.id, {}));
    if (fac === 'PVS') return c; // PVS contract lacks a NP-TIB-4 price: stays a finance exception
    await setClock(new Date(start.getTime() + 26 * 3600e3));
    const pk = await withTenant(T, (db) => bill.generatePacket(db, fin, c.id));
    await withTenant(T, (db) => bill.queuePacketToErp(db, fin, pk.packet.id));
    await processOutboxForTenant(T);
    if (opts.accept) {
      await setClock(new Date(start.getTime() + 4 * 864e5));
      await withTenant(T, async (db) => {
        const lines = await db.query(`select catalog_item_id, sum(qty)::int qty, max(unit_price_cents) p from charges where packet_id=$1 group by 1`, [pk.packet.id]);
        await bill.enterPO(db, fin, pk.packet.id, { poNumber: `SYN-PO-${70000 + n}`, lines: lines.rows.map((l: any) => ({ catalogItemId: l.catalog_item_id, qty: l.qty, unitPriceCents: l.p })) });
        await bill.acceptPacket(db, fin, pk.packet.id, { customerReference: `SYN-AP-ACK-${n}` });
      });
    }
    return c;
  }
  await historical(1, -21, 'SBR', { ins: 'INS-0010', fem: 'FEM4L-0102', tib: 'TIB4-0202', tray: 'TRY-K-001' }, 'SYN-0901', { accept: true });
  await historical(2, -12, 'SBR', { ins: 'INS-0011', fem: 'FEM4L-0103', tib: 'TIB4-0203', tray: 'TRY-K-002' }, 'SYN-0902', { accept: false, lateTray: true });
  await historical(3, -6, 'PVS', { ins: 'INS-0007', fem: 'FEM4L-0105', tib: 'TIB4-0204', tray: 'TRY-K-001' }, 'SYN-0903', { accept: false });
  log('ran 3 historical cases through the full workflow');

  // Return the two loaner trays to the warehouse (historical), so they are available.
  for (const [sn, fac, recvCtx] of [['TRY-K-001', 'PVS', pvsRecv], ['TRY-K-002', 'SBR', sbrRecv]] as const) {
    await setClock(zoned(addDays(D, -3), '15:00', CHI));
    const s = await withTenant(T, async (db) => {
      const sid = await stockId(db, sn);
      const bal = await one(db, `select * from stock_balances where stock_item_id=$1 and qty>0`, [sid]);
      const sh = await ship.createShipment(db, ops, { fromLocationId: bal.location_id, toLocationId: ids.L_WH, kind: 'return', lines: [{ stockItemId: sid, ownerPartyId: bal.owner_party_id, qty: 1 }], note: 'Loaner tray return after case' });
      const d = await ship.shipmentDetail(db, ops, sh.id);
      await ship.pickLine(db, ops, sh.id, { lineId: d.lines[0].id, qty: 1 });
      await ship.dispatchShipment(db, ops, sh.id, { courierName: 'Synthetic Courier Co.' });
      return sh;
    });
    await withTenant(T, async (db) => {
      const d = await ship.shipmentDetail(db, wh, s.id);
      await ship.receiveShipment(db, wh, s.id, { lines: [{ lineId: d.lines[0].id, qtyReceived: 1, sealIntact: true }] });
      const trayId = await stockId(db, sn);
      const m = await ship.trayManifest(db, trayId);
      // Warehouse reprocessing check after return: complete.
      await ship.verifyTray(db, wh, trayId, { sealIntact: true, lines: m.lines.map((l: any) => ({ catalogItemId: l.catalog_item_id, actualQty: l.qty })) });
      await ship.closeHandoff(db, wh, s.id);
    });
  }

  // Blind cycle count at the warehouse with one variance (screws), approved by a second person.
  await setClock(zoned(addDays(D, -5), '10:00', CHI));
  await withTenant(T, async (db) => {
    const s = await counts.startCount(db, wh, { locationId: ids.L_WH });
    const bal = await db.query(`select ci.ref, s.serial_number, s.lot_number, b.qty from stock_balances b join stock_items s on s.id=b.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id where b.location_id=$1 and b.qty>0 and b.condition='sealed'`, [ids.L_WH]);
    for (const b of bal.rows) await counts.addCountLine(db, wh, s.id, { ref: b.ref, lot: b.lot_number, serial: b.serial_number, countedQty: b.ref === 'NP-SCR-650' ? b.qty - 1 : b.qty });
    await counts.submitCount(db, wh, s.id);
    await counts.reviewCount(db, inv, s.id, { decision: 'approve', note: 'Recount confirmed 19 screws; one unit unaccounted (synthetic)' });
  });

  // ---------- Demo-day setup (anchor = demo date 08:00 Chicago) ----------
  await setClock(new Date(anchor.getTime() - 26 * 3600e3));
  const tomorrow = addDays(D, 1);
  await withTenant(T, async (db) => {
    // Manual quality hold on lot L26A003 (packaging investigation) -> excluded from rescue.
    const held = await one(db, `select id from stock_items where serial_number='INS-0006'`);
    await db.query(`insert into quality_holds(tenant_id,stock_item_id,reason,status,placed_by,placed_at) values ($1,$2,'Packaging damage investigation QH-0042 (synthetic)','active',$3,$4)`, [T, held.id, ids['u:quality'].id, nowIso()]);
  });
  // SYN-1003: later case at St. Brigid that already holds the nearest 10 mm insert.
  const c3 = await withTenant(T, (db) => createCase(db, sched, { facilityId: ids.SBR, cardVersionId: ids.cardV2, scheduledStart: zoned(addDays(D, 3), '10:00', CHI).toISOString(), repUserId: riley.userId, caseRef: 'SYN-1003' }));
  await withTenant(T, async (db) => {
    const sid = await stockId(db, 'INS-0001');
    await reserve(db, ops, { caseId: c3.id, requirementId: await reqId(db, c3.id, 'NP-INS-4-10'), stockItemId: sid, locationId: ids.L_WH, ownerPartyId: ids.dist, qty: 1 });
  });
  // SYN-1001: tomorrow 07:30 at St. Brigid. Femoral + tibial reserved from consignment; tray reserved at warehouse; 10 mm insert NOT yet reserved.
  const c1 = await withTenant(T, (db) => createCase(db, sched, { facilityId: ids.SBR, cardVersionId: ids.cardV2, scheduledStart: zoned(tomorrow, '07:30', CHI).toISOString(), repUserId: riley.userId, caseRef: 'SYN-1001' }));
  await withTenant(T, async (db) => {
    await reserve(db, ops, { caseId: c1.id, requirementId: await reqId(db, c1.id, 'NP-FEM-4L'), stockItemId: await stockId(db, 'FEM4L-0101'), locationId: ids.L_SBR_CONS, ownerPartyId: ids.mfr, qty: 1 });
    await reserve(db, ops, { caseId: c1.id, requirementId: await reqId(db, c1.id, 'NP-TIB-4'), stockItemId: await stockId(db, 'TIB4-0201'), locationId: ids.L_SBR_CONS, ownerPartyId: ids.mfr, qty: 1 });
    await reserve(db, ops, { caseId: c1.id, requirementId: await reqId(db, c1.id, 'NP-TRAY-KNEE'), stockItemId: await stockId(db, 'TRY-K-002'), locationId: ids.L_WH, ownerPartyId: ids.mfr, qty: 1 });
  });
  // SYN-1002: tomorrow 13:00 Eastern at Prairie Valley (schedule feed is stale).
  const c2 = await withTenant(T, (db) => createCase(db, sched, { facilityId: ids.PVS, cardVersionId: ids.cardV2, scheduledStart: zoned(tomorrow, '13:00', IND).toISOString(), repUserId: jordan.userId, caseRef: 'SYN-1002' }));
  await withTenant(T, async (db) => {
    await reserve(db, ops, { caseId: c2.id, requirementId: await reqId(db, c2.id, 'NP-FEM-4L'), stockItemId: await stockId(db, 'FEM4L-0104'), locationId: ids.L_TR_JORDAN, ownerPartyId: ids.dist, qty: 1 });
    await reserve(db, ops, { caseId: c2.id, requirementId: await reqId(db, c2.id, 'NP-INS-4-10'), stockItemId: await stockId(db, 'INS-0003'), locationId: ids.L_PVS_CONS, ownerPartyId: ids.pPVS, qty: 1 });
    await reserve(db, ops, { caseId: c2.id, requirementId: await reqId(db, c2.id, 'NP-TIB-4'), stockItemId: await stockId(db, 'TIB4-0205'), locationId: ids.L_TR_JORDAN, ownerPartyId: ids.dist, qty: 1 });
    await reserve(db, ops, { caseId: c2.id, requirementId: await reqId(db, c2.id, 'NP-TRAY-KNEE'), stockItemId: await stockId(db, 'TRY-K-001'), locationId: ids.L_WH, ownerPartyId: ids.mfr, qty: 1 });
    const feed = await one(db, `select id from integration_feeds where code='sched-PVS'`);
    await db.query(`insert into sync_differences(tenant_id,feed_id,entity,entity_ref,field,our_value,their_value,status,created_at) values ($1,$2,'case','SYN-1002','scheduled_start','13:00 EST','13:30 EST (last feed message, 9 h old)','open',$3)`, [T, feed.id, nowIso()]);
  });
  await setClock(anchor);
  log(`demo clock set to ${anchor.toISOString()} (demo date ${D}, 08:00 America/Chicago)`);

  // ---------- Tenant 2 (isolation proof) ----------
  const [t2] = await q(`insert into tenants(slug,name) values ('ridgeway','Ridgeway Surgical Supply (synthetic)') returning id`);
  await withTenant(t2.id, async (db) => {
    const T2 = t2.id;
    const p = (await db.query(`insert into parties(tenant_id,name,kind) values ($1,'Ridgeway Surgical Supply (synthetic)','distributor') returning id`, [T2])).rows[0].id;
    const f = (await db.query(`insert into facilities(tenant_id,code,name,kind,timezone) values ($1,'HPM','Harbor Point Medical (synthetic)','hospital','America/New_York') returning id`, [T2])).rows[0].id;
    await db.query(`insert into facility_policies(tenant_id,facility_id,version,tray_due_hours_before,implant_due_hours_before,required_evidence,effective_from,approved_by) values ($1,$2,1,12,2,'{}','2026-01-01','HPM (synthetic)')`, [T2, f]);
    await db.query(`insert into locations(tenant_id,code,name,kind,allocatable) values ($1,'RW-WH','Ridgeway warehouse','warehouse',true),($1,'RW-TRANSIT','In transit','in_transit',false),($1,'RW-CONSUMED','Consumed','consumed',false)`, [T2]);
    await db.query(`insert into locations(tenant_id,code,name,kind,facility_id,allocatable) values ($1,'HPM-RECV','Harbor Point receiving','hospital_receiving',$2,true)`, [T2, f]);
    const admin = (await db.query(`insert into users(tenant_id,email,display_name,password_hash,role) values ($1,'ops@ridgeway.example','Kai Ridgeway Ops','${pw}','ops_manager') returning id`, [T2])).rows[0].id;
    await db.query(`insert into users(tenant_id,email,display_name,password_hash,role) values ($1,'rep@ridgeway.example','Noor Ridgeway Rep','${pw}','rep')`, [T2]);
    await db.query(`insert into users(tenant_id,email,display_name,password_hash,role,facility_id) values ($1,'receiving@harborpoint.example','Harbor Point Receiving','${pw}','hospital_receiving',$2)`, [T2, f]);
    const mfr = (await db.query(`insert into parties(tenant_id,name,kind) values ($1,'Other Spine Co (synthetic)','manufacturer') returning id`, [T2])).rows[0].id;
    const ci = (await db.query(`insert into catalog_items(tenant_id,manufacturer_party_id,ref,description,item_type,tracking,unit_gtin) values ($1,$2,'RW-CAGE-10','Interbody cage 10 mm (synthetic)','implant','serial',$3) returning id`, [T2, mfr, gtinWithCheckDigit('0061414200001')])).rows[0].id;
    const card = (await db.query(`insert into preference_cards(tenant_id,code,surgeon_ref,procedure) values ($1,'RW-PC-1','Surgeon R-9 (synthetic)','Lumbar fusion') returning id`, [T2])).rows[0].id;
    const v = (await db.query(`insert into preference_card_versions(tenant_id,card_id,version,status,approved_by,approved_at) values ($1,$2,1,'approved',$3,$4) returning id`, [T2, card, admin, nowIso()])).rows[0].id;
    await db.query(`insert into preference_card_lines(tenant_id,card_version_id,catalog_item_id,qty,mandatory) values ($1,$2,$3,1,true)`, [T2, v, ci]);
    await db.query(`insert into cases(tenant_id,case_ref,facility_id,procedure,surgeon_ref,scheduled_start,status,preference_card_version_id) values ($1,'RDG-2001',$2,'Lumbar fusion','Surgeon R-9 (synthetic)',$3,'scheduled',$4)`, [T2, f, new Date(anchor.getTime() + 30 * 3600e3).toISOString(), v]);
    void p;
  });
  log('seeded second tenant (Ridgeway) for isolation tests');
  return { demoDate: D, anchor: anchor.toISOString(), tenantId: T, tenant2Id: t2.id };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then((r) => { console.log(`[seed] done. Demo date ${r.demoDate}. Password for all synthetic accounts: ${DEMO_PASSWORD} (development only)`); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
