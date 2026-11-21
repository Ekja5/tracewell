import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useData, useMe, Status, Err } from '../App';
import { fmtTime, post } from '../lib/api';
import { IssueHistory } from '../components/IssueControls';

/** Shift handoff: what is open, who has the next move, what was already tried, and what closed. */
export function Handoff() {
  const [hours, setHours] = useState(12);
  const { data, error } = useData<any>(`/api/handoff?hours=${hours}`, [hours]);
  const { me } = useMe();
  return (
    <div>
      <h1>Shift handoff</h1>
      <p className="small muted">Everything still open across your cases, most urgent first, with the full history of what was tried. Issues close only when the records clear them. Generated {fmtTime(data?.generatedAt)}.</p>
      <label className="row tight small">Show resolved in the last <select value={hours} onChange={(e) => setHours(Number(e.target.value))}><option value={8}>8 h</option><option value={12}>12 h</option><option value={24}>24 h</option></select></label>
      <Err e={error} />
      <h2>Open ({data?.open.length ?? 0})</h2>
      {(data?.open ?? []).map((i: any) => (
        <section key={i.id} className={`card issue sev-border-${i.severity}`} data-issue={i.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><Link to={`/cases/${i.case_id}`}><strong>{i.case_ref}</strong></Link> · {i.facility} · surgery {fmtTime(i.scheduled_start, i.timezone)}</div>
            <div className="small">{i.escalation_level > 0 && <span className="badge st-blocked">ESCALATED</span>} <Status s={i.status === 'acknowledged' ? 'pending' : 'blocked'} /> {i.status}</div>
          </div>
          <p>{i.message}</p>
          <p className="small"><strong>Next move:</strong> {i.action} · <strong>Owner:</strong> {i.owner_name ?? 'unassigned'}{i.owner_user_id === me.user.id ? ' (you)' : ''}{i.act_by ? <> · act by <strong>{fmtTime(i.act_by, i.timezone)}</strong></> : null}</p>
          <details open={i.escalation_level > 0}><summary className="small">History ({i.history?.length ?? 0} events)</summary><IssueHistory history={i.history} tz={i.timezone} /></details>
        </section>))}
      {data && !data.open.length && <p className="ok">Nothing open.</p>}
      <h2>Resolved in the last {hours} h ({data?.resolved.length ?? 0})</h2>
      {(data?.resolved ?? []).map((i: any) => (
        <div key={i.id} className="card small"><Link to={`/cases/${i.case_id}`}>{i.case_ref}</Link>: <strong>{i.code.replace(/_/g, ' ')}</strong>, {i.resolution} at {fmtTime(i.resolved_at, i.timezone)}
          <details><summary>History</summary><IssueHistory history={i.history} tz={i.timezone} /></details></div>))}
    </div>
  );
}

/** Alerts grouped per issue: repeats update one row, resolved issues close their alerts. */
export function Alerts({ reload }: { reload: () => void }) {
  const { data, reload: r2 } = useData<any[]>('/api/notifications');
  const [showClosed, setShowClosed] = useState(false);
  const active = (data ?? []).filter((n) => n.status === 'active');
  const closed = (data ?? []).filter((n) => n.status === 'closed');
  const list = showClosed ? closed : active;
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Alerts</h1>
        <div className="row tight">
          <button className={showClosed ? 'secondary' : ''} onClick={() => setShowClosed(false)}>Active ({active.length})</button>
          <button className={showClosed ? '' : 'secondary'} onClick={() => setShowClosed(true)}>Closed ({closed.length})</button>
          <button className="secondary" onClick={async () => { await post('/api/notifications/read'); reload(); r2(); }}>Mark all read</button>
        </div>
      </div>
      <p className="small muted">One alert per issue. Repeats update the same alert; when the issue is resolved or the case changes, the alert updates or closes.</p>
      {list.map((n) => (
        <div key={n.id} className={`card small ${n.read_at ? '' : 'unread'}`} data-alert={n.issue_id ?? n.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>{n.escalation_level > 0 || n.kind === 'issue_escalated' ? <span className="badge st-blocked">ESCALATED</span> : null} <strong>{n.case_ref ?? ''}</strong> · {n.kind.replace(/_/g, ' ')}{n.repeat_count > 1 ? <span className="badge st-pending"> ×{n.repeat_count} updates</span> : null}</span>
            <span className="muted">{fmtTime(n.last_at ?? n.created_at)}</span>
          </div>
          <div>{n.message}</div>
          {n.status === 'closed' && <div className="muted">Closed: {n.closed_reason}</div>}
          {n.case_id && <Link to={`/cases/${n.case_id}`}>Open case</Link>}
        </div>))}
      {data && !list.length && <p className="muted">No {showClosed ? 'closed' : 'active'} alerts.</p>}
    </div>
  );
}

export function QuarantineList() {
  const { data, error } = useData<any[]>('/api/sync-quarantine');
  return (
    <div>
      <h2>Field events held in quarantine</h2>
      <p className="small muted">Usage the server could not post (for example, the case was reassigned while the phone was offline). Nothing is discarded; review each one.</p>
      <Err e={error} />
      {(data ?? []).map((q) => <div key={q.id} className="card small"><strong>{q.actor}</strong> · {q.payload?.disposition} · captured {fmtTime(q.payload?.occurredAt)} · received {fmtTime(q.received_at)}<br />{q.reason}<br /><code>{String(q.payload?.rawScan ?? JSON.stringify(q.payload?.manual ?? {})).replace(/\x1d/g, '<GS>')}</code></div>)}
      {data && !data.length && <p className="muted small">None.</p>}
    </div>
  );
}
