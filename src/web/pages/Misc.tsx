import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useData, useMe, Status, Err, Simulated } from '../App';
import { fmtTime, post } from '../lib/api';

export function Inventory() {
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const inv = useData<any[]>(`/api/inventory?q=${encodeURIComponent(sp.get('q') ?? '')}`);
  const rec = useData<any>('/api/ledger/reconcile');
  const [ledgerFor, setLedgerFor] = useState<string | null>(null);
  const ledger = useData<any[]>(ledgerFor ? `/api/ledger?stockItemId=${ledgerFor}` : null, [ledgerFor]);
  return (
    <div>
      <h1>Inventory</h1>
      <form className="row card" onSubmit={(e) => { e.preventDefault(); setSp({ q }); }}>
        <label className="field">Exact ref, lot, serial or GTIN<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. NP-INS-4-10, L26C014, INS-0002" /></label>
        <button style={{ alignSelf: 'flex-end' }}>Search</button>
        <a className="btn secondary" style={{ alignSelf: 'flex-end' }} href="/api/exports/balances.csv">Export balances</a>
        <a className="btn secondary" style={{ alignSelf: 'flex-end' }} href="/api/exports/ledger.csv">Export ledger</a>
      </form>
      {rec.data && <div className={rec.data.matches ? 'ok' : 'alert'} role="status">Ledger rebuild {rec.data.matches ? 'matches' : 'DOES NOT match'} displayed balances ({rec.data.movementCount} movements). {rec.data.totalsByLocationKind.map((t: any) => `${t.kind}: ${t.on_hand}`).join(' · ')}</div>}
      <Err e={inv.error} />
      <div className="table-wrap"><table aria-label="Balances">
        <thead><tr><th>Item</th><th>Unit</th><th>Expiry</th><th>Location</th><th>Owner</th><th>Condition</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Hold</th><th></th></tr></thead>
        <tbody>{(inv.data ?? []).map((b: any) => (
          <tr key={b.stock_item_id + b.location_id + b.owner_party_id + b.condition}>
            <td><strong>{b.ref}</strong><div className="small">{b.description}</div></td><td>{b.serial_number ? `SN ${b.serial_number}` : ''} lot {b.lot_number}</td><td>{b.expiry_date ?? '—'}</td>
            <td>{b.location_code}<div className="small muted">{b.location_kind}</div></td><td className="small">{b.owner}</td><td>{b.condition}</td><td>{b.on_hand}</td><td>{b.reserved}</td>
            <td>{b.on_hold || b.condition !== 'sealed' || !b.allocatable ? 0 : Math.max(0, b.on_hand - b.reserved)}</td><td>{b.on_hold ? <span className="badge st-blocked">HOLD</span> : ''}</td>
            <td><button className="link" onClick={() => setLedgerFor(b.stock_item_id)}>Ledger</button></td>
          </tr>))}</tbody></table></div>
      {ledgerFor && ledger.data && (
        <section className="card"><h2>Source movements (append-only)</h2>
          <div className="table-wrap"><table><thead><tr><th>#</th><th>Type</th><th>Qty</th><th>From</th><th>To</th><th>Occurred</th><th>Recorded</th><th>Actor</th><th>Reason</th></tr></thead>
            <tbody>{ledger.data.map((m: any) => <tr key={m.id}><td>{m.id}{m.reverses_movement_id ? ` (reverses ${m.reverses_movement_id})` : ''}</td><td>{m.movement_type}</td><td>{m.qty}</td><td>{m.from_code ?? '—'} {m.from_condition ?? ''}</td><td>{m.to_code ?? '—'} {m.to_condition ?? ''}</td><td className="small">{fmtTime(m.occurred_at)}</td><td className="small">{fmtTime(m.recorded_at)}</td><td>{m.actor}</td><td className="small">{m.reason}</td></tr>)}</tbody></table></div>
        </section>)}
    </div>
  );
}

export function Exceptions() {
  const [status, setStatus] = useState('open');
  const { can } = useMe();
  const { data, error, reload } = useData<any[]>(`/api/exceptions?status=${status}`, [status]);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <h1>Exception queue</h1>
      <p className="small muted">Disputed observations, discrepancies, finance exceptions, recall escalations and failed integrations stay visible here until resolved at their source.</p>
      <div className="row"><select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter"><option value="open">Open</option><option value="resolved">Resolved</option></select>{can('usage.review') && <Link to="/usage-review">Usage lines needing review</Link>}</div>
      <Err e={error ?? err} />
      <div className="table-wrap"><table><thead><tr><th>Severity</th><th>Title</th><th>Detail</th><th>Case</th><th>Owner</th><th>Raised</th><th></th></tr></thead>
        <tbody>{(data ?? []).map((e) => (
          <tr key={e.id}><td><Status s={e.severity} /></td><td>{e.title}</td><td className="small">{e.detail}{e.resolution ? ` | Resolution: ${e.resolution}` : ''}</td><td>{e.case_id ? <Link to={`/cases/${e.case_id}`}>{e.case_ref}</Link> : '—'}</td><td>{e.owner_role}</td><td className="small">{fmtTime(e.created_at)}</td>
            <td>{e.status === 'open' && can('exception.resolve') && <button className="link" onClick={async () => { const n = prompt('Resolution note'); if (!n) return; try { await post(`/api/exceptions/${e.id}/resolve`, { resolution: n }); reload(); } catch (x: any) { setErr(x.message); } }}>Resolve</button>}</td></tr>))}</tbody></table></div>
    </div>
  );
}

export function UsageReview() {
  const { data, error, reload } = useData<any[]>('/api/usage-review');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <h1>Usage lines needing review</h1>
      <p className="small muted">Link each line to an existing validated stock record (from a label, import, or prior reviewed entry). Stock is never created from a scan.</p>
      <Err e={error ?? err} />
      {(data ?? []).map((u) => <ReviewRow key={u.id} u={u} onDone={reload} onErr={setErr} />)}
      {data && !data.length && <p className="muted">Nothing to review.</p>}
    </div>
  );
}
function ReviewRow({ u, onDone, onErr }: { u: any; onDone: () => void; onErr: (e: string) => void }) {
  const [q, setQ] = useState('');
  const [cands, setCands] = useState<any[]>([]);
  const [pick, setPick] = useState('');
  const [qty, setQty] = useState('');
  return (
    <div className="card small">
      <div><strong>{u.case_ref}</strong> · {u.disposition} · {u.entry_method} · raw <code>{(u.raw_scan ?? '').replace(/\x1d/g, '<GS>')}</code> · {u.review_reason}</div>
      <div className="row"><input placeholder="Search serial / lot / ref" value={q} onChange={(e) => setQ(e.target.value)} /><button className="secondary" onClick={async () => { const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json()); setCands(r.stock ?? []); }}>Find records</button>
        <select value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Select validated record…</option>{cands.map((c: any) => <option key={c.stock_item_id + c.location_id} value={c.stock_item_id}>{c.ref} {c.serial_number ?? ''} lot {c.lot_number} @ {c.location_code}</option>)}</select>
        <input type="number" placeholder="Units" style={{ width: 90 }} value={qty} onChange={(e) => setQty(e.target.value)} />
        <button onClick={async () => { const n = prompt('Review note'); if (!n) return; try { await post(`/api/usage/${u.id}/review`, { decision: 'accept', stockItemId: pick, qtyUnits: qty ? Number(qty) : undefined, note: n }); onDone(); } catch (e: any) { onErr(e.message); } }}>Accept</button>
        <button className="danger" onClick={async () => { const n = prompt('Reason for rejection'); if (!n) return; try { await post(`/api/usage/${u.id}/review`, { decision: 'reject', note: n }); onDone(); } catch (e: any) { onErr(e.message); } }}>Reject</button></div>
    </div>
  );
}

export function Integrations() {
  const { can } = useMe();
  const { data, error, reload } = useData<any>('/api/integrations');
  const [err, setErr] = useState<string | null>(null);
  const call = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); reload(); } catch (e: any) { setErr(e.message); } };
  return (
    <div>
      <h1>Integrations</h1>
      <div className="note">Every integration in this pilot is simulated or not connected. Live customer connections are disabled until credentials, data mappings, permissions and acceptance criteria exist. No incumbent or customer system is accessed.</div>
      <Err e={error ?? err} />
      <div className="table-wrap"><table><thead><tr><th>Feed</th><th>Mode</th><th>Last successful sync</th><th>Last error</th><th>Unresolved differences</th><th>Field ownership</th><th></th></tr></thead>
        <tbody>{(data?.feeds ?? []).map((f: any) => {
          const stale = f.simulated && f.last_success_at && Date.now() - new Date(f.last_success_at).getTime() > f.stale_after_minutes * 60e3 + Math.abs(Number(localStorage.getItem('tw-skew') ?? 0));
          return (<tr key={f.id}><td>{f.name}</td><td>{f.simulated ? <Simulated /> : <span className="badge st-cancelled">NOT CONNECTED</span>}</td>
            <td>{f.last_success_at ? fmtTime(f.last_success_at) : 'never'}{stale && <div className="small sev-warning">stale</div>}</td><td className="small">{f.last_error ?? ''}</td><td>{f.open_differences}</td>
            <td className="small">{Object.entries(f.field_ownership).map(([k, v]) => `${k}: ${v}`).join('; ')}</td>
            <td>{can('integration.manage') && f.simulated && f.code.startsWith('sched') && <button className="secondary" onClick={() => call(() => post(`/api/integrations/${f.id}/simulate-sync`))}>Run simulated sync</button>}
              {can('integration.manage') && f.code === 'erp-mock' && <><button className="secondary" onClick={() => call(() => post('/api/integrations/erp/run'))}>Process outbox now</button><button className="secondary" onClick={() => call(() => post('/api/integrations/erp/fail-next', { count: 2 }))}>Inject 2 failures</button></>}</td></tr>);
        })}</tbody></table></div>
      <h2>Unresolved differences</h2>
      {(data?.differences ?? []).map((d: any) => <div key={d.id} className="small">{d.feed}: {d.entity} {d.entity_ref} {d.field}: ours "{d.our_value}" vs theirs "{d.their_value}"</div>)}
      <h2>Outbox <Simulated /></h2>
      <div className="table-wrap"><table><thead><tr><th>Created</th><th>Topic</th><th>Case</th><th>Status</th><th>Attempts</th><th>Delivery log</th><th>Acknowledgments</th><th></th></tr></thead>
        <tbody>{(data?.outbox ?? []).map((o: any) => <tr key={o.id}><td className="small">{fmtTime(o.created_at)}</td><td>{o.topic}</td><td>{o.case_ref}</td><td><Status s={o.status} /></td><td>{o.attempts}</td>
          <td className="small">{(o.attempts_log ?? []).map((a: any, i: number) => <div key={i}>{fmtTime(a.at)}: {a.result}{a.detail?.error ? ` (${a.detail.error})` : ''}</div>)}</td>
          <td className="small">{(o.acks ?? []).map((a: any, i: number) => <div key={i}>{a.type} {a.ref} {fmtTime(a.at)}</div>)}</td>
          <td>{can('integration.manage') && o.acks?.length > 0 && <button className="link" onClick={() => call(() => post('/api/integrations/erp/replay-ack', { outboxId: o.id }))}>Replay ack (idempotency check)</button>}</td></tr>)}</tbody></table></div>
    </div>
  );
}

export function Metrics() {
  const [days, setDays] = useState(30);
  const { data, error } = useData<any>(`/api/metrics?days=${days}`, [days]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <h1>Pilot scorecard</h1>
      <div className="note">Values are computed from persisted records in this environment. All current data is synthetic; these are not customer results and imply no savings.</div>
      <label className="row">Date range <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></label>
      <Err e={error} />
      <div className="kpis">{(data?.metrics ?? []).map((m: any) => (
        <div key={m.key} className="card kpi">
          <div className="small muted">{m.name} <span className="badge sim">SYNTHETIC</span></div>
          <div className="v">{m.value ?? '—'} <span className="small">{m.unit}</span></div>
          <div className="small">{m.numerator != null ? `${m.numerator} / ${m.denominator}` : `n = ${m.denominator}`} · {fmtTime(m.range.from, undefined, { weekday: undefined, hour: undefined, minute: undefined, timeZoneName: undefined })} to {fmtTime(m.range.to, undefined, { weekday: undefined, hour: undefined, minute: undefined, timeZoneName: undefined })}</div>
          <p className="small muted">{m.definition}</p>
          <button className="link" onClick={() => setOpen(open === m.key ? null : m.key)}>{open === m.key ? 'Hide' : 'Show'} source records ({m.drill.length})</button>
          {open === m.key && <pre className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(m.drill, null, 1)}</pre>}
        </div>))}</div>
    </div>
  );
}

export function SearchPage() {
  const [sp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const { data, error } = useData<any>(`/api/search?q=${encodeURIComponent(q)}`, [q]);
  return (
    <div>
      <h1>Search: "{q}"</h1><Err e={error} />
      <h2>Cases</h2>{(data?.cases ?? []).map((c: any) => <div key={c.id}><Link to={`/cases/${c.id}`}>{c.case_ref}</Link> {c.facility} {fmtTime(c.scheduled_start, c.timezone)} <Status s={c.status} /></div>)}
      {data && !data.cases.length && <p className="muted">No visible cases.</p>}
      <h2>Stock</h2>{(data?.stock ?? []).map((s: any) => <div key={s.stock_item_id + s.location_id + s.condition}>{s.ref} {s.serial_number ? `SN ${s.serial_number}` : ''} lot {s.lot_number} · {s.location_code} · {s.condition} · on hand {s.on_hand}, reserved {s.reserved}{s.on_hold ? ' · HOLD' : ''}</div>)}
      {data?.catalog?.length > 0 && <><h2>Catalog</h2>{data.catalog.map((c: any) => <div key={c.id}>{c.ref} {c.description} GTIN {c.unit_gtin}</div>)}</>}
    </div>
  );
}

export function Notifications({ reload }: { reload: () => void }) {
  const { data } = useData<any[]>('/api/notifications');
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}><h1>Alerts</h1><button className="secondary" onClick={async () => { await post('/api/notifications/read'); reload(); }}>Mark all read</button></div>
      {(data ?? []).map((n) => <div key={n.id} className="card small" style={{ fontWeight: n.read_at ? 400 : 600 }}>{fmtTime(n.created_at)} · {n.kind.replace(/_/g, ' ')} · {n.case_id ? <Link to={`/cases/${n.case_id}`}>{n.case_ref}</Link> : ''} {n.message}</div>)}
      {data && !data.length && <p className="muted">No alerts.</p>}
    </div>
  );
}

export function Cases() {
  const { can } = useMe();
  const list = useData<any[]>('/api/cases');
  const meta = useData<any>('/api/meta');
  const [f, setF] = useState({ facilityId: '', cardVersionId: '', date: '', time: '07:30', repUserId: '', urgent: false });
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const hospitals = (meta.data?.facilities ?? []).filter((x: any) => x.kind === 'hospital');
  const fac = hospitals.find((h: any) => h.id === f.facilityId);
  const approved = (meta.data?.cards ?? []).filter((c: any) => c.status === 'approved');
  const create = async () => {
    setErr(null); setMsg(null);
    try {
      // Convert facility-local wall time to UTC using the facility time zone.
      const guess = new Date(`${f.date}T${f.time}:00Z`);
      const local = new Date(guess.toLocaleString('en-US', { timeZone: fac.timezone }));
      const utc = new Date(guess.getTime() + (guess.getTime() - local.getTime()));
      const c = await post('/api/cases', { facilityId: f.facilityId, cardVersionId: f.cardVersionId, scheduledStart: utc.toISOString(), repUserId: f.repUserId, urgent: f.urgent });
      setMsg(`Created ${c.case_ref}.`); list.reload();
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div>
      <h1>Cases</h1>
      {can('case.manage') && (
        <section className="card"><h2>Schedule a case</h2>
          <div className="row">
            <label className="field">Facility<select value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value })}><option value="">Select…</option>{hospitals.map((h: any) => <option key={h.id} value={h.id}>{h.name} ({h.timezone})</option>)}</select></label>
            <label className="field">Approved preference card<select value={f.cardVersionId} onChange={(e) => setF({ ...f, cardVersionId: e.target.value })}><option value="">Select…</option>{approved.map((c: any) => <option key={c.version_id} value={c.version_id}>{c.code} v{c.version}: {c.procedure}</option>)}</select></label>
            <label className="field">Date (facility local)<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
            <label className="field">Start time (facility local)<input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></label>
            <label className="field">Rep<select value={f.repUserId} onChange={(e) => setF({ ...f, repUserId: e.target.value })}><option value="">Select…</option>{(meta.data?.reps ?? []).map((r: any) => <option key={r.id} value={r.id}>{r.display_name}</option>)}</select></label>
            <label className="row"><input type="checkbox" checked={f.urgent} onChange={(e) => setF({ ...f, urgent: e.target.checked })} /> Urgent add-on</label>
            <button disabled={!f.facilityId || !f.cardVersionId || !f.date || !f.repUserId} onClick={create}>Create case</button>
          </div>
          {msg && <div className="ok">{msg}</div>}<Err e={err} />
          <h3>Preference card versions</h3>
          {(meta.data?.cards ?? []).map((c: any) => <div key={c.version_id} className="small">{c.code} v{c.version} · {c.surgeon_ref} · <Status s={c.status === 'approved' ? 'ready' : c.status === 'draft' ? 'pending' : 'cancelled'} /> {c.status}{c.approved_by_name ? ` by ${c.approved_by_name}` : ''}
            {c.status === 'draft' && can('card.approve') && <button className="link" onClick={async () => { try { await post(`/api/cards/${c.version_id}/approve`); meta.reload(); } catch (e: any) { setErr(e.message); } }}>Approve this version</button>}</div>)}
        </section>)}
      <div className="row"><a className="btn secondary" href="/api/exports/cases.csv">Export cases (CSV)</a></div>
      <div className="table-wrap" style={{ marginTop: 8 }}><table><thead><tr><th>Case</th><th>Facility</th><th>Start (facility time)</th><th>Rep</th><th>Status</th></tr></thead>
        <tbody>{(list.data ?? []).map((c) => <tr key={c.id}><td><Link to={`/cases/${c.id}`}>{c.case_ref}</Link>{c.urgent && ' (urgent)'}</td><td>{c.facility}</td><td>{fmtTime(c.scheduled_start, c.timezone)}</td><td>{c.rep_name}</td><td><Status s={c.status} /></td></tr>)}</tbody></table></div>
    </div>
  );
}
