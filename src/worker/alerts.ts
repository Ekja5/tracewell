import { rows, withTenant } from '../server/db.js';
import { now } from '../server/clock.js';
import { caseReadiness, fmtLocal } from '../server/domain/cases.js';
import { notify, notifyRole } from '../server/audit.js';

/** Alert owners when a case inside 24 h has a blocker whose act-by time is within 2 h or passed. Deduplicated per blocker. */
export async function runReadinessAlerts(tenantId: string) {
  return withTenant(tenantId, async (db) => {
    const t = now();
    const cases = await rows(db, `select c.id, c.case_ref, c.rep_user_id, c.facility_id, f.timezone from cases c join facilities f on f.id=c.facility_id where c.status='scheduled' and c.scheduled_start between $1 and $2`,
      [t.toISOString(), new Date(t.getTime() + 24 * 3600e3).toISOString()]);
    let sent = 0;
    for (const c of cases) {
      const r = await caseReadiness(db, c.id);
      for (const b of r.blockers) {
        const actBy = b.actBy ? new Date(b.actBy) : null;
        if (!actBy || actBy.getTime() - t.getTime() > 2 * 3600e3) continue;
        const msg = `${c.case_ref}: ${b.message} Act by ${fmtLocal(actBy, c.timezone)}.`;
        const dedupe = `cutoff:${c.id}:${b.code}:${actBy.toISOString()}`;
        if (b.ownerRole === 'rep') await notify(db, tenantId, c.rep_user_id, { kind: 'cutoff', message: msg, caseId: c.id, facilityId: c.facility_id, dedupe });
        else await notifyRole(db, tenantId, [b.ownerRole === 'hospital_receiving' || b.ownerRole === 'hospital_spd' ? b.ownerRole : 'ops_manager'], { kind: 'cutoff', message: msg, caseId: c.id, facilityId: c.facility_id, dedupe });
        sent++;
      }
    }
    return sent;
  });
}
