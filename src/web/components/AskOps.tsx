/**
 * "Ask operations" panel. Answers come from the server: the text (model or demo template) plus typed
 * cards whose facts and links were computed by the app under the signed-in user's permissions. The
 * panel never computes quantities or deadlines. If the assistant is unavailable, the regular screens
 * (board, Item finder, draft review) keep working; this panel just says so.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, post, fmtTime } from '../lib/api';

type Card = { type: string; title: string; checkedAt: string; data: any; sources: { label: string; href: string; kind: string }[]; caveats: string[]; actions?: { kind: string; label: string; params: any }[] };
type Turn = { role: 'user' | 'assistant'; text: string; cards?: Card[]; clarification?: any; mode?: string; status?: string; checkedAt?: string; error?: boolean };

const SUGGEST_BOARD = ["Which of tomorrow's cases do I need to make calls on before 3 today?", 'If I move Tray 14 to the urgent case, which other cases would I put at risk?'];
const SUGGEST_PILOT = ['Which cases do I need to make calls on before 3 today?', 'The spreadsheet says five are on hand. Why are we short?', 'What changed since the previous upload?', 'Which case still needs someone at the hospital to confirm receipt?'];
const SUGGEST_CASE = ['Why does this case still show short?', 'Where can I get one more of this exact item before receiving closes?', 'What changed since I checked this case yesterday afternoon?'];

export function AskOpsButton({ caseId, facilityId, label = 'Ask operations', pilot }: { caseId?: string; facilityId?: string; label?: string; pilot?: boolean }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="ask-btn" onClick={() => setOpen(true)} aria-haspopup="dialog">{label}</button>
    {open && <AskOpsPanel caseId={caseId} facilityId={facilityId} pilot={pilot} onClose={() => setOpen(false)} />}
  </>);
}

export function AskOpsPanel({ caseId, facilityId, onClose, pilot }: { caseId?: string; facilityId?: string; onClose: () => void; pilot?: boolean }) {
  const [status, setStatus] = useState<any>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conv, setConv] = useState<string | null>(null);
  const [ctx, setCtx] = useState<any>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { api('/api/assistant/status').then(setStatus).catch(() => setStatus({ mode: 'unreachable', label: 'Assistant unreachable' })); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [turns]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const send = async (message: string, select?: any) => {
    if (busy || (!message.trim() && !select)) return;
    setBusy(true); setQ('');
    setTurns((t) => [...t, { role: 'user', text: message || '(choice)' }]);
    try {
      const r = await post('/api/assistant/ask', { conversationId: conv, message, select: select ?? null, page: { caseId: caseId ?? null, facilityId: facilityId ?? null } });
      setConv(r.conversationId); setCtx(r.context);
      setTurns((t) => [...t, { role: 'assistant', text: r.text, cards: r.cards, clarification: r.clarification, mode: r.mode, status: r.status, checkedAt: r.checkedAt }]);
    } catch (e: any) {
      setTurns((t) => [...t, { role: 'assistant', error: true, text: `I can't answer right now (${e.message}). The readiness board, Item finder and draft review still work.` }]);
    } finally { setBusy(false); }
  };
  const addCards = (cards: Card[]) => setTurns((t) => [...t, { role: 'assistant', text: '', cards }]);

  const suggestions = pilot ? SUGGEST_PILOT : caseId ? SUGGEST_CASE : SUGGEST_BOARD;
  return (
    <div className="ask-overlay" role="dialog" aria-modal="true" aria-label="Ask operations">
      <div className="ask-panel">
        <div className="ask-head">
          <strong>Ask operations</strong>
          <button className="secondary" onClick={onClose} aria-label="Close Ask operations">Close</button>
        </div>
        {status && <div className={`ask-mode mode-${status.mode}`} data-testid="assistant-mode">{status.label}</div>}
        {ctx && (ctx.caseRef || ctx.catalogRef) && <div className="small muted ask-ctx">Context: {[ctx.caseRef, ctx.catalogRef && `${ctx.catalogRef}${ctx.manufacturer ? ` (${ctx.manufacturer})` : ''}${ctx.packageUnits ? `, pack of ${ctx.packageUnits}` : ''}`].filter(Boolean).join(' · ')}</div>}
        <div className="ask-body">
          {turns.length === 0 && <div className="small">
            <p className="muted">Logistics and admin questions about cases you can see. Answers cite the records they used. Product choice and sterile-processing release stay with authorized people.</p>
            <div className="ask-suggest">{suggestions.map((s) => <button key={s} className="secondary chip" onClick={() => send(s)}>{s}</button>)}</div>
          </div>}
          {turns.map((t, i) => <TurnView key={i} t={t} conv={conv} onChoose={(o: any) => send(`${o.label.split(' · ').slice(0, 2).join(' · ')}`, o.contextPatch)} onCards={addCards} />)}
          {busy && <p className="muted small" role="status">Checking records…</p>}
          <div ref={endRef} />
        </div>
        <form className="ask-input" onSubmit={(e) => { e.preventDefault(); send(q); }}>
          <label className="sr" htmlFor="ask-q">Question</label>
          <input id="ask-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={caseId ? 'Ask about this case…' : 'Ask about cases, items, transfers…'} maxLength={1000} autoComplete="off" />
          <button type="submit" disabled={busy || !q.trim()}>Ask</button>
        </form>
      </div>
    </div>
  );
}

function TurnView({ t, conv, onChoose, onCards }: { t: Turn; conv: string | null; onChoose: (o: any) => void; onCards: (c: Card[]) => void }) {
  if (t.role === 'user') return <div className="ask-user">{t.text}</div>;
  return (
    <div className={`ask-answer ${t.error || t.status !== 'ok' && t.status ? 'ask-error' : ''}`}>
      {t.text && <p>{t.text}</p>}
      {t.mode === 'demo' && <div className="tiny muted">Demo-mode answer (deterministic template; no AI model called){t.checkedAt ? ` · checked ${fmtTime(t.checkedAt)}` : ''}</div>}
      {t.mode === 'provider' && t.checkedAt && <div className="tiny muted">Model-written summary; facts below from records checked {fmtTime(t.checkedAt)}</div>}
      {t.clarification && <div className="ask-choices" role="group" aria-label={t.clarification.question}>
        {t.clarification.options.map((o: any, i: number) => <button key={i} className="secondary" onClick={() => onChoose(o)}>{o.label}</button>)}
      </div>}
      {t.cards?.map((c, i) => <CardView key={i} c={c} conv={conv} onCards={onCards} />)}
    </div>
  );
}

function Sources({ c }: { c: Card }) {
  return (<div className="ask-sources small">
    {c.caveats?.length > 0 && <ul className="ask-caveats">{c.caveats.map((x, i) => <li key={i}>{x}</li>)}</ul>}
    {c.sources?.length > 0 && <div>Sources: {c.sources.map((s, i) => <React.Fragment key={i}>{i > 0 && ' · '}<Link to={s.href} data-kind={s.kind}>{s.label}</Link></React.Fragment>)}</div>}
    <div className="muted tiny">Checked {fmtTime(c.checkedAt)}</div>
  </div>);
}

function Actions({ c, conv, onCards }: { c: Card; conv: string | null; onCards: (c: Card[]) => void }) {
  const [err, setErr] = useState<string | null>(null);
  if (!c.actions?.length) return null;
  const run = async (a: any) => {
    setErr(null);
    try { const r = await post('/api/assistant/drafts', { kind: a.kind, conversationId: conv, ...a.params }); onCards([r.card, ...(r.extra ? [r.extra] : [])]); }
    catch (e: any) { setErr(e.message); }
  };
  return (<div className="row tight ask-actions">{c.actions.map((a, i) => <button key={i} className="secondary" onClick={() => run(a)}>{a.label}</button>)}{err && <span className="txt-err small">{err}</span>}</div>);
}

function CardView({ c, conv, onCards }: { c: Card; conv: string | null; onCards: (c: Card[]) => void }) {
  const d = c.data ?? {};
  return (
    <section className={`ask-card ask-${c.type}`} data-card={c.type}>
      <h4>{c.title}</h4>
      {c.type === 'call_list' && <CallList d={d} />}
      {c.type === 'shortage' && <>
        <p className="ask-arith" data-testid="shortage-arith"><strong>{d.sentence}</strong></p>
        <table className="ask-table"><thead><tr><th>Unit</th><th>Where</th><th>Counts as</th></tr></thead>
          <tbody>{d.lines?.map((l: any, i: number) => <tr key={i}><td>{l.unit}</td><td>{l.location}</td><td>{l.caseId ? <>{l.why.replace(l.caseRef, '')} <Link to={`/cases/${l.caseId}`}>{l.caseRef}</Link></> : l.why}</td></tr>)}</tbody></table>
      </>}
      {c.type === 'availability' && <Availability d={d} />}
      {c.type === 'impact' && <>
        {d.atRisk?.length ? <ul>{d.atRisk.map((a: any, i: number) => <li key={i}><Link to={`/cases/${a.caseId}`}>{a.caseRef}</Link> ({a.startLocal}, {a.facility}): <strong>{a.risk}</strong>{a.replacement ? `; replacement ${a.replacement}` : ''}</li>)}</ul> : <p>No case currently holds this unit.</p>}
        {d.turnaround?.length > 0 && <p className="small">Same tray type within 24 h: {d.turnaround.map((x: any) => `${x.caseRef} (${x.startLocal})`).join(', ')}. Reprocessing time may not allow both.</p>}
        {d.targetNote && <p className="small">{d.targetNote}</p>}
        <p className="tiny muted">What-if only. Nothing was changed.</p>
      </>}
      {c.type === 'history' && <>
        {d.gap && <p className="ask-gap" role="note"><strong>History gap:</strong> {d.gapText}</p>}
        {d.events?.length ? <ol className="small ask-events">{d.events.map((e: any, i: number) => <li key={i}><span className="muted">{e.atLocal}</span> · {e.kind} · {e.actor}{e.detail ? `: ${e.detail}` : ''}</li>)}</ol> : <p className="small">No recorded changes in that window.</p>}
      </>}
      {c.type === 'readiness' && <>
        <p className="small">{d.facility} · {d.start}</p>
        {d.blockers?.length ? <ol className="small">{d.blockers.map((b: any, i: number) => <li key={i}>{b.explanation} <span className="muted">Owner: {b.owner ?? 'Unassigned'}{b.actByLocal ? ` · act by ${b.actByLocal}` : ''}</span></li>)}</ol> : <p className="ok small">No open blockers.</p>}
      </>}
      {c.type === 'changes' && <Changes d={d} />}
      {c.type === 'queue' && <ol className="ask-queue">{d.items.map((i: any, n: number) => <li key={n} data-priority={i.priority}>
        <p><span className={`badge q-badge-${i.priority}`}>{i.priority.toUpperCase()}</span> {i.caseId ? <Link to={`/cases/${i.caseId}`}><strong>{i.caseRef}</strong></Link> : null} <strong>{i.title}</strong>{i.deadlineLocal && <span className="small muted"> · act by {i.deadlineLocal}</span>}</p>
        <p className="small"><strong>Why:</strong> {i.why}</p><p className="small"><strong>Safest fix:</strong> {i.recommended}{i.waitingOn ? ` Waiting on ${i.waitingOn}.` : ''}</p>
        <p className="small">{i.actions.map((a: any, j: number) => <Link key={j} className="btn secondary" style={{ marginRight: 6 }} to={a.href}>{a.label}</Link>)}</p></li>)}
        {d.items.length === 0 && <li>Nothing needs fixing{d.byLocal ? ` before ${d.byLocal}` : ''}.</li>}</ol>}
      {c.type === 'awaiting' && <div>{d.entries.map((e: any, i: number) => <div key={i} className="ask-entry" data-await={e.caseRef}>
        <p><Link to={`/cases/${e.caseId}`}><strong>{e.caseRef}</strong></Link> · {e.facility} · surgery {e.startLocal}{e.tomorrow ? ' (tomorrow)' : ''}</p>
        <p className="small">Can confirm receipt: <strong>{e.whoCanResolve.length ? e.whoCanResolve.join(', ') : 'no receiving user set up'}</strong>{e.actByLocal ? ` · needed by ${e.actByLocal}${e.passed ? ' (passed)' : ''}` : ''}</p>
        <ul className="small">{e.evidence.map((x: any, j: number) => <li key={j}>{x.href ? <Link to={x.href}>{x.label}</Link> : x.label}<span className="muted"> · {x.atLocal}</span></li>)}</ul></div>)}</div>}
      {c.type === 'shortage' && d.evidence?.length > 0 && <details open><summary className="small">Evidence and when each fact was last verified</summary><ul className="small">{d.evidence.map((e: any, i: number) => <li key={i} data-evidence={e.kind}>{e.href ? <Link to={e.href}>{e.label}</Link> : e.label}{e.atLocal && <span className="muted"> · {e.atLocal}</span>}</li>)}</ul></details>}
      {c.type === 'notice' && <p className={d.unavailable ? 'txt-err' : ''}>{d.text}</p>}
      {c.type === 'draft' && <DraftView c={c} onCards={onCards} conv={conv} />}
      {c.type !== 'draft' && <Actions c={c} conv={conv} onCards={onCards} />}
      <Sources c={c} />
    </section>
  );
}

function CallList({ d }: { d: any }) {
  const row = (e: any, i: number) => (
    <tr key={i} className={e.owner === 'Unassigned' ? 'unassigned' : ''}>
      <td className="col-case"><Link to={e.recordLink}>{e.caseRef}</Link><div className="tiny muted">{e.facility}</div></td>
      <td className="small">{e.typeLabel && <span className={`badge ${e.type === 'confirmed_shortage' ? 'st-blocked' : e.type === 'missing_information' ? 'st-closed' : 'st-at_risk'}`}>{e.typeLabel}</span>} {e.detail ?? e.issue}{e.whoCanResolve?.length > 0 && <div className="tiny">Can resolve: {e.whoCanResolve.join(', ')}</div>}{e.lastVerified && <div className="tiny muted">Last verified {e.lastVerified.atLocal}: {e.lastVerified.what}</div>}</td>
      <td className="col-owner">{e.owner === 'Unassigned' ? <strong className="sev-warning">Unassigned</strong> : e.owner}<div className="small"><span className="tiny muted">Act by </span>{e.deadlineLocal}</div></td>
    </tr>);
  return (<>
    {d.upcoming?.length ? <div className="table-wrap"><table className="ask-table"><thead><tr><th>Case</th><th>Issue</th><th>Owner · act by (facility local time)</th></tr></thead><tbody>{d.upcoming.map(row)}</tbody></table></div>
      : <p className="ok small">No calls needed{d.cutoffLocal ? ` before ${d.cutoffLocal}` : ''}.</p>}
    {d.passed?.length > 0 && <><h5 className="sev-critical">Deadline already passed ({d.passed.length})</h5>
      <div className="table-wrap"><table className="ask-table passed"><tbody>{d.passed.map(row)}</tbody></table></div></>}
    <p className="tiny muted">{d.casesChecked} case(s) checked. Deadlines in each facility's local time.</p>
  </>);
}

function Changes({ d }: { d: any }) {
  if (d.gap) return <p className="ask-gap" role="note">{d.gap}</p>;
  const delta = (x: any) => (x.delta == null ? 'new' : x.delta > 0 ? `+${x.delta}` : String(x.delta));
  return (<>
    <p className="small">Latest: <Link to={`/uploads/runs/${d.latest.runId}`}>{d.latest.filename}</Link>, exported {d.latest.exportedAtLocal}, uploaded {d.latest.uploadedAtLocal} by {d.latest.by}. Previous: <Link to={`/uploads/runs/${d.previous.runId}`}>{d.previous.filename}</Link>, exported {d.previous.exportedAtLocal}.</p>
    {d.changes.length ? <div className="table-wrap"><table className="ask-table"><thead><tr><th>Item</th><th>Before → after</th><th>Status and evidence</th></tr></thead><tbody>
      {d.changes.map((x: any, i: number) => <tr key={i} data-change={x.ref} data-status={x.status}><td className="col-case"><strong>{x.ref}</strong> {x.unit}<div className="tiny muted">{x.location}</div></td>
        <td className="nowrap">{x.before ?? '—'} → <strong>{x.after}</strong> ({delta(x)})</td>
        <td className="small">{x.statusText}<div className="tiny"><Link to={x.row.href}>{x.row.label}</Link>{x.previousRow && <> · <Link to={x.previousRow.href}>{x.previousRow.label}</Link></>}</div></td></tr>)}
    </tbody></table></div> : <p className="small">No line changed between the two files.</p>}
    <p className="tiny muted">{d.unchangedCount} line(s) unchanged.{d.notListed.length ? ` ${d.notListed.length} item(s) the system holds are not listed in the latest file; nothing was zeroed.` : ''}</p>
    {d.effects.length > 0 && <><h5>Effect on upcoming cases</h5><ul className="small">{d.effects.map((e: any, i: number) => <li key={i}><Link to={`/cases/${e.caseId}`}>{e.caseRef}</Link> ({e.startLocal}): <strong>{e.sentence}</strong></li>)}</ul></>}
  </>);
}

function Availability({ d }: { d: any }) {
  if (d.mode === 'ambiguous') return <p>{d.text}</p>;
  const best = d.best;
  return (<>
    {d.mode === 'stock' ? null : best ? <p><strong>Best: {best.label}</strong> at {best.location}{best.custodian ? ` (custodian ${best.custodian})` : ''}. Estimated arrival {best.arrivalLocal ?? fmtTime(best.estimatedArrival)}{d.requiredByLocal ? `; must arrive by ${d.requiredByLocal}` : ''}. <span className="muted small">{best.evidence?.text}</span></p>
      : <p className="txt-err">No eligible exact unit found{d.requiredByLocal ? ` before ${d.requiredByLocal}` : ''}.</p>}
    {d.eligible?.length > 1 && <p className="small">Other eligible: {d.eligible.slice(1, 4).map((e: any) => `${e.label} at ${e.location}`).join('; ')}</p>}
    {d.excluded?.length > 0 && <details open><summary className="small">Excluded closer units ({d.excluded.length})</summary>
      <ul className="small">{d.excluded.slice(0, 6).map((x: any, i: number) => <li key={i}>{x.label} at {x.location}{x.travelMinutes != null ? ` (${x.travelMinutes} min)` : ''}: {x.reasons?.join('; ')}</li>)}</ul></details>}
    {d.mode === 'stock' && <><p><strong>{d.usableTotal} usable</strong> across visible locations.</p>
      <ul className="small">{d.rows?.map((u: any, i: number) => <li key={i}>{u.label} at {u.location} ({u.custodian}): {u.usable ? 'usable' : u.whyNot.join('; ')} <span className="muted">· {u.evidence?.text}</span></li>)}</ul></>}
  </>);
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

export function DraftView({ c, onCards, conv }: { c: Card; onCards?: (c: Card[]) => void; conv?: string | null }) {
  const [card, setCard] = useState<Card>(c);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const d = card.data; const p = d.payload;
  const [text, setText] = useState<string>(p.text ?? '');
  const [toName, setToName] = useState<string>(p.to?.name ?? '');
  const [note, setNote] = useState<string>(p.note ?? '');
  const [assignee, setAssignee] = useState<string>(p.assigneeUserId ?? '');
  const call = async (fn: () => Promise<any>) => { if (busy) return; setBusy(true); setErr(null); try { const r = await fn(); if (r?.data) setCard(r); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const saveEdits = () => call(() => post(`/api/assistant/drafts/${d.id}/edit`, d.kind === 'message' ? { text, toName } : d.kind === 'assign_followup' ? { assigneeUserId: assignee || undefined, note } : { note }));
  const confirm = () => call(async () => { if (d.kind === 'assign_followup' && assignee !== p.assigneeUserId) await post(`/api/assistant/drafts/${d.id}/edit`, { assigneeUserId: assignee, note }); else if (d.kind === 'transfer' && note !== p.note) await post(`/api/assistant/drafts/${d.id}/edit`, { note }); return post(`/api/assistant/drafts/${d.id}/confirm`); });
  const editable = d.status === 'draft';
  return (
    <div className={`draft draft-${d.status}`} data-draft-kind={d.kind} data-draft-status={d.status}>
      <div className="small"><span className={`badge st-${d.status === 'confirmed' ? 'ready' : d.status === 'stale' ? 'blocked' : 'at_risk'}`}>{d.status === 'draft' ? 'DRAFT: review before confirming' : d.status.toUpperCase()}</span></div>
      {d.kind === 'transfer' && <dl className="draft-fields">
        <dt>Item</dt><dd>{p.ref} ({p.manufacturer}) · {p.unitLabel} · qty {p.qty}</dd>
        <dt>From</dt><dd>{p.sourceLabel}</dd>
        <dt>To</dt><dd>{p.destination} for <Link to={`/cases/${p.caseId}`}>{p.caseRef}</Link> (surgery {p.startLocal})</dd>
        <dt>Arrival</dt><dd>{p.arrivalLocal} (estimate) · must arrive by {p.requiredByLocal} · {p.meetsCutoff ? <span className="txt-ok">meets cutoff</span> : <span className="txt-err">misses cutoff</span>}</dd>
        <dt>Affected cases</dt><dd><ul className="small">{p.affectedCases?.map((a: any, i: number) => <li key={i}><strong>{a.caseRef}</strong>: {a.effect}</li>)}</ul></dd>
        <dt><label htmlFor={`note-${d.id}`}>Note</label></dt><dd>{editable ? <input id={`note-${d.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /> : (p.note || '—')}</dd>
      </dl>}
      {d.kind === 'message' && <div>
        <label className="small">To <input value={toName} onChange={(e) => setToName(e.target.value)} disabled={!editable} /></label>
        {p.warning && <p className="small sev-warning">{p.warning}</p>}
        <label className="sr" htmlFor={`msg-${d.id}`}>Message text</label>
        <textarea id={`msg-${d.id}`} rows={5} value={text} onChange={(e) => setText(e.target.value)} disabled={!editable} />
        <div className="row tight">
          <button className="secondary" onClick={async () => setCopied(await copyText(text))}>{copied ? 'Copied' : 'Copy text'}</button>
          {editable && (text !== p.text || toName !== p.to?.name) && <button className="secondary" onClick={saveEdits} disabled={busy}>Save edits</button>}
          <span className="small muted">Not sent. Tracewell keeps messages as drafts in this pilot; send it yourself.</span>
        </div>
      </div>}
      {d.kind === 'assign_followup' && <div>
        <p className="small">{p.issueText}</p>
        <label className="small">Owner <select value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={!editable}>
          <option value="">Choose…</option>{p.choices?.map((u: any) => <option key={u.id} value={u.id}>{u.display_name}{u.role ? ` (${u.role.replace(/_/g, ' ')})` : ''}</option>)}</select></label>
        <label className="small">Note <input value={note} onChange={(e) => setNote(e.target.value)} disabled={!editable} maxLength={500} /></label>
      </div>}
      {d.status === 'stale' && d.result && <div className="ask-gap" role="alert">
        <p><strong>Changed since the draft:</strong> {d.result.whatChanged}</p>
        {d.result.refreshOptions?.length ? <><p className="small">Current eligible options:</p>
          <div className="row tight">{d.result.refreshOptions.map((o: any, i: number) => <button key={i} className="secondary" onClick={() => call(async () => { const r = await post('/api/assistant/drafts', { kind: 'transfer', conversationId: conv, caseId: p.caseId, requirementId: p.requirementId, stockItemId: o.stockItemId, locationId: o.locationId, ownerPartyId: o.ownerPartyId }); onCards?.([r.card]); })}>Draft with {o.label} ({o.location}{o.meetsCutoff === false ? ', misses cutoff' : ''})</button>)}</div></>
          : <p className="small">No other eligible unit right now. Check the Item finder.</p>}
      </div>}
      {d.status === 'confirmed' && d.result && <p className="ok small" role="status">Confirmed through the normal transfer/assignment service{d.result.shipmentRef ? `: shipment ${d.result.shipmentRef}` : ''}{d.result.assignedTo ? `: assigned to ${d.result.assignedTo}` : ''}. {d.result.shipmentId && <Link to={`/shipments/${d.result.shipmentId}`}>Open shipment</Link>}</p>}
      {err && <p className="txt-err small" role="alert">{err}</p>}
      {editable && d.kind !== 'message' && <div className="row tight">
        <button onClick={confirm} disabled={busy || (d.kind === 'assign_followup' && !assignee)} data-testid="confirm-draft">{busy ? 'Checking…' : d.kind === 'transfer' ? 'Confirm transfer' : 'Confirm assignment'}</button>
        <button className="secondary" onClick={() => call(() => post(`/api/assistant/drafts/${d.id}/discard`))} disabled={busy}>Discard</button>
        <span className="tiny muted">Rechecks permissions, availability, reservations, holds and the facility cutoff before anything is written.</span>
      </div>}
    </div>
  );
}
