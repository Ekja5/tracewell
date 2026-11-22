/**
 * Creates the pilot account: an EMPTY distributor tenant with its people, two hospitals, a warehouse
 * and each hospital's receiving rules. No items, stock, cases or reservations: those come from the
 * coordinator's files. This is the one step done by whoever administers the system.
 *
 * stageDemo() performs the "day before" work of the demo (load day-1 workbook, reserve, ship,
 * deliver, receive) by calling the same services the screens call, for presenters who want to start
 * the meeting at the Tomorrow board. tests/e2e/pilot.spec.ts does the same steps through the UI.
 */
import { q, withTenant, Db, one, rows } from '../db.js';
import { hashPassword } from '../auth.js';
import { now, setClock } from '../clock.js';
import { zoned, localYmd } from '../time.js';
import type { Ctx } from '../perms.js';
import { planCaseDelivery, shipmentDetail, pickLine, packShipment, dispatchShipment, courierEvent, receiveShipment } from '../domain/shipments.js';
import { storeFile, suggest, runUpload, verifyConversion, recheckRun } from './uploads.js';
import { reserveAvailable } from './tomorrow.js';
import { day1Workbook } from './samples.js';

export const PILOT = {
  slug: 'summit', name: 'Summit Ortho Supply (synthetic)', tz: 'America/Chicago', password: 'Pilot-Demo-2026!',
  users: { coordinator: 'casey.coordinator@summit.example', ops: 'avery.ops@summit.example', warehouse: 'warehouse@summit.example', courier: 'courier@summit.example', rep: 'dana.rep@summit.example',
    recvMedical: 'receiving@ridgeline-medical.example', recvEast: 'receiving@ridgeline-east.example' },
};

export async function provisionPilot(opts: { clockTime?: string | null } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to create demo accounts with the shared development password in production. Use REVIEW_MODE (random persona passwords) instead.');
  const pw = await hashPassword(PILOT.password);
  const [t] = await q(`insert into tenants(slug, name, timezone) values ($1,$2,$3) returning id`, [PILOT.slug, PILOT.name, PILOT.tz]);
  const T = t.id as string;
  await withTenant(T, async (db) => {
    const ins = async (sql: string, p: any[]) => (await db.query(sql, p)).rows[0];
    const dist = await ins(`insert into parties(tenant_id,name,kind) values ($1,$2,'distributor') returning id`, [T, PILOT.name]);
    const terr = await ins(`insert into territories(tenant_id,name) values ($1,'Ridgeline territory') returning id`, [T]);
    const fac = async (code: string, name: string, kind: string, tz: string) => ins(`insert into facilities(tenant_id,code,name,kind,timezone,territory_id,party_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [T, code, name, kind, tz, terr.id, kind === 'warehouse' ? dist.id : null]);
    const wh = await fac('WH', 'Summit Main Warehouse', 'warehouse', PILOT.tz);
    const rmc = await fac('RMC', 'Ridgeline Medical Center', 'hospital', 'America/Chicago');
    const rse = await fac('RSE', 'Ridgeline Surgery Center East', 'hospital', 'America/Indiana/Indianapolis');
    // Receiving rules agreed with each hospital. Medical Center: dock open 7 AM-3 PM, implants 2 h before start.
    // Surgery Center East: implants must be checked in the afternoon before (20 h ahead), dock open 6 AM-5 PM.
    const pol = (f: string, implantH: number, open: string, close: string, notes: string) => db.query(`insert into facility_policies(tenant_id,facility_id,version,tray_due_hours_before,implant_due_hours_before,requires_release_decision,required_evidence,receiving_notes,effective_from,approved_by,receiving_open,receiving_close)
       values ($1,$2,1,24,$3,true,'{hospital_processing_record_ref}',$4,'2026-01-01','Pilot setup (synthetic)',$5,$6)`, [T, f, implantH, notes, open, close]);
    await pol(rmc.id, 2, '07:00', '15:00', 'Receiving staff check in every delivery.');
    await pol(rse.id, 20, '06:00', '17:00', 'Implants are checked in by receiving the afternoon before surgery.');
    const user = (email: string, name: string, role: string, f: string | null = null, tr: string | null = null) => ins(`insert into users(tenant_id,email,display_name,password_hash,role,facility_id,territory_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [T, email, name, pw, role, f, tr]);
    await user(PILOT.users.coordinator, 'Casey Lindqvist', 'inventory_coordinator');
    await user(PILOT.users.ops, 'Avery Brooks', 'ops_manager');
    await user(PILOT.users.warehouse, 'Sam Ortega', 'warehouse');
    await user(PILOT.users.courier, 'Lee Tran', 'courier');
    await user(PILOT.users.rep, 'Dana Whitfield', 'rep', null, terr.id);
    await user(PILOT.users.recvMedical, 'Priya Nair', 'hospital_receiving', rmc.id);
    await user(PILOT.users.recvEast, 'Marcus Hall', 'hospital_receiving', rse.id);
    const loc = async (code: string, name: string, kind: string, f: string | null, alloc: boolean) => ins(`insert into locations(tenant_id,code,name,kind,facility_id,allocatable) values ($1,$2,$3,$4,$5,$6) returning id`, [T, code, name, kind, f, alloc]);
    const lwh = await loc('WH-MAIN', 'Summit Main Warehouse', 'warehouse', wh.id, true);
    await loc('RMC-RECV', 'Ridgeline Medical Center receiving', 'hospital_receiving', rmc.id, true);
    await loc('RSE-RECV', 'Ridgeline Surgery Center East receiving', 'hospital_receiving', rse.id, true);
    await loc('RMC-CONS', 'Ridgeline Medical Center consignment', 'consignment', rmc.id, true);
    await loc('RSE-CONS', 'Ridgeline Surgery Center East consignment', 'consignment', rse.id, true);
    for (const [code, name, kind] of [['TRANSIT', 'In transit', 'in_transit'], ['CONSUMED', 'Consumed', 'consumed'], ['WASTED', 'Wasted', 'wasted'], ['MISSING', 'Missing', 'missing'], ['QUAR', 'Quarantine', 'quarantine'], ['RETURNS', 'Returns', 'returns']]) await loc(code, name, kind, null, false);
    const te = (to: string, min: number, cents: number) => db.query(`insert into travel_estimates(tenant_id,from_location_id,to_facility_id,minutes,courier_cost_cents,basis) values ($1,$2,$3,$4,$5,'Pilot setup estimate (synthetic); not live traffic or a courier quote')`, [T, lwh.id, to, min, cents]);
    await te(rmc.id, 45, 4000); await te(rse.id, 150, 11000);
  });
  if (opts.clockTime) await setClock(zoned(localYmd(new Date(), PILOT.tz), opts.clockTime, PILOT.tz));
  return { tenantId: T };
}

export async function pilotCtx(email: string): Promise<Ctx> {
  const [u] = await q(`select * from users where email=$1`, [email]);
  if (!u) throw new Error(`No user ${email}`);
  return { userId: u.id, tenantId: u.tenant_id, role: u.role, facilityId: u.facility_id, territoryId: u.territory_id, displayName: u.display_name };
}

/** The "day before" work, through the same services as the screens. */
export async function stageDemo(tenantId: string) {
  const U = PILOT.users;
  const coord = { ...(await pilotCtx(U.coordinator)), tenantTz: PILOT.tz }; const whu = await pilotCtx(U.warehouse); const courier = await pilotCtx(U.courier); const recv = await pilotCtx(U.recvMedical);
  const tx = <R>(fn: (db: Db) => Promise<R>) => withTenant(tenantId, fn);
  const buf = await day1Workbook();
  const exportedAt = new Date(now().getTime() - 60 * 60e3).toISOString();
  const file = await tx((db) => storeFile(db, coord, { filename: 'summit-day1.xlsx', contentBase64: buf.toString('base64') }));
  const runs: Record<string, string> = {};
  for (const [sheet, kind] of [['Inventory', 'inventory'], ['Schedule', 'schedule'], ['Requirements', 'requirements']] as const) {
    const s = await tx((db) => suggest(db, coord, { fileId: file.fileId, worksheet: sheet, kind }));
    const r = await tx((db) => runUpload(db, coord, { fileId: file.fileId, worksheet: sheet, kind, mapping: s.mapping, exportedAt, coverage: 'complete' }, 'commit'));
    runs[kind] = r.run.id;
  }
  // Verify the box conversion the file proposed (1 BX of 08810 = 5 units), then re-check that row.
  await tx(async (db) => { for (const c of await rows(db, `select id, units_per from uom_conversions where verified_at is null and units_per is not null`)) await verifyConversion(db, coord, c.id, { unitsPer: c.units_per }); });
  await tx((db) => recheckRun(db, coord, runs.inventory));
  const caseId = async (ref: string) => (await tx((db) => one(db, `select id from cases where case_ref=$1`, [ref]))).id as string;
  const reqOf = async (cid: string) => (await tx((db) => one(db, `select id from case_requirements where case_id=$1 and active limit 1`, [cid]))).id as string;
  // Later-week cases hold four of the five tibial inserts; tomorrow's cases B and C get theirs delivered.
  for (const ref of ['SC-24040', 'SC-24041', 'SC-24032', 'SC-24033']) { const cid = await caseId(ref); const rq = await reqOf(cid); await tx((db) => reserveAvailable(db, coord, cid, rq)); }
  for (const ref of ['SC-24032', 'SC-24033']) {
    const cid = await caseId(ref);
    const { created } = await tx((db) => planCaseDelivery(db, coord, cid));
    for (const s of created) {
      await tx(async (db) => { const d = await shipmentDetail(db, whu, s.id); for (const l of d.lines) await pickLine(db, whu, s.id, { lineId: l.id, qty: l.qty_expected, lot: l.lot_number ?? undefined, serial: l.serial_number ?? undefined }); await packShipment(db, whu, s.id); await dispatchShipment(db, whu, s.id, {}); });
      await tx((db) => courierEvent(db, courier, s.id, { type: 'delivered' }));
      if (ref === 'SC-24033') await tx(async (db) => { const d = await shipmentDetail(db, recv, s.id); await receiveShipment(db, recv, s.id, { lines: d.lines.map((l: any) => ({ lineId: l.id, qtyReceived: l.qty_expected, sealIntact: true })) }); });
    }
  }
  return { runs };
}
