/** Enter a case on screen with an instant stock check, and the week-by-week demand plan. */
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useData, Err } from '../App';
import { post } from '../lib/api';

export function CaseEntry() {
  const nav = useNavigate();
  const { data: o, error } = useData<any>('/api/case-entry/options');
  const [f, setF] = useState<any>({ facilityId: '', date: '', time: '07:30', procedure: '', surgeon: '', repUserId: '', urgent: false, caseRef: '', previousId: '' });
  const [items, setItems] = useState<{ catalogItemId: string; qty: number }[]>([{ catalogItemId: '', qty: 1 }]);
  const [check, setCheck] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }); setCheck(null); };
  const setItem = (i: number, patch: any) => { setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x))); setCheck(null); };
  const body = () => ({ ...f, items: items.filter((x) => x.catalogItemId) });
  const run = async (commit: boolean) => {
    setErr(null); setBusy(true);
    try { const r = await post(commit ? '/api/case-entry' : '/api/case-entry/preview', body()); if (commit) nav(`/cases/${r.caseId}`); else setCheck(r); } catch (e: any) { setErr(e.message); setCheck(null); } finally { setBusy(false); }
  };
  const tz = o?.hospitals.find((h: any) => h.id === f.facilityId)?.timezone;
  return (<div style={{ maxWidth: 980 }}>
    <h1>Enter a case</h1>
    <p className="muted small">Enter a case as soon as the hospital tells you about it. Before you save, the stock check shows what this case would get under your rule ({o?.rule?.toLowerCase()}), and what it would still be short. No patient information belongs here.</p>
    <Err e={error ?? err} />
    <section className="card"><h2 style={{ marginTop: 0 }}>1. The case</h2><div className="row">
      <label className="field">Hospital<select value={f.facilityId} onChange={set('facilityId')} aria-label="Hospital"><option value="">Choose…</option>{o?.hospitals.map((h: any) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
      <label className="field">Surgery date<input type="date" value={f.date} onChange={set('date')} aria-label="Surgery date" /></label>
      <label className="field">Start time{tz ? ` (${tz.split('/')[1].replace('_', ' ')} time)` : ''}<input type="time" value={f.time} onChange={set('time')} aria-label="Start time" /></label></div>
      <div className="row"><label className="field">Procedure<input list="procs" value={f.procedure} onChange={set('procedure')} aria-label="Procedure" /><datalist id="procs">{o?.procedures.map((p: string) => <option key={p} value={p} />)}</datalist></label>
        <label className="field">Surgeon code<input value={f.surgeon} onChange={set('surgeon')} aria-label="Surgeon code" placeholder="e.g. Surgeon S-104" /></label>
        <label className="field">Rep<select value={f.repUserId} onChange={set('repUserId')} aria-label="Rep"><option value="">Not assigned yet</option>{o?.reps.map((r: any) => <option key={r.id} value={r.id}>{r.display_name}</option>)}</select></label></div>
      <div className="row"><label className="field">Case ID (optional; one is assigned if blank)<input value={f.caseRef} onChange={set('caseRef')} aria-label="Case ID" /></label>
        <label className="field">ID in your previous system (optional)<input value={f.previousId} onChange={set('previousId')} aria-label="Previous system ID" /></label>
        <label className="small" style={{ alignSelf: 'flex-end', paddingBottom: 12 }}><input type="checkbox" checked={f.urgent} onChange={set('urgent')} /> Urgent add-on (moves it up the queue and alerts the warehouse)</label></div></section>
    <section className="card"><h2 style={{ marginTop: 0 }}>2. What it needs</h2>
      {items.map((it, i) => <div className="row" key={i}><label className="field" style={{ flex: 3 }}>Item<select value={it.catalogItemId} onChange={(e) => setItem(i, { catalogItemId: e.target.value })} aria-label={`Item ${i + 1}`}><option value="">Choose…</option>{o?.items.map((x: any) => <option key={x.id} value={x.id}>{x.ref} · {x.description}{x.manufacturer ? ` · ${x.manufacturer}` : ''}</option>)}</select></label>
        <label className="field">Qty<input type="number" min={1} max={99} value={it.qty} onChange={(e) => setItem(i, { qty: Number(e.target.value) })} aria-label={`Quantity ${i + 1}`} /></label>
        {items.length > 1 && <button className="secondary" style={{ alignSelf: 'flex-end' }} onClick={() => { setItems(items.filter((_, j) => j !== i)); setCheck(null); }}>Remove</button>}</div>)}
      <button className="secondary" onClick={() => setItems([...items, { catalogItemId: '', qty: 1 }])}>Add another item</button></section>
    <div className="row"><button className="secondary" disabled={busy} onClick={() => run(false)}>Check stock</button><button disabled={busy || !check} title={check ? '' : 'Check stock first'} onClick={() => run(true)}>Save the case{check && !check.covered ? ' anyway' : ''}</button></div>
    {check && <section className={`card ${check.covered ? '' : 'q-item q-critical'}`} data-testid="entry-check" data-covered={String(check.covered)}>
      <h2 style={{ marginTop: 0 }}>{check.covered ? 'Fully covered' : 'Not fully covered'} <span className="small muted">· {check.facility}, {check.startLocal} · rule: {check.rule}</span></h2>
      <div className="table-wrap"><table aria-label="Stock check"><thead><tr><th>Item</th><th>Required</th><th>Would be reserved</th><th>Short</th><th>What this means</th></tr></thead>
        <tbody>{check.items.map((r: any) => <tr key={r.ref}><td><strong>{r.ref}</strong><div className="small muted">{r.description}</div></td><td>{r.required}</td><td>{r.reserved}</td><td>{r.short ? <span className="badge st-blocked">{r.short}</span> : <span className="badge st-ready">0</span>}</td><td className="small">{r.message}</td></tr>)}</tbody></table></div>
      <p className="small muted">Nothing has been saved yet. Saving creates the case, reserves what is shown, and puts anything short into Needs attention.</p></section>}
  </div>);
}

export function DemandPlan() {
  const [weeks, setWeeks] = useState(4);
  const { data, error } = useData<any>(`/api/demand-plan?weeks=${weeks}`, [weeks]);
  return (<div>
    <h1>Demand plan</h1>
    <p className="muted small">As of {data?.asOfLocal}. {data?.note}</p>
    <div className="row tight" role="group" aria-label="Weeks ahead">{[2, 4, 6, 8].map((w) => <button key={w} className={weeks === w ? '' : 'secondary'} aria-pressed={weeks === w} onClick={() => setWeeks(w)}>{w} weeks</button>)}
      {data && <span className={`badge ${data.short ? 'st-blocked' : 'st-ready'}`}>{data.short ? `${data.short} item(s) run out on the current schedule` : 'No item runs out on the current schedule'}</span>}</div>
    <Err e={error} />
    <div className="table-wrap"><table aria-label="Demand plan"><thead><tr><th>Item</th><th>Usable now</th>{data?.weeks.map((w: any) => <th key={w.index}>{w.label}<div className="tiny muted">needs → left</div></th>)}<th>Recent avg / week</th><th>Par</th><th>Owed</th><th>What to do</th></tr></thead>
      <tbody>{data?.items.map((r: any) => <tr key={r.catalogItemId} data-item={r.ref} className={r.shortWeek ? 'row-bad' : ''}><td><strong>{r.ref}</strong><div className="small muted">{r.description}</div></td><td><strong>{r.usable}</strong></td>
        {r.weeks.map((w: any, i: number) => <td key={i} title={w.cases.join(', ')}>{w.demand ? <>{w.demand} → </> : <span className="muted">· → </span>}<span className={w.balance < 0 ? 'sev-critical' : ''}>{w.balance}</span>{w.cases.length > 0 && <div className="tiny muted">{w.cases.join(', ')}</div>}</td>)}
        <td>{r.recentPerWeek}{r.vsAverage && <div className="tiny sev-warning">schedule below average</div>}</td><td>{r.par || '—'}</td><td>{r.owed || '—'}</td><td className="small">{r.suggestion}{r.vsAverage && <div className="muted">{r.vsAverage}</div>}</td></tr>)}</tbody></table></div>
    <p className="small muted">See also <Link to="/usage">Usage and consumption</Link> for what was actually used, and <Link to="/stock/par">Par levels</Link>.</p>
  </div>);
}
