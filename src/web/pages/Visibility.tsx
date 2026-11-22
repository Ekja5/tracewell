/** Where everything is, each case from entry to close, and the run sheet. Read-only views over the ledger and shipments. */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData, Err } from '../App';

const BUCKETS = ['warehouse', 'reps', 'hospitals', 'inTransit', 'quarantine', 'returns'];

export function WhereIsEverything() {
  const { data, error, reload } = useData<any>('/api/stock/where');
  const [open, setOpen] = useState<string | null>(null); const [q, setQ] = useState(''); const [only, setOnly] = useState(false);
  useEffect(() => { const t = setInterval(reload, 60000); return () => clearInterval(t); }, [reload]);
  const items = (data?.items ?? []).filter((it: any) => (!q || `${it.ref} ${it.description}`.toLowerCase().includes(q.toLowerCase())) && (!only || it.gap > 0));
  return (<div>
    <div className="row" style={{ justifyContent: 'space-between' }}><h1>Where everything is</h1><button className="secondary" onClick={reload}>Refresh</button></div>
    <p className="muted small">Every unit by where it is right now, as of {data?.asOfLocal}. {data?.note}</p>
    <Err e={error} />
    {data && <div className="nums" data-testid="where-totals">{BUCKETS.map((b) => <div key={b} className="num"><span className="num-v">{data.totals[b]}</span><span className="num-l">{data.labels[b]}</span></div>)}</div>}
    <div className="row tight"><input aria-label="Filter items" placeholder="Filter by catalog number or description" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
      <label className="small"><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Only items with not enough free stock for the next {data?.windowHours} h</label></div>
    <div className="table-wrap"><table aria-label="Inventory by location"><thead><tr><th>Item</th>{BUCKETS.map((b) => <th key={b}>{data?.labels[b]}</th>)}<th>Total</th><th>Reserved</th><th>Free</th><th>Unreserved case demand</th><th></th></tr></thead>
      <tbody>{items.map((it: any) => <React.Fragment key={it.catalogItemId}>
        <tr data-item={it.ref} className={it.gap > 0 ? 'row-bad' : ''}><td><strong>{it.ref}</strong><div className="small muted">{it.description}</div></td>{BUCKETS.map((b) => <td key={b}>{it.buckets[b] || <span className="muted">·</span>}</td>)}
          <td><strong>{it.total}</strong></td><td>{it.reserved}</td><td>{it.free}{it.onHold > 0 && <div className="small sev-critical">{it.onHold} on hold</div>}{it.onLoan > 0 && <div className="small muted">{it.onLoan} on loan</div>}</td>
          <td>{it.unreservedDemand}{it.gap > 0 && <div><span className="badge st-blocked">{it.gap} short</span></div>}</td>
          <td><button className="secondary" aria-expanded={open === it.catalogItemId} onClick={() => setOpen(open === it.catalogItemId ? null : it.catalogItemId)}>{open === it.catalogItemId ? 'Hide' : 'Units'}</button></td></tr>
        {open === it.catalogItemId && <tr><td colSpan={BUCKETS.length + 6}><div className="table-wrap"><table aria-label={`Units of ${it.ref}`}><thead><tr><th>Unit</th><th>Where</th><th>Held by</th><th>Qty</th><th>Reserved for</th><th>Free</th><th>Expiry</th><th>Owner</th></tr></thead>
          <tbody>{it.units.map((u: any, i: number) => <tr key={i}><td>{u.unit}</td><td>{u.location}<div className="small muted">{u.bucketLabel}{u.shipment ? ` · ${u.shipment}` : ''}</div></td><td>{u.holder ?? '—'}</td><td>{u.qty}{u.condition !== 'sealed' && <div className="small sev-warning">{u.condition}</div>}</td>
            <td>{u.reservedFor ?? '—'}</td><td>{u.free}{u.onHold && <div className="small sev-critical">on hold</div>}</td><td>{u.expiry ?? '—'}</td><td className="small">{u.owner}{u.loaner && <div className="muted">loaner {u.loaner}</div>}</td></tr>)}</tbody></table></div></td></tr>}
      </React.Fragment>)}
        {data && !items.length && <tr><td colSpan={BUCKETS.length + 6} className="muted">No items match.</td></tr>}</tbody></table></div>
  </div>);
}

function Track({ steps }: { steps: any[] }) {
  const cur = steps.findIndex((s) => !s.done);
  return <ol className="track" aria-label="Progress">{steps.map((s, i) => <li key={s.name} className={s.done ? 'done' : i === cur ? 'next' : ''} title={s.name}><span className="sr">{s.name}: {s.done ? 'done' : i === cur ? 'next' : 'not yet'}</span></li>)}</ol>;
}
function TrackTable({ list, label }: { list: any[]; label: string }) {
  return <div className="table-wrap"><table aria-label={label}><thead><tr><th>Case</th><th>Surgery</th><th>Rep</th><th>Progress</th><th>Stage</th><th>Waiting on</th></tr></thead>
    <tbody>{list.map((c) => <tr key={c.id} data-case={c.caseRef} data-stage={c.stageName} className={c.behind ? 'row-bad' : ''}><td><Link to={`/cases/${c.id}`}><strong>{c.caseRef}</strong></Link><div className="small muted">{c.facility}</div></td><td className="small">{c.startLocal}<div className="muted">entered {c.enteredLocal}</div></td><td>{c.rep ?? '—'}</td>
      <td><Track steps={c.steps} /></td><td><span className={`badge ${c.stageName === 'Closed' ? 'st-ready' : c.behind ? 'st-blocked' : 'st-at_risk'}`}>{c.stageName}</span></td><td className="small">{c.waitingOn ?? '—'}</td></tr>)}
      {!list.length && <tr><td colSpan={6} className="muted">None.</td></tr>}</tbody></table></div>;
}
export function CaseTracker() {
  const { data, error } = useData<any>('/api/case-tracker');
  return (<div><h1>Case tracker</h1>
    <p className="muted small">Each case from the moment it was entered to the moment it is closed and everything is back. One line per case, with the one thing it is waiting on. Rows in red are behind for where the surgery date is.</p>
    <Err e={error} />
    {data && <p className="small"><strong>Stages:</strong> {data.stages.join(' → ')}{data.toBringBack > 0 && <> · <strong>{data.toBringBack}</strong> unit(s) still at hospitals after finished cases</>}</p>}
    <h2>Upcoming ({data?.upcoming.length ?? 0})</h2>{data && <TrackTable list={data.upcoming} label="Upcoming cases" />}
    <h2>Last 7 days ({data?.recent.length ?? 0})</h2>{data && <TrackTable list={data.recent} label="Recent cases" />}
  </div>);
}

function Stop({ s }: { s: any }) {
  return <tr data-ref={s.ref} className={s.late ? 'row-bad' : ''}><td><Link to={`/shipments/${s.id}`}><strong>{s.ref}</strong></Link><div className="small muted">{s.kindLabel}</div></td><td>{s.to}{s.caseRef && <div className="small muted">for <Link to={`/cases/${s.caseId}`}>{s.caseRef}</Link></div>}</td>
    <td className="small">{s.units} unit(s)<div className="muted">{s.items}</div></td><td className="small">{s.who}{s.plannedPickupLocal && <div className="muted">planned {s.plannedPickupLocal}</div>}</td>
    <td className="small">{s.leaveByLocal ?? '—'}{s.minutesLeft != null && <div className={s.late ? 'sev-critical' : s.minutesLeft < 120 ? 'sev-warning' : 'muted'}>{s.late ? `${-s.minutesLeft} min overdue` : `${Math.floor(s.minutesLeft / 60)} h ${s.minutesLeft % 60} min left`}</div>}</td>
    <td className="small">{s.dueLocal ?? '—'}<div className="muted">{s.travelMinutes != null ? `${s.travelMinutes} min travel (estimate)` : 'no travel estimate'}</div></td><td><span className="badge st-at_risk">{s.status}</span><div className="small">Next: {s.next}</div></td></tr>;
}
export function RunSheet() {
  const { data, error, reload } = useData<any>('/api/run-sheet');
  useEffect(() => { const t = setInterval(reload, 60000); return () => clearInterval(t); }, [reload]);
  const head = <thead><tr><th>Shipment</th><th>To</th><th>What</th><th>Who</th><th>Must leave by</th><th>Required there by</th><th>Status</th></tr></thead>;
  return (<div>
    <div className="row" style={{ justifyContent: 'space-between' }}><h1>Run sheet</h1><div className="row tight"><button className="secondary" onClick={() => window.print()}>Print</button><button className="secondary" onClick={reload}>Refresh</button></div></div>
    <p className="muted small">What has to leave, from where, as of {data?.asOfLocal}. {data?.note}</p>
    <Err e={error} />
    {data && <p data-testid="run-counts"><span className="badge st-at_risk">{data.counts.toLeave} to leave</span> {data.counts.late > 0 && <span className="badge st-blocked">{data.counts.late} past their departure time</span>} <span className="badge st-closed">{data.counts.onTheRoad} on the road</span></p>}
    {data?.toLeave.map((g: any) => <section key={g.from} className="card" data-from={g.from}><h2 style={{ marginTop: 0 }}>From {g.from} <span className="small muted">({g.stops.length} stop{g.stops.length === 1 ? '' : 's'})</span></h2>
      <div className="table-wrap"><table aria-label={`Leaving ${g.from}`}>{head}<tbody>{g.stops.map((s: any) => <Stop key={s.id} s={s} />)}</tbody></table></div></section>)}
    {data && !data.toLeave.length && <div className="ok">Nothing is waiting to leave.</div>}
    <h2>On the road ({data?.onTheRoad.length ?? 0})</h2>
    <div className="table-wrap"><table aria-label="On the road">{head}<tbody>{data?.onTheRoad.map((s: any) => <Stop key={s.id} s={s} />)}{data && !data.onTheRoad.length && <tr><td colSpan={7} className="muted">Nothing in transit.</td></tr>}</tbody></table></div>
    {data?.loanerReturns.length > 0 && <><h2>Loaners to send back</h2><div className="table-wrap"><table aria-label="Loaner returns"><thead><tr><th>Loaner</th><th>Item</th><th>Used for</th><th>Where it is</th><th>Return to</th><th>Due back</th></tr></thead>
      <tbody>{data.loanerReturns.map((l: any) => <tr key={l.id}><td><Link to={`/loaners/${l.id}`}>{l.ref}</Link></td><td>{l.qty} x {l.item}</td><td>{l.caseRef}</td><td>{l.at}</td><td>{l.source}</td><td>{l.dueBack}</td></tr>)}</tbody></table></div></>}
  </div>);
}
