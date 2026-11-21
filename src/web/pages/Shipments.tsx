import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useData, useMe, Status, Err } from '../App';
import { fmtTime, post } from '../lib/api';

export function PickQueue() {
  const { data, error, reload } = useData<any[]>('/api/pick-queue');
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}><h1>Pick queue (ordered by dispatch cutoff)</h1><button className="secondary" onClick={reload}>Refresh</button></div>
      <p className="small muted">Dispatch-by = facility required-by minus seeded travel estimate.</p>
      <Err e={error} />
      <div className="table-wrap"><table aria-label="Pick queue">
        <thead><tr><th>Dispatch by</th><th>Shipment</th><th>Case</th><th>From → To</th><th>Lines picked</th><th>Status</th></tr></thead>
        <tbody>{(data ?? []).map((s) => (
          <tr key={s.id}>
            <td>{fmtTime(s.dispatch_by, s.timezone)}<div className={`small ${s.minutes_left < 0 ? 'sev-critical' : s.minutes_left < 120 ? 'sev-warning' : 'muted'}`}>{s.minutes_left == null ? '' : s.minutes_left < 0 ? `${-s.minutes_left} min late` : `${s.minutes_left} min left`}</div></td>
            <td><Link to={`/shipments/${s.id}`}>{s.ref}</Link><div className="small muted">{s.kind.replace('_', ' ')}</div></td>
            <td>{s.case_ref ?? '—'}</td><td>{s.from_name} → {s.to_name}</td><td>{s.picked_count}/{s.line_count}</td><td><Status s={s.status} /></td>
          </tr>))}
          {data && !data.length && <tr><td colSpan={6} className="muted">Nothing to pick.</td></tr>}
        </tbody></table></div>
    </div>
  );
}

export function Shipments() {
  const { data, error } = useData<any[]>('/api/shipments');
  return (
    <div>
      <h1>Shipments and handoffs</h1><Err e={error} />
      <div className="table-wrap"><table>
        <thead><tr><th>Ref</th><th>Case</th><th>Kind</th><th>From → To</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>{(data ?? []).map((s) => <tr key={s.id}><td><Link to={`/shipments/${s.id}`}>{s.ref}</Link></td><td>{s.case_ref ?? '—'}</td><td>{s.kind.replace('_', ' ')}</td><td>{s.from_name} → {s.to_name}</td><td><Status s={s.status} /></td><td className="small">{fmtTime(s.created_at)}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

export function ShipmentDetail() {
  const { id } = useParams();
  const { me, can } = useMe();
  const { data, error, reload } = useData<any>(`/api/shipments/${id}`);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [recv, setRecv] = useState<Record<string, { qty: number; seal: boolean }>>({});
  const [unexpected, setUnexpected] = useState('');
  const [reason, setReason] = useState('');
  const run = async (fn: () => Promise<any>, ok: string) => { setErr(null); setMsg(null); try { await fn(); setMsg(ok); reload(); } catch (e: any) { setErr(e.message); } };
  if (error) return <Err e={error} />;
  if (!data) return <p>Loading…</p>;
  const s = data.shipment; const tz = s.to_tz ?? undefined;
  const isHospitalDest = s.to_kind?.startsWith('hospital');
  const hospitalUser = me.user.role === 'hospital_receiving' || me.user.role === 'hospital_spd';
  const canReceive = can('shipment.receive') && (isHospitalDest ? hospitalUser && me.user.facilityId === s.to_facility : !hospitalUser);
  const lineState = (l: any) => recv[l.id] ?? { qty: l.qty_dispatched - l.qty_received, seal: true };
  return (
    <div>
      <h1>{s.ref} <Status s={s.status} /></h1>
      <p>{s.kind.replace('_', ' ')}{s.case_ref && <> for <Link to={`/cases/${s.case_id}`}>{s.case_ref}</Link></>}: {s.from_name} → {s.to_name}. {s.due_by && <>Due at facility by <strong>{fmtTime(s.due_by, tz)}</strong>.</>} {s.courier_name && `Courier: ${s.courier_name}.`}</p>
      {msg && <div className="ok" role="status">{msg}</div>}<Err e={err} />
      <section className="card">
        <h2>Expected vs actual contents</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Item</th><th>Unit</th><th>Owner</th><th>Expected</th><th>Picked</th><th>Dispatched</th><th>Received</th><th>Condition</th><th></th></tr></thead>
          <tbody>{data.lines.map((l: any) => (
            <tr key={l.id}>
              <td><strong>{l.ref}</strong><div className="small">{l.description}</div></td><td>{l.serial_number ? `SN ${l.serial_number}` : `Lot ${l.lot_number}`}</td><td className="small">{l.owner_name}</td>
              <td>{l.qty_expected}</td><td>{l.qty_picked}</td><td>{l.qty_dispatched}</td><td>{l.qty_received}</td><td>{l.received_condition ?? '—'}</td>
              <td>
                {['planned', 'picked'].includes(s.status) && can('shipment.pick') && l.qty_picked < l.qty_expected && <button className="secondary" onClick={() => run(() => post(`/api/shipments/${s.id}/pick`, { lineId: l.id, qty: l.qty_expected, serial: l.serial_number ?? undefined, lot: l.serial_number ? undefined : l.lot_number }), `Picked ${l.ref}`)}>Pick (verify unit)</button>}
                {['dispatched', 'delivered'].includes(s.status) && canReceive && l.qty_received < l.qty_dispatched && (
                  <div className="row small">
                    <label>Qty received <input type="number" min={0} style={{ width: 70 }} value={lineState(l).qty} onChange={(e) => setRecv({ ...recv, [l.id]: { ...lineState(l), qty: Number(e.target.value) } })} /></label>
                    <label><input type="checkbox" checked={lineState(l).seal} onChange={(e) => setRecv({ ...recv, [l.id]: { ...lineState(l), seal: e.target.checked } })} /> Seal intact</label>
                  </div>)}
                {l.manifest_version_id && s.status !== 'planned' && can('tray.verify') && <Link className="btn secondary" to={`/trays/${l.stock_item_id}/verify?case=${s.case_id ?? ''}&shipment=${s.id}`}>Verify tray contents</Link>}
              </td>
            </tr>))}</tbody></table></div>
        <div className="row" style={{ marginTop: 10 }}>
          {s.status === 'picked' && can('shipment.pick') && <button onClick={() => run(() => post(`/api/shipments/${s.id}/pack`), 'Packed.')}>Pack</button>}
          {['picked', 'packed'].includes(s.status) && can('shipment.dispatch') && <button onClick={() => run(() => post(`/api/shipments/${s.id}/dispatch`, { courierName: 'Synthetic Courier Co.' }), 'Dispatched. Stock is now in transit.')}>Dispatch</button>}
          {['dispatched', 'delivered'].includes(s.status) && can('shipment.courier') && <>
            <button className="secondary" onClick={() => run(() => post(`/api/shipments/${s.id}/courier`, { type: 'courier_scan', note: 'Scan at hub' }), 'Courier scan recorded (does not change readiness).')}>Courier scan</button>
            {s.status === 'dispatched' && <button onClick={() => run(() => post(`/api/shipments/${s.id}/courier`, { type: 'delivered' }), 'Delivery recorded. Hospital must still receive and verify.')}>Mark delivered (courier)</button>}</>}
        </div>
        {['dispatched', 'delivered'].includes(s.status) && canReceive && (
          <div className="card" style={{ marginTop: 10 }}>
            <h3>Receive</h3>
            <label className="field">Unexpected units (one per line, e.g. "NP-INS-4-12 SN INS12-9999")<textarea rows={2} value={unexpected} onChange={(e) => setUnexpected(e.target.value)} /></label>
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={() => run(() => post(`/api/shipments/${s.id}/receive`, { lines: data.lines.filter((l: any) => l.qty_received < l.qty_dispatched).map((l: any) => ({ lineId: l.id, qtyReceived: lineState(l).qty, sealIntact: lineState(l).seal })), unexpected: unexpected.split('\n').filter((x) => x.trim()).map((d) => ({ description: d.trim() })) }), 'Received. Discrepancies (if any) were recorded.')}>Record receipt</button>
              <input placeholder="Rejection reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="danger" onClick={() => run(() => post(`/api/shipments/${s.id}/reject`, { reason }), 'Delivery rejected.')}>Reject delivery</button>
            </div>
          </div>)}
        {s.status === 'received' && can('shipment.receive') && <p><button onClick={() => run(() => post(`/api/shipments/${s.id}/close`), 'Handoff closed.')}>Close handoff</button></p>}
      </section>
      <section className="card">
        <h2>Custody chain</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Event</th><th>Occurred</th><th>Recorded (server)</th><th>Actor</th><th>From → To</th><th>Acknowledgment</th><th>Notes</th></tr></thead>
          <tbody>{data.custody.map((e: any) => (
            <tr key={e.id}><td>{e.event_type.replace('_', ' ')}</td><td className="small">{fmtTime(e.occurred_at, tz)}</td><td className="small">{fmtTime(e.recorded_at, tz)}</td><td>{e.actor}</td><td className="small">{e.from_name ?? '—'} → {e.to_name ?? '—'}</td>
              <td><Status s={e.ack_state === 'acknowledged' ? 'complete' : e.ack_state === 'pending' ? 'pending' : e.ack_state === 'disputed' ? 'disputed' : 'scheduled'} /> {e.ack_name && <span className="small">{e.ack_name}</span>}
                {e.ack_state === 'pending' && e.actor_user_id !== me.user.id && <><button className="link" onClick={() => run(() => post(`/api/custody/${e.id}/ack`, { decision: 'acknowledged' }), 'Custody acknowledged.')}>Acknowledge</button><button className="link" onClick={() => run(() => post(`/api/custody/${e.id}/ack`, { decision: 'disputed', note: 'Disputed at handoff' }), 'Custody disputed.')}>Dispute</button></>}</td>
              <td className="small">{e.notes}</td></tr>))}</tbody></table></div>
      </section>
      <section className="card">
        <h2>Discrepancies</h2>
        {data.discrepancies.map((d: any) => <Discrepancy key={d.id} d={d} canResolve={can('discrepancy.resolve')} onDone={reload} />)}
        {!data.discrepancies.length && <p className="muted">None recorded.</p>}
      </section>
    </div>
  );
}

function Discrepancy({ d, canResolve, onDone }: { d: any; canResolve: boolean; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="small" style={{ marginBottom: 8 }}>
      <Status s={d.status === 'open' ? 'blocked' : 'closed'} /> <strong>{d.kind.replace(/_/g, ' ')}</strong>: {d.detail} <span className="muted">(reported by {d.reporter} {fmtTime(d.reported_at)})</span>
      {d.resolution && <div>Resolved: {d.resolution}</div>}
      {d.status === 'open' && canResolve && d.kind !== 'missing_instrument' && <div className="row"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="How it was resolved" /><button className="secondary" onClick={async () => { try { await post(`/api/discrepancies/${d.id}/resolve`, { resolution: note }); onDone(); } catch (e: any) { setErr(e.message); } }}>Resolve</button></div>}
      {d.status === 'open' && d.kind === 'missing_instrument' && <div className="muted">Resolves only when the tray is re-verified complete at the facility.</div>}
      <Err e={err} />
    </div>
  );
}
