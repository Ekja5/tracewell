/**
 * Synthetic example files a coordinator can download, look at, edit and upload. Dates are relative
 * to the day they are generated, so "tomorrow's cases" is always tomorrow. All names are fictional.
 */
import ExcelJS from 'exceljs';
import { addDaysYmd, localYmd } from '../time.js';
import { now } from '../clock.js';

export const MFR = 'Corvid Orthopaedics (synthetic)';
const INV_HEAD = ['Stock Location', 'Mfr', 'Cat No', 'Item Description', 'Lot', 'Exp Date', 'Qty On Hand', 'UOM', 'Units per Box'];
const SCHED_HEAD = ['Case ID', 'Hospital', 'Surgery Date', 'Start Time', 'Procedure', 'Surgeon', 'Rep'];
const REQ_HEAD = ['Case ID', 'Mfr', 'Cat No', 'Item Description', 'Qty Required', 'UOM'];
const ITEMS = { insert: ['00417', 'Tibial insert, size 4, 10 mm'], femoral: ['00233', 'Femoral component, size 4, left'], screw: ['08810', 'Bone screw, 6.5 mm'], patella: ['00550', 'Patella button, 32 mm'] } as const;

function data(tz = 'America/Chicago') {
  const today = localYmd(now(), tz); const d = (n: number) => addDaysYmd(today, n);
  const us = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;
  const exp = us(d(420));
  const inventory = [
    ['Main Warehouse', MFR, ITEMS.insert[0], ITEMS.insert[1], 'T10A', exp, '5', 'EA', ''],
    ['Main Warehouse', MFR, ITEMS.femoral[0], ITEMS.femoral[1], 'F4L1', exp, '3', 'EA', ''],
    ['Main Warehouse', MFR, ITEMS.screw[0], ITEMS.screw[1], 'S65B', exp, '2', 'BX', '5'],
    ['Main Warehouse', MFR, ITEMS.patella[0], ITEMS.patella[1], '', exp, '1', 'EA', ''],
    ['Main Warehouse', MFR, ITEMS.femoral[0], ITEMS.femoral[1], 'F4L1', exp, '3', 'EA', ''],
  ];
  const schedule = [
    ['SC-24031', 'Ridgeline Medical Center', us(d(1)), '7:30 AM', 'Total knee arthroplasty, primary', 'Surgeon S-104', 'Dana Whitfield'],
    ['SC-24032', 'Ridgeline Surgery Center East', us(d(1)), '10:00 AM', 'Total knee arthroplasty, primary', 'Surgeon S-221', 'Dana Whitfield'],
    ['SC-24033', 'Ridgeline Medical Center', us(d(1)), '1:00 PM', 'Total knee arthroplasty, revision', 'Surgeon S-104', 'Dana Whitfield'],
    ['SC-24040', 'Ridgeline Medical Center', us(d(3)), '8:00 AM', 'Total knee arthroplasty, primary', 'Surgeon S-118', 'Dana Whitfield'],
    ['SC-24041', 'Ridgeline Surgery Center East', us(d(4)), '9:00 AM', 'Total knee arthroplasty, primary', 'Surgeon S-221', 'Dana Whitfield'],
    ['SC-24050', 'Ridgeline', us(d(5)), '9:00 AM', 'Total knee arthroplasty, primary', 'Surgeon S-118', 'Dana Whitfield'],
  ];
  const requirements = [
    ['SC-24031', MFR, ITEMS.insert[0], ITEMS.insert[1], '2', 'EA'],
    ['SC-24032', MFR, ITEMS.femoral[0], ITEMS.femoral[1], '1', 'EA'],
    ['SC-24033', MFR, ITEMS.femoral[0], ITEMS.femoral[1], '1', 'EA'],
    ['SC-24040', MFR, ITEMS.insert[0], ITEMS.insert[1], '2', 'EA'],
    ['SC-24041', MFR, ITEMS.insert[0], ITEMS.insert[1], '2', 'EA'],
    ['SC-24050', MFR, ITEMS.femoral[0], ITEMS.femoral[1], '1', 'EA'],
  ];
  return { inventory, schedule, requirements, exp };
}

function addSheet(wb: ExcelJS.Workbook, name: string, head: string[], body: string[][], widths: number[]) {
  const ws = wb.addWorksheet(name);
  ws.addRow(head).font = { bold: true };
  for (const r of body) { const row = ws.addRow(r); row.eachCell((c) => { c.numFmt = '@'; }); } // text cells: leading zeros survive
  ws.columns.forEach((c, i) => { c.width = widths[i] ?? 16; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

/** Day-1 workbook: three worksheets plus a few deliberately untidy rows a real file would have. */
export async function day1Workbook(): Promise<Buffer> {
  const d = data(); const wb = new ExcelJS.Workbook(); wb.created = now(); wb.modified = now(); // stamped with the app clock, so a sample is never "older" than the demo it is loaded into
  const info = wb.addWorksheet('Read me');
  ['Synthetic example for the Tracewell pilot. No real hospitals, people or products.', '', 'Inventory: warehouse balances as of this morning.', 'Schedule: cases for the next few days, in each hospital\'s local time.', 'Requirements: the exact items each case needs.', '',
    'This file is untidy on purpose: one row has no lot number, one row is repeated, one quantity is in boxes, and one hospital name is ambiguous.'].forEach((t) => info.addRow([t]));
  info.getColumn(1).width = 110;
  addSheet(wb, 'Inventory', INV_HEAD, d.inventory, [18, 30, 10, 34, 10, 12, 12, 8, 14]);
  addSheet(wb, 'Schedule', SCHED_HEAD, d.schedule, [12, 30, 14, 12, 34, 16, 18]);
  addSheet(wb, 'Requirements', REQ_HEAD, d.requirements, [12, 30, 10, 34, 12, 8]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Day-2 workbook: a later warehouse snapshot. The buyer picks the tibial-insert quantity. */
export async function day2Workbook(insertQty = 6): Promise<Buffer> {
  const d = data(); const wb = new ExcelJS.Workbook(); wb.created = now(); wb.modified = now(); // stamped with the app clock, so a sample is never "older" than the demo it is loaded into
  addSheet(wb, 'Inventory', INV_HEAD, [
    ['Main Warehouse', MFR, ITEMS.insert[0], ITEMS.insert[1], 'T10A', d.exp, String(insertQty), 'EA', ''],
    ['Main Warehouse', MFR, ITEMS.femoral[0], ITEMS.femoral[1], 'F4L1', d.exp, '1', 'EA', ''],
    ['Main Warehouse', MFR, ITEMS.screw[0], ITEMS.screw[1], 'S65B', d.exp, '2', 'BX', '5'],
  ], [18, 30, 10, 34, 10, 12, 12, 8, 14]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const csv = (head: string[], body: string[][]) => [head, ...body].map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n';

export const SAMPLES: { name: string; label: string; description: string }[] = [
  { name: 'summit-day1.xlsx', label: 'Day 1 workbook (Excel)', description: 'Three worksheets: Inventory, Schedule, Requirements. Includes a few untidy rows.' },
  { name: 'summit-day2-inventory.xlsx', label: 'Day 2 inventory snapshot (Excel)', description: 'A later warehouse export. Change the tibial insert quantity (cell G2) before uploading, or add ?qty=7 to the link.' },
  { name: 'inventory-balances.csv', label: 'Inventory balances (CSV)', description: 'Same columns as the Inventory worksheet.' },
  { name: 'case-schedule.csv', label: 'Case schedule (CSV)', description: 'Same columns as the Schedule worksheet.' },
  { name: 'case-requirements.csv', label: 'Case requirements (CSV)', description: 'Same columns as the Requirements worksheet.' },
];

export async function sampleFile(name: string, qty?: number): Promise<{ body: Buffer; type: string } | null> {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; const d = data();
  if (name === 'summit-day1.xlsx') return { body: await day1Workbook(), type: XLSX };
  if (name === 'summit-day2-inventory.xlsx') return { body: await day2Workbook(Number.isInteger(qty) && qty! >= 0 && qty! < 1000 ? qty : 6), type: XLSX };
  if (name === 'inventory-balances.csv') return { body: Buffer.from(csv(INV_HEAD, d.inventory)), type: 'text/csv' };
  if (name === 'case-schedule.csv') return { body: Buffer.from(csv(SCHED_HEAD, d.schedule)), type: 'text/csv' };
  if (name === 'case-requirements.csv') return { body: Buffer.from(csv(REQ_HEAD, d.requirements)), type: 'text/csv' };
  return null;
}
