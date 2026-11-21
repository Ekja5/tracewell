import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { buildGs1, gs1Date, gtinCheckDigitValid, gtinWithCheckDigit, parseScan, detectFormat } from '../../src/shared/gs1.js';

const require = createRequire(import.meta.url);
const GS = String.fromCharCode(29);

describe('GS1 element string parser', () => {
  it('validates GTIN-14 check digits (GS1 example GTINs used in GS1 publications)', () => {
    // 09506000134352 appears throughout GS1 Digital Link documentation as the example GTIN.
    expect(gtinCheckDigitValid('09506000134352')).toBe(true);
    expect(gtinCheckDigitValid('09506000134353')).toBe(false);
    expect(gtinWithCheckDigit('0950600013435')).toBe('09506000134352');
  });

  it('parses the human-readable form with GTIN, expiry, lot and serial', () => {
    const p = parseScan('(01)09506000134352(17)271231(10)ABC123(21)SN-0001', { referenceYear: 2026 });
    expect(p.ok).toBe(true);
    expect(p).toMatchObject({ format: 'GS1', gtin: '09506000134352', expiry: '2027-12-31', lot: 'ABC123', serial: 'SN-0001' });
  });

  it('parses raw DataMatrix content with ]d2 symbology id and GS separators, preserving the raw string', () => {
    const raw = `]d2010950600013435217271231${'10'}ABC123${GS}21XYZ9`;
    const p = parseScan(raw, { referenceYear: 2026 });
    expect(p.ok).toBe(true);
    expect(p.raw).toBe(raw);
    expect(p.lot).toBe('ABC123'); expect(p.serial).toBe('XYZ9');
  });

  it('accepts keyboard-wedge placeholders for the group separator', () => {
    const p = parseScan('010950600013435210LOT7<GS>21S1', { referenceYear: 2026 });
    expect(p).toMatchObject({ ok: true, lot: 'LOT7', serial: 'S1' });
  });

  it('applies GS1 rules for day 00 (last day of month) and the century window', () => {
    expect(gs1Date('280200', 2026)).toBe('2028-02-29');
    expect(gs1Date('991231', 2026)).toBe('1999-12-31');
    expect(gs1Date('761231', 2026)).toBe('2076-12-31');
    expect(gs1Date('261332', 2026)).toBeNull();
  });

  it('rejects bad check digits and never returns a partial identity', () => {
    const p = parseScan(']d2010950600013435317271231' + '10ABC', { referenceYear: 2026 });
    expect(p.ok).toBe(false);
    expect(p.gtin).toBeUndefined();
    expect(p.errors.join(' ')).toMatch(/check digit/);
  });

  it('detects HIBCC and other non-GS1 formats and routes them to reviewed manual entry', () => {
    for (const s of ['+H629NPINS4101/$$3271231L26C014Y', '=A9999', 'hello world']) {
      const p = parseScan(s);
      expect(p.ok).toBe(false);
      expect(p.lot).toBeUndefined(); expect(p.serial).toBeUndefined();
    }
    expect(detectFormat('+H629NPINS4101/$$3271231L26C014Y')).toBe('HIBCC');
    expect(parseScan('+H629NPINS4101').errors[0]).toMatch(/HIBCC/);
  });

  it('reports a count AI without converting it into units', () => {
    const p = parseScan('(01)09506000134352(30)5(10)L1', { referenceYear: 2026 });
    expect(p.count).toBe(5);
    expect(p.ok).toBe(true);
  });

  it('round-trips labels produced by buildGs1 (used by the scan simulator)', () => {
    const g = gtinWithCheckDigit('0061414100101');
    const raw = buildGs1({ gtin: g, expiry: '2027-06-30', lot: 'L26C014', serial: 'INS-0002' }, { symbologyId: true });
    expect(parseScan(raw, { referenceYear: 2026 })).toMatchObject({ ok: true, gtin: g, expiry: '2027-06-30', lot: 'L26C014', serial: 'INS-0002' });
  });

  it('agrees with an independent open-source parser (gs1-barcode-parser-mod) on GTIN, lot, serial and expiry', () => {
    const lib = require('gs1-barcode-parser-mod');
    const parse = lib.parseBarcode ?? lib.default?.parseBarcode;
    const samples = [
      `010950600013435217271231${'10'}ABC123${GS}21XYZ9`,
      `]d201${gtinWithCheckDigit('0061414100101')}17280115${'10'}L26C014${GS}21INS-0002`,
      `0109506000134352${'10'}BATCH-77`,
    ];
    for (const s of samples) {
      const ours = parseScan(s, { referenceYear: 2026 });
      const theirs = parse(s);
      const get = (ai: string) => theirs.parsedCodeItems.find((x: any) => x.ai === ai)?.data;
      expect(ours.gtin).toBe(get('01'));
      expect(ours.lot).toBe(get('10'));
      expect(ours.serial).toBe(get('21'));
      const exp = get('17');
      if (exp) expect(ours.expiry).toBe(`${exp.getFullYear()}-${String(exp.getMonth() + 1).padStart(2, '0')}-${String(exp.getDate()).padStart(2, '0')}`);
    }
  });
});
