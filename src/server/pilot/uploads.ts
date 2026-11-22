/**
 * Spreadsheet uploads for the pilot: inventory balances, case schedules and case requirements.
 *
 * Rules that matter:
 *  - Every source row ends as accepted, held for review, or skipped, with a plain-English message.
 *  - Catalog numbers are text. Items match on manufacturer + catalog number.
 *  - Box/pack quantities convert only through a conversion a person verified.
 *  - The FIRST balance file for a location sets its opening balance. Every later file is a SNAPSHOT:
 *    an observation compared with the system balance. A difference opens a discrepancy for a person
 *    to reconcile; it never edits stock by itself. A row missing from a partial export means nothing.
 *  - The same file uploaded twice returns the first result. A file exported before newer evidence
 *    (a later file, a physical count, a recorded movement) is kept as history and not applied.
 *  - Preview runs the real commit inside a savepoint and rolls it back, so preview == commit.
 */
import crypto from 'node:crypto';
import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit } from '../audit.js';
import { applyMovement } from '../domain/inventory.js';
import { fmtLocal, moveCase, cancelCase, updateRequirement } from '../domain/cases.js';
import { zoned } from '../time.js';
import { guessHeaderRow, headerSignature, norm, normHeader, parseDate, parseFile, parseTime, Sheet } from './workbook.js';

export type UploadKind = 'inventory' | 'schedule' | 'requirements';
export interface FieldDef { name: string; label: string; required: boolean; help: string; synonyms: string[] }

export const FIELDS: Record<UploadKind, FieldDef[]> = {
  inventory: [
    { name: 'location', label: 'Location', required: true, help: 'Where the stock is: warehouse, consignment location, or facility name', synonyms: ['location name', 'inventory location', 'storage location', 'territory', 'location', 'loc', 'site', 'warehouse', 'bin location', 'stock location', 'facility'] },
    { name: 'manufacturer', label: 'Manufacturer', required: false, help: 'Needed when a catalog number is new or shared by two manufacturers', synonyms: ['manufacturer', 'mfr', 'mfg', 'vendor', 'supplier', 'brand'] },
    { name: 'catalog_number', label: 'Catalog number', required: true, help: 'Exact catalog/reference number, kept as text (leading zeros matter)', synonyms: ['product code', 'item code', 'material', 'material number', 'product number', 'catalog number', 'catalog no', 'catalog', 'cat no', 'ref', 'reference', 'item number', 'item no', 'part number', 'part no', 'sku', 'item'] },
    { name: 'description', label: 'Description', required: false, help: 'Used when the item is new', synonyms: ['product name', 'item name', 'product description', 'description', 'desc', 'item description', 'name', 'product'] },
    { name: 'lot', label: 'Lot', required: false, help: 'Lot/batch number', synonyms: ['lot', 'lot number', 'lot no', 'batch'] },
    { name: 'serial', label: 'Serial', required: false, help: 'Serial number, for serialized units', synonyms: ['serial', 'serial number', 'serial no', 'sn'] },
    { name: 'expiry', label: 'Expiry date', required: false, help: 'Expiration date', synonyms: ['expiry', 'expiration', 'expiration date', 'exp date', 'exp', 'use by'] },
    { name: 'quantity', label: 'Quantity on hand', required: true, help: 'Whole number', synonyms: ['quantity on hand', 'available quantity', 'qty available', 'current qty', 'quantity', 'qty', 'on hand', 'qty on hand', 'quantity on hand', 'qoh', 'count', 'balance'] },
    { name: 'uom', label: 'Unit of measure', required: false, help: 'EA for single units; BX/PK need a verified conversion', synonyms: ['uom', 'unit', 'unit of measure', 'um', 'units'] },
    { name: 'units_per_package', label: 'Units per box/pack', required: false, help: 'How many single units one box holds, if your file has it', synonyms: ['units per box', 'units per pack', 'units per package', 'pack size', 'box qty', 'per box', 'each per'] },
  ],
  schedule: [
    { name: 'case_id', label: 'Case ID', required: true, help: 'Your scheduling reference (not a patient identifier)', synonyms: ['order number', 'order no', 'order id', 'event id', 'case number', 'case id', 'case', 'case number', 'case no', 'case ref', 'booking', 'booking id', 'surgery id'] },
    { name: 'facility', label: 'Facility', required: true, help: 'Hospital or surgery center name', synonyms: ['account name', 'hospital name', 'customer', 'customer name', 'ship to', 'facility', 'hospital', 'site', 'location', 'account'] },
    { name: 'date', label: 'Surgery date', required: true, help: 'Date in the facility\'s local calendar', synonyms: ['start date time', 'start datetime', 'activity date', 'due date', 'surgery date time', 'date of surgery', 'date', 'surgery date', 'case date', 'procedure date', 'dos', 'start', 'start date', 'scheduled'] },
    { name: 'time', label: 'Start time', required: false, help: 'Local start time at the facility (may be in the date column)', synonyms: ['time', 'start time', 'case time', 'surgery time', 'or time'] },
    { name: 'procedure', label: 'Procedure', required: false, help: '', synonyms: ['subject', 'procedure type', 'procedure', 'procedure name', 'surgery', 'operation'] },
    { name: 'surgeon', label: 'Surgeon', required: false, help: 'Surgeon code or name', synonyms: ['surgeon', 'doctor', 'physician', 'dr'] },
    { name: 'rep', label: 'Rep', required: false, help: 'Your representative covering the case', synonyms: ['assigned to', 'owner name', 'case owner', 'account owner', 'agent', 'rep', 'sales rep', 'representative', 'covering rep', 'owner'] },
    { name: 'status', label: 'Status', required: false, help: '"Cancelled" cancels the case', synonyms: ['status', 'case status'] },
    { name: 'previous_id', label: 'ID in your previous system', required: false, help: 'Optional. Kept on the case so people can still search by the number they know', synonyms: ['record id', 'salesforce id', 'sf id', 'case record id', 'event record id', 'external id', 'legacy id', 'previous id', 'old id'] },
  ],
  requirements: [
    { name: 'case_id', label: 'Case ID', required: true, help: 'Must match a case from the schedule', synonyms: ['order number', 'order no', 'order id', 'event id', 'case number', 'work order', 'case id', 'case', 'case number', 'case no', 'case ref', 'booking', 'booking id', 'surgery id'] },
    { name: 'manufacturer', label: 'Manufacturer', required: false, help: 'Needed when a catalog number is new or shared', synonyms: ['manufacturer', 'mfr', 'mfg', 'vendor', 'supplier', 'brand'] },
    { name: 'catalog_number', label: 'Catalog number', required: true, help: 'Exact item required', synonyms: ['product code', 'item code', 'product required', 'material', 'product number', 'catalog number', 'catalog no', 'catalog', 'cat no', 'ref', 'reference', 'item number', 'item no', 'part number', 'part no', 'sku', 'item'] },
    { name: 'description', label: 'Description', required: false, help: '', synonyms: ['description', 'desc', 'item description', 'name', 'product'] },
    { name: 'quantity', label: 'Quantity required', required: true, help: 'Whole number', synonyms: ['quantity required', 'order qty', 'order quantity', 'qty ordered', 'quantity', 'qty', 'qty required', 'required', 'quantity required', 'needed', 'qty needed'] },
    { name: 'uom', label: 'Unit of measure', required: false, help: '', synonyms: ['uom', 'unit', 'unit of measure', 'um'] },
  ],
};
export const SOURCE_SYSTEMS: Record<string, string> = { redspot: 'RedSpot', salesforce: 'Salesforce', spreadsheet: 'Spreadsheet', other: 'Another system' };
export const KIND_LABEL: Record<UploadKind, string> = { inventory: 'Inventory balances', schedule: 'Case schedule', requirements: 'Case requirements' };
const EACH = new Set(['', 'ea', 'each', 'unit', 'units', 'pc', 'pcs', 'piece', 'pieces', 'single', 'eaches']);
const stripZeros = (s: string) => s.replace(/^0+(?=.)/, '');
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function suggestMapping(kind: UploadKind, headers: string[]) {
  const m: Record<string, string | null> = {}; const used = new Set<string>();
  for (const f of FIELDS[kind]) {
    const hit = headers.find((h) => h && !used.has(h) && f.synonyms.includes(normHeader(h)))
      ?? headers.find((h) => h && !used.has(h) && f.synonyms.some((s) => s.length > 3 && normHeader(h).includes(s)));
    m[f.name] = hit ?? null; if (hit) used.add(hit);
  }
  return m;
}

// ---------------- file storage ----------------

export async function storeFile(db: Db, ctx: Ctx, input: { filename: string; contentBase64: string }) {
  requirePerm(ctx, 'upload.run');
  const filename = String(input.filename ?? '').replace(/[\\/]/g, '_').slice(0, 200);
  if (!filename || !input.contentBase64) throw new AppError(400, 'no_file', 'Choose a file to upload');
  const buf = Buffer.from(input.contentBase64, 'base64');
  if (!buf.length) throw new AppError(400, 'empty_file', 'That file is empty');
  const parsed = await parseFile(filename, buf);
  // Identity is the cell contents, not the bytes: re-saving a workbook in Excel changes the bytes but not the data.
  const digest = sha(JSON.stringify(parsed.sheets.map((sh) => [sh.name, sh.rows])));
  const sheets = parsed.sheets.map((s) => { const hr = guessHeaderRow(s); return { name: s.name, rowCount: Math.max(0, s.rows.length - hr), headerRow: hr, headers: s.rows[hr - 1] ?? [] }; });
  let f = await maybe(db, `select id, filename, uploaded_at, uploaded_by from upload_files where content_sha256=$1`, [digest]);
  const duplicate = !!f;
  if (!f) f = (await db.query(`insert into upload_files(tenant_id, filename, content_sha256, size_bytes, content, sheets, uploaded_by, uploaded_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, filename, uploaded_at, uploaded_by`,
    [ctx.tenantId, filename, digest, buf.length, buf, JSON.stringify(sheets), ctx.userId, nowIso()])).rows[0];
  const priorRuns = await rows(db, `select r.id, r.worksheet, r.kind, r.created_at, r.counts, u.display_name by_name from upload_runs r join users u on u.id=r.created_by where r.file_id=$1 order by r.created_at`, [f.id]);
  const modifiedAt = parsed.modifiedAt && new Date(parsed.modifiedAt) <= now() ? parsed.modifiedAt : null;
  return { fileId: f.id, filename: f.filename, duplicate, firstUploadedAt: f.uploaded_at, sheets: sheets.map((s, i) => ({ ...s, sample: parsed.sheets[i].rows.slice(s.headerRow, s.headerRow + 4), guessKind: guessKind(s.name, s.headers) })), priorRuns, modifiedAt };
}
function guessKind(name: string, headers: string[]): UploadKind | null {
  const n = norm(name); const h = headers.map(normHeader);
  const score = (k: UploadKind) => FIELDS[k].filter((f) => f.required && h.some((x) => f.synonyms.includes(x))).length / FIELDS[k].filter((f) => f.required).length;
  if (/invent|stock|balance|on hand/.test(n)) return 'inventory';
  if (/sched|calendar/.test(n)) return 'schedule';
  if (/requ|need|bom|pick/.test(n)) return 'requirements';
  const best = (['inventory', 'requirements', 'schedule'] as UploadKind[]).map((k) => [k, score(k)] as const).sort((a, b) => b[1] - a[1])[0];
  return best[1] === 1 ? best[0] : null;
}

async function loadSheet(db: Db, fileId: string, worksheet: string) {
  if (!/^[0-9a-f-]{36}$/i.test(String(fileId))) throw new AppError(404, 'not_found', 'File not found');
  const f = await maybe(db, `select * from upload_files where id=$1`, [fileId]);
  if (!f) throw new AppError(404, 'not_found', 'File not found');
  const parsed = await parseFile(f.filename, f.content);
  const sheet = parsed.sheets.find((s) => s.name === worksheet);
  if (!sheet) throw new AppError(400, 'no_sheet', `Worksheet "${worksheet}" is not in ${f.filename}`);
  return { f, sheet };
}

export async function suggest(db: Db, ctx: Ctx, input: { fileId: string; worksheet: string; kind: UploadKind; headerRow?: number }) {
  requirePerm(ctx, 'upload.run');
  if (!FIELDS[input.kind]) throw new AppError(400, 'bad_kind', 'Choose what this worksheet contains');
  const { sheet } = await loadSheet(db, input.fileId, input.worksheet);
  const headerRow = input.headerRow ?? guessHeaderRow(sheet);
  const headers = sheet.rows[headerRow - 1] ?? [];
  const saved = await maybe(db, `select m.*, u.display_name by_name from column_mappings m join users u on u.id=m.saved_by where m.kind=$1 and m.header_signature=$2`, [input.kind, headerSignature(headers)]);
  return { headerRow, headers, fields: FIELDS[input.kind], mapping: saved?.mapping ?? suggestMapping(input.kind, headers),
    saved: saved ? { savedAt: saved.saved_at, by: saved.by_name, options: saved.options } : null, sample: sheet.rows.slice(headerRow, headerRow + 5) };
}

// ---------------- reference data for one run ----------------

interface Ref {
  facilities: any[]; locations: any[]; manufacturers: any[]; aliases: any[]; distributorId: string; reps: any[];
}
async function loadRef(db: Db): Promise<Ref> {
  const dist = await maybe(db, `select id from parties where kind='distributor' order by name limit 1`);
  if (!dist) throw new AppError(409, 'not_set_up', 'This account has no distributor organization yet');
  return {
    facilities: await rows(db, `select * from facilities where kind='hospital' order by name`),
    locations: await rows(db, `select l.*, f.name facility_name from locations l left join facilities f on f.id=l.facility_id where l.kind in ('warehouse','consignment','trunk','hospital_receiving','hospital_spd') order by l.name`),
    manufacturers: await rows(db, `select * from parties where kind='manufacturer' order by name`),
    aliases: await rows(db, `select * from name_aliases`),
    reps: await rows(db, `select id, display_name, email from users where role='rep' and active`),
    distributorId: dist.id,
  };
}
type Res<T> = { ok: T; note?: string } | { held: string; message: string; entity?: any };

/** Exact name/code/alias first; then a unique partial match; otherwise ask a person. */
function matchName(kind: 'facility' | 'location', text: string, list: any[], ref: Ref, what: string): Res<any> {
  const n = norm(text);
  if (!n) return { held: `missing_${kind}`, message: `The ${what} is blank. Fill it in and upload the file again.` };
  const alias = ref.aliases.find((a) => a.kind === kind && a.alias_norm === n);
  if (alias) { const t = list.find((x) => x.id === alias.target_id); if (t) return { ok: t }; }
  const exact = list.filter((x) => norm(x.name) === n || norm(x.code) === n);
  if (exact.length === 1) return { ok: exact[0] };
  const toks = n.split(' ');
  const partial = list.filter((x) => { const t = norm(`${x.name} ${x.facility_name ?? ''}`).split(' '); return toks.every((k) => t.includes(k)); });
  if (partial.length === 1) return { ok: partial[0], note: `"${text}" matched to ${partial[0].name}` };
  const choices = (partial.length ? partial : list).map((x) => ({ id: x.id, label: x.name }));
  if (partial.length > 1) return { held: `ambiguous_${kind}`, message: `"${text}" could mean ${partial.map((x) => x.name).join(' or ')}. Choose which one; the choice is remembered for future files.`, entity: { aliasKind: kind, aliasText: text, choices } };
  return { held: `unknown_${kind}`, message: `No ${what} is called "${text}". Choose the ${what} it refers to (remembered for future files), or correct the name in the file.`, entity: { aliasKind: kind, aliasText: text, choices } };
}

async function resolveManufacturer(db: Db, ctx: Ctx, text: string, ref: Ref, dry: { created: string[] }): Promise<Res<any>> {
  const n = norm(text);
  const alias = ref.aliases.find((a) => a.kind === 'manufacturer' && a.alias_norm === n);
  if (alias) { const t = ref.manufacturers.find((x) => x.id === alias.target_id); if (t) return { ok: t }; }
  const exact = ref.manufacturers.find((x) => norm(x.name) === n);
  if (exact) return { ok: exact };
  const strip = (s: string) => norm(s).replace(/\b(inc|llc|corp|corporation|co|ltd|synthetic|orthopaedics|orthopedics|ortho|medical|devices)\b/g, '').replace(/\s+/g, ' ').trim();
  const near = ref.manufacturers.filter((x) => strip(x.name) && (strip(x.name) === strip(text) || norm(x.name).includes(n) || n.includes(norm(x.name))));
  if (near.length) return { held: 'ambiguous_manufacturer', message: `Manufacturer "${text}" is not on file, but ${near.map((x) => x.name).join(' and ')} ${near.length === 1 ? 'is' : 'are'}. Choose whether it is the same company or a different one.`,
    entity: { aliasKind: 'manufacturer', aliasText: text, choices: [...near.map((x) => ({ id: x.id, label: `Same as ${x.name}` })), { id: 'new', label: `Different company: add "${text}"` }] } };
  const p = (await db.query(`insert into parties(tenant_id, name, kind, source_system) values ($1,$2,'manufacturer','upload') returning *`, [ctx.tenantId, text.trim()])).rows[0];
  ref.manufacturers.push(p); dry.created.push(`manufacturer ${p.name}`);
  return { ok: p, note: `new manufacturer "${p.name}" added` };
}

async function resolveItem(db: Db, ctx: Ctx, ref: Ref, f: { manufacturer: string; catalog: string; description: string; serial?: string; numericCell: boolean }, dry: { created: string[] }): Promise<Res<any>> {
  const cat = f.catalog.trim();
  if (!cat) return { held: 'missing_catalog', message: 'The catalog number is blank. Fill it in and upload the file again.' };
  const same = await rows(db, `select ci.*, p.name manufacturer from catalog_items ci left join parties p on p.id=ci.manufacturer_party_id where lower(ci.ref)=lower($1) order by p.name`, [cat]);
  const zeroTwins = async (mfrId: string | null) => rows(db, `select ci.ref, p.name manufacturer from catalog_items ci left join parties p on p.id=ci.manufacturer_party_id
     where ltrim(lower(ci.ref),'0')=ltrim(lower($1),'0') and lower(ci.ref)<>lower($1) and ($2::uuid is null or ci.manufacturer_party_id=$2)`, [cat, mfrId]);
  const zeroMsg = (t: any[]) => `The file has catalog number "${cat}" but the catalog has "${t[0].ref}" (${t[0].manufacturer}). ${f.numericCell ? 'Excel stored this cell as a number, which drops leading zeros. ' : ''}Format the catalog column as Text, enter ${t[0].ref}, and upload again. Nothing was created under "${cat}".`;
  if (!f.manufacturer.trim()) {
    if (same.length === 1) return { ok: same[0], note: 'manufacturer not in the file; matched the only item with this catalog number' };
    if (same.length > 1) return { held: 'ambiguous_catalog', message: `Catalog number ${cat} is used by ${same.map((s) => s.manufacturer).join(' and ')}; these are different products. Add the manufacturer to this row and upload again.`, entity: { catalog: cat, manufacturers: same.map((s) => s.manufacturer) } };
    const t = await zeroTwins(null);
    if (t.length) return { held: 'leading_zeros', message: zeroMsg(t) };
    return { held: 'missing_manufacturer', message: `Catalog number ${cat} is new and the row has no manufacturer. Add the manufacturer so the item can be created, then upload again.` };
  }
  const m = await resolveManufacturer(db, ctx, f.manufacturer, ref, dry);
  if ('held' in m) return m;
  const hit = same.find((s) => s.manufacturer_party_id === m.ok.id);
  if (hit) return { ok: hit, note: m.note };
  const t = await zeroTwins(m.ok.id);
  if (t.length) return { held: 'leading_zeros', message: zeroMsg(t) };
  const item = (await db.query(`insert into catalog_items(tenant_id, manufacturer_party_id, ref, description, item_type, tracking, source_system) values ($1,$2,$3,$4,'implant',$5,'upload') returning *`,
    [ctx.tenantId, m.ok.id, cat, f.description.trim() || 'Description not provided', f.serial ? 'serial' : 'lot'])).rows[0];
  dry.created.push(`item ${cat}`);
  return { ok: { ...item, manufacturer: m.ok.name }, note: [m.note, `new catalog item ${cat} (${m.ok.name}) added${same.length ? `; note that ${same.map((s) => s.manufacturer).join(', ')} also uses this number` : ''}`].filter(Boolean).join('; ') };
}

/** Quantity in single units. Boxes and packs convert only through a verified conversion. */
async function resolveQty(db: Db, ctx: Ctx, item: any, qtyText: string, uomText: string, perText: string, src: string): Promise<Res<{ units: number; note?: string }>> {
  const q = qtyText.trim();
  if (!/^\d+$/.test(q.replace(/,/g, ''))) return { held: 'bad_quantity', message: q === '' ? 'The quantity is blank. Enter a whole number and upload again.' : `"${qtyText}" is not a whole number of units. Correct the quantity and upload again.` };
  const n = Number(q.replace(/,/g, ''));
  const u = norm(uomText);
  if (EACH.has(u)) return { ok: { units: n } };
  let conv = await maybe(db, `select * from uom_conversions where catalog_item_id=$1 and uom_norm=$2`, [item.id, u]);
  const per = /^\d+$/.test(perText.trim()) && Number(perText) > 0 ? Number(perText) : null;
  if (conv?.verified_at && conv.units_per) {
    if (per && per !== conv.units_per) return { held: 'package_mismatch', message: `This row says ${per} units per ${uomText}, but the verified conversion for ${item.ref} is ${conv.units_per}. Correct the file, or update the conversion on this page and re-check.`, entity: { conversionId: conv.id } };
    return { ok: { units: n * conv.units_per, note: `${n} ${uomText} × ${conv.units_per} = ${n * conv.units_per} units (verified conversion)` } };
  }
  if (!conv) conv = (await db.query(`insert into uom_conversions(tenant_id, catalog_item_id, uom_norm, units_per, proposed_from, created_at) values ($1,$2,$3,$4,$5,$6) returning *`, [ctx.tenantId, item.id, u, per, src, nowIso()])).rows[0];
  return { held: 'unverified_package', message: `This row counts ${n} ${uomText}, not single units. Confirm how many units are in one ${uomText} of ${item.ref}${conv.units_per ? ` (the file says ${conv.units_per})` : ''}; then this row is re-checked. Nothing is converted on a guess.`,
    entity: { conversionId: conv.id, proposedUnits: conv.units_per, uom: uomText, itemRef: item.ref } };
}

// ---------------- the run ----------------

export interface RunInput { fileId: string; worksheet: string; kind: UploadKind; headerRow?: number; mapping: Record<string, string | null>; exportedAt?: string | null; coverage?: 'complete' | 'partial'; saveMapping?: boolean; sourceSystem?: string | null }

export async function runUpload(db: Db, ctx: Ctx, input: RunInput, mode: 'preview' | 'commit') {
  requirePerm(ctx, 'upload.run');
  if (!FIELDS[input.kind]) throw new AppError(400, 'bad_kind', 'Choose what this worksheet contains');
  const { f, sheet } = await loadSheet(db, input.fileId, input.worksheet);
  const prior = await maybe(db, `select id from upload_runs where file_id=$1 and worksheet=$2 and kind=$3`, [f.id, input.worksheet, input.kind]);
  if (prior) return { ...(await runDetail(db, ctx, prior.id)), replayed: true, preview: mode === 'preview',
    replayMessage: `This exact file and worksheet were already loaded as ${KIND_LABEL[input.kind].toLowerCase()}. Nothing was imported again; this is the original result.` };
  // No time given means "exported just now". A time a few seconds ahead (minute-precision input) is read as now.
  let exportedAt = input.exportedAt ? new Date(input.exportedAt) : now();
  if (isNaN(exportedAt.getTime())) throw new AppError(400, 'bad_export_time', 'Enter when this file was exported from your system');
  if (exportedAt.getTime() > now().getTime() + 5 * 60e3) throw new AppError(400, 'future_export_time', 'The export time is in the future. Enter when the file was actually exported.');
  if (exportedAt > now()) exportedAt = now();
  const headerRow = input.headerRow ?? guessHeaderRow(sheet);
  const headers = sheet.rows[headerRow - 1] ?? [];
  for (const fd of FIELDS[input.kind]) if (fd.required && !input.mapping?.[fd.name]) throw new AppError(400, 'mapping_incomplete', `Choose which column holds "${fd.label}"`);
  for (const [k, h] of Object.entries(input.mapping ?? {})) if (h && !headers.includes(h)) throw new AppError(400, 'mapping_stale', `Column "${h}" (mapped to ${k}) is not in this worksheet`);
  const coverage = input.kind === 'inventory' ? (input.coverage === 'complete' ? 'complete' : 'partial') : null;

  await db.query('savepoint upload_run');
  const run = (await db.query(`insert into upload_runs(tenant_id, file_id, worksheet, kind, mapping, header_row, exported_at, coverage, created_by, created_at, source_system) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [ctx.tenantId, f.id, input.worksheet, input.kind, input.mapping, headerRow, exportedAt.toISOString(), coverage, ctx.userId, nowIso(), SOURCE_SYSTEMS[String(input.sourceSystem ?? '')] ?? null])).rows[0];
  await processRows(db, ctx, run, f, sheet, null);
  if (mode === 'commit' && input.saveMapping !== false) {
    await db.query(`insert into column_mappings(tenant_id, kind, header_signature, worksheet, mapping, options, saved_by, saved_at) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (tenant_id, kind, header_signature) do update set mapping=excluded.mapping, options=excluded.options, worksheet=excluded.worksheet, saved_by=excluded.saved_by, saved_at=excluded.saved_at`,
      [ctx.tenantId, input.kind, headerSignature(headers), input.worksheet, input.mapping, { coverage, headerRow }, ctx.userId, nowIso()]);
  }
  const detail = await runDetail(db, ctx, run.id);
  if (mode === 'preview') { await db.query('rollback to savepoint upload_run'); return { ...detail, preview: true, replayed: false }; }
  await db.query('release savepoint upload_run');
  await audit(db, ctx, 'upload.commit', 'upload_run', run.id, { file: f.filename, worksheet: input.worksheet, kind: input.kind, counts: detail.run.counts, exported_at: exportedAt.toISOString() });
  return { ...detail, preview: false, replayed: false };
}

/** Re-evaluate rows that were held for a fixable reason (alias chosen, conversion verified, schedule now loaded). */
export async function recheckRun(db: Db, ctx: Ctx, runId: string) {
  requirePerm(ctx, 'upload.run');
  const run = await maybe(db, `select * from upload_runs where id=$1`, [runId]);
  if (!run) throw new AppError(404, 'not_found', 'Upload not found');
  const { f, sheet } = await loadSheet(db, run.file_id, run.worksheet);
  const held = (await rows(db, `select row_number from upload_rows where run_id=$1 and outcome='held' and reason_code <> 'needs_reconciliation'`, [runId])).map((r) => r.row_number);
  if (held.length) await processRows(db, ctx, run, f, sheet, new Set(held));
  return runDetail(db, ctx, runId);
}

async function processRows(db: Db, ctx: Ctx, run: any, f: any, sheet: Sheet, only: Set<number> | null) {
  const headers = sheet.rows[run.header_row - 1] ?? [];
  const col = (name: string) => { const h = run.mapping?.[name]; return h ? headers.indexOf(h) : -1; };
  const ref = await loadRef(db);
  run.tz = (await one(db, `select timezone from tenants where id=$1`, [ctx.tenantId])).timezone;
  const dry = { created: [] as string[] };
  const src = (n: number) => `${f.filename} › ${run.worksheet} › row ${n}`;
  const put = async (n: number, raw: any, outcome: 'accepted' | 'held' | 'skipped', reason: string | null, message: string, interpreted: any = {}, entity: any = {}) => {
    if (only && !only.has(n)) return (await one(db, `select id from upload_rows where run_id=$1 and row_number=$2`, [run.id, n])).id as string;
    return (await db.query(`insert into upload_rows(tenant_id, run_id, row_number, raw, interpreted, outcome, reason_code, message, entity, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (run_id, row_number) do update set interpreted=excluded.interpreted, outcome=excluded.outcome, reason_code=excluded.reason_code, message=excluded.message, entity=excluded.entity, updated_at=excluded.updated_at returning id`,
      [ctx.tenantId, run.id, n, raw, interpreted, outcome, reason, message, entity, nowIso()])).rows[0].id as string;
  };
  const active = (n: number) => !only || only.has(n);

  // Pass 1: read and interpret every data row.
  interface Row { n: number; raw: Record<string, string>; get: (f: string) => string; numeric: (f: string) => boolean; blank: boolean; held?: { code: string; message: string; entity?: any }; data?: any; notes: string[]; key?: string }
  const list: Row[] = [];
  for (let i = run.header_row; i < sheet.rows.length; i++) {
    const cells = sheet.rows[i]; const n = i + 1;
    const raw: Record<string, string> = {}; headers.forEach((h, c) => { if (h) raw[h] = cells[c] ?? ''; });
    const get = (name: string) => { const c = col(name); return c < 0 ? '' : String(cells[c] ?? '').trim(); };
    list.push({ n, raw, get, numeric: (name) => sheet.numeric.has(`${n}:${col(name)}`), blank: cells.every((c) => !String(c ?? '').trim()), notes: [] });
  }
  const hold = (r: Row, x: { held: string; message: string; entity?: any }) => { r.held = { code: x.held, message: x.message, entity: x.entity }; };

  if (run.kind === 'inventory') {
    for (const r of list) {
      if (r.blank) continue;
      const loc = matchName('location', r.get('location'), ref.locations, ref, 'location');
      if ('held' in loc) { hold(r, loc); continue; }
      if (loc.note) r.notes.push(loc.note);
      const item = await resolveItem(db, ctx, ref, { manufacturer: r.get('manufacturer'), catalog: r.get('catalog_number'), description: r.get('description'), serial: r.get('serial'), numericCell: r.numeric('catalog_number') }, dry);
      if ('held' in item) { hold(r, item); continue; }
      if (item.note) r.notes.push(item.note);
      const lot = r.get('lot'), serial = r.get('serial');
      if (!lot && !serial) { hold(r, { held: 'missing_lot', message: `No lot or serial number for ${item.ok.ref}. Implant stock is tracked by lot: add the lot number from the label to this row and upload again.` }); continue; }
      if (item.ok.tracking === 'serial' && !serial) { hold(r, { held: 'missing_serial', message: `${item.ok.ref} is tracked by serial number, and this row has none. Add one row per serial number.` }); continue; }
      let expiry: string | null = null;
      if (r.get('expiry')) { expiry = parseDate(r.get('expiry')); if (!expiry) { hold(r, { held: 'bad_date', message: `"${r.get('expiry')}" is not a date this app can read. Use YYYY-MM-DD or MM/DD/YYYY.` }); continue; } }
      const qty = await resolveQty(db, ctx, item.ok, r.get('quantity'), r.get('uom'), r.get('units_per_package'), src(r.n));
      if ('held' in qty) { hold(r, qty); continue; }
      if (qty.ok.note) r.notes.push(qty.ok.note);
      const isSerial = item.ok.tracking === 'serial';
      if (isSerial && qty.ok.units > 1) { hold(r, { held: 'serial_qty', message: `A serialized unit can only have quantity 0 or 1; this row says ${qty.ok.units}.` }); continue; }
      r.data = { itemId: item.ok.id, ref: item.ok.ref, manufacturer: item.ok.manufacturer, lot: lot || null, serial: isSerial ? serial : null, expiry, locationId: loc.ok.id, locationName: loc.ok.name, units: qty.ok.units };
      r.key = [item.ok.id, isSerial ? `sn:${serial}` : `lot:${lot}`, loc.ok.id].join('|');
    }
  } else if (run.kind === 'schedule') {
    for (const r of list) {
      if (r.blank) continue;
      const caseRef = r.get('case_id');
      if (!caseRef) { hold(r, { held: 'missing_case_id', message: 'The case ID is blank. Fill it in and upload again.' }); continue; }
      const fac = matchName('facility', r.get('facility'), ref.facilities, ref, 'facility');
      if ('held' in fac) { hold(r, fac); continue; }
      if (fac.note) r.notes.push(fac.note);
      const date = parseDate(r.get('date'));
      const time = parseTime(r.get('time') || r.get('date'));
      if (!date) { hold(r, { held: 'bad_date', message: `"${r.get('date')}" is not a date this app can read. Use YYYY-MM-DD or MM/DD/YYYY.` }); continue; }
      if (!time) { hold(r, { held: 'bad_time', message: `No readable start time${r.get('time') ? ` ("${r.get('time')}")` : ''}. Enter the local start time at ${fac.ok.name}, for example 07:30 or 1:15 PM.` }); continue; }
      const repText = r.get('rep'); let rep: any = null;
      if (repText) { const m = ref.reps.filter((u) => norm(u.display_name) === norm(repText) || u.email.toLowerCase() === repText.toLowerCase() || norm(u.display_name).split(' ')[0] === norm(repText)); if (m.length === 1) rep = m[0]; else r.notes.push(`rep "${repText}" is not a user here; no rep assigned`); }
      const start = zoned(date, time, fac.ok.timezone);
      r.data = { caseRef, facilityId: fac.ok.id, facilityName: fac.ok.name, timezone: fac.ok.timezone, start: start.toISOString(), startLocal: fmtLocal(start, fac.ok.timezone), procedure: r.get('procedure'), surgeon: r.get('surgeon'), repId: rep?.id ?? null, cancelled: /cancel/i.test(r.get('status')), previousId: r.get('previous_id') || null };
      r.key = caseRef.toLowerCase();
    }
  } else {
    for (const r of list) {
      if (r.blank) continue;
      const caseRef = r.get('case_id');
      if (!caseRef) { hold(r, { held: 'missing_case_id', message: 'The case ID is blank. Fill it in and upload again.' }); continue; }
      const c = await maybe(db, `select id, case_ref, status from cases where lower(case_ref)=lower($1)`, [caseRef]);
      if (!c) { hold(r, { held: 'unknown_case', message: `Case ${caseRef} is not on the schedule. Load the schedule row for this case, then re-check held rows here.` }); continue; }
      if (c.status !== 'scheduled') { hold(r, { held: 'case_closed', message: `Case ${caseRef} is ${c.status}; requirements cannot be changed.` }); continue; }
      const item = await resolveItem(db, ctx, ref, { manufacturer: r.get('manufacturer'), catalog: r.get('catalog_number'), description: r.get('description'), numericCell: r.numeric('catalog_number') }, dry);
      if ('held' in item) { hold(r, item); continue; }
      if (item.note) r.notes.push(item.note);
      const qty = await resolveQty(db, ctx, item.ok, r.get('quantity'), r.get('uom'), '', src(r.n));
      if ('held' in qty) { hold(r, qty); continue; }
      if (qty.ok.units < 1) { hold(r, { held: 'bad_quantity', message: 'The required quantity must be at least 1.' }); continue; }
      r.data = { caseId: c.id, caseRef: c.case_ref, itemId: item.ok.id, ref: item.ok.ref, manufacturer: item.ok.manufacturer, units: qty.ok.units };
      r.key = `${c.id}|${item.ok.id}`;
    }
  }

  // Pass 2: duplicates inside the file. Identical repeats count once; conflicting repeats are held together.
  const byKey = new Map<string, Row[]>();
  for (const r of list) if (r.key && r.data) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  const dupSkip = new Map<number, number>();
  for (const g of byKey.values()) {
    if (g.length < 2) continue;
    const sig = (r: Row) => JSON.stringify(run.kind === 'schedule' ? [r.data.facilityId, r.data.start, r.data.cancelled] : [r.data.units]);
    if (g.every((r) => sig(r) === sig(g[0]))) g.slice(1).forEach((r) => dupSkip.set(r.n, g[0].n));
    else for (const r of g) hold(r, { held: 'conflicting_duplicate', message: `Rows ${g.map((x) => x.n).join(' and ')} describe the same ${run.kind === 'inventory' ? 'item, lot and location' : run.kind === 'schedule' ? 'case' : 'case and item'} with different values. Keep one row (or correct them) and upload again; neither was applied.` });
  }

  // Pass 3: apply.
  const opened = new Set<string>((await rows(db, `select distinct location_id from balance_observations where run_id <> $1 and role in ('opening','snapshot')
       union select distinct location_id from stock_balances`, [run.id])).map((x) => x.location_id));
  const openedByThisRun = new Set<string>((await rows(db, `select distinct location_id from balance_observations where run_id=$1 and role='opening'`, [run.id])).map((x) => x.location_id));
  const fileKeys = new Set<string>(); const unresolvedAt = { any: false };
  for (const r of list) {
    const tail = r.notes.length ? ` (${r.notes.join('; ')})` : '';
    if (r.blank) { if (active(r.n)) await put(r.n, r.raw, 'skipped', 'blank', 'Blank row.'); continue; }
    if (r.held) { if (run.kind === 'inventory') { if (r.key) fileKeys.add(r.key); else unresolvedAt.any = true; } await put(r.n, r.raw, 'held', r.held.code, r.held.message, {}, r.held.entity ?? {}); continue; }
    if (dupSkip.has(r.n)) { await put(r.n, r.raw, 'skipped', 'duplicate_row', `Same as row ${dupSkip.get(r.n)} in this file; counted once.`, r.data); if (run.kind === 'inventory') fileKeys.add(r.key!); continue; }
    const d = r.data;
    if (run.kind === 'inventory') { fileKeys.add(r.key!); if (active(r.n)) await applyInventoryRow(db, ctx, run, r.n, r.raw, d, tail, put, opened, openedByThisRun, ref.distributorId); continue; }
    if (!active(r.n)) continue;
    if (run.kind === 'schedule') {
      const ex = await maybe(db, `select * from cases where lower(case_ref)=lower($1)`, [d.caseRef]);
      // Keep the identifier the case had in the system the file came from.
      const keepId = async (caseId: string, rowId?: string) => { if (d.previousId) await db.query(`insert into external_refs(tenant_id, entity_type, entity_id, system, external_id, upload_row_id) values ($1,'case',$2,$3,$4,$5) on conflict (tenant_id, entity_type, system, external_id) do nothing`, [ctx.tenantId, caseId, run.source_system ?? 'Previous system', d.previousId, rowId ?? null]); };
      if (ex) await keepId(ex.id);
      const sys: Ctx = { ...ctx, role: 'admin' }; // authorized by upload.run; the audit trail keeps the real user
      if (!ex) {
        if (d.cancelled) { await put(r.n, r.raw, 'skipped', 'cancelled_unknown', `Case ${d.caseRef} is marked cancelled and was never loaded; nothing to do.`, d); continue; }
        const rowId = await put(r.n, r.raw, 'accepted', 'case_created', `New case ${d.caseRef} at ${d.facilityName}, ${d.startLocal}.${tail}`, d);
        const c = (await db.query(`insert into cases(tenant_id, case_ref, facility_id, procedure, surgeon_ref, scheduled_start, status, rep_user_id, created_by, created_at, upload_row_id) values ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8,$9,$10) returning id`,
          [ctx.tenantId, d.caseRef, d.facilityId, d.procedure || 'Procedure not provided', d.surgeon || 'Surgeon not provided', d.start, d.repId, ctx.userId, nowIso(), rowId])).rows[0];
        await audit(db, ctx, 'case.create', 'case', c.id, { case_ref: d.caseRef, scheduled_start: d.start, source: src(r.n) }, { caseId: c.id });
        await db.query(`update upload_rows set entity=$2 where id=$1`, [rowId, { caseId: c.id }]);
        await keepId(c.id, rowId);
      } else if (d.cancelled) {
        if (ex.status === 'cancelled') await put(r.n, r.raw, 'skipped', 'unchanged', `Case ${d.caseRef} is already cancelled.`, d, { caseId: ex.id });
        else { await cancelCase(db, sys, ex.id, { reason: `Marked cancelled in ${src(r.n)}` }); await put(r.n, r.raw, 'accepted', 'case_cancelled', `Case ${d.caseRef} cancelled; its reservations were released.`, d, { caseId: ex.id }); }
      } else if (ex.facility_id !== d.facilityId) {
        await put(r.n, r.raw, 'held', 'facility_changed', `Case ${d.caseRef} is on file at a different facility. Moving a case between facilities is not done from a spreadsheet: cancel it and load it under a new case ID, or correct the facility.`, d, { caseId: ex.id });
      } else if (new Date(ex.scheduled_start).toISOString() === d.start) {
        await put(r.n, r.raw, 'skipped', 'unchanged', `Case ${d.caseRef} is already loaded with the same time; no change.`, d, { caseId: ex.id });
      } else if (ex.status !== 'scheduled') {
        await put(r.n, r.raw, 'held', 'case_closed', `Case ${d.caseRef} is ${ex.status}; its time cannot be changed.`, d, { caseId: ex.id });
      } else {
        await moveCase(db, sys, ex.id, { scheduledStart: d.start, reason: `Schedule file ${src(r.n)}` });
        await put(r.n, r.raw, 'accepted', 'case_moved', `Case ${d.caseRef} moved from ${fmtLocal(ex.scheduled_start, d.timezone)} to ${d.startLocal}. Deadlines and owners were recalculated.${tail}`, d, { caseId: ex.id });
      }
    } else {
      const ex = await maybe(db, `select * from case_requirements where case_id=$1 and catalog_item_id=$2 and active`, [d.caseId, d.itemId]);
      if (ex && ex.qty === d.units) { await put(r.n, r.raw, 'skipped', 'unchanged', `${d.caseRef} already requires ${d.units} × ${d.ref}; no change.`, d, { caseId: d.caseId, requirementId: ex.id }); continue; }
      if (ex) {
        await updateRequirement(db, { ...ctx, role: 'admin' }, d.caseId, { requirementId: ex.id, qty: d.units, reason: `Requirements file ${src(r.n)}` });
        const rowId = await put(r.n, r.raw, 'accepted', 'requirement_changed', `${d.caseRef}: ${d.ref} changed from ${ex.qty} to ${d.units}.${tail}`, d, { caseId: d.caseId, requirementId: ex.id });
        await db.query(`update case_requirements set upload_row_id=$2 where id=$1`, [ex.id, rowId]);
      } else {
        const rowId = await put(r.n, r.raw, 'accepted', 'requirement_added', `${d.caseRef} requires ${d.units} × ${d.ref} (${d.manufacturer}).${tail}`, d);
        const q = (await db.query(`insert into case_requirements(tenant_id, case_id, catalog_item_id, qty, mandatory, upload_row_id) values ($1,$2,$3,$4,true,$5) returning id`, [ctx.tenantId, d.caseId, d.itemId, d.units, rowId])).rows[0];
        await audit(db, ctx, 'case.requirement_change', 'case_requirement', q.id, { qty: d.units, source: src(r.n) }, { caseId: d.caseId });
        await db.query(`update upload_rows set entity=$2 where id=$1`, [rowId, { caseId: d.caseId, requirementId: q.id }]);
      }
    }
  }

  // A "complete" file that omits stock the system holds at a covered location raises a question, never a zero.
  const covered = [...new Set(list.filter((r) => r.data?.locationId).map((r) => r.data.locationId as string))];
  const notes: string[] = [];
  if (run.kind === 'inventory' && !only) {
    if (run.coverage === 'complete') {
      if (!covered.some((l) => opened.has(l)) && !unresolvedAt.any) { /* first file for these locations: nothing to compare */ }
      else if (unresolvedAt.any && !opened.size) { /* opening load with held rows: nothing could be missing yet */ }
      else if (unresolvedAt.any) notes.push('Some rows could not be matched to an item or location, so stock missing from this file was not flagged. Fix the held rows first.');
      else {
        const bals = await rows(db, `select b.*, s.catalog_item_id, ci.ref, s.lot_number, s.serial_number, l.name loc_name from stock_balances b join stock_items s on s.id=b.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join locations l on l.id=b.location_id
           where b.location_id = any($1) and b.condition='sealed' and b.qty>0`, [covered.filter((l) => opened.has(l))]);
        for (const b of bals) {
          const key = [b.catalog_item_id, b.serial_number ? `sn:${b.serial_number}` : `lot:${b.lot_number}`, b.location_id].join('|');
          if (fileKeys.has(key)) continue;
          if (await newerEvidence(db, b.stock_item_id, b.location_id, run.exported_at)) continue;
          await db.query(`update stock_discrepancies set status='superseded' where stock_item_id=$1 and location_id=$2 and status='open'`, [b.stock_item_id, b.location_id]);
          await db.query(`insert into stock_discrepancies(tenant_id, ref, run_id, stock_item_id, location_id, owner_party_id, kind, ledger_qty, observed_qty, status, opened_at) values ($1,$2,$3,$4,$5,$6,'not_listed',$7,0,'open',$8)`,
            [ctx.tenantId, await nextDiscRef(db), run.id, b.stock_item_id, b.location_id, b.owner_party_id, b.qty, nowIso()]);
        }
      }
    } else notes.push('Partial export: stock that is not listed in this file was left unchanged.');
  }
  const counts = Object.fromEntries((await rows(db, `select outcome, count(*)::int n from upload_rows where run_id=$1 and reason_code is distinct from 'blank' group by 1`, [run.id])).map((x) => [x.outcome, x.n]));
  const reasons = Object.fromEntries((await rows(db, `select reason_code, count(*)::int n from upload_rows where run_id=$1 and reason_code is not null and reason_code <> 'blank' group by 1`, [run.id])).map((x) => [x.reason_code, x.n]));
  const prevSummary = only ? run.summary ?? {} : {};
  await db.query(`update upload_runs set counts=$2, covered_location_ids=$3, summary=$4 where id=$1`, [run.id, counts, only ? run.covered_location_ids : covered,
    { ...prevSummary, reasons, notes: only ? prevSummary.notes ?? [] : notes, created: only ? prevSummary.created ?? [] : dry.created }]);
}

async function nextDiscRef(db: Db) {
  const r = await one(db, `select coalesce(max(substring(ref from 6)::int), 0) n from stock_discrepancies`);
  return `DISC-${String(r.n + 1).padStart(4, '0')}`;
}

/** Anything recorded for this unit at this location AFTER the file was exported: a newer file, a count, a movement. */
export async function newerEvidence(db: Db, stockItemId: string, locationId: string, exportedAt: string | Date): Promise<{ at: string; what: string } | null> {
  const t = new Date(exportedAt).toISOString();
  const o = await maybe(db, `select o.exported_at at, f.filename from balance_observations o join upload_runs r on r.id=o.run_id join upload_files f on f.id=r.file_id
     where o.stock_item_id=$1 and o.location_id=$2 and o.role in ('opening','snapshot') and o.exported_at > $3 order by o.exported_at desc limit 1`, [stockItemId, locationId, t]);
  const c = await maybe(db, `select max(cl.counted_at) at from count_lines cl join count_sessions cs on cs.id=cl.session_id where cl.stock_item_id=$1 and cs.location_id=$2 and cl.counted_at > $3`, [stockItemId, locationId, t]);
  const m = await maybe(db, `select occurred_at at, movement_type from inventory_movements where stock_item_id=$1 and (to_location_id=$2 or from_location_id=$2) and occurred_at > $3 and movement_type <> 'opening_balance' order by occurred_at desc limit 1`, [stockItemId, locationId, t]);
  const cands = [o && { at: o.at, what: `a newer file (${o.filename})` }, c?.at && { at: c.at, what: 'a physical count' }, m && { at: m.at, what: m.movement_type === 'adjustment' ? 'a reconciliation or count adjustment' : `a recorded ${m.movement_type}` }].filter(Boolean) as any[];
  if (!cands.length) return null;
  cands.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return { at: new Date(cands[0].at).toISOString(), what: cands[0].what };
}

async function applyInventoryRow(db: Db, ctx: Ctx, run: any, n: number, raw: any, d: any, tail: string, put: Function, opened: Set<string>, openedByThisRun: Set<string>, ownerId: string) {
  let si = d.serial ? await maybe(db, `select * from stock_items where catalog_item_id=$1 and serial_number=$2`, [d.itemId, d.serial])
    : await maybe(db, `select * from stock_items where catalog_item_id=$1 and lot_number=$2 and serial_number is null`, [d.itemId, d.lot]);
  if (!si) si = (await db.query(`insert into stock_items(tenant_id, catalog_item_id, lot_number, serial_number, expiry_date, is_serial, data_source) values ($1,$2,$3,$4,$5,$6,'upload') returning *`, [ctx.tenantId, d.itemId, d.lot, d.serial, d.expiry, !!d.serial])).rows[0];
  const bal = await maybe(db, `select coalesce(sum(qty),0)::int qty, min(owner_party_id::text) owner from stock_balances where stock_item_id=$1 and location_id=$2 and condition='sealed'`, [si.id, d.locationId]);
  const L = bal?.qty ?? 0; const owner = bal?.owner ?? ownerId;
  const label = `${d.ref} ${d.serial ? 'SN ' + d.serial : 'lot ' + d.lot} at ${d.locationName}`;
  const interp = { ...d, stockItemId: si.id, systemQty: L };
  const prev = await maybe(db, `select * from balance_observations where stock_item_id=$1 and location_id=$2 and role in ('opening','snapshot') order by exported_at desc, created_at desc limit 1`, [si.id, d.locationId]);
  const obs = async (rowId: string, role: string) => (await db.query(`insert into balance_observations(tenant_id, run_id, row_id, stock_item_id, location_id, owner_party_id, observed_qty, exported_at, role, ledger_qty, previous_observation_id, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [ctx.tenantId, run.id, rowId, si.id, d.locationId, owner, d.units, run.exported_at, role, L, prev?.id ?? null, nowIso()])).rows[0].id;

  // First file for this location: opening balance.
  if (!opened.has(d.locationId) || openedByThisRun.has(d.locationId)) {
    const rowId = await put(n, raw, 'accepted', 'opening_balance', `Opening balance: ${plural(d.units, 'unit')} of ${label}.${tail}`, interp, { stockItemId: si.id, locationId: d.locationId });
    await obs(rowId, 'opening'); openedByThisRun.add(d.locationId);
    if (d.units > 0) await applyMovement(db, ctx, { stockItemId: si.id, qty: d.units, ownerPartyId: owner, to: { locationId: d.locationId, condition: 'sealed' }, type: 'opening_balance',
      reason: `Opening balance from ${run.worksheet} row ${n}`, occurredAt: new Date(run.exported_at).toISOString(), uploadRowId: rowId, idempotencyKey: `upload:${rowId}` });
    return;
  }
  // Later files are snapshots.
  if (prev && new Date(prev.exported_at).getTime() === new Date(run.exported_at).getTime() && prev.observed_qty === d.units) {
    await put(n, raw, 'skipped', 'already_observed', `Already recorded from an earlier upload with the same export time and quantity (${d.units}); nothing new.`, interp, { stockItemId: si.id, locationId: d.locationId }); return;
  }
  const newer = await newerEvidence(db, si.id, d.locationId, run.exported_at);
  if (newer) {
    const rowId = await put(n, raw, 'skipped', 'stale_file', `Not applied: this file was exported ${fmtLocal(run.exported_at, run.tz)}, before ${newer.what} on ${fmtLocal(newer.at, run.tz)}. Kept as history only; the system still shows ${L}.`, interp, { stockItemId: si.id, locationId: d.locationId });
    await obs(rowId, 'stale'); return;
  }
  const openDisc = await rows(db, `select id from stock_discrepancies where stock_item_id=$1 and location_id=$2 and status='open'`, [si.id, d.locationId]);
  for (const x of openDisc) {
    await db.query(`update stock_discrepancies set status='superseded', resolved_at=$2 where id=$1`, [x.id, nowIso()]);
    await db.query(`insert into discrepancy_decisions(tenant_id, discrepancy_id, decision, note, decided_by, decided_at) values ($1,$2,'superseded',$3,$4,$5)`, [ctx.tenantId, x.id, `Replaced by a newer file (${run.worksheet} row ${n})`, ctx.userId, nowIso()]);
  }
  const change = prev ? d.units - prev.observed_qty : null;
  const sincePrev = prev && change !== 0 ? ` The previous file said ${prev.observed_qty} (${change! > 0 ? '+' : ''}${change}).` : '';
  if (d.units === L) {
    const rowId = await put(n, raw, 'accepted', 'matches_system', `Matches the system balance (${L}) for ${label}.${sincePrev}${sincePrev ? ' Recorded movements explain the change.' : ''}${tail}`, interp, { stockItemId: si.id, locationId: d.locationId });
    await obs(rowId, 'snapshot'); return;
  }
  const dref = await nextDiscRef(db);
  const rowId = await put(n, raw, 'held', 'needs_reconciliation', `The file says ${d.units}; the system has ${L} for ${label} (difference ${d.units - L > 0 ? '+' : ''}${d.units - L}).${sincePrev} Stock was not changed. Reconcile ${dref} to accept the file's number or keep the system's.${tail}`, interp, { stockItemId: si.id, locationId: d.locationId, discrepancyRef: dref });
  const oid = await obs(rowId, 'snapshot');
  const disc = (await db.query(`insert into stock_discrepancies(tenant_id, ref, run_id, observation_id, stock_item_id, location_id, owner_party_id, kind, ledger_qty, observed_qty, previous_observed_qty, status, opened_at) values ($1,$2,$3,$4,$5,$6,$7,'quantity',$8,$9,$10,'open',$11) returning id`,
    [ctx.tenantId, dref, run.id, oid, si.id, d.locationId, owner, L, d.units, prev?.observed_qty ?? null, nowIso()])).rows[0];
  await db.query(`update upload_rows set entity = entity || $2 where id=$1`, [rowId, { discrepancyId: disc.id }]);
}

// ---------------- reading results ----------------

export async function runDetail(db: Db, ctx: Ctx, runId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(String(runId))) throw new AppError(404, 'not_found', 'Upload not found');
  const run = await maybe(db, `select r.*, f.filename, f.uploaded_at file_uploaded_at, f.size_bytes, u.display_name by_name,
      (select array_agg(l.name order by l.name) from locations l where l.id = any(r.covered_location_ids)) covered_locations
    from upload_runs r join upload_files f on f.id=r.file_id join users u on u.id=r.created_by where r.id=$1`, [runId]);
  if (!run) throw new AppError(404, 'not_found', 'Upload not found');
  const list = await rows(db, `select * from upload_rows where run_id=$1 and reason_code is distinct from 'blank' order by row_number`, [runId]);
  return { run, rows: list, headers: Object.keys(list[0]?.raw ?? {}), fields: FIELDS[run.kind as UploadKind] };
}

export async function listRuns(db: Db) {
  return rows(db, `select r.id, r.kind, r.worksheet, r.exported_at, r.created_at, r.coverage, r.counts, f.filename, u.display_name by_name,
      (select array_agg(l.name order by l.name) from locations l where l.id = any(r.covered_location_ids)) covered_locations
    from upload_runs r join upload_files f on f.id=r.file_id join users u on u.id=r.created_by order by r.created_at desc limit 100`);
}

// ---------------- fixes a coordinator can make without touching the file ----------------

export async function saveAlias(db: Db, ctx: Ctx, input: { kind: 'facility' | 'location' | 'manufacturer'; aliasText: string; targetId: string }) {
  requirePerm(ctx, 'upload.run');
  const text = String(input.aliasText ?? '').trim();
  if (!text) throw new AppError(400, 'bad_alias', 'Nothing to remember');
  let target = input.targetId;
  if (input.kind === 'manufacturer' && target === 'new') {
    target = (await db.query(`insert into parties(tenant_id, name, kind, source_system) values ($1,$2,'manufacturer','upload') on conflict (tenant_id, name) do update set name=excluded.name returning id`, [ctx.tenantId, text])).rows[0].id;
  } else {
    const ok = input.kind === 'facility' ? await maybe(db, `select id from facilities where id=$1`, [target]) : input.kind === 'location' ? await maybe(db, `select id from locations where id=$1`, [target]) : await maybe(db, `select id from parties where id=$1 and kind='manufacturer'`, [target]);
    if (!ok) throw new AppError(404, 'not_found', 'That choice no longer exists');
  }
  await db.query(`insert into name_aliases(tenant_id, kind, alias_norm, alias_text, target_id, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_id, kind, alias_norm) do update set target_id=excluded.target_id, created_by=excluded.created_by, created_at=excluded.created_at`, [ctx.tenantId, input.kind, norm(text), text, target, ctx.userId, nowIso()]);
  await audit(db, ctx, 'upload.alias', 'name_alias', null, { kind: input.kind, alias: text, target });
  return { ok: true };
}

export async function verifyConversion(db: Db, ctx: Ctx, id: string, input: { unitsPer: number }) {
  requirePerm(ctx, 'upload.run');
  const n = Number(input.unitsPer);
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw new AppError(400, 'bad_units', 'Enter how many single units one package holds (a whole number)');
  const c = await maybe(db, `select * from uom_conversions where id=$1`, [id]);
  if (!c) throw new AppError(404, 'not_found', 'Conversion not found');
  await db.query(`update uom_conversions set units_per=$2, verified_by=$3, verified_at=$4 where id=$1`, [id, n, ctx.userId, nowIso()]);
  await audit(db, ctx, 'upload.conversion_verified', 'uom_conversion', id, { units_per: n, uom: c.uom_norm, catalog_item_id: c.catalog_item_id });
  return { ok: true };
}

export async function listConversions(db: Db) {
  return rows(db, `select c.*, ci.ref, ci.description, p.name manufacturer, u.display_name verified_by_name from uom_conversions c join catalog_items ci on ci.id=c.catalog_item_id left join parties p on p.id=ci.manufacturer_party_id left join users u on u.id=c.verified_by order by ci.ref`);
}
