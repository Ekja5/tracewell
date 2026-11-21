/**
 * GS1 element-string parser for UDI labels (GS1 DataMatrix / GS1-128 content).
 *
 * Supports: symbology identifiers (]d2, ]C1, ]Q3, ]e0), ASCII 29 group separators (FNC1),
 * keyboard-wedge placeholders "<GS>" / "{GS}", and human-readable "(01)...(17)..." text.
 * Validates GTIN check digits and YYMMDD dates (DD=00 means last day of month).
 *
 * Unsupported formats (HIBCC "+...", ISBT 128 "=...", anything not GS1) are DETECTED and
 * returned with ok=false so callers route them to reviewed manual entry. This module never
 * guesses a lot, serial, or package quantity.
 *
 * AI definitions follow the GS1 General Specifications AI table for the subset used on
 * medical device labels. Tests: tests/integration/gs1.test.ts (published-style examples and a
 * differential check against the open-source gs1-barcode-parser-mod library).
 */

export type ScanFormat = 'GS1' | 'HIBCC' | 'ISBT128' | 'UNKNOWN' | 'EMPTY';

export interface ParsedScan {
  raw: string;
  format: ScanFormat;
  ok: boolean;
  gtin?: string;
  lot?: string;
  serial?: string;
  expiry?: string; // YYYY-MM-DD
  productionDate?: string;
  count?: number; // AI 30 / 37 (variable count) as printed; never converted to units
  elements: { ai: string; value: string }[];
  errors: string[];
}

const GS = String.fromCharCode(29);

// [fixed length of data] or [-maxLen] for variable-length.
const AI_TABLE: Record<string, { len: number; variable: boolean; title: string }> = {
  '00': { len: 18, variable: false, title: 'SSCC' },
  '01': { len: 14, variable: false, title: 'GTIN' },
  '02': { len: 14, variable: false, title: 'CONTENT' },
  '10': { len: 20, variable: true, title: 'BATCH/LOT' },
  '11': { len: 6, variable: false, title: 'PROD DATE' },
  '12': { len: 6, variable: false, title: 'DUE DATE' },
  '13': { len: 6, variable: false, title: 'PACK DATE' },
  '15': { len: 6, variable: false, title: 'BEST BEFORE' },
  '16': { len: 6, variable: false, title: 'SELL BY' },
  '17': { len: 6, variable: false, title: 'USE BY / EXPIRY' },
  '20': { len: 2, variable: false, title: 'VARIANT' },
  '21': { len: 20, variable: true, title: 'SERIAL' },
  '22': { len: 20, variable: true, title: 'CPV' },
  '240': { len: 30, variable: true, title: 'ADDITIONAL ID' },
  '241': { len: 30, variable: true, title: 'CUST. PART NO.' },
  '250': { len: 30, variable: true, title: 'SECONDARY SERIAL' },
  '30': { len: 8, variable: true, title: 'VAR. COUNT' },
  '37': { len: 8, variable: true, title: 'COUNT' },
  '400': { len: 30, variable: true, title: 'ORDER NUMBER' },
  '7003': { len: 10, variable: false, title: 'EXPIRY TIME' },
  '8020': { len: 25, variable: true, title: 'REF NO.' },
};

function lookupAi(s: string, i: number): string | null {
  for (const n of [2, 3, 4]) {
    const ai = s.slice(i, i + n);
    if (AI_TABLE[ai]) return ai;
  }
  return null;
}

export function gtinCheckDigitValid(gtin: string): boolean {
  if (!/^\d{14}$/.test(gtin)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(gtin[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(gtin[13]);
}

/** Compute the GS1 check digit for a 13-digit body (used by seed/test fixtures). */
export function gtinWithCheckDigit(body13: string): string {
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(body13[i]) * (i % 2 === 0 ? 3 : 1);
  return body13 + ((10 - (sum % 10)) % 10);
}

/** GS1 YYMMDD -> YYYY-MM-DD using the GS1 General Specifications century rule. */
export function gs1Date(yymmdd: string, referenceYear = new Date().getUTCFullYear()): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2)), mm = Number(yymmdd.slice(2, 4)), dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  const refYY = referenceYear % 100, century = referenceYear - refYY;
  const diff = yy - refYY;
  let year = century + yy;
  if (diff >= 51) year -= 100; else if (diff <= -50) year += 100;
  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  const day = dd === 0 ? lastDay : dd;
  if (day > lastDay) return null;
  return `${year}-${String(mm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function detectFormat(raw: string): ScanFormat {
  const s = normalizeSeparators(raw).replace(/^\](d2|C1|Q3|e0|d1)/, '').replace(new RegExp('^' + GS), '');
  if (!s.trim()) return 'EMPTY';
  if (s.startsWith('+') || /^\]d1\+/.test(raw)) return 'HIBCC';
  if (s.startsWith('=') || s.startsWith('&')) return 'ISBT128';
  if (s.startsWith('(') && /^\(\d{2,4}\)/.test(s)) return 'GS1';
  if (/^\]d2|^\]C1|^\]Q3|^\]e0/.test(raw)) return 'GS1';
  if (/^(01|02|00)\d{14}/.test(s)) return 'GS1';
  return 'UNKNOWN';
}

function normalizeSeparators(raw: string): string {
  return raw.replace(/\r|\n/g, '').replace(/<GS>|\{GS\}|\\x1d|\\u001d/gi, GS);
}

export function parseScan(raw: string, opts: { referenceYear?: number } = {}): ParsedScan {
  const out: ParsedScan = { raw, format: detectFormat(raw), ok: false, elements: [], errors: [] };
  if (out.format === 'EMPTY') { out.errors.push('Empty scan'); return out; }
  if (out.format === 'HIBCC') { out.errors.push('HIBCC label detected. No verified HIBCC parser is installed; use reviewed manual entry.'); return out; }
  if (out.format === 'ISBT128') { out.errors.push('ISBT 128 label detected; not supported for orthopedic devices here. Use reviewed manual entry.'); return out; }
  if (out.format === 'UNKNOWN') { out.errors.push('Unrecognized barcode content (not a GS1 element string). Use reviewed manual entry.'); return out; }

  let s = normalizeSeparators(raw).replace(/^\](d2|C1|Q3|e0)/, '');
  if (s.startsWith('(')) {
    // Human-readable interpretation: (AI)value(AI)value
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m: RegExpExecArray | null; let consumed = 0;
    while ((m = re.exec(s))) {
      consumed += m[0].length;
      const def = AI_TABLE[m[1]];
      if (!def) { out.errors.push(`Unsupported AI (${m[1]})`); continue; }
      out.elements.push({ ai: m[1], value: m[2].replace(new RegExp(GS, 'g'), '') });
    }
    if (consumed !== s.length) out.errors.push('Malformed human-readable element string');
  } else {
    s = s.replace(new RegExp('^' + GS + '+'), '');
    let i = 0;
    while (i < s.length) {
      if (s[i] === GS) { i++; continue; }
      const ai = lookupAi(s, i);
      if (!ai) { out.errors.push(`Unsupported or invalid AI at position ${i}: "${s.slice(i, i + 4)}"`); break; }
      const def = AI_TABLE[ai];
      i += ai.length;
      let value: string;
      if (def.variable) {
        const end = s.indexOf(GS, i);
        value = end === -1 ? s.slice(i) : s.slice(i, end);
        i = end === -1 ? s.length : end + 1;
        if (value.length > def.len) { out.errors.push(`AI (${ai}) exceeds ${def.len} characters; a group separator may be missing`); }
      } else {
        value = s.slice(i, i + def.len);
        if (value.length !== def.len) out.errors.push(`AI (${ai}) requires ${def.len} characters`);
        i += def.len;
      }
      out.elements.push({ ai, value });
    }
  }

  const refYear = opts.referenceYear;
  for (const { ai, value } of out.elements) {
    switch (ai) {
      case '01':
        if (!gtinCheckDigitValid(value)) out.errors.push(`GTIN ${value} has an invalid check digit`); else out.gtin = value; break;
      case '10':
        if (!/^[\x21-\x22\x25-\x2F\x30-\x39\x3A-\x3F\x41-\x5A\x5F\x61-\x7A]{1,20}$/.test(value)) out.errors.push('Lot contains characters outside GS1 character set 82'); else out.lot = value; break;
      case '21':
        if (!/^[\x21-\x22\x25-\x2F\x30-\x39\x3A-\x3F\x41-\x5A\x5F\x61-\x7A]{1,20}$/.test(value)) out.errors.push('Serial contains characters outside GS1 character set 82'); else out.serial = value; break;
      case '17': { const d = gs1Date(value, refYear); if (!d) out.errors.push(`Invalid expiry date ${value}`); else out.expiry = d; break; }
      case '11': { const d = gs1Date(value, refYear); if (!d) out.errors.push(`Invalid production date ${value}`); else out.productionDate = d; break; }
      case '30': case '37':
        if (!/^\d{1,8}$/.test(value)) out.errors.push(`Invalid count in AI (${ai})`); else out.count = Number(value); break;
    }
  }
  if (!out.gtin && out.errors.length === 0) out.errors.push('No GTIN (01) present; device identifier is required');
  out.ok = out.errors.length === 0;
  return out;
}

/** Build a raw GS1 element string with ASCII 29 separators (for fixtures and the scan simulator). */
export function buildGs1(parts: { gtin: string; expiry?: string; lot?: string; serial?: string }, opts: { symbologyId?: boolean; sep?: string } = {}): string {
  const sep = opts.sep ?? GS;
  let s = (opts.symbologyId ? ']d2' : '') + '01' + parts.gtin;
  if (parts.expiry) s += '17' + parts.expiry.slice(2, 4) + parts.expiry.slice(5, 7) + parts.expiry.slice(8, 10);
  const vars: string[] = [];
  if (parts.lot) vars.push('10' + parts.lot);
  if (parts.serial) vars.push('21' + parts.serial);
  return s + vars.join(sep);
}
