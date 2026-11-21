import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useData, useMe, Status, Err } from '../App';
import { fmtTime, post } from '../lib/api';

export function Counts() {
  const nav = useNavigate();
  const list = useData<any[]>('/api/counts');
  const meta = useData<any>('/api/meta');
  const [loc, setLoc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <h1>Blind cycle counts</h1>
      <p className="small muted">Counters never see expected quantities. Variances are computed at submission and must be approved by a different person before an adjustment is posted to the ledger.</p>
      <div className="card row">
        <label className="field">Location<select value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">Select…</option>{(meta.data?.locations ?? []).filter((l: any) => ['warehouse', 'trunk', 'consignment', 'hospital_receiving'].includes(l.kind)).map((l: any) => <option key={l.id} value={l.id}>{l.code}: {l.name}</option>)}</select></label>
        <button style={{ alignSelf: 'flex-end' }} disabled={!loc} onClick={async () => { try { const s = await post('/api/counts', { locationId: loc }); nav(`/counts/${s.id}`); } catch (e: any) { setErr(e.message); } }}>Start blind count</button>
      </div><Err e={err} />
      <div className="table-wrap"><table><thead><tr><th>Started</th><th>Location</th><th>Counter</th><th>Lines</th><th>Variances</th><th>Status</th></tr></thead>
        <tbody>{(list.data ?? []).map((s) => <tr key={s.id}><td><Link to={`/counts/${s.id}`}>{fmtTime(s.created_at)}</Link></td><td>{s.location_name}</td><td>{s.counter}</td><td>{s.lines}</td><td>{s.variances}</td><td><Status s={s.status === 'approved' ? 'complete' : s.status === 'submitted' ? 'review' : s.status} /> {s.status}</td></tr>)}</tbody></table></div>
    </div>
  );
}

export function CountDetail() {
  const { id } = useParams();
  const { can } = useMe();
  const { data, error, reload } = useData<any>(`/api/counts/${id}`);
  const [f, setF] = useState({ ref: '', lot: '', serial: '', countedQty: 1 });
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const call = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); reload(); } catch (e: any) { setErr(e.message); } };
  if (error) return <Err e={error} />;
  if (!data) return <p>Loading…</p>;
  const s = data.session;
  return (
    <div>
      <p><Link to="/counts">← Counts</Link></p>
      <h1>Count at {s.location_name} <Status s={s.status === 'approved' ? 'complete' : s.status === 'submitted' ? 'review' : 'pending'} /></h1>
      <p className="small">Started by {s.counter} {fmtTime(s.created_at)}{s.submitted_at ? `; submitted ${fmtTime(s.submitted_at)}` : ''}{s.reviewed_at ? `; reviewed ${fmtTime(s.reviewed_at)}: ${s.review_note}` : ''}</p>
      <Err e={err} />
      {s.status === 'open' && can('count.perform') && (
        <div className="card"><h2>Add counted item</h2><div className="row">
          <label className="field">Ref<input value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></label>
          <label className="field">Lot<input value={f.lot} onChange={(e) => setF({ ...f, lot: e.target.value })} /></label>
          <label className="field">Serial<input value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} /></label>
          <label className="field">Units counted<input type="number" min={0} value={f.countedQty} onChange={(e) => setF({ ...f, countedQty: Number(e.target.value) })} /></label>
          <button style={{ alignSelf: 'flex-end' }} onClick={() => call(() => post(`/api/counts/${id}/lines`, { ...f, lot: f.lot || undefined, serial: f.serial || undefined }))}>Add</button>
        </div></div>)}
      <div className="table-wrap"><table><thead><tr><th>Item</th><th>Unit</th><th>Owner</th><th>Counted</th><th>Expected (ledger)</th><th>Variance</th></tr></thead>
        <tbody>{data.lines.map((l: any) => <tr key={l.id}><td>{l.ref}</td><td>{l.serial_number ? `SN ${l.serial_number}` : `Lot ${l.lot_number}`}</td><td className="small">{l.owner}</td><td>{l.counted_qty}</td>
          <td>{data.blind ? <em className="muted">hidden (blind)</em> : l.expected_qty}</td><td>{data.blind ? '' : <span className={l.counted_qty !== l.expected_qty ? 'sev-critical' : ''}>{l.counted_qty - l.expected_qty}</span>}</td></tr>)}</tbody></table></div>
      {s.status === 'open' && <p><button onClick={() => call(() => post(`/api/counts/${id}/submit`))}>Submit count</button></p>}
      {s.status === 'submitted' && can('count.approve') && <div className="card row"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Review note" /><button onClick={() => call(() => post(`/api/counts/${id}/review`, { decision: 'approve', note }))}>Approve adjustments</button><button className="danger" onClick={() => call(() => post(`/api/counts/${id}/review`, { decision: 'reject', note }))}>Reject</button></div>}
    </div>
  );
}
