import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { AppError, Db, maybe, rows } from '../db.js';
import type { Ctx } from '../perms.js';
import { nowIso } from '../clock.js';
import { applyMovement } from './inventory.js';
import { audit } from '../audit.js';
import { gtinCheckDigitValid } from '../../shared/gs1.js';

export type ImportKind = 'catalog' | 'packages' | 'opening_balances';

export const TEMPLATES: Record<ImportKind, { fields: { name: string; required: boolean; help: string; synonyms: string[] }[]; example: string[][] }> = {
  catalog: {
    fields: [
      { name: 'source_id', required: true, help: 'Stable ID of the row in the source system (preserved for provenance)', synonyms: ['id', 'source id', 'item id', 'material'] },
      { name: 'manufacturer', required: true, help: 'Manufacturer name (must exist as a party)', synonyms: ['mfr', 'vendor', 'manufacturer name'] },
      { name: 'ref', required: true, help: 'Catalog / reference number', synonyms: ['catalog number', 'catalog #', 'ref #', 'part number', 'reference'] },
      { name: 'description', required: true, help: 'Description', synonyms: ['desc', 'item description', 'name'] },
      { name: 'item_type', required: true, help: 'implant | instrument | tray | disposable', synonyms: ['type', 'category'] },
      { name: 'tracking', required: true, help: 'serial | lot', synonyms: ['control', 'tracking type'] },
      { name: 'unit_gtin', required: false, help: '14-digit GTIN of the individual unit (device identifier)', synonyms: ['gtin', 'di', 'udi-di', 'primary di'] },
      { name: 'size', required: false, help: 'Size', synonyms: [] },
      { name: 'product_line', required: false, help: 'Product line', synonyms: ['family', 'system'] },
      { name: 'uom', required: false, help: 'Unit of measure of one unit (default EA)', synonyms: ['unit', 'unit of measure'] },
    ],
    example: [['source_id', 'manufacturer', 'ref', 'description', 'item_type', 'tracking', 'unit_gtin', 'size', 'product_line', 'uom'],
      ['ERP-MAT-90001', 'Northpoint Ortho Devices (synthetic)', 'NP-SCR-650', 'Cortical screw 6.5 x 40 mm (synthetic)', 'implant', 'lot', '00614141000951', '6.5x40', 'Meridian Knee (synthetic)', 'EA']],
  },
  packages: {
    fields: [
      { name: 'source_id', required: true, help: 'Stable source row ID', synonyms: ['id'] },
      { name: 'item_ref', required: true, help: 'Catalog reference number of the unit', synonyms: ['ref', 'catalog number'] },
      { name: 'package_gtin', required: true, help: '14-digit GTIN printed on the package', synonyms: ['gtin', 'package di'] },
      { name: 'level', required: true, help: 'each | inner | case', synonyms: ['package level', 'pkg level'] },
      { name: 'units_per_package', required: true, help: 'Number of individual units in one package', synonyms: ['qty per package', 'units', 'quantity per package'] },
      { name: 'uom', required: true, help: 'Package unit of measure, e.g. BX', synonyms: ['unit of measure'] },
    ],
    example: [['source_id', 'item_ref', 'package_gtin', 'level', 'units_per_package', 'uom'], ['PKG-1', 'NP-SCR-650', '10614141000958', 'inner', '5', 'BX']],
  },
  opening_balances: {
    fields: [
      { name: 'source_id', required: true, help: 'Stable source row ID', synonyms: ['id', 'line id'] },
      { name: 'owner', required: true, help: 'Owning party name (distributor, manufacturer consignment, hospital)', synonyms: ['owner name', 'owned by'] },
      { name: 'location_code', required: true, help: 'Location code (warehouse bin, trunk, consignment)', synonyms: ['location', 'loc', 'bin'] },
      { name: 'item_ref', required: true, help: 'Catalog reference number', synonyms: ['ref', 'catalog number'] },
      { name: 'lot', required: false, help: 'Lot / batch (required for lot-tracked items)', synonyms: ['batch', 'lot number'] },
      { name: 'serial', required: false, help: 'Serial (required for serial-tracked items; quantity must be 1)', synonyms: ['serial number', 'sn'] },
      { name: 'expiry', required: false, help: 'Expiry date YYYY-MM-DD', synonyms: ['expiration', 'exp', 'use by'] },
      { name: 'package_level', required: true, help: 'each | inner | case: level the quantity is counted in', synonyms: ['level', 'pkg level'] },
      { name: 'quantity', required: true, help: 'Quantity at that package level', synonyms: ['qty', 'count'] },
      { name: 'uom', required: true, help: 'Unit of measure as counted (must match the package configuration)', synonyms: ['unit'] },
    ],
    example: [['source_id', 'owner', 'location_code', 'item_ref', 'lot', 'serial', 'expiry', 'package_level', 'quantity', 'uom'],
      ['OB-0001', 'Lakeshore Orthopedic Partners (synthetic)', 'WH-MAIN', 'NP-SCR-650', 'L24A17', '', '2028-06-30', 'inner', '2', 'BX']],
  },
};

export function templateCsv(kind: ImportKind) {
  return TEMPLATES[kind].example.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
export function csvCell(v: any) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

export function suggestMapping(kind: ImportKind, headers: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of TEMPLATES[kind].fields) {
    const cands = [f.name, f.name.replace(/_/g, ' '), ...f.synonyms].map(norm);
    out[f.name] = headers.find((h) => cands.includes(norm(h))) ?? null;
  }
  return out;
}

interface RowResult { row_number: number; source_id: string | null; status: string; errors: string[]; values: Record<string, string>; row_hash: string; detail?: string; units?: number }

export async function runImport(db: Db, ctx: Ctx, input: { kind: ImportKind; filename: string; sourceSystem: string; csv: string; mapping?: Record<string, string | null>; mode: 'dry_run' | 'commit' }) {
  const kind = input.kind;
  if (!TEMPLATES[kind]) throw new AppError(400, 'bad_kind', 'Unknown import kind');
  if (!input.sourceSystem?.trim()) throw new AppError(400, 'source_required', 'Source system name is required for provenance');
  let records: Record<string, string>[];
  try {
    records = parse(input.csv, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (e: any) {
    throw new AppError(400, 'csv_parse', `CSV could not be parsed: ${e.message}`);
  }
  const headers = records.length ? Object.keys(records[0]) : (input.csv.split('\n')[0] ?? '').split(',').map((s) => s.trim());
  const mapping = input.mapping ?? suggestMapping(kind, headers);
  const missingRequired = TEMPLATES[kind].fields.filter((f) => f.required && !mapping[f.name]).map((f) => f.name);
  const fileSha = createHash('sha256').update(input.csv).digest('hex');

  const results: RowResult[] = [];
  const seenSource = new Set<string>();
  const seenNatural = new Map<string, number>();

  // Reference data for validation.
  const parties = new Map((await rows(db, `select id, name from parties`)).map((p) => [p.name.toLowerCase(), p.id]));
  const items = new Map((await rows(db, `select * from catalog_items`)).map((i) => [i.ref.toLowerCase(), i]));
  const locations = new Map((await rows(db, `select * from locations`)).map((l) => [l.code.toLowerCase(), l]));
  const pkgs = await rows(db, `select * from packages`);
  const gtins = new Set((await rows(db, `select unit_gtin g from catalog_items where unit_gtin is not null union select gtin from packages`)).map((r) => r.g));

  records.forEach((rec, idx) => {
    const v: Record<string, string> = {};
    for (const f of TEMPLATES[kind].fields) v[f.name] = mapping[f.name] ? String(rec[mapping[f.name]!] ?? '').trim() : '';
    const errors: string[] = [];
    for (const f of TEMPLATES[kind].fields) if (f.required && !v[f.name]) errors.push(`${f.name} is required`);
    const rowHash = createHash('sha256').update(JSON.stringify(v)).digest('hex');
    const r: RowResult = { row_number: idx + 2, source_id: v.source_id || null, status: 'accepted', errors, values: v, row_hash: rowHash };

    if (kind === 'catalog') {
      if (v.manufacturer && !parties.has(v.manufacturer.toLowerCase())) errors.push(`Unknown manufacturer "${v.manufacturer}"`);
      if (v.item_type && !['implant', 'instrument', 'tray', 'disposable'].includes(v.item_type)) errors.push(`item_type must be implant|instrument|tray|disposable`);
      if (v.tracking && !['serial', 'lot'].includes(v.tracking)) errors.push('tracking must be serial|lot');
      if (v.unit_gtin && !gtinCheckDigitValid(v.unit_gtin)) errors.push(`unit_gtin ${v.unit_gtin} is not a valid 14-digit GTIN`);
      const existing = items.get(v.ref?.toLowerCase());
      if (existing && existing.source_id !== v.source_id) errors.push(`ref ${v.ref} already exists from source ${existing.source_system}:${existing.source_id}`);
      if (v.unit_gtin && gtins.has(v.unit_gtin) && !(existing && existing.unit_gtin === v.unit_gtin)) errors.push(`GTIN ${v.unit_gtin} is already assigned`);
      natural(`ref:${v.ref}`);
      if (v.unit_gtin) natural(`gtin:${v.unit_gtin}`);
    } else if (kind === 'packages') {
      if (v.item_ref && !items.has(v.item_ref.toLowerCase())) errors.push(`Unknown item_ref ${v.item_ref}`);
      if (v.package_gtin && !gtinCheckDigitValid(v.package_gtin)) errors.push(`package_gtin ${v.package_gtin} is not a valid GTIN`);
      if (v.level && !['each', 'inner', 'case'].includes(v.level)) errors.push('level must be each|inner|case');
      if (v.units_per_package && !/^[1-9]\d*$/.test(v.units_per_package)) errors.push('units_per_package must be a positive whole number');
      const ex = pkgs.find((p) => p.gtin === v.package_gtin);
      if (ex && ex.source_id !== v.source_id) errors.push(`Package GTIN ${v.package_gtin} already configured (${ex.units_per_package} units)`);
      natural(`pkg:${v.package_gtin}`);
    } else {
      const item = items.get(v.item_ref?.toLowerCase());
      if (v.item_ref && !item) errors.push(`Unknown item_ref ${v.item_ref}`);
      if (v.owner && !parties.has(v.owner.toLowerCase())) errors.push(`Unknown owner "${v.owner}"`);
      const loc = locations.get(v.location_code?.toLowerCase());
      if (v.location_code && !loc) errors.push(`Unknown location_code ${v.location_code}`);
      if (loc && ['consumed', 'wasted', 'missing', 'in_transit'].includes(loc.kind)) errors.push(`Opening balances cannot be loaded into a ${loc.kind} location`);
      if (v.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(v.expiry)) errors.push('expiry must be YYYY-MM-DD');
      if (v.quantity && !/^[1-9]\d*$/.test(v.quantity)) errors.push('quantity must be a positive whole number');
      if (v.package_level && !['each', 'inner', 'case'].includes(v.package_level)) errors.push('package_level must be each|inner|case');
      if (item) {
        if (item.tracking === 'serial') {
          if (!v.serial) errors.push(`${item.ref} is serial-tracked; serial is required`);
          if (v.quantity && v.quantity !== '1') errors.push('Serialized rows must have quantity 1');
          if (v.package_level && v.package_level !== 'each') errors.push('Serialized rows must be counted at package_level each');
          natural(`serial:${item.ref}:${v.serial}`);
        } else if (!v.lot) errors.push(`${item.ref} is lot-tracked; lot is required`);
        // Package conversion must come from a configured package; never guessed.
        if (v.package_level === 'each') {
          if (v.uom && v.uom.toUpperCase() !== item.uom.toUpperCase()) errors.push(`uom ${v.uom} does not match unit uom ${item.uom}`);
          r.units = Number(v.quantity);
        } else if (v.package_level) {
          const p = pkgs.find((p) => p.catalog_item_id === item.id && p.level === v.package_level && p.uom.toUpperCase() === v.uom?.toUpperCase());
          if (!p) errors.push(`No package configuration for ${item.ref} at level "${v.package_level}" with uom ${v.uom}; conversion to units is not guessed`);
          else { r.units = Number(v.quantity) * p.units_per_package; r.detail = `${v.quantity} ${p.uom} x ${p.units_per_package} = ${r.units} units`; }
        }
      }
    }
    function natural(key: string) {
      if (seenNatural.has(key)) errors.push(`Duplicate in file: same ${key.split(':')[0]} as row ${seenNatural.get(key)}`);
      else seenNatural.set(key, idx + 2);
    }
    if (v.source_id) {
      if (seenSource.has(v.source_id)) { r.status = 'duplicate_in_file'; errors.push(`source_id ${v.source_id} repeats an earlier row in this file`); }
      seenSource.add(v.source_id);
    }
    if (errors.length && r.status === 'accepted') r.status = 'error';
    results.push(r);
  });

  // Idempotency: rows already committed from the same source system + source id.
  const keys = await rows(db, `select source_id, row_hash, first_batch_id from import_row_keys where kind=$1 and source_system=$2 and source_id = any($3)`,
    [kind, input.sourceSystem, results.map((r) => r.source_id).filter(Boolean)]);
  const keyMap = new Map(keys.map((k) => [k.source_id, k]));
  for (const r of results) {
    const k = r.source_id ? keyMap.get(r.source_id) : null;
    if (!k || r.status === 'duplicate_in_file') continue;
    if (k.row_hash === r.row_hash) { r.status = 'already_imported'; r.errors = []; r.detail = `Already imported in batch ${k.first_batch_id}; skipped`; }
    else { r.status = 'conflict'; r.errors = [`source_id ${r.source_id} was imported earlier with different values; submit a correction, not a re-import`]; }
  }
  // Serial already on hand from another source.
  if (kind === 'opening_balances') {
    for (const r of results.filter((r) => r.status === 'accepted' && r.values.serial)) {
      const item = items.get(r.values.item_ref.toLowerCase());
      const ex = await maybe(db, `select l.code from stock_items s join stock_balances b on b.stock_item_id=s.id and b.qty>0 join locations l on l.id=b.location_id where s.catalog_item_id=$1 and s.serial_number=$2`, [item.id, r.values.serial]);
      if (ex) { r.status = 'conflict'; r.errors.push(`Serial ${r.values.serial} is already on hand at ${ex.code}`); }
    }
  }

  const blocked = missingRequired.length > 0;
  const batch = (await db.query(
    `insert into import_batches(tenant_id, kind, filename, source_system, file_sha256, mode, mapping, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, kind, input.filename, input.sourceSystem, fileSha, input.mode, mapping, ctx.userId, nowIso()])).rows[0];

  const before = kind === 'opening_balances' ? await unitsByLocation(db) : null;
  let committedUnits = 0;
  if (input.mode === 'commit' && !blocked) {
    for (const r of results.filter((r) => r.status === 'accepted')) {
      const entityId = await commitRow(db, ctx, kind, r, batch.id, input.sourceSystem, { parties, items, locations, pkgs });
      if (kind === 'opening_balances') committedUnits += r.units ?? 0;
      await db.query(`insert into import_row_keys(tenant_id, kind, source_system, source_id, row_hash, first_batch_id, entity_id) values ($1,$2,$3,$4,$5,$6,$7)`,
        [ctx.tenantId, kind, input.sourceSystem, r.source_id, r.row_hash, batch.id, entityId]);
      (r as any).entity_id = entityId;
    }
  }
  for (const r of results) {
    await db.query(`insert into import_rows(tenant_id,batch_id,row_number,source_id,row_hash,status,errors,raw,entity_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.tenantId, batch.id, r.row_number, r.source_id, r.row_hash, r.status, JSON.stringify(r.errors), r.values, (r as any).entity_id ?? null]);
  }
  const after = kind === 'opening_balances' ? await unitsByLocation(db) : null;
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const ledgerUnits = kind === 'opening_balances' ? (await rows(db, `select coalesce(sum(qty),0)::int n from inventory_movements where import_batch_id=$1`, [batch.id]))[0].n : null;
  const report = {
    batch_id: batch.id, kind, mode: input.mode, filename: input.filename, source_system: input.sourceSystem, file_sha256: fileSha,
    rows_read: results.length, counts, missing_required_mappings: missingRequired, mapping, headers,
    committed: input.mode === 'commit' && !blocked,
    reconciliation: kind === 'opening_balances' ? {
      accepted_units: results.filter((r) => r.status === 'accepted').reduce((a, r) => a + (r.units ?? 0), 0),
      units_posted_to_ledger: ledgerUnits, committed_units: committedUnits,
      ledger_matches: input.mode === 'commit' ? ledgerUnits === committedUnits : null,
      by_location: mergeLoc(before!, after!),
    } : null,
    rows: results.map(({ row_number, source_id, status, errors, detail, units, values }) => ({ row_number, source_id, status, errors, detail, units, values })),
  };
  await db.query(`update import_batches set report=$2 where id=$1`, [batch.id, { ...report, rows: undefined }]);
  await audit(db, ctx, `import.${input.mode}`, 'import_batch', batch.id, { kind, counts, filename: input.filename, source_system: input.sourceSystem });
  return report;
}

async function unitsByLocation(db: Db) {
  return rows(db, `select l.code, coalesce(sum(b.qty),0)::int units from locations l left join stock_balances b on b.location_id=l.id group by l.code order by l.code`);
}
function mergeLoc(before: any[], after: any[]) {
  return after.map((a) => ({ location: a.code, before: before.find((b) => b.code === a.code)?.units ?? 0, after: a.units }))
    .filter((x) => x.before !== 0 || x.after !== 0);
}

async function commitRow(db: Db, ctx: Ctx, kind: ImportKind, r: RowResult, batchId: string, sourceSystem: string, ref: any): Promise<string> {
  const v = r.values;
  if (kind === 'catalog') {
    const res = await db.query(
      `insert into catalog_items(tenant_id, manufacturer_party_id, ref, description, item_type, tracking, unit_gtin, size, product_line, uom, source_system, source_id, import_batch_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [ctx.tenantId, ref.parties.get(v.manufacturer.toLowerCase()), v.ref, v.description, v.item_type, v.tracking, v.unit_gtin || null, v.size || null, v.product_line || null, (v.uom || 'EA').toUpperCase(), sourceSystem, v.source_id, batchId]);
    const item = { id: res.rows[0].id, ref: v.ref, tracking: v.tracking, uom: (v.uom || 'EA').toUpperCase(), source_id: v.source_id };
    ref.items.set(v.ref.toLowerCase(), item);
    return res.rows[0].id;
  }
  if (kind === 'packages') {
    const item = ref.items.get(v.item_ref.toLowerCase());
    const res = await db.query(`insert into packages(tenant_id, catalog_item_id, gtin, level, units_per_package, uom, source_system, source_id, import_batch_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [ctx.tenantId, item.id, v.package_gtin, v.level, Number(v.units_per_package), v.uom.toUpperCase(), sourceSystem, v.source_id, batchId]);
    return res.rows[0].id;
  }
  const item = ref.items.get(v.item_ref.toLowerCase());
  const loc = ref.locations.get(v.location_code.toLowerCase());
  const owner = ref.parties.get(v.owner.toLowerCase());
  const serial = item.tracking === 'serial';
  let si = serial
    ? await maybe(db, `select * from stock_items where catalog_item_id=$1 and serial_number=$2`, [item.id, v.serial])
    : await maybe(db, `select * from stock_items where catalog_item_id=$1 and lot_number=$2 and serial_number is null`, [item.id, v.lot]);
  if (si && si.expiry_date && v.expiry && si.expiry_date !== v.expiry) throw new AppError(409, 'expiry_conflict', `Row ${r.row_number}: expiry ${v.expiry} conflicts with recorded ${si.expiry_date} for the same lot`);
  if (!si) {
    si = (await db.query(`insert into stock_items(tenant_id, catalog_item_id, lot_number, serial_number, expiry_date, is_serial, data_source, import_batch_id) values ($1,$2,$3,$4,$5,$6,'import',$7) returning *`,
      [ctx.tenantId, item.id, v.lot || null, serial ? v.serial : null, v.expiry || null, serial, batchId])).rows[0];
  }
  await applyMovement(db, ctx, {
    stockItemId: si.id, qty: r.units!, ownerPartyId: owner, to: { locationId: loc.id, condition: 'sealed' }, type: 'opening_balance',
    reason: `Opening balance import ${sourceSystem}:${v.source_id}${r.detail ? ` (${r.detail})` : ''}`, importBatchId: batchId,
    idempotencyKey: `import:opening_balances:${sourceSystem}:${v.source_id}`,
  });
  return si.id;
}
