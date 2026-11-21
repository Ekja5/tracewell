/** Time-zone helpers. All deadlines are computed in the facility's own time zone. */
export function zoned(dateYmd: string, hhmm: string, tz: string): Date {
  const [y, m, d] = dateYmd.split('-').map(Number); const [hh, mm] = hhmm.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz);
    guess += Date.UTC(y, m - 1, d, hh, mm) - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  }
  return new Date(guess);
}
export function localParts(d: Date, tz: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh: Number(parts.hour) % 24, mm: Number(parts.minute) };
}
export function localYmd(d: Date, tz: string) { const p = localParts(d, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
export function addDaysYmd(ymd: string, n: number) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const hm = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export function fmtClock(t: string) { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }

/**
 * Latest moment at or before `due` when the facility's receiving desk is open.
 * If `due` falls outside receiving hours, the deadline moves back to the most recent closing time.
 */
export function receivingDeadline(due: Date, tz: string, open?: string | null, close?: string | null): { at: Date; clipped: boolean } {
  if (!open || !close) return { at: due, clipped: false };
  const p = localParts(due, tz);
  const mins = p.hh * 60 + p.mm;
  if (mins >= hm(open) && mins <= hm(close)) return { at: due, clipped: false };
  const ymd = localYmd(due, tz);
  const closeDay = mins > hm(close) ? ymd : addDaysYmd(ymd, -1);
  return { at: zoned(closeDay, close.slice(0, 5), tz), clipped: true };
}

/** Earliest moment at or after `arrival` when the receiving desk is open. */
export function nextReceivingOpen(arrival: Date, tz: string, open?: string | null, close?: string | null): Date {
  if (!open || !close) return arrival;
  const p = localParts(arrival, tz);
  const mins = p.hh * 60 + p.mm;
  if (mins >= hm(open) && mins <= hm(close)) return arrival;
  const ymd = localYmd(arrival, tz);
  const day = mins < hm(open) ? ymd : addDaysYmd(ymd, 1);
  return zoned(day, open.slice(0, 5), tz);
}
