/**
 * Reads the files a coordinator already has: .xlsx workbooks and .csv exports.
 * Every cell is returned as TEXT exactly as a person would read it, because catalog numbers such as
 * "00417" are identifiers, not numbers. Where Excel stored a value as a number we record that fact so
 * the preview can warn that leading zeros may have been lost before the file ever reached us.
 */
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { AppError } from '../db.js';

export interface Sheet { name: string; rows: string[][]; numeric: Set<string>; firstRowNumber: number }
export interface ParsedFile { sheets: Sheet[]; modifiedAt: string | null }

const pad2 = (n: number) => String(n).padStart(2, '0');

function cellText(cell: ExcelJS.Cell): { text: string; numeric: boolean } {
  let v: any = cell.value;
  if (v == null) return { text: '', numeric: false };
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result ?? '';                                   // formula: use the computed value
    else if ('richText' in v) v = v.richText.map((r: any) => r.text).join('');
    else if ('text' in v) v = v.text;                                         // hyperlink
    else if ('error' in v) return { text: '', numeric: false };
  }
  if (v instanceof Date) {
    // Excel has no time zone: a date/time cell is a wall-clock value. ExcelJS exposes it as UTC.
    const y = v.getUTCFullYear(), hasTime = v.getUTCHours() + v.getUTCMinutes() + v.getUTCSeconds() > 0;
    const time = `${pad2(v.getUTCHours())}:${pad2(v.getUTCMinutes())}`;
    if (y <= 1900) return { text: time, numeric: false };                     // time-only cell
    const date = `${y}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`;
    return { text: hasTime ? `${date} ${time}` : date, numeric: false };
  }
  if (typeof v === 'number') {
    // A "00000" number format is how Excel shows leading zeros on a numeric cell: honor it.
    const fmt = cell.numFmt ?? '';
    if (/^0+$/.test(fmt) && Number.isInteger(v)) return { text: String(v).padStart(fmt.length, '0'), numeric: true };
    return { text: Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6))), numeric: true };
  }
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', numeric: false };
  return { text: String(v).trim(), numeric: false };
}

export async function parseFile(filename: string, buf: Buffer): Promise<ParsedFile> {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') {
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let rows: string[][];
    try { rows = parseCsv(text, { relax_column_count: true, skip_empty_lines: false, bom: true }) as string[][]; }
    catch (e: any) { throw new AppError(400, 'bad_csv', `This CSV could not be read: ${e.message}. Export it again as "CSV (comma delimited)".`); }
    return { sheets: [{ name: 'CSV', rows: rows.map((r) => r.map((c) => String(c ?? '').trim())), numeric: new Set(), firstRowNumber: 1 }], modifiedAt: null };
  }
  if (ext === 'xls') throw new AppError(400, 'old_excel', 'This is an older Excel format (.xls). Open it in Excel and use Save As > Excel Workbook (.xlsx), or export CSV.');
  if (ext !== 'xlsx' && ext !== 'xlsm') throw new AppError(400, 'bad_type', 'Upload an Excel workbook (.xlsx) or a CSV file.');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { throw new AppError(400, 'bad_xlsx', 'This workbook could not be opened. If it is password-protected, remove the password and try again.'); }
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const rows: string[][] = []; const numeric = new Set<string>();
    const last = ws.actualRowCount ? ws.rowCount : 0;
    for (let r = 1; r <= last; r++) {
      const row = ws.getRow(r); const out: string[] = [];
      for (let c = 1; c <= ws.actualColumnCount; c++) {
        const { text, numeric: n } = cellText(row.getCell(c));
        out.push(text); if (n) numeric.add(`${r}:${c - 1}`);
      }
      rows.push(out);
    }
    sheets.push({ name: ws.name, rows, numeric, firstRowNumber: 1 });
  });
  if (!sheets.length) throw new AppError(400, 'empty_workbook', 'This workbook has no visible worksheets.');
  const m = wb.modified instanceof Date && !isNaN(wb.modified.getTime()) ? wb.modified.toISOString() : null;
  return { sheets, modifiedAt: m };
}

/** First row that looks like column headings (two or more filled cells). 1-based, as shown in Excel. */
export function guessHeaderRow(sheet: Sheet): number {
  for (let i = 0; i < Math.min(sheet.rows.length, 15); i++) if (sheet.rows[i].filter((c) => c !== '').length >= 2) return i + 1;
  return 1;
}

export const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function headerSignature(headers: string[]) { return headers.map(normHeader).filter(Boolean).join('|'); }

/** Dates as people type them. Returns YYYY-MM-DD or null. Day-first is not guessed: 03/04 is March 4 (US). */
export function parseDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) return valid(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  return null;
}
function valid(y: number, mo: number, d: number) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
}
/** "7:30 AM", "07:30", "0730", "13:00", "2026-11-22 07:30" -> HH:MM (24 h) or null. */
export function parseTime(s: string): string | null {
  const t = s.trim().toLowerCase().replace(/^\d{4}-\d{2}-\d{2}[ t]/, '');
  let m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?$/);
  if (!m) { const c = t.match(/^(\d{2})(\d{2})$/); if (c) m = [t, c[1], c[2], undefined] as any; }
  if (!m) { const h = t.match(/^(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)$/); if (h) m = [t, h[1], '00', h[2]] as any; }
  if (!m) return null;
  let hh = +m[1]; const mm = +m[2];
  if (m[3]) { if (hh < 1 || hh > 12) return null; hh = (hh % 12) + (m[3].startsWith('p') ? 12 : 0); }
  if (hh > 23 || mm > 59) return null;
  return `${pad2(hh)}:${pad2(mm)}`;
}
