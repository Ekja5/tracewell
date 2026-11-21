import { rows, withTenant } from '../server/db.js';
import { now } from '../server/clock.js';
import { caseReadiness } from '../server/domain/cases.js';
import { syncIssues, escalateOverdue } from '../server/domain/issues.js';

/**
 * Keep issues current for cases in the next 72 h (so deadlines, owners and alerts update even when
 * nobody has the board open), then escalate any issue whose act-by time passed unresolved.
 * Alerts are grouped per issue (one alert per person per issue, updated in place).
 */
export async function runReadinessAlerts(tenantId: string) {
  return withTenant(tenantId, async (db) => {
    const t = now();
    const cases = await rows(db, `select c.id from cases c where (c.status='scheduled' and c.scheduled_start between $1 and $2)
        or exists (select 1 from case_issues i where i.case_id=c.id and i.status <> 'resolved')`,
      [new Date(t.getTime() - 6 * 3600e3).toISOString(), new Date(t.getTime() + 72 * 3600e3).toISOString()]);
    for (const c of cases) await syncIssues(db, tenantId, c.id, await caseReadiness(db, c.id));
    return escalateOverdue(db, tenantId);
  });
}
