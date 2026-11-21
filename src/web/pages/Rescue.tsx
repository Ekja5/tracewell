import React, { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useData, useMe, Err } from '../App';
import { fmtTime, money, post, uuid } from '../lib/api';

export function Rescue() {
  const { id, reqId } = useParams();
  const { can } = useMe();
  const nav = useNavigate();
  const { data, error } = useData<any>(`/api/cases/${id}/rescue/${reqId}`);
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());
  const dlg = useRef<HTMLDialogElement>(null);
  if (error) return <Err e={error} />;
  if (!data) return <p>Searching every location for the exact item…</p>;
  const tz = data.case.timezone;
  const src = (e: any) => ({ stockItemId: e.stockItemId, locationId: e.locationId, ownerPartyId: e.ownerPartyId });
  const doPreview = async (e: any) => {
    setErr(null);
    try { setPreview({ ...(await post(`/api/cases/${id}/rescue/${reqId}/preview`, src(e))), e }); key.current = uuid(); dlg.current?.showModal(); } catch (x: any) { setErr(x.message); }
  };
  const confirm = async () => {
    setBusy(true);
    try { const r = await post(`/api/cases/${id}/rescue/${reqId}/reserve`, { ...src(preview.e), idempotencyKey: key.current }); dlg.current?.close(); nav(r.shipment ? `/shipments/${r.shipment.id}` : `/cases/${id}`); }
    catch (x: any) { setErr(x.message); dlg.current?.close(); } finally { setBusy(false); }
  };
  return (
    <div>
      <p><Link to={`/cases/${id}`}>← {data.case.caseRef}</Link></p>
      <h1>Exact-item rescue: {data.requirement.ref}</h1>
      <p>{data.requirement.description}. Need {data.requirement.needed} more for {data.case.caseRef} at {data.case.facility}. Required at facility by <strong>{fmtTime(data.requiredBy, tz)}</strong>; planned use {data.plannedUseDate}.</p>
      <div className="note">{data.rankingRule} {data.travelDisclaimer}</div>
      <Err e={err} />
      <h2>Eligible sources ({data.eligible.length})</h2>
      <div className="table-wrap"><table aria-label="Eligible sources">
        <thead><tr><th>#</th><th>Unit</th><th>Location / custodian</th><th>Owner</th><th>Expiry</th><th>Est. travel</th><th>Est. arrival</th><th>Meets cutoff</th><th>Last physical verification</th><th>Incremental cost</th><th></th></tr></thead>
        <tbody>{data.eligible.map((e: any) => (
          <tr key={e.stockItemId + e.locationId}>
            <td>{e.rank}</td><td><strong>{e.label}</strong><div className="small">Lot {e.lot}</div></td>
            <td>{e.location}<div className="small muted">{e.locationKind} · custodian {e.custodian}</div></td><td className="small">{e.owner}</td><td>{e.expiry ?? '—'}</td>
            <td>{e.travelMinutes} min + {e.handlingMinutes} handling<div className="small muted">{e.travelBasis}</div></td>
            <td>{fmtTime(e.estimatedArrival, tz)}</td><td>{e.meetsCutoff ? <span className="badge st-ready">Yes</span> : <span className="badge st-blocked">No</span>}{e.warning && <div className="small sev-warning">{e.warning}</div>}</td>
            <td className="small">{e.lastVerifiedKind ?? 'none'}<br />{e.lastVerifiedAt ? `${fmtTime(e.lastVerifiedAt, tz)} (${e.verificationAgeHours} h ago)` : ''}</td>
            <td>{money(e.incrementalCostCents)}<div className="small muted">estimate</div></td>
            <td>{can('rescue.reserve') && <button onClick={() => doPreview(e)}>Preview transfer</button>}</td>
          </tr>))}
          {!data.eligible.length && <tr><td colSpan={11}><strong>No eligible unit of this exact item exists.</strong> Escalate to ops; the system will not suggest a clinical substitute.</td></tr>}
        </tbody></table></div>
      <h2>Excluded sources ({data.excluded.length})</h2>
      <p className="small muted">Sorted by travel time. Rows marked "closer" were nearer than the best eligible source.</p>
      <div className="table-wrap"><table className="excluded" aria-label="Excluded sources">
        <thead><tr><th>Unit</th><th>Location</th><th>Owner</th><th>Expiry</th><th>Est. travel</th><th>Why excluded</th></tr></thead>
        <tbody>{data.excluded.map((e: any) => (
          <tr key={e.stockItemId + e.locationId + e.condition}>
            <td>{e.label}<div className="small">Lot {e.lot}</div></td><td>{e.location}{e.closerThanBest && <span className="badge st-at_risk"> closer</span>}</td><td className="small">{e.owner}</td><td>{e.expiry ?? '—'}</td>
            <td>{e.travelMinutes != null ? `${e.travelMinutes} min` : '—'}</td><td><ul className="blockers">{e.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></td>
          </tr>))}</tbody></table></div>
      <dialog ref={dlg} aria-labelledby="pv-title">
        {preview && <>
          <h2 id="pv-title">Preview: reserve {preview.candidate.label} and create transfer</h2>
          <p>From <strong>{preview.source.name}</strong> ({preview.source.kind}) to {data.case.facility}. Estimated arrival {fmtTime(preview.candidate.estimatedArrival, tz)} vs required by {fmtTime(preview.requiredBy, tz)}.</p>
          <h3>Affected cases</h3>
          <ul>{preview.affectedCases.map((a: any, i: number) => <li key={i}><strong>{a.caseRef}</strong>: {a.effect}</li>)}</ul>
          <p className="small muted">Reservation and transfer are created together in one transaction. If someone else reserves this unit first, nothing is created.</p>
          <div className="row"><button disabled={busy} onClick={confirm}>Reserve and create transfer</button><button className="secondary" onClick={() => dlg.current?.close()}>Cancel</button></div>
        </>}
      </dialog>
    </div>
  );
}
