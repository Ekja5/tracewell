/**
 * Pilot screens: Tomorrow's cases (one view, same calculations as the assistant), Reconcile
 * (spreadsheet-vs-system differences with decision history), Pilot review and the one-page report.
 */
import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useData, useMe, Err } from '../App';
import { fmtTime, post } from '../lib/api';
import { AskOpsButton } from '../components/AskOps';

const TYPE_CLASS: Record<string, string> = { confirmed_shortage: 'st-blocked', missing_information: 'st-closed', awaiting_hospital: 'st-at_risk', action_needed: 'st-at_risk' };
const STATUS_CLASS: Record<string, string> = { ready: 'st-ready', needs_attention: 'st-blocked', needs_information: 'st-closed', in_progress: 'st-at_risk' };

export function EvidenceList({ ev }: { ev: any[] }) {
  if (!ev?.length) return null;
  return <ul className="ev-list small">{ev.map((e, i) => <li key={i} data-evidence={e.kind}>{e.href ? <Link to={e.href}>{e.label}</Link> : e.label}{e.atLocal && <span className="muted"> · {e.atLocal}</span>}</li>)}</ul>;
}

export function Tomorrow() {
  const { can } = useMe();
  const { data, error, reload } = useData<any>('/api/tomorrow');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(reload, 30000); return () => clearInterval(t); }, [reload]);
  const act = async (c: any, a: any) => { setErr(null); try { await post(`/api/cases/${c.id}/requirements/${a.requirementId}/reserve-available`); reload(); } catch (e: any) { setErr(e.message); } };
  const k = data?.counts;
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Tomorrow's cases</h1>
        <div className="row tight"><AskOpsButton pilot /><button className="secondary" onClick={reload}>Refresh</button></div>
      </div>
      <p className="muted small">Each case in its hospital's local time. A shortage is called confirmed only when the records agree; otherwise it is shown as missing information. The assistant uses these same calculations.
        {k && <> <strong>{k.needsAttention}</strong> need attention · <strong>{k.inProgress}</strong> in progress · <strong>{k.needsInformation}</strong> need information · <strong>{k.ready}</strong> ready. Checked {fmtTime(data.generatedAt)}.</>}</p>
      <Err e={error ?? err} />
      {data?.pending?.discrepancies > 0 && <div className="alert" role="status" data-testid="pending-reconcile">{data.pending.discrepancies} spreadsheet difference{data.pending.discrepancies === 1 ? '' : 's'} waiting to be reconciled. Until then, availability uses the system quantity. <Link to="/reconcile">Open Reconcile</Link></div>}
      {data?.pending?.held_rows > 0 && <p className="small muted">{data.pending.held_rows} uploaded row(s) are held for review. <Link to="/uploads">Open Load files</Link></p>}
      {data?.cases.map((c: any) => (
        <section key={c.id} className={`card casecard tm-${c.status}`} data-case={c.caseRef} data-status={c.status} aria-label={`Case ${c.caseRef}`}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><Link to={`/cases/${c.id}`}><strong style={{ fontSize: '1.1rem' }}>{c.caseRef}</strong></Link> <span className={`badge ${STATUS_CLASS[c.status]}`}>{c.statusLabel}</span>
              <div className="small">{c.facility} · {c.procedure}{c.repName ? ` · Rep ${c.repName}` : ''}</div></div>
            <div className="small" style={{ textAlign: 'right' }}>Surgery <strong>{c.startLocal}</strong></div>
          </div>
          {c.blockers.length === 0 && <div className="ok small">Ready. Every required item is reserved, delivered and checked in by the hospital.<EvidenceList ev={c.handoffEvidence} /></div>}
          <ol className="issues">{c.blockers.map((b: any) => (
            <li key={b.key} className="issue" data-type={b.type}>
              <div><span className={`badge ${TYPE_CLASS[b.type]}`}>{b.typeLabel}</span> {b.detail ?? b.message}</div>
              {b.detail && <div className="small muted">{b.message}</div>}
              <div className="small"><strong>Owner:</strong> {b.owner}{b.whoCanResolve?.length > 0 && <> · <strong>Can resolve:</strong> {b.whoCanResolve.join(', ')}</>} · <strong>Latest time to act:</strong> {b.actByLocal ? <span className={b.passed ? 'sev-critical' : ''}>{b.actByLocal}{b.passed ? ' (passed)' : ''}</span> : 'not set'}</div>
              <details open={b.type === 'confirmed_shortage' || b.type === 'awaiting_hospital'}><summary className="small">Evidence ({b.evidence.length}){b.lastVerified && <span className="muted"> · last verified {b.lastVerified.atLocal}</span>}</summary><EvidenceList ev={b.evidence} /></details>
              <div className="row tight">{b.actions.map((a: any, i: number) => <button key={i} onClick={() => act(c, a)}>{a.label}</button>)}
                {b.code === 'not_shipped' && can('shipment.plan') && <Link className="btn secondary" to={`/cases/${c.id}`}>Plan delivery</Link>}</div>
            </li>))}</ol>
        </section>))}
      {data && !data.cases.length && <p className="muted">No cases are scheduled for tomorrow in the records you can see. {can('upload.run') && <Link to="/uploads">Load a schedule</Link>}</p>}
    </div>
  );
}

export function Reconcile() {
  const { can } = useMe();
  const [sp] = useSearchParams();
  const { data, error, reload } = useData<any>('/api/reconcile');
  return (
    <div>
      <h1>Reconcile</h1>
      <p className="muted small">A later spreadsheet is an observation. When it disagrees with the system, the difference waits here; stock changes only when an authorized person decides. Every decision is kept.</p>
      <Err e={error} />
      <h2>Waiting for a decision ({data?.open.length ?? 0})</h2>
      {data?.open.map((d: any) => <Disc key={d.id} d={d} causes={data.causes} canDecide={can('reconcile.decide')} onDone={reload} hi={sp.get('ref') === d.ref} />)}
      {data && !data.open.length && <p className="ok">Nothing is waiting. Spreadsheets and system agree, or every difference has a decision.</p>}
      <h2>Decided or replaced ({data?.closed.length ?? 0})</h2>
      {data?.closed.map((d: any) => <Disc key={d.id} d={d} causes={data.causes} canDecide={false} onDone={reload} hi={sp.get('ref') === d.ref} />)}
    </div>
  );
}

function Disc({ d, causes, canDecide, onDone, hi }: { d: any; causes: Record<string, string>; canDecide: boolean; onDone: () => void; hi: boolean }) {
  const [cause, setCause] = useState(''); const [note, setNote] = useState(''); const [evidence, setEvidence] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const go = async (decision: string) => { if (busy) return; setBusy(true); setErr(null); try { await post(`/api/reconcile/${d.id}/decide`, { decision, cause, note, evidenceRef: evidence }); onDone(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const unit = d.serial_number ? `SN ${d.serial_number}` : `lot ${d.lot_number}`;
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  return (
    <section className={`card ${hi ? 'row-hi' : ''}`} data-disc={d.ref} data-status={d.status} id={d.ref}>
      <div className="row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>{d.ref}: {d.item_ref} {unit} at {d.loc_name}</h3><span className={`badge ${d.status === 'open' ? 'st-at_risk' : 'st-closed'}`}>{d.status === 'open' ? 'Cause open' : d.status === 'resolved' ? `Resolved: ${causes[d.cause] ?? d.cause}` : 'Replaced by a newer file'}</span></div>
      <p className="small muted">{d.description} · {d.manufacturer}</p>
      {d.kind === 'not_listed'
        ? <p>The system holds <strong>{d.ledger_qty}</strong>, but the latest complete file for this location does not list it. Nothing was set to zero.</p>
        : <p className="ask-arith">Spreadsheet says <strong>{d.observed_qty}</strong> · system had <strong>{d.ledger_qty}</strong> · difference <strong>{sign(d.difference)}</strong>{d.status === 'open' && d.system_now !== d.ledger_qty ? ` · system now ${d.system_now}` : ''}</p>}
      {d.previous && <p className="small">Previous file said {d.previous.qty} (<Link to={d.previous.href}>{d.previous.label}</Link>, exported {fmtTime(d.previous.exportedAt)}). Observed change between the two files: <strong>{sign(d.observedChange)}</strong>. Recorded movements in between account for <strong>{sign(d.explainedByMovements)}</strong>; unexplained: <strong>{sign(d.unexplained)}</strong>.</p>}
      {d.movementsBetween?.length > 0 && <ul className="small">{d.movementsBetween.map((m: any, i: number) => <li key={i}>{fmtTime(m.occurred_at)}: {m.movement_type} {m.inbound ? '+' : '-'}{m.qty} by {m.actor}</li>)}</ul>}
      <p className="small">Source: <Link to={d.source.href}>{d.source.label}</Link> · exported {fmtTime(d.exported_at)} · uploaded {fmtTime(d.uploaded_at)}. Reserved at this location now: {d.reserved_now}.
        {d.affectedCases.length > 0 && <> Cases needing this item: {d.affectedCases.map((c: any, i: number) => <React.Fragment key={c.id}>{i > 0 && ', '}<Link to={`/cases/${c.id}`}>{c.case_ref}</Link> ({c.qty})</React.Fragment>)}.</>}</p>
      {d.decisions.length > 0 && <><h4 style={{ margin: '8px 0 2px' }}>Decision history</h4><ol className="small">{d.decisions.map((x: any) => <li key={x.id}>{fmtTime(x.decided_at)} · {x.by_name} · <strong>{{ accept_observed: `accepted the spreadsheet quantity (${x.qty_before} → ${x.qty_after})`, keep_system: `kept the system quantity (${x.qty_before})`, note: 'added a note', superseded: 'replaced by a newer file', reopen: 'reopened' }[x.decision as string]}</strong>{x.cause ? ` · ${causes[x.cause]}` : ''}: {x.note}{x.evidence_ref ? ` (evidence: ${x.evidence_ref})` : ''}</li>)}</ol></>}
      {d.status === 'open' && canDecide && <div className="draft">
        <div className="row">
          <label className="field">Cause<select value={cause} onChange={(e) => setCause(e.target.value)} aria-label={`Cause for ${d.ref}`}><option value="">Choose…</option>{Object.entries(causes).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field" style={{ flex: 2 }}>What you checked (kept with the record)<input value={note} onChange={(e) => setNote(e.target.value)} aria-label={`Note for ${d.ref}`} maxLength={1000} /></label>
          <label className="field">Evidence reference (optional)<input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="PO, count sheet, usage form" maxLength={300} /></label>
        </div>
        {err && <p className="txt-err small" role="alert">{err}</p>}
        <div className="row tight">
          {d.kind !== 'not_listed' && <button disabled={busy || !cause || note.trim().length < 3} onClick={() => go('accept_observed')}>Accept {d.observed_qty} as the current balance</button>}
          {d.kind === 'not_listed' && <button disabled={busy || !cause || note.trim().length < 3} onClick={() => go('accept_observed')}>Accept: none on hand</button>}
          <button className="secondary" disabled={busy || !cause || note.trim().length < 3} onClick={() => go('keep_system')}>Keep the system quantity ({d.system_now})</button>
          <button className="secondary" disabled={busy || note.trim().length < 3} onClick={() => go('note')}>Add note only</button>
        </div>
      </div>}
      {d.status === 'open' && !canDecide && <p className="small muted">Your role can view this but not decide it.</p>}
    </section>
  );
}

const PRED_LABEL: Record<string, string> = { ready: 'Ready', problem: 'Problem expected', unknown: 'Did not know' };
const VER_LABEL: Record<string, string> = { yes: 'Yes, a real problem', no: 'No problem', unknown: 'Not known yet' };

export function PilotReview() {
  const { data, error, reload } = useData<any>('/api/pilot/review');
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}><h1>Pilot review</h1><Link className="btn" to="/pilot/report">One-page report</Link></div>
      <p className="muted small">For each case, record what your current process expected, what this app said, and what was verified. Entries are timestamped; a change adds a revision and keeps the earlier entry.</p>
      <Err e={error} />
      {data?.cases.map((c: any) => <ReviewCase key={c.id} c={c} labels={data.outcomeLabels} onDone={reload} />)}
      {data && !data.cases.length && <p className="muted">No cases yet.</p>}
    </div>
  );
}

function ReviewCase({ c, labels, onDone }: { c: any; labels: Record<string, string>; onDone: () => void }) {
  const [pred, setPred] = useState(c.existing?.prediction ?? ''); const [detail, setDetail] = useState(c.existing?.detail ?? '');
  const o = c.outcome ?? {};
  const [f, setF] = useState<any>({ verifiedProblem: o.verified_problem ?? '', problemDetail: o.problem_detail ?? '', problemEvidence: o.problem_evidence ?? '', intervention: o.intervention ?? '', caseOutcome: o.case_outcome ?? 'unknown',
    minutesSaved: o.minutes_saved ?? '', freightAvoided: o.freight_avoided_cents != null ? String(o.freight_avoided_cents / 100) : '', savingsEvidence: o.savings_evidence ?? '', note: o.note ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const call = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); onDone(); } catch (e: any) { setErr(e.message); } };
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="card" data-review={c.case_ref}>
      <div className="row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}><Link to={`/cases/${c.id}`}>{c.case_ref}</Link> <span className="small muted">{c.facility} · {c.startLocal}</span></h3></div>
      <div className="grid3">
        <div><h4>Your current process predicted</h4>
          <select aria-label={`Existing process prediction for ${c.case_ref}`} value={pred} onChange={(e) => setPred(e.target.value)}><option value="">Choose…</option>{Object.entries(PRED_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <input aria-label="Why" placeholder="What it was based on" value={detail} onChange={(e) => setDetail(e.target.value)} />
          <button className="secondary" disabled={!pred} onClick={() => call(() => post(`/api/pilot/cases/${c.id}/prediction`, { prediction: pred, detail }))}>{c.existing ? 'Save revision' : 'Record'}</button>
          {c.existing && <p className="tiny muted">Recorded {fmtTime(c.existing.recorded_at)} by {c.existing.by_name}{c.existing.supersedes_id ? ' (revised)' : ''}</p>}</div>
        <div><h4>This app predicted</h4>
          {c.app ? <><p><strong data-testid="app-prediction">{PRED_LABEL[c.app.prediction]}</strong></p><p className="small">{c.app.detail}</p><p className="tiny muted">Captured {fmtTime(c.app.recorded_at)}{c.app.supersedes_id ? ' (revised)' : ''}</p></> : <p className="small muted">Not captured yet. It is captured automatically when you record your own prediction.</p>}
          {c.status === 'scheduled' && <button className="secondary" onClick={() => call(() => post(`/api/pilot/cases/${c.id}/app-prediction`))}>Capture now</button>}</div>
        <div><h4>What was verified</h4>
          <label className="small">Was there really a problem?<select aria-label={`Verified problem for ${c.case_ref}`} value={f.verifiedProblem} onChange={set('verifiedProblem')}><option value="">Choose…</option>{Object.entries(VER_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <input placeholder="The verified problem" aria-label="Verified problem detail" value={f.problemDetail} onChange={set('problemDetail')} />
          <input placeholder="How it was verified (count, photo, call)" aria-label="Problem evidence" value={f.problemEvidence} onChange={set('problemEvidence')} />
          <input placeholder="What was done about it (intervention)" aria-label="Intervention" value={f.intervention} onChange={set('intervention')} />
          <label className="small">How the case went<select aria-label={`Case outcome for ${c.case_ref}`} value={f.caseOutcome} onChange={set('caseOutcome')}>{Object.entries(labels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <div className="row tight"><input style={{ width: 110 }} placeholder="Minutes saved" aria-label="Minutes saved" inputMode="numeric" value={f.minutesSaved} onChange={set('minutesSaved')} /><input style={{ width: 130 }} placeholder="Freight avoided $" aria-label="Freight avoided" inputMode="decimal" value={f.freightAvoided} onChange={set('freightAvoided')} /></div>
          <input placeholder="Evidence for savings (invoice, quote); required to count them" aria-label="Savings evidence" value={f.savingsEvidence} onChange={set('savingsEvidence')} />
          <button className="secondary" disabled={!f.verifiedProblem} onClick={() => call(() => post(`/api/pilot/cases/${c.id}/outcome`, f))}>{c.outcome ? 'Save revision' : 'Record outcome'}</button>
          {c.outcome && <p className="tiny muted">Recorded {fmtTime(c.outcome.recorded_at)} by {c.outcome.by_name}{c.outcome.supersedes_id ? ' (revised)' : ''}</p>}</div>
      </div>
      {err && <p className="txt-err small" role="alert">{err}</p>}
      {(c.history.predictions.length + c.history.outcomes.length > 0) && <details><summary className="small">History ({c.history.predictions.length + c.history.outcomes.length} entries, nothing overwritten)</summary>
        <ol className="small">{[...c.history.predictions.map((p: any) => ({ at: p.recorded_at, t: `${p.source === 'app' ? 'App' : 'Existing process'} predicted ${PRED_LABEL[p.prediction]}${p.detail ? `: ${p.detail}` : ''} (${p.by_name})` })), ...c.history.outcomes.map((x: any) => ({ at: x.recorded_at, t: `Outcome: problem ${x.verified_problem}; ${labels[x.case_outcome]}${x.intervention ? `; intervention: ${x.intervention}` : ''} (${x.by_name})` }))].sort((a, b) => String(a.at).localeCompare(String(b.at))).map((h, i) => <li key={i}>{fmtTime(h.at)} · {h.t}</li>)}</ol></details>}
    </section>
  );
}

export function PilotReport() {
  const { data, error } = useData<any>('/api/pilot/report');
  const { me } = useMe();
  if (error) return <Err e={error} />;
  if (!data) return <p>Loading…</p>;
  const Cases = ({ xs }: { xs: any[] }) => xs.length ? <span className="small">{xs.map((x, i) => <React.Fragment key={x.id}>{i > 0 && ', '}<Link to={`/cases/${x.id}`}>{x.caseRef}</Link></React.Fragment>)}</span> : <span className="small muted">none</span>;
  const Row = ({ label, k, help }: { label: string; k: string; help: string }) => (
    <tr data-metric={k}><th scope="row">{label}<div className="tiny muted">{help}</div></th>
      <td><strong data-side="app">{data.app[k].length}</strong><div><Cases xs={data.app[k]} /></div></td>
      <td><strong data-side="existing">{data.existing[k].length}</strong><div><Cases xs={data.existing[k]} /></div></td></tr>);
  return (
    <div className="report">
      <div className="row no-print" style={{ justifyContent: 'space-between' }}><p className="small"><Link to="/pilot">← Pilot review</Link></p><button className="secondary" onClick={() => window.print()}>Print</button></div>
      <h1>Pilot report: {me.user.tenantName ?? 'distributor'}</h1>
      <p className="small muted">Generated {fmtTime(data.generatedAt)}. Synthetic pilot data. Every number lists the cases behind it.</p>
      <p><strong data-metric="reviewed">{data.reviewed.length}</strong> cases reviewed: <Cases xs={data.reviewed} /></p>
      <div className="table-wrap"><table aria-label="Pilot results"><thead><tr><th></th><th>This app</th><th>Existing process</th></tr></thead><tbody>
        <Row label="Confirmed problems found" k="found" help="Predicted a problem, and a real problem was verified" />
        <Row label="False alarms" k="false_alarm" help="Predicted a problem; verified there was none" />
        <Row label="Missed problems" k="missed" help="Did not predict a problem; a real problem was verified" />
        <Row label="Correctly clear" k="correct_clear" help="Predicted ready; verified no problem" />
        <Row label="Outcome unknown" k="unknown_outcome" help="No verified outcome recorded yet; not counted either way" />
      </tbody></table></div>
      <h2>Verified problems, what was done, and how the case went</h2>
      {data.verifiedProblems.length ? <ul className="small">{data.verifiedProblems.map((p: any) => <li key={p.id}><Link to={`/cases/${p.id}`}>{p.caseRef}</Link>: {p.problem}{p.evidence ? ` (verified by: ${p.evidence})` : ''}. Intervention: {p.intervention || 'none recorded'}. Case: {p.caseOutcome}.</li>)}</ul> : <p className="small muted">None recorded.</p>}
      <p className="small">Resolved before surgery (real problem, intervention recorded, case on time): <strong>{data.resolvedBeforeSurgery.length}</strong> <Cases xs={data.resolvedBeforeSurgery} />. These count as problems found, not false alarms.</p>
      <h2>Savings with supporting evidence</h2>
      {data.savings.items.length ? <><p><strong>{data.savings.minutes}</strong> minutes · <strong>${(data.savings.freightCents / 100).toFixed(2)}</strong> freight avoided</p>
        <ul className="small">{data.savings.items.map((s: any) => <li key={s.id}><Link to={`/cases/${s.id}`}>{s.caseRef}</Link>: {s.minutes ?? 0} min, ${((s.freightCents ?? 0) / 100).toFixed(2)}. Evidence: {s.evidence}</li>)}</ul></> : <p className="small muted">No savings are reported: none has been recorded with supporting evidence.</p>}
      <p className="tiny muted">{data.revisions.predictions} prediction revision(s) and {data.revisions.outcomes} outcome revision(s) are preserved in the review history.</p>
    </div>
  );
}
