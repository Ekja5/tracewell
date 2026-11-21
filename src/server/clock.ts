import { q } from './db.js';

/**
 * Application clock. In demo mode the seed pins "now" to a fixed demo anchor and the clock then
 * advances in real time: appNow = realNow + offset. Every record stores both occurred_at (what the
 * actor reports) and recorded_at (server receipt, app clock), plus db_created_at (database wall clock).
 */
let offsetMs = 0;
let loadedAt = 0;
export async function refreshClock(force = false) {
  if (!force && Date.now() - loadedAt < 2000) return;
  const r = await q<{ value: any }>(`select value from system_settings where key='clock_offset_ms'`);
  offsetMs = r[0] ? Number(r[0].value) : 0;
  loadedAt = Date.now();
}
export function now(): Date { return new Date(Date.now() + offsetMs); }
export function nowIso(): string { return now().toISOString(); }
export async function setClock(target: Date) {
  const off = target.getTime() - Date.now();
  await q(`insert into system_settings(key,value) values('clock_offset_ms',$1) on conflict(key) do update set value=excluded.value`, [JSON.stringify(off)]);
  offsetMs = off; loadedAt = Date.now();
}
