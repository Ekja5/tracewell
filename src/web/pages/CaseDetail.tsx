import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useData, useMe, Status, Err } from '../App';
import { fmtTime, post } from '../lib/api';
import { IssueControls, IssueHistory } from '../components/IssueControls';

export function CaseDetail() {
  const { id } = useParams();
  const { me, can } = useMe();
  const { data, error, reload } = useData<any>(`/api/cases/${id}`);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<any>, ok?: (r: any) => string) => { setErr(null); setMsg(null); try { const r = await fn(); setMsg(ok ? ok(r) : 'Saved.'); reload(); } catch (e: any) { setErr(e.message); } };
  if (error) return <Err e={error} />;
  if (!data) return <p>Loading…</p>;
  const c = data.case; const r = data.readiness; const tz = c.timezone;
  const isHospital = me.user.role === 'hospital_spd' || me.user.role === 'hospital_receiving';
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{c.case_ref} <Status s={r.status} /></h1>
        <div className="row">
          {can('closeout.record') && c.status === 'scheduled' && <Link className="btn" to={`/cases/${c.id}/closeout`}>Close case</Link>}
          {can('finance.manage') && ['completed', 'closed'].includes(c.status) && <Link className="btn" to={`/cases/${c.id}/finance`}>Finance</Link>}
        </div>
      </div>
      <p>{c.procedure} · {c.surgeon_ref} · <strong>{c.facility_name}</strong> · {fmtTime(c.scheduled_start, tz)} · Rep {c.rep_name ?? '—'}</p>
      <p className="small muted">Facility policy v{data.policy.version}: trays due {data.policy.tray_due_hours_before} h before start ({fmtTime(r.requiredBy.tray, tz)}), implants {data.policy.implant_due_hours_before} h before ({fmtTime(r.requiredBy.implant, tz)}). {data.policy.requires_release_decision ? `Hospital release decision required; evidence: ${data.policy.required_evidence.join(', ')}.` : ''}
        {data.card && <> Preference card {data.card.code} v{data.card.version}, approved by {data.card.approved_by_name} {fmtTime(data.card.approved_at, tz)}.</>}</p>
      {msg && <div className="ok" role="status">{msg}</div>}<Err e={err} />

      <section className="card">
        <h2>Open issues ({r.blockers.length})</h2>
        {r.blockers.length === 0 ? <p className="ok">No outstanding blockers. Every mandatory item is at the facility, verified{data.policy.requires_release_decision ? ', and released by the hospital' : ''}.</p> : (
          <ol className="issues">{r.blockers.map((b: any, i: number) => (
            <li key={b.key ?? i} className={`issue sev-border-${b.severity}`}>
              <div><span className={`sev-${b.severity}`}>{b.severity === 'critical' ? 'Critical' : 'Warning'}:</span> {b.explanation}</div>
              <IssueControls b={b} tz={tz} assignable={data.assignable} onDone={reload} />
              <details><summary className="small">What happened so far</summary><IssueHistory history={data.issues.find((x: any) => x.id === b.issueId)?.history} tz={tz} /></details>
            </li>))}
          </ol>)}
        {r.staleEvidence?.length > 0 && <p className="small evidence-stale">Evidence to re-check: {r.staleEvidence.map((s: any) => `${s.label} at ${s.location}: ${s.kind}`).join('; ')}.</p>}
        {data.issues.filter((i: any) => i.status === 'resolved').length > 0 && <details><summary className="small">Resolved issues ({data.issues.filter((i: any) => i.status === 'resolved').length})</summary>
          {data.issues.filter((i: any) => i.status === 'resolved').map((i: any) => <div key={i.id} className="small" style={{ marginBottom: 6 }}><strong>{i.code.replace(/_/g, ' ')}</strong>: {i.resolution} ({fmtTime(i.resolved_at, tz)})<IssueHistory history={i.history} tz={tz} /></div>)}</details>}
        <p className="small muted">Most recent physical verification: {r.lastVerification ? `${r.lastVerification.kind}, ${r.lastVerification.what}, ${fmtTime(r.lastVerification.at, tz)}` : 'none on record'}.</p>
      </section>

      <section className="card">
        <h2>Requirements</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Item</th><th>Type</th><th>Need</th><th>Reserved</th><th>Units and state</th><th>Required by</th><th></th></tr></thead>
          <tbody>{r.items.map((it: any) => (
            <tr key={it.requirementId}>
              <td><strong>{it.ref}</strong><div className="small">{it.description}</div></td>
              <td>{it.itemType}{it.mandatory ? '' : <div className="small muted">optional backup</div>}</td>
              <td>{it.qty}</td><td>{it.reserved}</td>
              <td className="small">{it.units.map((u: any) => <div key={u.reservationId}>{u.serial ? `SN ${u.serial}` : `Lot ${u.lot}`} @ {u.location}: <strong>{u.state}</strong></div>)}{!it.units.length && <span className="muted">none</span>}</td>
              <td className="small">{fmtTime(it.requiredBy, tz)}</td>
              <td>{can('rescue.search') && c.status === 'scheduled' && it.reserved < it.qty && <Link className="btn secondary" to={`/cases/${c.id}/rescue/${it.requirementId}`}>Find exact item</Link>}</td>
            </tr>))}</tbody>
        </table></div>
        {can('shipment.plan') && c.status === 'scheduled' && <p><button onClick={() => act(() => post(`/api/cases/${c.id}/plan-delivery`), (x) => `${x.created.length} delivery shipment(s) planned.`)}>Plan delivery for reserved items</button></p>}
      </section>

      {data.trays.length > 0 && (
        <section className="card">
          <h2>Trays</h2>
          {data.trays.map((t: any) => (
            <div key={t.id} className="row">
              <span><strong>{t.ref}</strong> {t.serial_number} at {t.location_name}</span>
              {can('tray.verify') && <Link className="btn secondary" to={`/trays/${t.stock_item_id}/verify?case=${c.id}`}>Verify contents</Link>}
            </div>))}
          {isHospital && <ReleaseForm caseId={c.id} trays={data.trays} evidence={data.policy.required_evidence} onDone={(m) => { setMsg(m); reload(); }} />}
          {!isHospital && <p className="small muted">Release decisions can only be recorded by authorized personnel of {c.facility_name}. Tracewell does not determine sterility or provide clinical clearance.</p>}
          {data.releases.map((rd: any) => <p key={rd.id} className="small">Release decision: <strong>{rd.decision}</strong> by {rd.recorder} {fmtTime(rd.recorded_at, tz)}. Evidence: {Object.entries(rd.evidence).map(([k, v]) => `${k}=${v}`).join(', ')}</p>)}
        </section>)}

      <section className="card">
        <h2>Shipments and discrepancies</h2>
        {data.shipments.map((s: any) => <div key={s.id}><Link to={`/shipments/${s.id}`}>{s.ref}</Link> {s.kind.replace('_', ' ')}: {s.from_name} → {s.to_name} <Status s={s.status} /></div>)}
        {!data.shipments.length && <p className="muted">No shipments.</p>}
        {data.discrepancies.map((d: any) => <div key={d.id} className="small"><Status s={d.status === 'open' ? 'blocked' : 'closed'} /> {d.kind.replace(/_/g, ' ')}: {d.detail}{d.resolution ? ` | Resolved: ${d.resolution}` : ''}
          {d.status === 'open' && d.kind === 'missing_instrument' && can('shipment.plan') && <button className="link" onClick={() => act(() => post(`/api/discrepancies/${d.id}/replacement`), (s) => `Replacement shipment ${s.ref} created for the warehouse pick queue.`)}>Send exact replacement from warehouse</button>}</div>)}
      </section>

      {can('case.manage') && c.status === 'scheduled' && <ScheduleForms c={c} catalog={data.requirements} act={act} />}

      {data.timeline.length > 0 && (
        <section className="card"><h2>Audit timeline</h2>
          <div className="table-wrap"><table><thead><tr><th>Recorded</th><th>Occurred</th><th>Actor</th><th>Action</th><th>Reason</th></tr></thead>
            <tbody>{data.timeline.map((a: any, i: number) => <tr key={i}><td className="small">{fmtTime(a.recorded_at, tz)}</td><td className="small">{fmtTime(a.occurred_at, tz)}</td><td>{a.actor ?? 'system'}</td><td>{a.action}</td><td className="small">{a.reason}</td></tr>)}</tbody></table></div>
        </section>)}
    </div>
  );
}

function ReleaseForm({ caseId, trays, evidence, onDone }: { caseId: string; trays: any[]; evidence: string[]; onDone: (m: string) => void }) {
  const [tray, setTray] = useState(trays[0]?.stock_item_id);
  const [ev, setEv] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const submit = async (decision: string) => {
    setErr(null);
    try { await post(`/api/cases/${caseId}/release`, { trayStockItemId: tray, decision, evidence: ev }); onDone(`Hospital decision "${decision.replace('_', ' ')}" recorded.`); } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="card" style={{ background: '#f7faf8' }}>
      <h3>Hospital release decision</h3>
      <p className="small">Record your facility's decision and the reference to your own processing records. This system stores the decision; it does not infer sterilization.</p>
      <div className="row">
        <label className="field">Tray<select value={tray} onChange={(e) => setTray(e.target.value)}>{trays.map((t) => <option key={t.stock_item_id} value={t.stock_item_id}>{t.serial_number}</option>)}</select></label>
        {evidence.map((k) => <label key={k} className="field">{k.replace(/_/g, ' ')}<input value={ev[k] ?? ''} onChange={(e) => setEv({ ...ev, [k]: e.target.value })} /></label>)}
      </div>
      <div className="row" style={{ marginTop: 8 }}><button onClick={() => submit('released')}>Record: released for use</button><button className="danger" onClick={() => submit('not_released')}>Record: not released</button></div>
      <Err e={err} />
    </div>
  );
}

function ScheduleForms({ c, catalog, act }: { c: any; catalog: any[]; act: (fn: () => Promise<any>, ok?: (r: any) => string) => void }) {
  // Facility-local wall time: what the scheduler sees on the OR schedule.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: c.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(c.scheduled_start)).map((p) => [p.type, p.value]));
  const [when, setWhen] = useState(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`);
  const toUtc = (local: string) => {
    const guess = new Date(local + ':00Z');
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: c.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess).map((x) => [x.type, x.value]));
    const asLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    return new Date(guess.getTime() + (guess.getTime() - asLocal)).toISOString();
  };
  const [reason, setReason] = useState('');
  const [req, setReq] = useState(catalog[0]?.id ?? '');
  const [qty, setQty] = useState(1);
  return (
    <section className="card">
      <h2>Schedule changes</h2>
      <p className="small muted">Enter the new start in {c.facility_name} local time ({c.timezone}). Moving a case recalculates every reservation, delivery cutoff and owner deadline, and updates the owners' alerts.</p>
      <div className="row">
        <label className="field">New start (facility local time)<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
        <label className="field">Reason<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. OR block moved" /></label>
        <button onClick={() => act(() => post(`/api/cases/${c.id}/move`, { scheduledStart: toUtc(when), reason, expectedVersion: c.version }), (r) => `Moved. ${r.conflicts.length ? 'Conflicts: ' + r.conflicts.map((x: any) => x.message).join('; ') : 'No conflicts.'}`)}>Move case</button>
        <button className="danger" onClick={() => act(() => post(`/api/cases/${c.id}/cancel`, { reason, expectedVersion: c.version }), (r) => `Cancelled. ${r.released} reservation(s) released.`)}>Cancel case</button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <label className="field">Requirement<select value={req} onChange={(e) => setReq(e.target.value)}>{catalog.map((r) => <option key={r.id} value={r.id}>{r.ref} (now {r.qty})</option>)}</select></label>
        <label className="field">New qty<input type="number" min={0} value={qty} onChange={(e) => setQty(Number(e.target.value))} /></label>
        <button className="secondary" onClick={() => act(() => post(`/api/cases/${c.id}/requirements`, { requirementId: req, qty, reason }), (r) => `Requirement updated. ${r.conflicts.length} conflict(s).`)}>Change requirement</button>
      </div>
    </section>
  );
}
