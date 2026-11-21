import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData, useMe, Status, Err } from '../App';
import { fmtTime, relMinutes } from '../lib/api';
import { IssueControls } from '../components/IssueControls';
import { AskOpsButton } from '../components/AskOps';

function timeLeft(mins: number | null) {
  if (mins == null) return null;
  if (mins < 0) return <span className="sev-critical">{Math.abs(mins) >= 120 ? `${Math.round(-mins / 6) / 10} h` : `${-mins} min`} past act-by</span>;
  return <span className={mins < 120 ? 'sev-critical' : mins < 360 ? 'sev-warning' : ''}>{mins >= 120 ? `${Math.round(mins / 6) / 10} h` : `${mins} min`} left</span>;
}

export function Board() {
  const { me, can } = useMe();
  useEffect(() => { sessionStorage.setItem('tw-board', '1'); }, []);
  const [hours, setHours] = useState(72);
  const { data, error, reload } = useData<any>(`/api/board?hours=${hours}`, [hours]);
  const people = useData<any>(can('issue.assign') ? '/api/meta' : null);
  useEffect(() => { const t = setInterval(reload, 30000); return () => clearInterval(t); }, [reload]);
  const cases = data?.cases ?? [];
  const counts = { blocked: cases.filter((c: any) => c.status === 'blocked').length, at_risk: cases.filter((c: any) => c.status === 'at_risk').length, ready: cases.filter((c: any) => c.status === 'ready').length };
  const assignable = (people.data?.assignable ?? null);
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Case readiness: next {hours === 24 ? '24' : '72'} hours</h1>
        <div className="row tight">
          <button className={hours === 24 ? '' : 'secondary'} onClick={() => setHours(24)}>Tomorrow (24 h)</button>
          <button className={hours === 72 ? '' : 'secondary'} onClick={() => setHours(72)}>72 h</button>
          <AskOpsButton />
          <Link className="btn secondary" to="/handoff">Shift handoff</Link>
          <button className="secondary" onClick={reload}>Refresh</button>
        </div>
      </div>
      <p className="muted small">Most urgent first. Status comes from ledger, receiving, tray verification and hospital release records; a courier scan alone never makes a case ready. Deadlines are in each facility's local time and respect its receiving hours. Updated {fmtTime(data?.generatedAt)}.{' '}
        <strong>{counts.blocked}</strong> blocked · <strong>{counts.at_risk}</strong> at risk · <strong>{counts.ready}</strong> ready.</p>
      <Err e={error} />
      {cases.map((c: any) => (
        <section key={c.id} className={`card casecard ${c.status}`} data-case={c.caseRef} aria-label={`Case ${c.caseRef}`}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <Link to={`/cases/${c.id}`}><strong style={{ fontSize: '1.1rem' }}>{c.caseRef}</strong></Link> <Status s={c.status} />{c.urgent && <span className="badge st-blocked"> URGENT</span>}
              <div className="small">{c.facility} · {c.procedure} · Rep {c.repName}</div>
            </div>
            <div className="small" style={{ textAlign: 'right' }}>
              Surgery <strong>{fmtTime(c.scheduledStart, c.timezone)}</strong> ({relMinutes(c.scheduledStart, me.now)})<br />
              {c.nextAction?.actBy && <>Next act-by {fmtTime(c.nextAction.actBy, c.timezone)} · {timeLeft(c.minutesLeft)}</>}
            </div>
          </div>
          {c.blockers.length === 0 && <p className="ok small">Ready: every mandatory item is at the facility and verified{c.status === 'ready' ? ', with hospital release recorded where required' : ''}.</p>}
          <ol className="issues">
            {c.blockers.map((b: any, i: number) => (
              <li key={b.key ?? i} className={`issue sev-border-${b.severity}`}>
                <div><span className={`sev-${b.severity}`}>{b.severity === 'critical' ? 'Critical' : 'Warning'}:</span> {b.explanation}</div>
                <IssueControls b={b} tz={c.timezone} assignable={assignable?.filter((u: any) => !u.facility_id || u.facility_id === c.facilityId)} onDone={reload} compact />
              </li>))}
          </ol>
          {c.staleEvidence?.length > 0 && <p className="small evidence-stale">Evidence to re-check: {c.staleEvidence.map((s: any) => `${s.label} at ${s.location}: ${s.kind}${s.ageHours != null ? `, ${Math.round(s.ageHours / 24)} days ago` : ''}`).join('; ')}.</p>}
          <p className="small muted">Last physical verification: {c.lastVerification ? `${c.lastVerification.kind}, ${c.lastVerification.what}, ${fmtTime(c.lastVerification.at, c.timezone)}` : 'none on record'}.{c.hoursNote ? ` ${c.hoursNote}.` : ''}</p>
        </section>))}
      {data && !cases.length && <p className="muted">No cases in this window visible to you.</p>}
    </div>
  );
}
