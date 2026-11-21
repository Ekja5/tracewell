import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useData, useMe, Status, Err } from '../App';
import { fmtTime, relMinutes } from '../lib/api';

export function Board() {
  const { me } = useMe();
  useEffect(() => { sessionStorage.setItem('tw-board', '1'); }, []);
  const { data, error, reload } = useData<any>('/api/board?hours=72');
  useEffect(() => { const t = setInterval(reload, 30000); return () => clearInterval(t); }, [reload]);
  const cases = data?.cases ?? [];
  const counts = { blocked: cases.filter((c: any) => c.status === 'blocked').length, at_risk: cases.filter((c: any) => c.status === 'at_risk').length, ready: cases.filter((c: any) => c.status === 'ready').length };
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Case readiness: next 72 hours</h1>
        <button className="secondary" onClick={reload}>Refresh</button>
      </div>
      <p className="muted small">Status is derived from ledger, receiving, tray verification and hospital release records. A courier scan alone never makes a case ready. Generated {fmtTime(data?.generatedAt)}.
        {' '}<strong>{counts.blocked}</strong> blocked · <strong>{counts.at_risk}</strong> at risk · <strong>{counts.ready}</strong> ready.</p>
      <Err e={error} />
      <div className="table-wrap">
        <table aria-label="Cases in the next 72 hours">
          <thead><tr><th>Case</th><th>Facility-local start</th><th>Required by</th><th className="hide-sm">Rep</th><th>Readiness</th><th>Outstanding blockers</th><th className="hide-sm">Last physical verification</th><th>Next action / owner / act by</th></tr></thead>
          <tbody>
            {cases.map((c: any) => (
              <tr key={c.id} data-case={c.caseRef}>
                <td><Link to={`/cases/${c.id}`}><strong>{c.caseRef}</strong></Link>{c.urgent && <span className="badge st-blocked"> URGENT</span>}<div className="small muted">{c.procedure}</div><div className="small">{c.facility}</div></td>
                <td>{fmtTime(c.scheduledStart, c.timezone)}<div className="small muted">{relMinutes(c.scheduledStart, me.now)}</div></td>
                <td className="small">Trays: {fmtTime(c.requiredBy?.tray, c.timezone)}<br />Implants: {fmtTime(c.requiredBy?.implant, c.timezone)}</td>
                <td className="hide-sm">{c.repName}</td>
                <td><Status s={c.status} /></td>
                <td>{c.blockers.length === 0 ? <span className="muted">None</span> : (
                  <ul className="blockers">{c.blockers.map((b: any, i: number) => <li key={i}><span className={`sev-${b.severity}`}>{b.severity === 'critical' ? 'Critical: ' : 'Warning: '}</span>{b.message}</li>)}</ul>)}</td>
                <td className="small hide-sm">{c.lastVerification ? <>{c.lastVerification.kind}<br />{c.lastVerification.what}<br />{fmtTime(c.lastVerification.at, c.timezone)}</> : <span className="sev-warning">No physical verification on record</span>}</td>
                <td>{c.nextAction ? <><div>{c.nextAction.link ? <Link to={c.nextAction.link}>{c.nextAction.action}</Link> : c.nextAction.action}</div><div className="small">Owner: {c.nextAction.owner}</div>
                  {c.nextAction.actBy && <div className="small">Act by {fmtTime(c.nextAction.actBy, c.timezone)} ({relMinutes(c.nextAction.actBy, me.now)})</div>}</> : <span className="muted">—</span>}</td>
              </tr>
            ))}
            {!cases.length && <tr><td colSpan={8} className="muted">No cases in the next 72 hours visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
