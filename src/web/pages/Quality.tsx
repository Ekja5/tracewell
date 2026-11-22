import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useData, useMe, Status, Err } from '../App';
import { fmtTime, post } from '../lib/api';

export function Quality() {
  const { can } = useMe();
  const nav = useNavigate();
  const { data, error, reload } = useData<any>('/api/quality');
  const meta = useData<any>('/api/meta');
  const [f, setF] = useState({ catalogItemId: '', scopeType: 'lot', scope: '', noticeRef: '', description: '' });
  const [err, setErr] = useState<string | null>(null);
  const implants = (meta.data?.catalog ?? []).filter((c: any) => c.item_type === 'implant');
  const create = async () => {
    setErr(null);
    const item = implants.find((c: any) => c.id === f.catalogItemId);
    try { const r = await post('/api/recalls', { manufacturerPartyId: item?.manufacturer_party_id, catalogItemId: f.catalogItemId, scopeType: f.scopeType, scopeValues: f.scope.split(/[,\s]+/), noticeRef: f.noticeRef, description: f.description }); nav(`/recalls/${r.id}`); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div>
      <h1>Quality: holds and recalls</h1><Err e={error} />
      <section className="card"><h2>Recalls</h2>
        <div className="table-wrap"><table><thead><tr><th>Ref</th><th>Device</th><th>Scope</th><th>Status</th><th>Open tasks</th><th>Unacknowledged</th></tr></thead>
          <tbody>{(data?.recalls ?? []).map((r: any) => <tr key={r.id}><td><Link to={`/recalls/${r.id}`}>{r.ref}</Link></td><td>{r.item_ref} {r.item_description}<div className="small muted">{r.description}</div></td><td>{r.scope_type}: {r.scope_values.join(', ')}</td><td><Status s={r.status} /></td><td>{r.open_tasks}</td><td>{r.unacked}</td></tr>)}
            {data && !data.recalls.length && <tr><td colSpan={6} className="muted">No recalls.</td></tr>}</tbody></table></div>
      </section>
      <section className="card"><h2>Active quality holds ({data?.holds.length ?? 0})</h2>
        {(data?.holds ?? []).map((h: any) => <div key={h.id} className="small">{h.ref} {h.serial_number ? `SN ${h.serial_number}` : ''} lot {h.lot_number}: {h.reason} (since {fmtTime(h.placed_at)})</div>)}
      </section>
      <section className="card"><h2>My recall tasks</h2>
        {(data?.tasks ?? []).map((t: any) => <TaskRow key={t.id} t={t} onDone={reload} />)}
        {data && !data.tasks.length && <p className="muted">None open.</p>}
      </section>
      {can('recall.manage') && (
        <section className="card"><h2>Enter manufacturer recall</h2>
          <p className="small muted">Enter exactly what the manufacturer notice states. A second authorized user must re-enter the scope to verify it before activation.</p>
          <div className="row">
            <label className="field">Device<select value={f.catalogItemId} onChange={(e) => setF({ ...f, catalogItemId: e.target.value })}><option value="">Select…</option>{implants.map((c: any) => <option key={c.id} value={c.id}>{c.ref}: {c.description} ({c.manufacturer})</option>)}</select></label>
            <label className="field">Scope type<select value={f.scopeType} onChange={(e) => setF({ ...f, scopeType: e.target.value })}><option value="lot">Lot</option><option value="serial">Serial</option></select></label>
            <label className="field">Affected lots/serials<input value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} placeholder="L26C014" /></label>
            <label className="field">Manufacturer notice ref<input value={f.noticeRef} onChange={(e) => setF({ ...f, noticeRef: e.target.value })} /></label>
            <label className="field">Description<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
            <button onClick={create} style={{ alignSelf: 'flex-end' }}>Create draft recall</button>
          </div><Err e={err} />
        </section>)}
    </div>
  );
}

function TaskRow({ t, onDone }: { t: any; onDone: () => void }) {
  const { can } = useMe();
  const [err, setErr] = useState<string | null>(null);
  const call = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); onDone(); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="small" style={{ borderBottom: '1px solid #eee', padding: '6px 0' }}>
      <Status s={t.status} /> <strong>{t.task_type.replace(/_/g, ' ')}</strong> {t.ref ? `(${t.ref})` : ''} {t.owner_name ? `· owner ${t.owner_name}` : ''}: {t.detail}
      <div className="row">
        {t.status === 'open' && !['completed_case_trace', 'late_usage_review'].includes(t.task_type) && <button className="secondary" onClick={() => call(() => post(`/api/recall-tasks/${t.id}/ack`))}>Acknowledge</button>}
        {t.status === 'acknowledged' && t.task_type === 'acknowledge_and_quarantine' && <button className="secondary" onClick={() => call(() => post(`/api/recall-tasks/${t.id}/quarantine`))}>Move to quarantine</button>}
        {can('recall.manage') && ['quarantined', 'open', 'acknowledged'].includes(t.status) && t.task_type !== 'acknowledge_and_quarantine' && <button className="secondary" onClick={() => { const n = prompt('Disposition note'); if (n) call(() => post(`/api/recall-tasks/${t.id}/disposition`, { disposition: 'Reviewed per manufacturer notice', note: n })); }}>Record disposition</button>}
        {can('recall.manage') && t.status === 'quarantined' && <button className="secondary" onClick={() => { const n = prompt('Disposition note (e.g. RMA number)'); if (n) call(() => post(`/api/recall-tasks/${t.id}/disposition`, { disposition: 'Return to manufacturer', note: n })); }}>Return to manufacturer</button>}
      </div><Err e={err} />
    </div>
  );
}

export function RecallDetail() {
  const { id } = useParams();
  const { can } = useMe();
  const { data, error, reload } = useData<any>(`/api/recalls/${id}`);
  const [scope, setScope] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ev, setEv] = useState('');
  const call = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); reload(); } catch (e: any) { setErr(e.message); } };
  if (error) return <Err e={error} />;
  if (!data) return <p>Loading…</p>;
  const r = data.recall;
  return (
    <div>
      <p><Link to="/quality">← Quality</Link></p>
      <h1>{r.ref} <Status s={r.status} /></h1>
      <p>{r.manufacturer} · device <strong>{r.item_ref}</strong> {r.item_description} · scope {r.scope_type}: <strong>{r.scope_values.join(', ')}</strong> · notice {r.manufacturer_notice_ref}</p>
      <p className="small">{String(r.description).replace(/\.$/, '')}. Entered {fmtTime(r.entered_at)}{r.verified_at ? `, verified ${fmtTime(r.verified_at)}` : ''}{r.activated_at ? `, activated ${fmtTime(r.activated_at)}` : ''}.</p>
      <Err e={err} />
      {r.status === 'draft' && can('recall.manage') && (
        <div className="card"><h2>Second-person verification</h2><p className="small">Re-enter the affected {r.scope_type}s from the manufacturer notice. Must be a different user from the one who entered the recall.</p>
          <div className="row"><input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="lots / serials" /><button onClick={() => call(() => post(`/api/recalls/${id}/verify`, { confirmScope: scope.split(/[,\s]+/) }))}>Verify scope</button></div></div>)}
      <section className="card"><h2>{r.status === 'active' || r.status === 'closed' ? 'Affected inventory and references' : 'Preview of matches'}</h2>
        <p>Units by location type: {Object.entries(data.summary.unitsByLocationKind).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ') || 'none'}. Outstanding outside quarantine: <strong>{data.outstandingUnits}</strong>. Quarantined: {data.quarantinedUnits}.</p>
        <div className="table-wrap"><table><thead><tr><th>Unit</th><th>Location</th><th>Type</th><th>Owner / custodian</th><th>Qty</th><th>Condition</th></tr></thead>
          <tbody>{data.inventory.map((i: any) => <tr key={i.id}><td>{i.serial_number ? `SN ${i.serial_number}` : ''} lot {i.lot_number}</td><td>{i.location_name}</td><td>{String(i.location_kind).replace(/_/g, ' ')}</td><td className="small">{i.owner}{i.holder ? ` / ${i.holder}` : ''}</td><td>{i.qty}</td><td>{i.condition}</td></tr>)}</tbody></table></div>
        <h3>Open cases holding affected units</h3>
        {data.reservations.map((x: any) => <div key={x.id} className="small">{x.case_ref} at {x.facility}, {fmtTime(x.scheduled_start, x.timezone)}: {x.serial_number ?? x.lot_number}</div>)}
        {!data.reservations.length && <p className="small muted">None.</p>}
        <h3>In-transit shipments</h3>
        {data.shipments.map((x: any, i: number) => <div key={i} className="small">{x.ref} ({String(x.kind).replace(/_/g, ' ')}, {x.status}): {x.serial_number ?? x.lot_number}</div>)}
        {!data.shipments.length && <p className="small muted">None.</p>}
        <h3>Completed case references (usage preserved, listed separately)</h3>
        {data.completedUsage.map((u: any) => <div key={u.id} className="small">{u.case_ref} at {u.facility}: {u.disposition} {u.serial_number ?? ''} lot {u.lot_number}, occurred {fmtTime(u.occurred_at, u.timezone)}{u.recorded_offline ? ' (captured offline)' : ''}</div>)}
        {!data.completedUsage.length && <p className="small muted">None.</p>}
        {r.status === 'verified' && can('recall.manage') && <p><button className="danger" onClick={() => call(() => post(`/api/recalls/${id}/activate`))}>Activate recall: place holds and notify owners</button></p>}
      </section>
      {data.tasks.length > 0 && <section className="card"><h2>Tasks</h2>{data.tasks.map((t: any) => <TaskRow key={t.id} t={{ ...t, ref: r.ref }} onDone={reload} />)}</section>}
      {r.status === 'active' && can('recall.manage') && <section className="card"><h2>Close recall</h2><div className="row"><input value={ev} onChange={(e) => setEv(e.target.value)} placeholder="Closure evidence (e.g. manufacturer RMA confirmation)" /><button onClick={() => call(() => post(`/api/recalls/${id}/close`, { evidence: ev }))}>Close</button></div></section>}
      {r.status === 'closed' && <p className="ok">Closed {fmtTime(r.closed_at)}: {r.closure_evidence}</p>}
    </div>
  );
}
