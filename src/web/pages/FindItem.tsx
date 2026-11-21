import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useData, useMe, Err } from '../App';
import { api, fmtTime } from '../lib/api';

export function EvidenceBadge({ e }: { e: { tier: string; text: string } | null | undefined }) {
  if (!e) return null;
  const cls = e.tier === 'fresh' ? 'ev-fresh' : e.tier === 'recent' ? 'ev-recent' : e.tier === 'stale' ? 'ev-stale' : 'ev-none';
  const label = e.tier === 'fresh' ? 'Physically confirmed' : e.tier === 'recent' ? 'Scanned today' : e.tier === 'stale' ? 'Old scan' : 'Not physically scanned';
  return <span className={`evidence ${cls}`}><strong>{label}</strong> · {e.text}</span>;
}

/** Rep's exact-item lookup: exact catalog number or GTIN, optionally against one of their cases. */
export function FindItem() {
  const { me } = useMe();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [caseId, setCaseId] = useState(sp.get('case') ?? '');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const mine = useData<any[]>(me.user.role === 'rep' ? '/api/cases?mine=1' : '/api/cases');
  const open = (mine.data ?? []).filter((c) => c.status === 'scheduled');
  const search = async (e?: React.FormEvent) => {
    e?.preventDefault(); setErr(null);
    setSp({ q, ...(caseId ? { case: caseId } : {}) });
    try { setRes(await api(`/api/availability?q=${encodeURIComponent(q)}${caseId ? `&caseId=${caseId}` : ''}`)); } catch (x: any) { setErr(x.message); }
  };
  return (
    <div>
      <h1>Find an exact item</h1>
      <form className="card row" onSubmit={search}>
        <label className="field">Exact catalog number or GTIN<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. NP-INS-4-10" autoCapitalize="characters" /></label>
        <label className="field">For case (optional)<select value={caseId} onChange={(e) => setCaseId(e.target.value)}><option value="">No case: show all stock</option>{open.map((c) => <option key={c.id} value={c.id}>{c.case_ref} · {c.facility} · {fmtTime(c.scheduled_start, c.timezone)}</option>)}</select></label>
        <button style={{ alignSelf: 'flex-end' }} disabled={!q.trim()}>Search</button>
      </form>
      <Err e={err} />
      {res?.mode === 'none' && <p className="alert">{res.message}</p>}
      {res?.mode === 'case' && (
        <div className="card">
          <p><strong>{res.item.ref}</strong> {res.item.description} for <strong>{res.case.caseRef}</strong>: needed at {res.case.facility} by <strong>{fmtTime(res.requiredBy, res.case.timezone)}</strong>. {res.eligible.length} eligible, {res.excluded.length} excluded.</p>
          <Link className="btn" to={`/cases/${res.case.id}/rescue/${res.requirement.id}`}>Open ranked sources and reserve</Link>
          <ul className="small">{res.eligible.slice(0, 3).map((e: any) => <li key={e.stockItemId + e.locationId}>{e.label} at {e.location}: arrives {fmtTime(e.estimatedArrival, res.case.timezone)} ({e.meetsCutoff ? 'before cutoff' : 'AFTER cutoff'}) · <EvidenceBadge e={e.evidence} /></li>)}</ul>
        </div>)}
      {res?.mode === 'stock' && (
        <div>
          <p><strong>{res.item.ref}</strong> {res.item.description}: <strong>{res.usableTotal}</strong> usable unit(s) across {res.rows.length} location(s). <span className="muted small">{res.note}</span></p>
          {res.rows.map((r: any) => (
            <div key={r.stockItemId + r.location} className={`card avail ${r.usable ? '' : 'unusable'}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}><strong>{r.label}</strong><span className={r.usable ? 'badge st-ready' : 'badge st-cancelled'}>{r.usable ? `${r.usable} usable` : 'Not usable'}</span></div>
              <div className="small">{r.location} · custodian {r.custodian} · owner {r.owner} · expiry {r.expiry ?? '—'}</div>
              <div className="small"><EvidenceBadge e={r.evidence} /></div>
              {r.whyNot.length > 0 && <div className="small sev-warning">Why not: {r.whyNot.join('; ')}</div>}
            </div>))}
        </div>)}
    </div>
  );
}
