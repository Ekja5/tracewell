/** Per-account operating settings: planning window, allocation rule and the outside loaner source. */
import { AppError, Db, maybe } from '../db.js';
import { Ctx, requirePerm } from '../perms.js';
import { nowIso } from '../clock.js';
import { audit } from '../audit.js';

export interface OpsSettings {
  planningWindowHours: number; allocationRule: 'first_entered' | 'earliest_surgery';
  loanerSourceName: string | null; loanerTransitHours: number; loanerCutoffLocal: string; loanerTimezone: string; loanerReturnDays: number; expiryWarningDays: number;
}
export const RULE_LABEL: Record<string, string> = { first_entered: 'First case entered is served first', earliest_surgery: 'Earliest surgery is served first' };
const DEFAULTS: OpsSettings = { planningWindowHours: 72, allocationRule: 'first_entered', loanerSourceName: null, loanerTransitHours: 24, loanerCutoffLocal: '15:00', loanerTimezone: 'America/New_York', loanerReturnDays: 3, expiryWarningDays: 60 };

export async function getSettings(db: Db): Promise<OpsSettings> {
  const r = await maybe(db, `select * from ops_settings limit 1`);
  if (!r) return { ...DEFAULTS };
  return { planningWindowHours: r.planning_window_hours, allocationRule: r.allocation_rule, loanerSourceName: r.loaner_source_name, loanerTransitHours: r.loaner_transit_hours,
    loanerCutoffLocal: String(r.loaner_cutoff_local).slice(0, 5), loanerTimezone: r.loaner_timezone, loanerReturnDays: r.loaner_return_days, expiryWarningDays: r.expiry_warning_days };
}

export async function updateSettings(db: Db, ctx: Ctx, input: Partial<OpsSettings>) {
  requirePerm(ctx, 'settings.manage');
  const s = { ...(await getSettings(db)), ...input };
  const int = (v: any, lo: number, hi: number, what: string) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new AppError(400, 'bad_setting', `${what} must be a whole number from ${lo} to ${hi}`); return n; };
  if (!['first_entered', 'earliest_surgery'].includes(s.allocationRule)) throw new AppError(400, 'bad_setting', 'Choose an allocation rule');
  if (!/^\d{2}:\d{2}$/.test(s.loanerCutoffLocal)) throw new AppError(400, 'bad_setting', 'Enter the loaner cutoff as HH:MM');
  try { new Intl.DateTimeFormat('en-US', { timeZone: s.loanerTimezone }); } catch { throw new AppError(400, 'bad_setting', 'Unknown time zone for the loaner source'); }
  const name = s.loanerSourceName?.trim() || null;
  await db.query(`insert into ops_settings(tenant_id, planning_window_hours, allocation_rule, loaner_source_name, loaner_transit_hours, loaner_cutoff_local, loaner_timezone, loaner_return_days, expiry_warning_days, updated_by, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (tenant_id) do update set planning_window_hours=excluded.planning_window_hours, allocation_rule=excluded.allocation_rule, loaner_source_name=excluded.loaner_source_name, loaner_transit_hours=excluded.loaner_transit_hours,
       loaner_cutoff_local=excluded.loaner_cutoff_local, loaner_timezone=excluded.loaner_timezone, loaner_return_days=excluded.loaner_return_days, expiry_warning_days=excluded.expiry_warning_days, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    [ctx.tenantId, int(s.planningWindowHours, 24, 336, 'Planning window (hours)'), s.allocationRule, name, int(s.loanerTransitHours, 1, 240, 'Loaner transit time (hours)'), s.loanerCutoffLocal, s.loanerTimezone,
      int(s.loanerReturnDays, 1, 60, 'Loaner return days'), int(s.expiryWarningDays, 7, 365, 'Expiry warning (days)'), ctx.userId, nowIso()]);
  await audit(db, ctx, 'settings.update', 'ops_settings', null, s);
  return getSettings(db);
}
