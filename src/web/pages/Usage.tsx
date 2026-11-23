/** Usage and consumption: what was used, where, by whom, how often, its value at contract price, and replacements still owed. */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useData, useMe, Err } from '../App';
import { money, post } from '../lib/api';

export function UsageReport() {
  const { can } = useMe();
  const [days, setDays] = useState(30);
  const { data, error, reload } = useData<any>(`/api/usage-report?days=${days}`, [days]);
  const [sel, setSel] = useState<Record<string, boolean>>({}); const [po, setPo] = useState(''); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const s = data?.summary; const max = Math.max(1, ...(data?.weeks ?? []).map((w: any) => w.units));
  const ids = Object.keys(sel).filter((k) => sel[k]);
  const mark = async () => { setErr(null); setMsg(null); try { const r = await post('/api/replenishments/done', { ids, orderRef: po }); setMsg(`${r.marked} line(s) marked replaced. ${r.remaining} unit(s) still owed.`); setSel({}); setPo(''); reload(); } catch (e: any) { setErr(e.message); } };
  return (<div>
    <h1>Usage and consumption</h1>
    <p className="muted small">{data ? `${data.sinceLocal} to ${data.asOfLocal}. ` : ''}{data?.note}</p>
    <div className="row tight" role="group" aria-label="Period">{[30, 60, 90].map((d) => <button key={d} className={days === d ? '' : 'secondary'} aria-pressed={days === d} onClick={() => setDays(d)}>Last {d} days</button>)}</div>
    <Err e={error ?? err} />{msg && <div className="ok" role="status">{msg}</div>}
    {s && <div className="nums" data-testid="usage-summary">
      <div className="num"><span className="num-v">{s.cases}</span><span className="num-l">cases finished</span></div>
      <div className="num"><span className="num-v">{s.unitsUsed}</span><span className="num-l">units used</span></div>
      <div className="num"><span className="num-v">{s.implanted}</span><span className="num-l">implanted</span></div>
      <div className={`num ${s.wasted + s.openedUnused ? 'bad' : ''}`}><span className="num-v">{s.wasted + s.openedUnused}</span><span className="num-l">wasted or opened unused ({s.wastePct}%)</span></div>
      <div className="num"><span className="num-v">{money(s.valueCents)}</span><span className="num-l">at contract price (draft)</span></div>
      <div className={`num ${s.replacementsOwed ? 'bad' : 'good'}`}><span className="num-v">{s.replacementsOwed}</span><span className="num-l">replacement units owed</span></div>
      <div className="num"><span className="num-v">{s.avgDaysToReplace ?? '—'}</span><span className="num-l">avg days, use to replaced</span></div></div>}
    {data && <section className="card"><h2 style={{ marginTop: 0 }}>Units used per week</h2>
      <div className="bars" role="img" aria-label={`Units used per week: ${data.weeks.map((w: any) => `${w.week} ${w.units}`).join(', ')}`}>{data.weeks.map((w: any) => <div key={w.week} className="bar-col"><span className="small">{w.units}</span><div className="bar" style={{ height: `${Math.round((w.units / max) * 100)}%` }} /><span className="tiny muted">wk of {w.week.slice(5)}</span></div>)}</div></section>}
    <h2>By item</h2>
    <div className="table-wrap"><table aria-label="Usage by item"><thead><tr><th>Item</th><th>Used</th><th>Implanted</th><th>Wasted / opened unused</th><th>Cases</th><th>Last used</th><th>Days between uses</th><th>Per week</th><th>Usable now</th><th>Weeks of cover</th><th>Owed</th><th>Value</th></tr></thead>
      <tbody>{data?.items.map((r: any) => <tr key={r.catalogItemId} data-item={r.ref}><td><strong>{r.ref}</strong><div className="small muted">{r.description}</div></td><td><strong>{r.used}</strong></td><td>{r.implanted}</td><td>{r.wasted + r.openedUnused || '—'}</td><td>{r.cases}</td><td className="small">{r.lastUsedLocal ?? '—'}</td><td>{r.daysBetweenUses ?? '—'}</td><td>{r.perWeek}</td><td>{r.usableNow}</td>
        <td>{r.weeksOfCover == null ? '—' : <span className={`badge ${r.weeksOfCover < 1 ? 'st-blocked' : r.weeksOfCover < 2 ? 'st-at_risk' : 'st-ready'}`}>{r.weeksOfCover}</span>}</td><td>{r.replacementsOwed || '—'}</td><td>{money(r.valueCents)}</td></tr>)}
        {data && !data.items.length && <tr><td colSpan={12} className="muted">No usage was recorded in this period.</td></tr>}</tbody></table></div>
    <div className="row" style={{ alignItems: 'flex-start' }}>
      {[['By hospital', data?.hospitals], ['By rep', data?.reps]].map(([title, list]: any) => <div key={title} style={{ flex: 1, minWidth: 300 }}><h2>{title}</h2><div className="table-wrap"><table aria-label={title}><thead><tr><th>{title.slice(3)}</th><th>Cases</th><th>Units</th><th>Value</th></tr></thead>
        <tbody>{list?.map((g: any) => <tr key={g.name}><td>{g.name}</td><td>{g.cases}</td><td>{g.units}</td><td>{money(g.valueCents)}</td></tr>)}</tbody></table></div></div>)}
    </div>
    <h2>Replacements owed ({data?.owed.length ?? 0})</h2>
    <p className="small muted">Each line is stock a contract says must be replaced after a case. Marking it replaced records when and against which order; it does not add stock (that arrives through a receipt, count or upload).</p>
    <div className="table-wrap"><table aria-label="Replacements owed"><thead><tr><th></th><th>Item</th><th>Qty</th><th>From case</th><th>Hospital</th><th>Owed since</th><th>Days open</th></tr></thead>
      <tbody>{data?.owed.map((r: any) => <tr key={r.id}><td>{can('par.manage') && <input type="checkbox" aria-label={`Select ${r.ref} from ${r.caseRef}`} checked={!!sel[r.id]} onChange={(e) => setSel({ ...sel, [r.id]: e.target.checked })} />}</td><td>{r.ref}<div className="small muted">{r.description}</div></td><td>{r.qty}</td><td><Link to={`/cases/${r.caseId}`}>{r.caseRef}</Link></td><td>{r.facility}</td><td className="small">{r.sinceLocal}</td><td>{r.daysOpen}</td></tr>)}
        {data && !data.owed.length && <tr><td colSpan={7} className="muted">Nothing is owed.</td></tr>}</tbody></table></div>
    {can('par.manage') && data?.owed.length > 0 && <div className="row"><label className="field">Order or PO reference (optional)<input value={po} onChange={(e) => setPo(e.target.value)} /></label><button disabled={!ids.length} onClick={mark}>Mark {ids.length || ''} replaced</button>
      <button className="secondary" onClick={() => setSel(Object.fromEntries(data.owed.map((r: any) => [r.id, true])))}>Select all</button></div>}
  </div>);
}
