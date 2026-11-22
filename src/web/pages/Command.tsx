/**
 * Operations command center screens: the ranked "Needs attention" queue, the five-number evidence panel,
 * transfer requests and their status chain, loaners, par levels, expiring stock, allocation and settings.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useData, useMe, Err } from '../App';
import { post } from '../lib/api';
import { AskOpsButton } from '../components/AskOps';
import { EvidenceList } from './Pilot';

const PRI_LABEL: Record<string, string> = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM' };
const left = (m: number | null) => m == null ? '' : m < 0 ? `${fmtDur(-m)} overdue` : `${fmtDur(m)} left`;
const fmtDur = (m: number) => m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${Math.round(m / 1440)} days`;

/** Runs one queue action. Shared by the queue and the evidence panel. */
export function useQueueActions(reload: () => void) {
  const nav = useNavigate();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (a: any) => {
    setErr(null); setMsg(null);
    if (a.kind === 'reallocate' && !window.confirm(`${a.label}?\n\n${a.note}. That case will then show as needing resupply.`)) return;
    setBusy(true);
    try {
      if (a.kind === 'reserve') { const r = await post(`/api/cases/${a.params.caseId}/requirements/${a.params.requirementId}/reserve-available`); setMsg(`Reserved ${r.reserved} unit(s)${r.stillNeeded ? `; ${r.stillNeeded} still needed` : ''}.`); reload(); }
      else if (a.kind === 'reallocate') { const r = await post('/api/reallocate', a.params); setMsg(`Moved ${r.moved} from ${r.fromCaseRef} to ${r.toCaseRef}. ${r.fromCaseRef} now needs resupply.`); reload(); }
      else if (a.kind === 'plan_delivery') { const r = await post(`/api/cases/${a.params.caseId}/plan-delivery`); setMsg(`${r.created.length} delivery shipment(s) planned; they are now in the pick queue.`); reload(); }
      else if (a.kind === 'request_loaner') { const r = await post('/api/loaners', a.params); nav(`/loaners/${r.id}`); }
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return { run, msg, err, busy };
}

export function ActionButtons({ actions, run, busy }: { actions: any[]; run: (a: any) => void; busy: boolean }) {
  return <div className="q-actions">{actions.map((a, i) => (
    <div key={i} className="q-action">
      {a.href ? <Link className={`btn ${a.primary ? '' : 'secondary'}`} to={a.href}>{a.label}</Link> : <button className={a.primary ? '' : 'secondary'} disabled={busy} onClick={() => run(a)}>{a.label}</button>}
      {a.note && <div className="small muted">{a.note}</div>}
    </div>))}</div>;
}

export function Attention() {
  const { can } = useMe();
  const [by, setBy] = useState('');
  const { data, error, reload } = useData<any>(`/api/attention${by ? `?byLocal=${by}` : ''}`, [by]);
  const { run, msg, err, busy } = useQueueActions(reload);
  useEffect(() => { const t = setInterval(reload, 60000); return () => clearInterval(t); }, [reload]);
  const k = data?.counts;
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Needs attention</h1>
        <div className="row tight"><AskOpsButton pilot /><button className="secondary" onClick={reload}>Refresh</button></div>
      </div>
      <p className="muted small">The work, most urgent first. Each item says why it is a problem, the safest fix on record, and gives you the action. Looks {data?.windowHours ?? 72} hours ahead. Exact items only; nothing here chooses a product or releases a tray.</p>
      <div className="row tight" role="group" aria-label="Show what must be fixed before">
        <span className="small"><strong>Fix before:</strong></span>
        {[['', 'Everything'], ['12:00', '12 PM'], ['15:00', '3 PM today'], ['17:00', '5 PM today']].map(([v, l]) => <button key={v} className={by === v ? '' : 'secondary'} aria-pressed={by === v} onClick={() => setBy(v)}>{l}</button>)}
      </div>
      {k && <p data-testid="q-counts"><span className="badge st-blocked">{k.critical} critical</span> <span className="badge st-at_risk">{k.high} high</span> <span className="badge q-badge-medium">{k.medium} medium</span>
        <span className="small muted"> · {k.casesReady} of {k.cases} upcoming cases are ready · checked {data.generatedAtLocal}{data.byLocal ? ` · showing what is due by ${data.byLocal}` : ''}</span></p>}
      <Err e={error ?? err} />
      {msg && <div className="ok" role="status">{msg}</div>}
      <ol className="queue">{data?.items.map((i: any, n: number) => (
        <li key={i.id} className={`card q-item q-${i.priority}`} data-priority={i.priority} data-kind={i.kind} data-case={i.caseRef ?? ''}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div><span className={`badge q-badge-${i.priority}`}>{n + 1}. {PRI_LABEL[i.priority]}</span> {i.caseId ? <Link to={`/cases/${i.caseId}`}><strong>{i.caseRef}</strong></Link> : null}
              {i.caseRef && <span className="small muted"> · {i.facility}{i.caseStartLocal ? ` · surgery ${i.caseStartLocal}` : ''}</span>}
              <div className="q-title">{i.title}</div></div>
            {i.deadlineLocal && <div className="small" style={{ textAlign: 'right' }}>Act by <strong>{i.deadlineLocal}</strong><div className={i.minutesLeft < 0 ? 'sev-critical' : i.minutesLeft < 240 ? 'sev-warning' : 'muted'}>{left(i.minutesLeft)}</div></div>}
          </div>
          <p className="q-why"><strong>Why:</strong> {i.why}</p>
          <p className="q-fix"><strong>Safest fix:</strong> {i.recommended}</p>
          {(i.owner || i.waitingOn) && <p className="small muted">{i.owner && <>Owner: {i.owner}</>}{i.owner && i.waitingOn ? ' · ' : ''}{i.waitingOn && <>Waiting on: <strong>{i.waitingOn}</strong></>}</p>}
          <ActionButtons actions={i.actions} run={run} busy={busy} />
        </li>))}</ol>
      {data && !data.items.length && <div className="ok">Nothing needs attention{data.byLocal ? ` before ${data.byLocal}` : ''}. {k.casesReady} of {k.cases} upcoming cases are ready.</div>}
      {data?.hiddenLater > 0 && <p className="small muted">{data.hiddenLater} more item(s) are due later. <button className="linkish" onClick={() => setBy('')}>Show everything</button></p>}
      <p className="small muted">Planning rule: {data?.rule}. {data?.loanerSource ? `Loaner source: ${data.loanerSource}.` : 'No loaner source is set up.'} {can('settings.manage') && <Link to="/settings/ops">Change settings</Link>} · <Link to="/allocation">See allocation by item</Link></p>
    </div>
  );
}

/** Required / on hand / reserved / available / short. Each number opens to the records behind it. */
export function Breakdown({ caseId, requirementId, open: startOpen }: { caseId: string; requirementId: string; open?: boolean }) {
  const { data, error, reload } = useData<any>(`/api/cases/${caseId}/requirements/${requirementId}/breakdown`);
  const { run, msg, err, busy } = useQueueActions(reload);
  const [open, setOpen] = useState<string | null>(startOpen ? 'short' : null);
  if (error) return <Err e={error} />;
  if (!data) return <p className="small muted">Loading the numbers…</p>;
  const n = data.numbers; const o = data.options;
  const cell = (key: string, label: string, value: number, cls = '') => (
    <button className={`num ${cls} ${open === key ? 'on' : ''}`} aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)} data-num={key}><span className="num-v">{value}</span><span className="num-l">{label}</span></button>);
  const actions: any[] = [];
  for (const u of data.availableUnits) {
    if ((u.atFacility || u.locationKind === 'warehouse') && data.can.reserve && !actions.some((a) => a.kind === 'reserve')) actions.push({ kind: 'reserve', label: 'Reserve available units', params: { caseId, requirementId }, primary: true });
    if (!u.atFacility && u.locationKind !== 'warehouse' && data.can.requestTransfer) actions.push({ kind: 'request_transfer', label: `Request transfer from ${u.custodian}`, href: `/cases/${caseId}/rescue/${requirementId}?unit=${u.stockItemId}&loc=${u.locationId}`, note: `${u.unit} · ${u.travelMinutes} min away · arrives ${u.arrivalLocal}${u.meetsCutoff ? '' : ' (after required-by)'}${u.donorConflicts.length ? ` · caution: ${u.custodian} needs it for ${u.donorConflicts.map((d: any) => d.caseRef).join(', ')}` : ''}` });
  }
  return (
    <div className="breakdown" data-testid="breakdown" data-req={data.item.ref}>
      <div className="small"><strong>{data.item.ref}</strong> {data.item.description}{data.item.manufacturer ? ` · ${data.item.manufacturer}` : ''} <span className="muted">· checked {data.checkedAtLocal}</span></div>
      <div className="nums" role="group" aria-label={`Inventory numbers for ${data.item.ref}`}>
        {cell('required', 'Required', n.required)}{cell('onHand', 'Physical on hand', n.onHand)}{cell('reserved', 'Reserved for other cases', n.reservedOther)}{cell('available', 'Available', n.available)}{cell('short', 'Short', n.short, n.short > 0 ? 'bad' : 'good')}
      </div>
      <div className="small muted">{data.why}{n.reservedThisCase ? ` ${n.reservedThisCase} already reserved for this case.` : ''}{n.onHold ? ` ${n.onHold} on quality hold.` : ''}{n.expiredBeforeUse ? ` ${n.expiredBeforeUse} expire before use.` : ''}{n.notAllocatable ? ` ${n.notAllocatable} not allocatable.` : ''} Tap a number to see what is behind it.</div>
      <Err e={err} />{msg && <div className="ok" role="status">{msg}</div>}
      {open === 'required' && <div className="num-detail"><strong>Required: {n.required}</strong>{data.requiredSource.length ? <EvidenceList ev={data.requiredSource} /> : <p className="small muted">Entered on the case in this system (not from an uploaded file).</p>}</div>}
      {open === 'onHand' && <div className="num-detail"><strong>Physical on hand: {n.onHand}</strong>
        <div className="table-wrap"><table aria-label="Units on hand"><thead><tr><th>Unit</th><th>Location</th><th>Qty</th><th>State</th><th>Source and last check</th></tr></thead>
          <tbody>{data.onHandUnits.map((u: any, i: number) => <tr key={i}><td>{u.unit}</td><td>{u.location}</td><td>{u.qty}</td><td className="small">{u.states.join('; ')}</td><td>{u.evidence.length ? <EvidenceList ev={u.evidence} /> : <span className="small muted">No source record or physical check</span>}</td></tr>)}</tbody></table></div></div>}
      {open === 'reserved' && <div className="num-detail"><strong>Reserved for other cases: {n.reservedOther}</strong>
        {data.reserved.length ? <div className="table-wrap"><table aria-label="Reservations for other cases"><thead><tr><th>Case</th><th>Surgery</th><th>Hospital</th><th>Rep</th><th>Qty</th><th>Unit</th><th>Reserved</th><th>Commitment</th></tr></thead>
          <tbody>{data.reserved.map((r: any, i: number) => <tr key={i}><td><Link to={`/cases/${r.caseId}`}>{r.caseRef}</Link><div className="small muted">entered {r.enteredAtLocal}</div></td><td>{r.whenLocal}</td><td>{r.facility}</td><td>{r.rep ?? '—'}</td><td>{r.qty}</td><td className="small">{r.unit}<div className="muted">{r.location}</div></td><td className="small">{r.reservedAtLocal}<div className="muted">by {r.reservedBy}</div></td><td className="small">{r.commitment}</td></tr>)}</tbody></table></div> : <p className="small muted">None.</p>}
        {data.hiddenReservations > 0 && <p className="small muted">{data.hiddenReservations} reservation(s) belong to cases outside your view.</p>}</div>}
      {open === 'available' && <div className="num-detail"><strong>Available: {n.available}</strong>
        {data.availableUnits.length ? <div className="table-wrap"><table aria-label="Available units"><thead><tr><th>Unit</th><th>Where it is now</th><th>Condition</th><th>Last physical check</th><th>Earliest arrival</th><th>In time?</th></tr></thead>
          <tbody>{data.availableUnits.map((u: any, i: number) => <tr key={i}><td>{u.unit}</td><td>{u.location}<div className="small muted">held by {u.custodian}</div></td><td>{u.condition}</td><td className="small">{u.evidence ?? '—'}</td><td>{u.atFacility ? 'Already at the hospital' : u.arrivalLocal}<div className="small muted">{u.atFacility ? '' : `${u.travelMinutes} min travel (estimate)`}</div></td>
            <td>{u.meetsCutoff ? <span className="badge st-ready">Yes</span> : <span className="badge st-blocked">No</span>}{u.donorConflicts.length > 0 && <div className="small sev-warning">{u.custodian} needs it for {u.donorConflicts.map((d: any) => d.caseRef).join(', ')}</div>}</td></tr>)}</tbody></table></div> : <p className="small muted">No unit of this exact item is free anywhere.</p>}
        <ActionButtons actions={actions} run={run} busy={busy} /></div>}
      {open === 'short' && <div className="num-detail"><strong>Short: {n.short}</strong> <span className="small muted">Needed at the hospital by {o.requiredByLocal}.</span>
        <p className="small">{data.why}</p>
        {data.openDifferences.length > 0 && <p className="small sev-warning">Not confirmed: {data.openDifferences.map((d: any) => <Link key={d.ref} to={d.href}>{d.ref} </Link>)} is waiting to be reconciled, so these numbers may change.</p>}
        {(o.transfers.length > 0 || o.loaners.length > 0) && <><div className="small"><strong>Already in hand</strong></div><ul className="small">
          {o.transfers.map((t: any) => <li key={t.id}><Link to={`/transfers/${t.id}`}>{t.ref}</Link>: {t.current}; waiting on {t.waitingOn}</li>)}
          {o.loaners.map((l: any) => <li key={l.id}><Link to={`/loaners/${l.id}`}>{l.ref}</Link>: {l.statusLabel}{l.expectedArrivalLocal ? `; expected ${l.expectedArrivalLocal}` : ''}</li>)}</ul></>}
        <div className="small"><strong>Ways to cover it, safest first</strong></div>
        <ol className="small opts">
          <li><strong>Nearby stock:</strong> {data.availableUnits.length ? `${data.availableUnits.length} matching unit(s); earliest arrives ${data.availableUnits[0].atFacility ? 'now (already there)' : data.availableUnits[0].arrivalLocal}.` : 'none free.'} {data.availableUnits.length > 0 && <button className="linkish" onClick={() => setOpen('available')}>See them</button>}</li>
          <li><strong>A later case holding it:</strong> {o.reallocate.length ? o.reallocate.map((r: any) => `${r.fromCaseRef} (${r.fromCaseWhen}, ${r.daysOut} days out) holds ${r.qty} at ${r.location}`).join('; ') + '.' : 'none that can still be resupplied in time.'}
            {o.reallocate.length > 0 && data.can.reserve && n.short > 0 && <div><button className="secondary" disabled={busy} onClick={() => run({ kind: 'reallocate', label: `Move ${Math.min(n.short, o.reallocate[0].qty)} from ${o.reallocate[0].fromCaseRef}`, note: `${o.reallocate[0].fromCaseRef} is ${o.reallocate[0].daysOut} days out`, params: { toCaseId: caseId, requirementId, reservationId: o.reallocate[0].reservationId, qty: Math.min(n.short, o.reallocate[0].qty) } })}>Move {Math.min(n.short, o.reallocate[0].qty)} from {o.reallocate[0].fromCaseRef}</button></div>}</li>
          <li><strong>Loaner:</strong> {o.loaner ? <>{o.loaner.inTime ? `Request from ${o.loaner.source} by ${o.loaner.requestByLocal}; it would arrive ${o.loaner.arrivalIfRequestedNowLocal}.` : `From ${o.loaner.source} it would arrive ${o.loaner.arrivalIfRequestedNowLocal}, after the required-by time.`} <span className="muted">{o.loaner.basis}</span>
            {data.can.requestLoaner && n.short > 0 && !o.loaners.length && <div><button className="secondary" disabled={busy} onClick={() => run({ kind: 'request_loaner', params: { caseId, requirementId, qty: n.short } })}>Request {n.short} from {o.loaner.source}</button></div>}</> : 'no loaner source is set up for this account.'}</li>
        </ol></div>}
    </div>
  );
}

function Chain({ steps, ended }: { steps: any[]; ended?: string | null }) {
  const cur = steps.findIndex((s) => !s.done);
  return <ol className="chain" aria-label="Status">{steps.map((s, i) => (
    <li key={s.name} className={s.done ? 'done' : i === cur && !ended ? 'next' : ''}><span className="chain-n">{s.name}</span>{s.done ? <span className="small muted">{s.done.atLocal}{s.done.by ? ` · ${s.done.by}` : ''}</span> : <span className="small muted">{i === cur && !ended ? 'next' : '—'}</span>}</li>))}
    {ended && <li className="ended"><span className="chain-n">{ended}</span></li>}</ol>;
}

export function Transfers() {
  const { data, error } = useData<any[]>('/api/transfers');
  return (<div><h1>Transfer requests</h1>
    <p className="muted small">A request holds the unit for the case, but nothing is treated as moving until whoever holds it accepts. Each one has an owner, a pickup plan, a required-by time and a receiver.</p>
    <Err e={error} />
    <div className="table-wrap"><table aria-label="Transfer requests"><thead><tr><th>Ref</th><th>Case</th><th>Unit</th><th>From</th><th>Status</th><th>Waiting on</th><th>Pickup</th><th>Required by</th></tr></thead>
      <tbody>{data?.map((t) => <tr key={t.id} data-ref={t.ref}><td><Link to={`/transfers/${t.id}`}>{t.ref}</Link></td><td><Link to={`/cases/${t.caseId}`}>{t.caseRef}</Link><div className="small muted">{t.facility}</div></td><td>{t.item.ref}<div className="small muted">{t.item.unit}</div></td><td>{t.from}</td>
        <td><span className={`badge ${t.current === 'Received' ? 'st-ready' : ['Declined', 'Withdrawn'].includes(t.current) || t.late ? 'st-blocked' : 'st-at_risk'}`}>{t.current}{t.late ? ' · late' : ''}</span></td><td>{t.waitingOn ?? '—'}</td><td className="small">{t.pickupBy}<div className="muted">{t.pickupAtLocal}</div></td><td className="small">{t.requiredByLocal}</td></tr>)}
        {data && !data.length && <tr><td colSpan={8} className="muted">No transfer requests yet. They start from a shortage: open the case, tap Short, and request a transfer.</td></tr>}</tbody></table></div></div>);
}

export function TransferDetail() {
  const { id } = useParams();
  const { data: t, error, reload } = useData<any>(`/api/transfers/${id}`);
  const [note, setNote] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const act = async (path: string, body: any) => { setErr(null); setBusy(true); try { await post(`/api/transfers/${id}/${path}`, body); setNote(''); reload(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  if (error) return <Err e={error} />;
  if (!t) return <p>Loading…</p>;
  const ended = t.status === 'declined' ? 'Declined' : t.status === 'cancelled' ? 'Withdrawn' : null;
  const conflicts = t.donorCheck.filter((d: any) => d.uncovered > 0);
  return (<div data-testid="transfer" data-status={t.current}>
    <p><Link to="/transfers">← Transfer requests</Link></p>
    <h1>{t.ref}: {t.item.ref} {t.item.unit}</h1>
    <p>{t.item.description}. From <strong>{t.from}</strong> (held by {t.holder}) to <strong>{t.facility}</strong> for <Link to={`/cases/${t.caseId}`}>{t.caseRef}</Link>, surgery {t.caseStartLocal}.</p>
    <Chain steps={t.steps} ended={ended} />
    {t.late && <div className="alert">Required by {t.requiredByLocal} and not yet received.</div>}
    {!ended && t.waitingOn && <p><strong>Waiting on:</strong> {t.waitingOn}{t.nextStep ? ` (next: ${t.nextStep})` : ''}</p>}
    {ended && <div className="alert">{ended} by {t.decidedBy}: {t.decisionNote}. The unit is no longer held for {t.caseRef}.</div>}
    <section className="card"><h2>The plan</h2>
      <dl className="kv"><dt>Owner</dt><dd>{t.owner}</dd><dt>Who gives it up</dt><dd>{t.holder}</dd><dt>Who collects it</dt><dd>{t.pickupBy}</dd><dt>When it leaves</dt><dd>{t.pickupAtLocal}</dd><dt>Required at {t.facility} by</dt><dd>{t.requiredByLocal}</dd><dt>Who receives it</dt><dd>{t.receiver}</dd>
        <dt>Requested by</dt><dd>{t.requestedBy}</dd>{t.note && <><dt>Note</dt><dd>{t.note}</dd></>}{t.status === 'accepted' && <><dt>Accepted</dt><dd>{t.decidedBy}{t.decisionNote ? `: ${t.decisionNote}` : ''}</dd></>}
        {t.shipmentId && <><dt>Shipment</dt><dd><Link to={`/shipments/${t.shipmentId}`}>{t.shipmentRef}</Link> ({t.shipmentStatus})</dd></>}</dl></section>
    <section className="card"><h2>Does {t.holder} need it?</h2>
      {t.donorCheck.length === 0 && <p className="ok small">No upcoming case on the giving side needs this item (checked when the request was made).</p>}
      {t.donorCheck.length > 0 && <><p className={conflicts.length ? 'alert small' : 'ok small'}>{conflicts.length ? `Caution: ${conflicts.length} upcoming case(s) on the giving side still need this item and are not fully reserved.` : 'The giving side has upcoming cases that use this item, and they are fully reserved without this unit.'}</p>
        <ul className="small">{t.donorCheck.map((d: any) => <li key={d.caseId}><Link to={`/cases/${d.caseId}`}>{d.caseRef}</Link> · {d.when} · {d.facility}: {d.reserved} of {d.required} reserved</li>)}</ul></>}</section>
    <Err e={err} />
    {t.canDecide && <section className="card" data-testid="decide"><h2>{t.actingForHolder ? `Answer for ${t.holder}` : 'Your answer'}</h2>
      {t.actingForHolder && <p className="small muted">You are recording {t.holder}'s answer. Say how they agreed, for example "confirmed by phone at 9:12".</p>}
      <label className="field">Note {t.actingForHolder ? '(required)' : '(required to decline)'}<input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Decision note" /></label>
      <div className="row"><button disabled={busy} onClick={() => act('decide', { decision: 'accept', note })}>Accept: release the unit</button><button className="secondary" disabled={busy} onClick={() => act('decide', { decision: 'decline', note })}>Decline</button></div></section>}
    {t.canCancel && !t.canDecide && <section className="card"><label className="field">Reason<input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Reason for withdrawing" /></label><button className="secondary" disabled={busy} onClick={() => act('cancel', { reason: note })}>Withdraw this request</button></section>}
    {t.shipmentId && t.status === 'accepted' && <p className="small muted">Pickup, courier scans and the hospital's check-in are recorded on <Link to={`/shipments/${t.shipmentId}`}>{t.shipmentRef}</Link>; this page follows along.</p>}
  </div>);
}

export function Loaners() {
  const { data, error } = useData<any>('/api/loaners');
  return (<div><h1>Loaners</h1>
    <p className="muted small">{data?.source ? `Loaners requested from ${data.source}, tracked from request to return.` : 'No loaner source is set up yet.'} Tracewell records and tracks the request; it does not send it to the source.</p>
    <Err e={error} />
    <div className="table-wrap"><table aria-label="Loaners"><thead><tr><th>Ref</th><th>Case</th><th>Item</th><th>Qty</th><th>Status</th><th>Needed by</th><th>Expected</th><th>Due back</th></tr></thead>
      <tbody>{data?.loaners.map((l: any) => <tr key={l.id} data-ref={l.ref}><td><Link to={`/loaners/${l.id}`}>{l.ref}</Link></td><td><Link to={`/cases/${l.caseId}`}>{l.caseRef}</Link><div className="small muted">{l.facility}</div></td><td>{l.item.ref}<div className="small muted">{l.item.unit ?? l.item.description}</div></td><td>{l.qty}</td>
        <td><span className={`badge ${l.status === 'returned' ? 'st-ready' : l.returnLate || l.overdueArrival || l.status === 'cancelled' ? 'st-blocked' : 'st-at_risk'}`}>{l.statusLabel}{l.returnLate ? ' · return overdue' : ''}</span></td><td className="small">{l.neededByLocal}</td>
        <td className="small">{l.expectedArrivalLocal ?? '—'}{l.arrivesInTime === false && <div className="sev-critical">after needed-by</div>}</td><td className="small">{l.dueBack ?? '—'}</td></tr>)}
        {data && !data.loaners.length && <tr><td colSpan={8} className="muted">No loaners yet. They start from a shortage: open the case, tap Short, and request a loaner.</td></tr>}</tbody></table></div></div>);
}

export function LoanerDetail() {
  const { id } = useParams();
  const { data: l, error, reload } = useData<any>(`/api/loaners/${id}`);
  const [f, setF] = useState<any>({}); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const act = async (step: string) => { setErr(null); setBusy(true); try { await post(`/api/loaners/${id}/advance`, { step, ...f, locationId: f.locationId ?? l.receiveLocations[0]?.id }); setF({}); reload(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  if (error) return <Err e={error} />;
  if (!l) return <p>Loading…</p>;
  return (<div data-testid="loaner" data-status={l.status}>
    <p><Link to="/loaners">← Loaners</Link></p>
    <h1>{l.ref}: {l.qty} x {l.item.ref}</h1>
    <p>{l.item.description}. From <strong>{l.source}</strong> for <Link to={`/cases/${l.caseId}`}>{l.caseRef}</Link> at {l.facility}, surgery {l.caseStartLocal}. Needed at the hospital by <strong>{l.neededByLocal}</strong>.</p>
    <Chain steps={l.steps} ended={l.status === 'cancelled' ? 'Cancelled' : null} />
    {l.arrivesInTime === false && l.status !== 'received' && l.status !== 'returned' && <div className="alert">Expected {l.expectedArrivalLocal}, after the needed-by time. Call {l.source} or plan another option.</div>}
    {l.returnLate && <div className="alert">Due back {l.dueBack}. The return is overdue.</div>}
    <section className="card"><dl className="kv"><dt>Requested</dt><dd>{l.requestedAtLocal} by {l.requestedBy}</dd><dt>Source confirmation</dt><dd>{l.confirmation ?? '—'}</dd><dt>Expected arrival</dt><dd>{l.expectedArrivalLocal ?? '—'}</dd><dt>Inbound tracking</dt><dd>{l.inboundTracking ?? '—'}</dd>
      <dt>Received</dt><dd>{l.receivedAt ? `${l.item.unit} at ${l.receivedAt}` : '—'}</dd><dt>Due back</dt><dd>{l.dueBack ?? '—'}</dd><dt>Return tracking</dt><dd>{l.returnTracking ?? '—'}</dd></dl></section>
    <Err e={err} />
    {l.status === 'requested' && <section className="card"><h2>Next: record the source's confirmation</h2><div className="row"><label className="field">Confirmation / order number<input value={f.confirmation ?? ''} onChange={set('confirmation')} /></label></div>
      <div className="row"><button disabled={busy} onClick={() => act('confirm')}>Record confirmation</button><button className="secondary" disabled={busy} onClick={() => act('cancel')}>Cancel loaner</button></div><label className="field">Note (required to cancel)<input value={f.note ?? ''} onChange={set('note')} /></label></section>}
    {l.status === 'confirmed' && <section className="card"><h2>Next: it ships</h2><label className="field">Inbound tracking number<input value={f.tracking ?? ''} onChange={set('tracking')} /></label><button disabled={busy} onClick={() => act('ship')}>Record shipped</button></section>}
    {['requested', 'confirmed', 'shipped'].includes(l.status) && <section className="card"><h2>{l.status === 'shipped' ? 'Next: check it in' : 'Or: it has arrived'}</h2>
      <div className="row"><label className="field">Lot from the label<input value={f.lot ?? ''} onChange={set('lot')} /></label><label className="field">Serial (if serialized)<input value={f.serial ?? ''} onChange={set('serial')} /></label><label className="field">Expiry<input type="date" value={f.expiry ?? ''} onChange={set('expiry')} /></label>
        <label className="field">Received at<select value={f.locationId ?? l.receiveLocations[0]?.id} onChange={set('locationId')}>{l.receiveLocations.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label></div>
      <button disabled={busy} onClick={() => act('receive')}>Check in and reserve for {l.caseRef}</button></section>}
    {l.status === 'received' && <section className="card"><h2>Next: return it by {l.dueBack}</h2><label className="field">Return tracking number<input value={f.tracking ?? ''} onChange={set('tracking')} /></label><button disabled={busy} onClick={() => act('return')}>Record return</button></section>}
    <h2>Chain of custody</h2>
    <ul className="small">{l.events.map((e: any, i: number) => <li key={i}><strong>{e.atLocal}</strong> · {e.by} · {e.event}: {e.detail}</li>)}</ul>
  </div>);
}

export function ParLevels() {
  const { can } = useMe();
  const { data, error, reload } = useData<any>('/api/stock/par');
  const [f, setF] = useState<any>({}); const [err, setErr] = useState<string | null>(null);
  const save = async (locationId: string, catalogItemId: string, par: any) => { setErr(null); try { await post('/api/stock/par', { locationId, catalogItemId, par: par === '' ? null : Number(par) }); reload(); } catch (e: any) { setErr(e.message); } };
  return (<div><h1>Par levels</h1>
    <p className="muted small">What each location is meant to hold, against what is usable there now and what upcoming cases will draw. {data?.note}</p>
    <Err e={error ?? err} />
    <div className="table-wrap"><table aria-label="Par levels"><thead><tr><th>Location</th><th>Item</th><th>Par</th><th>Usable</th><th>Reserved</th><th>Case demand, next {data?.windowHours} h</th><th>Used, 90 days</th><th>Status</th><th>Suggestion</th></tr></thead>
      <tbody>{data?.rows.map((r: any) => <tr key={r.id} data-status={r.status}><td>{r.location}</td><td>{r.ref}<div className="small muted">{r.description}</div></td>
        <td>{can('par.manage') ? <input className="par-in" type="number" min={0} defaultValue={r.par} aria-label={`Par for ${r.ref} at ${r.location}`} onBlur={(e) => { if (e.target.value !== String(r.par)) save(r.locationId, r.catalogItemId, e.target.value); }} /> : r.par}</td>
        <td>{r.usable}</td><td>{r.reserved}</td><td>{r.windowDemand}</td><td>{r.used90}</td><td><span className={`badge ${r.status === 'below' ? 'st-blocked' : r.status === 'over' ? 'st-at_risk' : 'st-ready'}`}>{r.status === 'below' ? `${-r.delta} below` : r.status === 'over' ? `${r.delta} over` : 'At par'}</span></td><td className="small">{r.suggestion}</td></tr>)}
        {data && !data.rows.length && <tr><td colSpan={9} className="muted">No par levels set yet.</td></tr>}</tbody></table></div>
    {can('par.manage') && data && <section className="card"><h2>Set a par level</h2><div className="row">
      <label className="field">Location<select value={f.locationId ?? ''} onChange={(e) => setF({ ...f, locationId: e.target.value })}><option value="">Choose…</option>{data.locations.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label className="field">Item<select value={f.catalogItemId ?? ''} onChange={(e) => setF({ ...f, catalogItemId: e.target.value })}><option value="">Choose…</option>{data.items.map((x: any) => <option key={x.id} value={x.id}>{x.ref} {x.description}</option>)}</select></label>
      <label className="field">Par<input type="number" min={0} value={f.par ?? ''} onChange={(e) => setF({ ...f, par: e.target.value })} /></label></div>
      <button disabled={!f.locationId || !f.catalogItemId || f.par === undefined || f.par === ''} onClick={() => save(f.locationId, f.catalogItemId, f.par).then(() => setF({}))}>Save par</button></section>}
  </div>);
}

export function Expiring() {
  const { data, error } = useData<any>('/api/stock/expiring');
  return (<div><h1>Expiring stock</h1>
    <p className="muted small">Sealed stock that expires within {data?.warningDays} days, soonest first, with the earliest scheduled case that still needs the item and could use it before then.</p>
    <Err e={error} />
    <div className="table-wrap"><table aria-label="Expiring stock"><thead><tr><th>Item</th><th>Unit</th><th>Location</th><th>Qty</th><th>Expires</th><th>Days left</th><th>Suggestion</th></tr></thead>
      <tbody>{data?.rows.map((r: any, i: number) => <tr key={i}><td>{r.ref}<div className="small muted">{r.description}</div></td><td>{r.unit}</td><td>{r.location}{r.holder && <div className="small muted">{r.holder}</div>}</td><td>{r.qty}{r.reserved > 0 && <div className="small muted">{r.reserved} reserved</div>}</td><td>{r.expiry}</td>
        <td><span className={`badge ${r.daysLeft <= 14 ? 'st-blocked' : 'st-at_risk'}`}>{r.daysLeft < 0 ? 'Expired' : r.daysLeft}</span></td><td className="small">{r.suggestion}{r.useOn && <> <Link to={`/cases/${r.useOn.caseId}`}>Open {r.useOn.caseRef}</Link></>}</td></tr>)}
        {data && !data.rows.length && <tr><td colSpan={7} className="muted">Nothing expires within {data.warningDays} days.</td></tr>}</tbody></table></div></div>);
}

export function Allocation() {
  const { can } = useMe();
  const { data, error, reload } = useData<any>('/api/allocation');
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const apply = async () => { setErr(null); try { const r = await post('/api/allocation/apply'); setMsg(`Reserved ${r.reserved} unit(s) across ${r.cases.length} case(s).${r.uncovered.length ? ` Still uncovered: ${r.uncovered.map((u: any) => `${u.caseRef} (${u.uncovered} x ${u.ref})`).join(', ')}.` : ''}`); reload(); } catch (e: any) { setErr(e.message); } };
  return (<div><h1>Allocation</h1>
    <p className="muted small">Every item needed in the next {data?.windowHours} hours: demand from cases against free stock, served in rule order. <strong>Rule: {data?.ruleLabel}.</strong> {data?.note}</p>
    <Err e={error ?? err} />{msg && <div className="ok" role="status">{msg}</div>}
    {data && can('allocation.run') && data.toReserve > 0 && <p><button onClick={apply}>Reserve {data.toReserve} unit(s) in rule order</button></p>}
    {data?.items.map((it: any) => <section key={it.ref} className="card" data-item={it.ref}><h2>{it.ref} {it.description} {it.conflict ? <span className="badge st-blocked">Conflict: {it.uncovered} uncovered</span> : <span className="badge st-ready">Enough stock</span>}</h2>
      <p className="small">{it.required} required across {it.lines.length} case(s), {it.reserved} already reserved, {it.freeStock} free in stock.</p>
      <div className="table-wrap"><table aria-label={`Allocation of ${it.ref}`}><thead><tr><th>Order</th><th>Case</th><th>Surgery</th><th>Entered</th><th>Required</th><th>Reserved</th><th>Would get</th><th>Uncovered</th></tr></thead>
        <tbody>{it.lines.map((l: any) => <tr key={l.caseId}><td>{l.order}</td><td><Link to={`/cases/${l.caseId}?req=${l.requirementId}`}>{l.caseRef}</Link><div className="small muted">{l.facility}</div></td><td className="small">{l.whenLocal}</td><td className="small">{l.enteredLocal}</td><td>{l.required}</td><td>{l.reserved}</td><td>{l.wouldGet}</td><td>{l.uncovered > 0 ? <span className="badge st-blocked">{l.uncovered}</span> : '0'}</td></tr>)}</tbody></table></div></section>)}
    {data && !data.items.length && <div className="ok">Every requirement in the window is fully reserved.</div>}
  </div>);
}

export function OpsSettings() {
  const { can } = useMe();
  const { data, error, reload } = useData<any>('/api/settings/ops');
  const [f, setF] = useState<any>(null); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (data && !f) setF(data.settings); }, [data]);
  if (error) return <Err e={error} />;
  if (!f) return <p>Loading…</p>;
  const set = (k: string, num = false) => (e: any) => setF({ ...f, [k]: num ? Number(e.target.value) : e.target.value });
  const save = async () => { setErr(null); setMsg(null); try { await post('/api/settings/ops', f); setMsg('Saved.'); reload(); } catch (e: any) { setErr(e.message); } };
  const ro = !can('settings.manage');
  return (<div><h1>Operations settings</h1>
    <p className="muted small">How this account plans. These are your organization's own rules; change them to match how you work.</p>
    <Err e={err} />{msg && <div className="ok" role="status">{msg}</div>}
    <section className="card"><h2>Planning</h2><div className="row">
      <label className="field">Planning window (hours ahead)<input type="number" disabled={ro} value={f.planningWindowHours} onChange={set('planningWindowHours', true)} /></label>
      <label className="field">When cases compete for the same item<select disabled={ro} value={f.allocationRule} onChange={set('allocationRule')}>{Object.entries(data.rules).map(([k, v]) => <option key={k} value={k}>{String(v)}</option>)}</select></label>
      <label className="field">Warn about expiry (days ahead)<input type="number" disabled={ro} value={f.expiryWarningDays} onChange={set('expiryWarningDays', true)} /></label></div></section>
    <section className="card"><h2>Loaner source</h2><p className="small muted">Where you request loaners from when local stock cannot cover a case. Leave the name empty if you do not use one. Times are your own estimates, not a live quote.</p><div className="row">
      <label className="field">Name<input disabled={ro} value={f.loanerSourceName ?? ''} onChange={set('loanerSourceName')} placeholder="e.g. Corporate loaner desk" /></label>
      <label className="field">Daily request cutoff (their local time)<input type="time" disabled={ro} value={f.loanerCutoffLocal} onChange={set('loanerCutoffLocal')} /></label>
      <label className="field">Their time zone<input disabled={ro} value={f.loanerTimezone} onChange={set('loanerTimezone')} /></label>
      <label className="field">Transit time (hours)<input type="number" disabled={ro} value={f.loanerTransitHours} onChange={set('loanerTransitHours', true)} /></label>
      <label className="field">Return within (days after the case)<input type="number" disabled={ro} value={f.loanerReturnDays} onChange={set('loanerReturnDays', true)} /></label></div></section>
    {!ro && <button onClick={save}>Save settings</button>}
  </div>);
}

/** The request form that replaces a one-click transfer: who owns it, who collects, when, who receives. */
export function TransferRequestForm({ caseId, reqId, preview, facility, onDone, onConflict, onCancel }: { caseId: string; reqId: string; preview: any; facility: string; onDone: (r: any) => void; onConflict: (m: string) => void; onCancel: () => void }) {
  const { me } = useMe();
  const people = useData<any[]>('/api/people');
  const key = useRef(crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));
  const [f, setF] = useState<any>({ ownerUserId: '', pickupBy: preview.candidate.custodian === 'Distributor warehouse' ? 'Courier' : preview.candidate.custodian, pickupInMinutes: 30, receiver: `Hospital receiving at ${facility}`, note: '' });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const e = preview.e;
  const submit = async () => {
    setErr(null); setBusy(true);
    try { onDone(await post(`/api/cases/${caseId}/rescue/${reqId}/request`, { stockItemId: e.stockItemId, locationId: e.locationId, ownerPartyId: e.ownerPartyId, ...f, ownerUserId: f.ownerUserId || undefined, pickupInMinutes: Number(f.pickupInMinutes), idempotencyKey: key.current })); }
    catch (x: any) { if (x.status === 409) onConflict(x.message); else setErr(x.message); } finally { setBusy(false); }
  };
  const mine = (people.data ?? []).some((p) => p.id === me.user.id);
  return (<div>
    <h3>The plan</h3>
    <div className="row">
      <label className="field">Owner (sees it through)<select value={f.ownerUserId} onChange={set('ownerUserId')} aria-label="Owner">{mine ? <option value="">Me ({me.user.displayName})</option> : <option value="">Choose…</option>}{(people.data ?? []).filter((p) => p.id !== me.user.id).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label>
      <label className="field">Who collects it<input value={f.pickupBy} onChange={set('pickupBy')} aria-label="Who collects it" /></label>
      <label className="field">When it leaves<select value={f.pickupInMinutes} onChange={set('pickupInMinutes')} aria-label="When it leaves">{[[15, 'In 15 minutes'], [30, 'In 30 minutes'], [60, 'In 1 hour'], [120, 'In 2 hours'], [240, 'In 4 hours'], [480, 'In 8 hours']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label className="field">Who receives it<input value={f.receiver} onChange={set('receiver')} aria-label="Who receives it" /></label>
    </div>
    <label className="field">Note for {preview.candidate.custodian} (optional)<input value={f.note} onChange={set('note')} /></label>
    <Err e={err} />
    <p className="small muted">This holds the unit for the case now and asks {preview.candidate.custodian} to accept. Nothing is treated as moving until they do. If someone else takes the unit first, nothing is created and you are shown the next option.</p>
    <div className="row"><button disabled={busy || (!mine && !f.ownerUserId)} onClick={submit}>Reserve &amp; request transfer</button><button className="secondary" onClick={onCancel}>Cancel</button></div>
  </div>);
}
