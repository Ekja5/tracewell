/**
 * Second, independent synthetic dataset. Shares NOTHING with the demo seed except code: different
 * tenants, facility names, time zones, cutoffs, accounts, catalog (with catalog numbers that overlap
 * between the two tenants), and a different reference date. Used by tests/integration/alt-dataset.test.ts
 * to prove behavior does not depend on demo IDs, dates or names.
 *
 *   ALT_DATE=2027-03-09 npx tsx src/server/seed/seed-alt.ts
 */
import { pool, q, withTenant, one } from '../db.js';
import { setClock, nowIso } from '../clock.js';
import { hashPassword } from '../auth.js';
import { gtinWithCheckDigit } from '../../shared/gs1.js';
import type { Ctx } from '../perms.js';
import { runImport, csvCell } from '../domain/imports.js';
import { createCase, cancelCase } from '../domain/cases.js';
import { reserve } from '../domain/inventory.js';
import { resetDb } from './seed.js';
import { zoned, addDaysYmd } from '../time.js';

export const ALT_PASSWORD = 'Alt-Synthetic-2027!';

interface TenantSpec {
  slug: string; name: string; tz: string; gtinBase: string; hospitals: { code: string; name: string; tz: string; tray: number; implant: number; open: string | null; close: string | null; evidence: string[] }[];
}

const SPECS: TenantSpec[] = [
  { slug: 'cascade', name: 'Cascade Ortho Supply (synthetic)', tz: 'America/Denver', gtinBase: '0812345',
    hospitals: [
      { code: 'MTN', name: 'Mountain View Ortho Hospital (synthetic)', tz: 'America/Denver', tray: 18, implant: 6, open: '08:00', close: '16:00', evidence: ['spd_record'] },
      { code: 'CST', name: 'Coastline Surgical Center (synthetic)', tz: 'America/Los_Angeles', tray: 6, implant: 1, open: null, close: null, evidence: [] },
    ] },
  { slug: 'bayline', name: 'Bayline Medical Distribution (synthetic)', tz: 'America/Los_Angeles', gtinBase: '0898765',
    hospitals: [
      { code: 'HBR', name: 'Harborlight Medical Center (synthetic)', tz: 'America/Los_Angeles', tray: 10, implant: 3, open: '06:30', close: '18:30', evidence: ['spd_record', 'count_sheet'] },
    ] },
];

// The same catalog numbers exist in both tenants (overlap), with different GTINs and prices.
const ITEMS = [
  ['KN-STEM-12', 'Knee stem 12 mm', 'implant', 'serial'], ['KN-INSERT-9', 'Insert 9 mm', 'implant', 'serial'],
  ['SCREW-35-30', 'Cortical screw 3.5 x 30', 'implant', 'lot'], ['TRAY-KN-A', 'Knee instrument set A', 'tray', 'serial'],
  ['INST-GUIDE', 'Alignment guide', 'instrument', 'serial'], ['INST-REAMER', 'Reamer 12', 'instrument', 'serial'],
];

export async function seedAlt(opts: { date?: string; quiet?: boolean } = {}) {
  const log = (s: string) => { if (!opts.quiet) console.log(`[seed-alt] ${s}`); };
  const D = opts.date ?? process.env.ALT_DATE ?? '2027-03-09';
  await resetDb();
  const pw = await hashPassword(ALT_PASSWORD);
  const out: any = { date: D, tenants: {} };
  for (const [ti, spec] of SPECS.entries()) {
    const [t] = await q(`insert into tenants(slug,name) values ($1,$2) returning id`, [spec.slug, spec.name]);
    const T = t.id;
    const ids: any = { T };
    await setClock(zoned(addDaysYmd(D, -30), '09:00', spec.tz));
    await withTenant(T, async (db) => {
      const ins = async (sql: string, p: any[]) => (await db.query(sql, p)).rows[0];
      ids.terr = (await ins(`insert into territories(tenant_id,name) values ($1,'All') returning id`, [T])).id;
      ids.dist = (await ins(`insert into parties(tenant_id,name,kind) values ($1,$2,'distributor') returning id`, [T, spec.name])).id;
      ids.mfr = (await ins(`insert into parties(tenant_id,name,kind) values ($1,$2,'manufacturer') returning id`, [T, `Alder Implant Works ${ti + 1} (synthetic)`])).id;
      ids.whFac = (await ins(`insert into facilities(tenant_id,code,name,kind,timezone,territory_id,party_id) values ($1,'DC','Distribution center','warehouse',$2,$3,$4) returning id`, [T, spec.tz, ids.terr, ids.dist])).id;
      const users: [string, string, string, string | null][] = [
        [`ops@${spec.slug}.example`, `${spec.slug} ops lead`, 'ops_manager', null], [`rep1@${spec.slug}.example`, `${spec.slug} rep one`, 'rep', null],
        [`rep2@${spec.slug}.example`, `${spec.slug} rep two`, 'rep', null], [`wh@${spec.slug}.example`, `${spec.slug} warehouse`, 'warehouse', null],
        [`fin@${spec.slug}.example`, `${spec.slug} finance`, 'finance', null], [`qa1@${spec.slug}.example`, `${spec.slug} quality one`, 'quality_manager', null],
        [`qa2@${spec.slug}.example`, `${spec.slug} quality two`, 'quality_manager', null], [`inv@${spec.slug}.example`, `${spec.slug} inventory`, 'inventory_coordinator', null],
        [`sched@${spec.slug}.example`, `${spec.slug} scheduler`, 'scheduler', null],
      ];
      for (const [email, name, role] of users) ids[role + ':' + email.split('@')[0]] = (await ins(`insert into users(tenant_id,email,display_name,password_hash,role,territory_id) values ($1,$2,$3,$4,$5,$6) returning id`, [T, email, name, pw, role, role === 'rep' ? ids.terr : null])).id;
      const L = async (code: string, kind: string, fac: string | null, holder: string | null, alloc: boolean) => (await ins(`insert into locations(tenant_id,code,name,kind,facility_id,holder_user_id,allocatable) values ($1,$2,$2,$3,$4,$5,$6) returning id`, [T, code, kind, fac, holder, alloc])).id;
      ids.L_DC = await L('DC-A', 'warehouse', ids.whFac, null, true);
      ids.L_FAR = await L('DC-FAR', 'warehouse', null, null, true); // remote depot: overnight transfers
      await L('Q', 'quarantine', null, null, false); await L('RET', 'returns', null, null, false); await L('TRANSIT', 'in_transit', null, null, false);
      await L('USED', 'consumed', null, null, false); await L('WASTE', 'wasted', null, null, false); await L('LOST', 'missing', null, null, false);
      ids.L_T1 = await L('TRK-1', 'trunk', null, ids['rep:rep1'], true);
      ids.L_T2 = await L('TRK-2', 'trunk', null, ids['rep:rep2'], true);
      ids.hosp = {};
      for (const h of spec.hospitals) {
        const party = (await ins(`insert into parties(tenant_id,name,kind) values ($1,$2,'hospital') returning id`, [T, h.name])).id;
        const f = (await ins(`insert into facilities(tenant_id,code,name,kind,timezone,territory_id,party_id) values ($1,$2,$3,'hospital',$4,$5,$6) returning id`, [T, h.code, h.name, h.tz, ids.terr, party])).id;
        await db.query(`insert into facility_policies(tenant_id,facility_id,version,tray_due_hours_before,implant_due_hours_before,requires_release_decision,required_evidence,effective_from,approved_by,receiving_open,receiving_close) values ($1,$2,1,$3,$4,true,$5,'2026-01-01','synthetic',$6,$7)`,
          [T, f, h.tray, h.implant, h.evidence, h.open, h.close]);
        const recv = await L(`${h.code}-RCV`, 'hospital_receiving', f, null, true);
        await db.query(`insert into users(tenant_id,email,display_name,password_hash,role,facility_id) values ($1,$2,$3,$4,'hospital_receiving',$5),($1,$6,$7,$4,'hospital_spd',$5)`,
          [T, `rcv@${h.code.toLowerCase()}.${spec.slug}.example`, `${h.code} receiving`, pw, f, `spd@${h.code.toLowerCase()}.${spec.slug}.example`, `${h.code} SPD`]);
        for (const [loc, min, cost] of [[ids.L_DC, 45, 3000], [ids.L_FAR, 720, 9000], [ids.L_T1, 20, 1000], [ids.L_T2, 70, 2000]] as const)
          await db.query(`insert into travel_estimates(tenant_id,from_location_id,to_facility_id,minutes,courier_cost_cents) values ($1,$2,$3,$4,$5)`, [T, loc, f, min, cost]);
        ids.hosp[h.code] = { id: f, recv, tz: h.tz };
        // Contract with a deliberate missing price (SCREW) for correction tests.
        const k = (await ins(`insert into contracts(tenant_id,facility_id,name) values ($1,$2,$3) returning id`, [T, f, `${h.code} agreement`])).id;
        ids.hosp[h.code].cv = (await ins(`insert into contract_versions(tenant_id,contract_id,version,effective_from,approved_by) values ($1,$2,1,'2026-01-01','synthetic') returning id`, [T, k])).id;
        for (const [d, c, r, m] of [['implanted', 'charge', 'replace', 'bill_and_replace'], ['opened_unused', 'review', 'review', 'bill_and_replace'], ['wasted', 'charge', 'none', 'bill_only'], ['damaged', 'review', 'review', 'bill_only'], ['returned_sealed', 'no_charge', 'none', 'bill_only'], ['missing', 'review', 'review', 'bill_only']])
          await db.query(`insert into contract_rules(tenant_id,contract_version_id,disposition,charge_action,replenish_action,billing_mode,rule_text) values ($1,$2,$3,$4,$5,$6,$7)`, [T, ids.hosp[h.code].cv, d, c, r, m, `${d}: ${c} (synthetic rule)`]);
      }
      await db.query(`insert into integration_feeds(tenant_id,code,name,simulated,stale_after_minutes,last_success_at) values ($1,'erp-mock','Mock ERP (SIMULATED)',true,1440,null)`, [T]);
    });
    const inv: Ctx = { tenantId: T, userId: ids['inventory_coordinator:inv'], role: 'inventory_coordinator', facilityId: null, territoryId: null, displayName: 'inv' };
    const cat = ITEMS.map(([ref, desc, type, tr], i) => [`ALT-${spec.slug}-${i}`, `Alder Implant Works ${ti + 1} (synthetic)`, ref, `${desc} (synthetic)`, type, tr, gtinWithCheckDigit(spec.gtinBase + String(100 + i).padStart(6, '0')), '', 'Alder', 'EA']);
    const csv = (h: string[], r: any[][]) => [h.join(','), ...r.map((x) => x.map(csvCell).join(','))].join('\n') + '\n';
    const cr = await withTenant(T, (db) => runImport(db, inv, { kind: 'catalog', filename: 'alt-catalog.csv', sourceSystem: 'ALT-SRC', mode: 'commit', csv: csv(['source_id', 'manufacturer', 'ref', 'description', 'item_type', 'tracking', 'unit_gtin', 'size', 'product_line', 'uom'], cat) }));
    if (cr.counts.error) throw new Error('alt catalog errors ' + JSON.stringify(cr.rows.filter((x: any) => x.errors.length)));
    await withTenant(T, (db) => runImport(db, inv, { kind: 'packages', filename: 'alt-pkg.csv', sourceSystem: 'ALT-SRC', mode: 'commit', csv: csv(['source_id', 'item_ref', 'package_gtin', 'level', 'units_per_package', 'uom'], [['PK-ALT', 'SCREW-35-30', gtinWithCheckDigit('1' + spec.gtinBase.slice(1) + '000102'), 'inner', '10', 'BX']]) }));
    const exp = (n: number) => addDaysYmd(D, n);
    const ob = [
      ['A1', spec.name, 'DC-A', 'KN-STEM-12', 'LS1', 'ST-001', exp(300), 'each', '1', 'EA'],
      ['A2', spec.name, 'DC-FAR', 'KN-STEM-12', 'LS1', 'ST-002', exp(300), 'each', '1', 'EA'],
      ['A3', spec.name, 'TRK-1', 'KN-STEM-12', 'LS0', 'ST-003', exp(-3), 'each', '1', 'EA'], // expired lot
      ['A4', spec.name, 'TRK-2', 'KN-STEM-12', 'LS1', 'ST-004', exp(300), 'each', '1', 'EA'],
      ['A5', spec.name, 'DC-A', 'KN-INSERT-9', 'LI1', 'IN-001', exp(300), 'each', '1', 'EA'],
      ['A6', spec.name, 'DC-A', 'KN-INSERT-9', 'LI1', 'IN-002', exp(300), 'each', '1', 'EA'],
      ['A7', spec.name, 'DC-A', 'SCREW-35-30', 'SC7', '', exp(500), 'inner', '3', 'BX'], // 30 units
      ['A8', spec.name, 'TRK-1', 'SCREW-35-30', 'SC7', '', exp(500), 'each', '4', 'EA'],
      ['A9', spec.name, 'DC-A', 'TRAY-KN-A', 'TL', 'TK-1', '', 'each', '1', 'EA'],
      ['A10', spec.name, 'DC-A', 'INST-GUIDE', 'IL', 'GD-9', '', 'each', '1', 'EA'],
    ];
    const r = await withTenant(T, (db) => runImport(db, inv, { kind: 'opening_balances', filename: 'alt-ob.csv', sourceSystem: 'ALT-SRC', mode: 'commit', csv: csv(['source_id', 'owner', 'location_code', 'item_ref', 'lot', 'serial', 'expiry', 'package_level', 'quantity', 'uom'], ob) }));
    if (r.counts.error) throw new Error('alt seed import errors ' + JSON.stringify(r.rows.filter((x: any) => x.status === 'error')));
    ids.obCsv = csv(['source_id', 'owner', 'location_code', 'item_ref', 'lot', 'serial', 'expiry', 'package_level', 'quantity', 'uom'], ob);
    await withTenant(T, async (db) => {
      const item = async (ref: string) => (await one(db, `select id from catalog_items where ref=$1`, [ref])).id;
      const prices: [string, number][] = [['KN-STEM-12', 280000 + ti * 1000], ['KN-INSERT-9', 99000 + ti * 1000]]; // SCREW intentionally unpriced
      for (const h of Object.values(ids.hosp) as any[]) for (const [ref, c] of prices) await db.query(`insert into contract_prices(tenant_id,contract_version_id,catalog_item_id,unit_price_cents,price_date) values ($1,$2,$3,$4,'2026-01-01')`, [T, h.cv, await item(ref), c]);
      const mv = (await one(db, `insert into tray_manifest_versions(tenant_id,tray_catalog_item_id,version,status,approved_by,approved_at) values ($1,$2,1,'approved',$3,$4) returning id`, [T, await item('TRAY-KN-A'), ids['ops_manager:ops'], nowIso()])).id;
      for (const ref of ['INST-GUIDE', 'INST-REAMER']) await db.query(`insert into tray_manifest_lines(tenant_id,manifest_version_id,catalog_item_id,qty,required) values ($1,$2,$3,1,true)`, [T, mv, await item(ref)]);
      await db.query(`insert into tray_instances(stock_item_id,tenant_id,manifest_version_id) select id,$1,$2 from stock_items where serial_number='TK-1'`, [T, mv]);
      const card = (await one(db, `insert into preference_cards(tenant_id,code,surgeon_ref,procedure) values ($1,'ALT-CARD','Surgeon Z-1 (synthetic)','Knee revision (synthetic)') returning id`, [T])).id;
      ids.cardV = (await one(db, `insert into preference_card_versions(tenant_id,card_id,version,status,approved_by,approved_at) values ($1,$2,1,'approved',$3,$4) returning id`, [T, card, ids['ops_manager:ops'], nowIso()])).id;
      for (const [ref, qty] of [['KN-STEM-12', 1], ['KN-INSERT-9', 1], ['SCREW-35-30', 2], ['TRAY-KN-A', 1]] as const)
        await db.query(`insert into preference_card_lines(tenant_id,card_version_id,catalog_item_id,qty,mandatory) values ($1,$2,$3,$4,true)`, [T, ids.cardV, await item(ref), qty]);
    });
    // Cases relative to the alternate reference date (anchor 15:00 local at the first hospital).
    const first = spec.hospitals[0];
    await setClock(zoned(D, '15:00', first.tz));
    const sched: Ctx = { tenantId: T, userId: ids['scheduler:sched'], role: 'scheduler', facilityId: null, territoryId: null, displayName: 'sched' };
    const ops: Ctx = { tenantId: T, userId: ids['ops_manager:ops'], role: 'ops_manager', facilityId: null, territoryId: null, displayName: 'ops' };
    const mk = (code: string, day: number, hhmm: string, rep: string) => withTenant(T, (db) => createCase(db, sched, { facilityId: ids.hosp[code].id, cardVersionId: ids.cardV, scheduledStart: zoned(addDaysYmd(D, day), hhmm, ids.hosp[code].tz).toISOString(), repUserId: ids[`rep:${rep}`] }));
    ids.cases = {
      morning: await mk(first.code, 1, '07:00', 'rep1'), // tomorrow morning: tight
      later: await mk(first.code, 3, '12:00', 'rep2'),
      canceled: await mk(spec.hospitals[spec.hospitals.length - 1].code, 2, '09:00', 'rep1'),
    };
    await withTenant(T, async (db) => {
      const sid = async (sn: string) => (await one(db, `select id from stock_items where serial_number=$1`, [sn])).id;
      const rq = async (c: any, ref: string) => (await one(db, `select cr.id from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and ci.ref=$2`, [c.id, ref])).id;
      await reserve(db, ops, { caseId: ids.cases.later.id, requirementId: await rq(ids.cases.later, 'KN-STEM-12'), stockItemId: await sid('ST-001'), locationId: ids.L_DC, ownerPartyId: ids.dist, qty: 1 });
      await reserve(db, ops, { caseId: ids.cases.canceled.id, requirementId: await rq(ids.cases.canceled, 'KN-INSERT-9'), stockItemId: await sid('IN-002'), locationId: ids.L_DC, ownerPartyId: ids.dist, qty: 1 });
      await reserve(db, ops, { caseId: ids.cases.morning.id, requirementId: await rq(ids.cases.morning, 'KN-INSERT-9'), stockItemId: await sid('IN-001'), locationId: ids.L_DC, ownerPartyId: ids.dist, qty: 1 });
      await cancelCase(db, sched, ids.cases.canceled.id, { reason: 'Rescheduled by hospital (synthetic)' });
    });
    out.tenants[spec.slug] = ids;
    log(`seeded ${spec.name}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedAlt().then((r) => { console.log(`[seed-alt] done, reference date ${r.date}; password ${ALT_PASSWORD} (development only)`); return pool.end(); }).catch((e) => { console.error(e); process.exit(1); });
}
