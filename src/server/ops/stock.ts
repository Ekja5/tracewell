/**
 * Par levels and expiring stock. Both are plain arithmetic on what is recorded: on-hand, reservations,
 * the cases inside the planning window and recorded usage. Nothing here is a forecast.
 */
import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit } from '../audit.js';
import { fmtLocal } from '../domain/cases.js';
import { addDaysYmd, localYmd } from '../time.js';
import { getSettings } from './settings.js';
import { guessHeaderRow, norm, normHeader, parseFile } from '../pilot/workbook.js';

export async function parView(db: Db, ctx: Ctx & { tenantTz?: string }) {
  requirePerm(ctx, 'inventory.view');
  const s = await getSettings(db); const t = now();
  const list = await rows(db, `select p.id, p.par_qty, p.set_at, u.display_name set_by, l.id location_id, l.name location, l.kind, l.holder_user_id, l.facility_id, ci.id catalog_item_id, ci.ref, ci.description,
      coalesce((select sum(b.qty) from stock_balances b join stock_items st on st.id=b.stock_item_id where b.location_id=l.id and st.catalog_item_id=ci.id and b.condition='sealed' and b.qty>0
         and not exists (select 1 from quality_holds h where h.stock_item_id=b.stock_item_id and h.status='active') and (st.expiry_date is null or st.expiry_date >= $1::date)),0)::int usable,
      coalesce((select sum(r.qty) from reservations r join stock_items st on st.id=r.stock_item_id where r.location_id=l.id and st.catalog_item_id=ci.id and r.status='active'),0)::int reserved,
      coalesce((select sum(m.qty) from inventory_movements m join stock_items st on st.id=m.stock_item_id where st.catalog_item_id=ci.id and m.movement_type='consume' and m.occurred_at >= $2),0)::int used90
    from par_levels p join locations l on l.id=p.location_id join catalog_items ci on ci.id=p.catalog_item_id join users u on u.id=p.set_by order by l.name, ci.ref`,
    [localYmd(t, ctx.tenantTz ?? 'UTC'), new Date(t.getTime() - 90 * 86400e3).toISOString()]);
  const out: any[] = [];
  for (const p of list) {
    // Cases in the planning window that will draw on this location: the holder's own cases for a trunk, the facility's for a hospital location, all cases for a warehouse.
    const d = await one(db, `select coalesce(sum(greatest(cr.qty - coalesce((select sum(r.qty) from reservations r where r.requirement_id=cr.id and r.status='active'),0),0)),0)::int n
       from case_requirements cr join cases c on c.id=cr.case_id where cr.catalog_item_id=$1 and cr.active and c.status='scheduled' and c.scheduled_start between $2 and $3
         and (($4::uuid is not null and c.rep_user_id=$4) or ($4::uuid is null and $5='warehouse') or ($4::uuid is null and $5<>'warehouse' and c.facility_id=$6))`,
      [p.catalog_item_id, t.toISOString(), new Date(t.getTime() + s.planningWindowHours * 3600e3).toISOString(), p.holder_user_id, p.kind, p.facility_id]);
    const free = p.usable - p.reserved; const delta = p.usable - p.par_qty;
    const status = delta < 0 ? 'below' : delta > 0 ? 'over' : 'at';
    const afterDemand = free - d.n;
    const suggestion = status === 'below' ? `Replenish ${-delta} to reach par${afterDemand < 0 ? `; ${-afterDemand} more is needed for unreserved case demand in the next ${s.planningWindowHours} h` : ''}.`
      : status === 'over' ? (afterDemand - p.par_qty > 0 ? `${delta} over par and not needed by any case in the window: candidate to move where it is short.` : `${delta} over par, but upcoming cases will use it.`)
      : afterDemand < 0 ? `At par, but unreserved case demand in the window exceeds what is free by ${-afterDemand}.` : 'At par.';
    out.push({ id: p.id, locationId: p.location_id, location: p.location, catalogItemId: p.catalog_item_id, ref: p.ref, description: p.description, par: p.par_qty, usable: p.usable, reserved: p.reserved, free, windowDemand: d.n, delta, status, used90: p.used90, suggestion,
      setBy: p.set_by, setAtLocal: fmtLocal(p.set_at, ctx.tenantTz ?? 'UTC') });
  }
  const locations = await rows(db, `select id, name from locations where kind in ('warehouse','trunk','consignment','hospital_receiving') order by name`);
  const items = await rows(db, `select id, ref, description from catalog_items where item_type <> 'instrument' order by ref`);
  return { windowHours: s.planningWindowHours, rows: out, locations, items,
    note: 'Usable = sealed, not on hold, not expired. "Used, 90 days" counts recorded case usage. Suggestions are arithmetic on these numbers, not a demand forecast.' };
}

export async function setPar(db: Db, ctx: Ctx, input: { locationId: string; catalogItemId: string; par: number | null }) {
  requirePerm(ctx, 'par.manage');
  if (!(await maybe(db, `select 1 from locations where id=$1`, [input.locationId])) || !(await maybe(db, `select 1 from catalog_items where id=$1`, [input.catalogItemId]))) throw new AppError(400, 'bad_target', 'Choose a location and an item');
  if (input.par === null || input.par === undefined || (input.par as any) === '') {
    await db.query(`delete from par_levels where location_id=$1 and catalog_item_id=$2`, [input.locationId, input.catalogItemId]);
    await audit(db, ctx, 'par.remove', 'par_level', null, input); return { removed: true };
  }
  const n = Number(input.par);
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw new AppError(400, 'bad_par', 'Par must be a whole number, 0 or more');
  await db.query(`insert into par_levels(tenant_id, location_id, catalog_item_id, par_qty, set_by, set_at) values ($1,$2,$3,$4,$5,$6)
     on conflict (tenant_id, location_id, catalog_item_id) do update set par_qty=excluded.par_qty, set_by=excluded.set_by, set_at=excluded.set_at`, [ctx.tenantId, input.locationId, input.catalogItemId, n, ctx.userId, nowIso()]);
  await audit(db, ctx, 'par.set', 'par_level', null, { ...input, par: n });
  return { par: n };
}

/** Sealed stock that expires inside the warning window, with the earliest upcoming case that could use it first. */
export async function expiringStock(db: Db, ctx: Ctx & { tenantTz?: string }) {
  requirePerm(ctx, 'inventory.view');
  const s = await getSettings(db); const t = now(); const today = localYmd(t, ctx.tenantTz ?? 'UTC');
  const list = await rows(db, `select b.qty, st.id stock_item_id, st.lot_number, st.serial_number, st.expiry_date, ci.id catalog_item_id, ci.ref, ci.description, l.id location_id, l.name location, l.kind, hu.display_name holder,
      coalesce((select sum(r.qty) from reservations r where r.stock_item_id=st.id and r.location_id=l.id and r.status='active'),0)::int reserved
    from stock_balances b join stock_items st on st.id=b.stock_item_id join catalog_items ci on ci.id=st.catalog_item_id join locations l on l.id=b.location_id left join users hu on hu.id=l.holder_user_id
    where b.qty>0 and b.condition='sealed' and st.expiry_date is not null and st.expiry_date <= $1::date and l.kind in ('warehouse','trunk','consignment','hospital_receiving') order by st.expiry_date, ci.ref`, [addDaysYmd(today, s.expiryWarningDays)]);
  const out: any[] = [];
  for (const r of list) {
    const exp = typeof r.expiry_date === 'string' ? r.expiry_date : localYmd(r.expiry_date, 'UTC');
    const daysLeft = Math.round((new Date(exp + 'T12:00:00Z').getTime() - new Date(today + 'T12:00:00Z').getTime()) / 86400e3);
    const use = daysLeft < 0 ? null : await maybe(db, `select c.id, c.case_ref, c.scheduled_start, f.name facility, f.timezone, cr.qty - coalesce((select sum(x.qty) from reservations x where x.requirement_id=cr.id and x.status='active'),0)::int open_need
       from case_requirements cr join cases c on c.id=cr.case_id join facilities f on f.id=c.facility_id
       where cr.catalog_item_id=$1 and cr.active and c.status='scheduled' and c.scheduled_start > $2 and (c.scheduled_start at time zone f.timezone)::date <= $3::date
         and cr.qty > coalesce((select sum(x.qty) from reservations x where x.requirement_id=cr.id and x.status='active'),0) order by c.scheduled_start limit 1`, [r.catalog_item_id, t.toISOString(), exp]);
    const free = r.qty - r.reserved;
    out.push({ stockItemId: r.stock_item_id, ref: r.ref, description: r.description, unit: r.serial_number ? `SN ${r.serial_number}` : `lot ${r.lot_number}`, location: r.location, holder: r.holder, qty: r.qty, reserved: r.reserved, expiry: exp, daysLeft,
      useOn: use && free > 0 ? { caseId: use.id, caseRef: use.case_ref, whenLocal: fmtLocal(use.scheduled_start, use.timezone), facility: use.facility } : null,
      suggestion: daysLeft < 0 ? 'Expired: remove from usable stock and record the disposition.' : r.reserved >= r.qty ? 'Already reserved for a case before it expires.' : use ? `Use on ${use.case_ref} (${fmtLocal(use.scheduled_start, use.timezone)}, ${use.facility}), which still needs this item.` : 'No scheduled case needs it before it expires: move it to where it is used most, or arrange the return.' });
  }
  return { warningDays: s.expiryWarningDays, rows: out };
}

/** Par levels from a spreadsheet (location, catalog number, par). Rows that do not match exactly are reported, never guessed. */
export async function importPars(db: Db, ctx: Ctx, input: { filename: string; contentBase64: string }) {
  requirePerm(ctx, 'par.manage');
  const buf = Buffer.from(String(input.contentBase64 ?? ''), 'base64');
  if (!buf.length) throw new AppError(400, 'empty_file', 'Choose a file');
  if (buf.length > 5 * 1024 * 1024) throw new AppError(400, 'too_large', 'The file is larger than 5 MB');
  const parsed = await parseFile(String(input.filename ?? 'pars.xlsx'), buf);
  const sheet = parsed.sheets.find((x) => x.rows.length > 1) ?? parsed.sheets[0];
  if (!sheet) throw new AppError(400, 'no_rows', 'No rows were found in the file');
  const hr = guessHeaderRow(sheet); const head = (sheet.rows[hr - 1] ?? []).map((h) => normHeader(String(h ?? '')));
  const col = (names: string[]) => head.findIndex((h) => names.includes(h));
  const cLoc = col(['location', 'location name', 'stock location', 'warehouse', 'site', 'territory', 'inventory location']), cRef = col(['catalog number', 'catalog no', 'cat no', 'item number', 'item no', 'part number', 'product code', 'item code', 'ref', 'sku', 'item']), cPar = col(['par', 'par level', 'par qty', 'par quantity', 'min', 'minimum', 'target', 'target qty']);
  if (cLoc < 0 || cRef < 0 || cPar < 0) throw new AppError(400, 'columns_missing', `The file needs three columns: Location, Catalog number and Par. Found: ${(sheet.rows[hr - 1] ?? []).join(', ') || 'no header row'}.`);
  const locs = await rows(db, `select id, name, code from locations`); const items = await rows(db, `select id, ref from catalog_items`);
  const out: any[] = []; let set = 0;
  for (let i = hr; i < sheet.rows.length; i++) {
    const r = sheet.rows[i]; const loc = String(r[cLoc] ?? '').trim(), ref = String(r[cRef] ?? '').trim(), par = String(r[cPar] ?? '').trim();
    if (!loc && !ref && !par) continue;
    const L = locs.filter((l) => norm(l.name) === norm(loc) || l.code.toLowerCase() === loc.toLowerCase()); const I = items.filter((x) => x.ref === ref);
    const n = Number(par);
    const why = L.length !== 1 ? `location "${loc}" ${L.length ? 'matches more than one location' : 'is not a location here'}` : I.length !== 1 ? `catalog number "${ref}" ${I.length ? 'is shared by more than one manufacturer' : 'is not in the catalog (load inventory first)'}` : !Number.isInteger(n) || n < 0 ? `"${par}" is not a whole number` : null;
    if (why) { out.push({ row: i + 1, outcome: 'held', message: why }); continue; }
    await setPar(db, ctx, { locationId: L[0].id, catalogItemId: I[0].id, par: n }); set++;
    out.push({ row: i + 1, outcome: 'accepted', message: `${ref} at ${L[0].name}: par ${n}` });
  }
  return { worksheet: sheet.name, set, held: out.filter((o) => o.outcome === 'held').length, rows: out };
}

/** Where the move from a previous system stands. Counts only; nothing is inferred. */
export async function moveInStatus(db: Db, ctx: Ctx) {
  requirePerm(ctx, 'upload.view');
  const c = await one(db, `select (select count(*)::int from facilities where kind='hospital') hospitals, (select count(*)::int from users where active and facility_id is null) people, (select count(*)::int from locations where kind in ('warehouse','trunk','consignment')) stock_locations,
      (select count(*)::int from catalog_items) items, (select coalesce(sum(qty),0)::int from stock_balances b join locations l on l.id=b.location_id where l.kind in ('warehouse','trunk','consignment','hospital_receiving')) units,
      (select count(*)::int from cases where status='scheduled') cases, (select count(*)::int from external_refs where entity_type='case') cases_with_previous_id, (select count(*)::int from case_requirements where active) requirements,
      (select count(*)::int from par_levels) pars, (select count(*)::int from stock_discrepancies where status='open') open_differences, (select count(*)::int from upload_rows where outcome='held') held_rows,
      (select count(*)::int from column_mappings) saved_mappings, (select max(created_at) from upload_runs where kind='inventory') last_inventory, (select count(*)::int from upload_runs where kind='inventory') inventory_uploads`);
  const systems = await rows(db, `select coalesce(source_system,'Not stated') system, kind, count(*)::int runs, max(created_at) last from upload_runs group by 1,2 order by 1,2`);
  return { counts: c, systems: systems.map((x) => ({ ...x, lastLocal: fmtLocal(x.last, (ctx as any).tenantTz ?? 'UTC') })), lastInventoryLocal: c.last_inventory ? fmtLocal(c.last_inventory, (ctx as any).tenantTz ?? 'UTC') : null };
}
