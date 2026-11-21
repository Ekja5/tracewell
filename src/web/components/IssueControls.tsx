import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMe } from '../App';
import { fmtTime, post } from '../lib/api';

/** Owner, acknowledgment and next-action controls for one issue, usable from the board or the case. */
export function IssueControls({ b, tz, assignable, onDone, compact }: { b: any; tz: string; assignable?: any[]; onDone: () => void; compact?: boolean }) {
  const { me, can } = useMe();
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'none' | 'assign' | 'note'>('none');
  const [val, setVal] = useState('');
  if (!b.issueId) return null;
  const call = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); setMode('none'); setVal(''); onDone(); } catch (e: any) { setErr(e.message); } };
  const mine = b.ownerUserId === me.user.id;
  const canAck = b.issueStatus !== 'acknowledged' && (mine || can('issue.assign'));
  return (
    <div className="issue-controls" data-issue={b.issueId}>
      <div className="small">
        <span className={`badge ${b.escalated ? 'st-blocked' : b.issueStatus === 'acknowledged' ? 'st-pending' : 'st-scheduled'}`}>
          {b.escalated ? 'ESCALATED · ' : ''}{b.issueStatus === 'acknowledged' ? `Acknowledged by ${b.acknowledgedBy}` : 'Not yet acknowledged'}
        </span>{' '}
        Owner: <strong>{b.owner}</strong>
        {b.lastEvent && !compact && <span className="muted"> · last: {b.lastEvent.detail.slice(0, 90)} ({fmtTime(b.lastEvent.at, tz)})</span>}
      </div>
      <div className="row tight">
        {b.link && <Link className="btn small-btn secondary" to={b.link}>{b.action}</Link>}
        {canAck && <button className="small-btn secondary" onClick={() => call(() => post(`/api/issues/${b.issueId}/ack`, {}))}>{mine ? 'Acknowledge' : 'Take ownership'}</button>}
        {can('issue.assign') && assignable && <button className="small-btn secondary" onClick={() => setMode(mode === 'assign' ? 'none' : 'assign')}>Assign</button>}
        <button className="small-btn secondary" onClick={() => setMode(mode === 'note' ? 'none' : 'note')}>Add note</button>
      </div>
      {mode === 'assign' && assignable && (
        <div className="row tight">
          <label className="sr" htmlFor={`as-${b.issueId}`}>Assign to</label>
          <select id={`as-${b.issueId}`} value={val} onChange={(e) => setVal(e.target.value)}><option value="">Assign to…</option>{assignable.map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.role.replace('_', ' ')})</option>)}</select>
          <button className="small-btn" disabled={!val} onClick={() => call(() => post(`/api/issues/${b.issueId}/assign`, { userId: val }))}>Save</button>
        </div>)}
      {mode === 'note' && (
        <div className="row tight">
          <label className="sr" htmlFor={`nt-${b.issueId}`}>Note</label>
          <input id={`nt-${b.issueId}`} value={val} onChange={(e) => setVal(e.target.value)} placeholder="What was tried / agreed" />
          <button className="small-btn" disabled={!val.trim()} onClick={() => call(() => post(`/api/issues/${b.issueId}/note`, { note: val }))}>Save note</button>
        </div>)}
      {err && <div className="alert small" role="alert">{err}</div>}
    </div>
  );
}

export function IssueHistory({ history, tz }: { history: any[] | null; tz: string }) {
  if (!history?.length) return null;
  return (
    <ol className="history small">
      {history.map((h, i) => <li key={i}><span className="muted">{fmtTime(h.at, tz)}</span> <strong>{h.kind.replace('_', ' ')}</strong>{h.actor ? ` · ${h.actor}` : ' · system'}: {h.detail}</li>)}
    </ol>
  );
}
