import { Db, maybe, rows } from '../db.js';
import { now } from '../clock.js';
import { getPolicy } from './cases.js';

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Pilot scorecard metrics. Every value is computed from persisted records in the date range and
 * every metric returns its drill-down rows (source events). All seeded data is synthetic.
 */
export async function computeMetrics(db: Db, days = 30) {
  const end = now(); const start = new Date(end.getTime() - days * 864e5);
  const range = { from: start.toISOString(), to: end.toISOString(), days };
  const out: any[] = [];

  // 1. Cases ready by facility cutoff
  const cases = await rows(db, `select c.*, f.name facility from cases c join facilities f on f.id=c.facility_id where c.status <> 'cancelled' and c.scheduled_start between $1 and $2 order by c.scheduled_start`, [start.toISOString(), end.toISOString()]);
  const drill1: any[] = [];
  for (const c of cases) {
    const policy = await getPolicy(db, c.facility_id, new Date(c.scheduled_start));
    const st = new Date(c.scheduled_start).getTime();
    const trayDue = new Date(st - policy.tray_due_hours_before * 3600e3).toISOString();
    const implantDue = new Date(st - policy.implant_due_hours_before * 3600e3).toISOString();
    const reasons: string[] = [];
    const resv = await rows(db, `select r.stock_item_id, ci.item_type, ci.ref from reservations r join stock_items s on s.id=r.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join case_requirements cr on cr.id=r.requirement_id
       where r.case_id=$1 and cr.mandatory and r.status in ('active','consumed','released')`, [c.id]);
    if (!resv.length) reasons.push('no reserved units on record');
    for (const r of resv) {
      const due = r.item_type === 'tray' ? trayDue : implantDue;
      const recv = await maybe(db, `select min(m.occurred_at) at from inventory_movements m join locations l on l.id=m.to_location_id where m.stock_item_id=$1 and l.facility_id=$2 and m.movement_type in ('receive','opening_balance')`, [r.stock_item_id, c.facility_id]);
      if (!recv?.at || new Date(recv.at) > new Date(due)) reasons.push(`${r.ref} not received by cutoff`);
      if (r.item_type === 'tray') {
        const v = await maybe(db, `select min(verified_at) at from tray_verifications where tray_stock_item_id=$1 and result='complete' and verified_at <= $2 and verified_at >= $3`, [r.stock_item_id, c.scheduled_start, new Date(st - 7 * 864e5).toISOString()]);
        if (!v?.at) reasons.push(`${r.ref} not verified complete before surgery`);
        if (policy.requires_release_decision) { const rel = await maybe(db, `select 1 from release_decisions where case_id=$1 and decision='released' and recorded_at <= $2`, [c.id, c.scheduled_start]); if (!rel) reasons.push('no hospital release before surgery'); }
      }
    }
    drill1.push({ caseRef: c.case_ref, caseId: c.id, facility: c.facility, scheduledStart: c.scheduled_start, ready: reasons.length === 0, reasons });
  }
  const ready = drill1.filter((d) => d.ready).length;
  out.push({ key: 'cases_ready_by_cutoff', name: 'Cases ready by facility cutoff', unit: '%', value: cases.length ? Math.round((ready / cases.length) * 1000) / 10 : null, numerator: ready, denominator: cases.length,
    definition: 'Numerator: non-cancelled cases whose every mandatory reserved unit was received at the facility before its policy cutoff, trays verified complete before surgery, and (where required) hospital release recorded before surgery. Denominator: non-cancelled cases with scheduled start in the range.', range, drill: drill1 });

  // 2. Emergency transfers per 100 cases
  const xfr = await rows(db, `select s.ref, s.created_at, c.case_ref from shipments s left join cases c on c.id=s.case_id where s.kind='rescue_transfer' and s.created_at between $1 and $2 order by s.created_at`, [start.toISOString(), end.toISOString()]);
  out.push({ key: 'emergency_transfers_per_100', name: 'Emergency transfers per 100 cases', unit: 'per 100', value: cases.length ? Math.round((xfr.length / cases.length) * 1000) / 10 : null, numerator: xfr.length, denominator: cases.length,
    definition: 'Numerator: rescue-transfer shipments created in the range. Denominator: non-cancelled cases scheduled in the range. x100.', range, drill: xfr });

  // 3. Minutes to locate a verified item
  const pairs = await rows(db, `select s.case_id, c.case_ref, s.recorded_at searched_at, (select min(r.recorded_at) from audit_log r where r.action='rescue.reserve_transfer' and r.case_id=s.case_id and r.actor_user_id=s.actor_user_id and r.recorded_at >= s.recorded_at) reserved_at
     from audit_log s join cases c on c.id=s.case_id where s.action='rescue.search' and s.recorded_at between $1 and $2
       and not exists (select 1 from audit_log s2 where s2.action='rescue.search' and s2.case_id=s.case_id and s2.actor_user_id=s.actor_user_id and s2.recorded_at < s.recorded_at and s2.recorded_at > s.recorded_at - interval '2 hours')`, [start.toISOString(), end.toISOString()]);
  const locate = pairs.filter((p) => p.reserved_at).map((p) => ({ ...p, minutes: Math.round((new Date(p.reserved_at).getTime() - new Date(p.searched_at).getTime()) / 6e3) / 10 }));
  out.push({ key: 'minutes_to_locate', name: 'Minutes to locate a verified item', unit: 'min (median)', value: median(locate.map((l) => l.minutes)), numerator: null, denominator: locate.length,
    definition: 'Median minutes from the first rescue search for a case (per user, 2-hour session) to the reservation of an eligible, physically verified unit. Searches without a reservation are excluded and listed separately.', range, drill: pairs.map((p) => ({ ...p, minutes: locate.find((l) => l.searched_at === p.searched_at)?.minutes ?? null })) });

  // 4. Rep closeout time
  const closeouts = await rows(db, `select a.case_id, c.case_ref, a.recorded_at submitted_at, (select min(u.recorded_at) from usage_events u where u.case_id=a.case_id) first_usage_at
     from audit_log a join cases c on c.id=a.case_id where a.action='closeout.submit' and a.recorded_at between $1 and $2`, [start.toISOString(), end.toISOString()]);
  const co = closeouts.filter((c) => c.first_usage_at).map((c) => ({ ...c, minutes: Math.round((new Date(c.submitted_at).getTime() - new Date(c.first_usage_at).getTime()) / 6e3) / 10 }));
  out.push({ key: 'rep_closeout_minutes', name: 'Rep closeout time', unit: 'min (median)', value: median(co.map((c) => c.minutes)), numerator: null, denominator: co.length,
    definition: 'Median minutes from the first usage line recorded (server receipt) to closeout submission, per case submitted in the range.', range, drill: co });

  // 5. Days from surgery to accepted billing packet
  const acc = await rows(db, `select c.case_ref, c.scheduled_start, bp.accepted_at from billing_packets bp join cases c on c.id=bp.case_id where bp.status='accepted' and bp.accepted_at between $1 and $2`, [start.toISOString(), end.toISOString()]);
  const accD = acc.map((a) => ({ ...a, days: Math.round((new Date(a.accepted_at).getTime() - new Date(a.scheduled_start).getTime()) / 864e4) / 10 }));
  const notYet = await rows(db, `select c.case_ref, c.scheduled_start from cases c where c.status='completed' and c.scheduled_start between $1 and $2`, [start.toISOString(), end.toISOString()]);
  out.push({ key: 'days_to_accepted_packet', name: 'Days from surgery to accepted billing packet', unit: 'days (median)', value: median(accD.map((a) => a.days)), numerator: null, denominator: accD.length,
    definition: 'Median days from scheduled surgery start to the packet being marked accepted (matching PO recorded and customer acceptance reference entered). Completed cases without an accepted packet are listed as open, not counted.', range, drill: [...accD, ...notYet.map((n) => ({ ...n, accepted_at: null, days: null, open: true }))] });

  // 6. Inventory count accuracy
  const lines = await rows(db, `select cl.*, cs.status, l.code location, ci.ref, si.serial_number, si.lot_number from count_lines cl join count_sessions cs on cs.id=cl.session_id join locations l on l.id=cs.location_id
     join stock_items si on si.id=cl.stock_item_id join catalog_items ci on ci.id=si.catalog_item_id where cs.status in ('submitted','approved','rejected') and cs.submitted_at between $1 and $2`, [start.toISOString(), end.toISOString()]);
  const exact = lines.filter((l) => l.counted_qty === l.expected_qty).length;
  out.push({ key: 'count_accuracy', name: 'Inventory count accuracy', unit: '%', value: lines.length ? Math.round((exact / lines.length) * 1000) / 10 : null, numerator: exact, denominator: lines.length,
    definition: 'Numerator: blind count lines whose counted quantity equals the ledger quantity at submission. Denominator: all count lines (including implicit zero lines for uncounted expected stock) in counts submitted in the range.', range, drill: lines });

  // 7. Recall acknowledgment time
  const tasks = await rows(db, `select t.id, t.task_type, t.status, t.acknowledged_at, r.ref, r.activated_at, u.display_name owner from recall_tasks t join recalls r on r.id=t.recall_id left join users u on u.id=t.owner_user_id
     where r.activated_at between $1 and $2 and t.task_type in ('acknowledge_and_quarantine','return_in_transit','open_case_alert')`, [start.toISOString(), end.toISOString()]);
  const ackd = tasks.filter((t) => t.acknowledged_at).map((t) => ({ ...t, hours: Math.round((new Date(t.acknowledged_at).getTime() - new Date(t.activated_at).getTime()) / 36e4) / 10 }));
  out.push({ key: 'recall_ack_hours', name: 'Recall acknowledgment time', unit: 'hours (median)', value: median(ackd.map((t) => t.hours)), numerator: ackd.length, denominator: tasks.length,
    definition: 'Median hours from recall activation to owner acknowledgment for location and open-case tasks. Numerator/denominator show acknowledged vs total tasks; unacknowledged tasks remain listed.', range, drill: tasks.map((t) => ({ ...t, hours: ackd.find((a) => a.id === t.id)?.hours ?? null })) });

  return { generatedAt: end.toISOString(), range, synthetic: true, metrics: out };
}
