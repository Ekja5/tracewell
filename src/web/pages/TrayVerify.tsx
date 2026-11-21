import React, { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useData, Status, Err } from '../App';
import { fmtTime, post } from '../lib/api';

export function TrayVerify() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const caseId = sp.get('case') || null; const shipmentId = sp.get('shipment') || null;
  const { data, error, reload } = useData<any>(`/api/trays/${id}`);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [seal, setSeal] = useState(true);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (data) setCounts(Object.fromEntries(data.lines.map((l: any) => [l.catalog_item_id, l.qty]))); }, [data]);
  if (error) return <Err e={error} />;
  if (!data) return <p>Loading…</p>;
  const submit = async () => {
    setErr(null);
    try { const r = await post(`/api/trays/${id}/verify`, { caseId, shipmentId, sealIntact: seal, lines: Object.entries(counts).map(([catalogItemId, actualQty]) => ({ catalogItemId, actualQty })) }); setResult(r); reload(); } catch (e: any) { setErr(e.message); }
  };
  return (
    <div>
      {caseId && <p><Link to={`/cases/${caseId}`}>← Back to case</Link></p>}
      <h1>Verify tray {data.tray.asset_tag}</h1>
      <p>{data.tray.tray_name} ({data.tray.tray_ref}), manifest version {data.tray.version}. Current ledger location: {data.location?.name ?? 'unknown'}.</p>
      {data.latestVerification && <p className="small">Latest verification: <Status s={data.latestVerification.result} /> by {data.latestVerification.verifier} at {data.latestVerification.location_name}, {fmtTime(data.latestVerification.verified_at)}.</p>}
      <div className="card">
        <p className="small muted">Count what is physically in the tray. Expected quantities come from the approved manifest version. Missing required instruments keep the case blocked.</p>
        <div className="table-wrap"><table><thead><tr><th>Instrument</th><th>Required</th><th>Expected</th><th>Actual count</th></tr></thead>
          <tbody>{data.lines.map((l: any) => (
            <tr key={l.id}><td><strong>{l.ref}</strong> {l.description}</td><td>{l.required ? 'Yes' : 'No'}</td><td>{l.qty}</td>
              <td><label className="sr" htmlFor={`c-${l.id}`}>Actual count for {l.ref}</label><input id={`c-${l.id}`} type="number" min={0} style={{ width: 90 }} value={counts[l.catalog_item_id] ?? 0} onChange={(e) => setCounts({ ...counts, [l.catalog_item_id]: Number(e.target.value) })} /></td></tr>))}</tbody></table></div>
        <label className="row" style={{ marginTop: 8 }}><input type="checkbox" checked={seal} onChange={(e) => setSeal(e.target.checked)} /> Container seal / lock intact</label>
        <p><button onClick={submit}>Record verification</button></p>
        <Err e={err} />
        {result && (result.result === 'complete' ? <div className="ok">Verified complete against manifest v{data.tray.version}.</div> :
          <div className="alert">Incomplete. Missing: {result.missing.map((m: any) => `${m.description} (${m.ref}) expected ${m.expected}, found ${m.actual}`).join('; ')}. The case stays blocked until a replacement is received and the tray is re-verified.</div>)}
      </div>
    </div>
  );
}
