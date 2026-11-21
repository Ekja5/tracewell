import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useData, useMe, Status, Err, Simulated } from '../App';
import { fmtTime, money, post, uuid } from '../lib/api';

/** A total that opens the records that make it up. */
function Drill({ label, cents, rows, render }: { label: string; cents: number | null; rows: any[]; render: (r: any) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="drill">
      <button className="linkish" aria-expanded={open} onClick={() => setOpen(!open)}>{label}: <strong>{money(cents)}</strong> ({rows.length})</button>
      {open && <ul className="small">{rows.map((r, i) => <li key={i}>{render(r)}</li>)}{!rows.length && <li className="muted">No records.</li>}</ul>}
    </span>
  );
}

function Stages({ s }: { s: any }) {
  if (!s) return null;
  const st = (done: boolean, label: string, warn = false) => <span className={`stage ${warn ? 'warn' : done ? 'done' : ''}`}>{done ? '✓ ' : '○ '}{label}</span>;
  return (
    <div className="stages" aria-label="Billing lifecycle">
      {st(s.usageRecorded.done, `Usage recorded (${s.usageRecorded.lines})`)}
      {st(s.packetPrepared.done, 'Packet prepared')}
      {st(s.packetSent.done, 'Packet sent (simulated ERP)')}
      {st(s.poReceived.full, s.poReceived.partial ? `PO partial (${money(s.poReceived.coveredCents)} covered)` : s.poReceived.full ? 'PO received in full' : 'PO received', s.poReceived.partial)}
      {s.disputed.done && st(true, 'Disputed', true)}
      {st(s.credited.done, s.credited.done ? `Credited ${money(s.credited.cents)}` : 'No credits')}
      {st(s.accepted.done, 'Accepted by customer')}
    </div>
  );
}

export function Finance() {
  const { data, error } = useData<any[]>('/api/finance/worklist');
  const rows = data ?? [];
  const outstanding = rows.reduce((a, r) => a + r.outstandingCents, 0);
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}><h1>Cases with money outstanding</h1><Link className="btn" to="/finance/queue">Open billing line queue</Link></div>
      <p className="small muted">Completed cases whose billing is not finished, oldest then largest. Amounts are draft charges; nothing here is a payment record.{' '}
        <Drill label="Outstanding (priced, not yet on a PO)" cents={outstanding} rows={rows.filter((r) => r.outstandingCents > 0)} render={(r) => <><Link to={`/cases/${r.caseId}/finance`}>{r.caseRef}</Link> {money(r.outstandingCents)}</>} /></p>
      <Err e={error} />
      <div className="table-wrap"><table aria-label="Finance worklist">
        <thead><tr><th>Case</th><th>Facility</th><th>Surgery</th><th>Age (days)</th><th>Net billed</th><th>PO covered</th><th>Outstanding</th><th>Unpriced lines</th><th>Packet</th><th>What is holding it up</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.caseId}><td><Link to={`/cases/${r.caseId}/finance`}>{r.caseRef}</Link></td><td className="small">{r.facility}</td><td className="small">{r.surgeryLocal}</td><td>{r.ageDays}</td><td>{money(r.netCents)}</td><td>{money(r.poCoveredCents)}</td><td><strong>{money(r.outstandingCents)}</strong></td><td>{r.unpricedLines}</td><td><Status s={r.packetStatus} /></td>
            <td className="small"><ul className="blockers">{r.holdingUp.map((h: string, i: number) => <li key={i}>{h}</li>)}</ul></td></tr>))}
          {data && !rows.length && <tr><td colSpan={10} className="muted">Nothing outstanding.</td></tr>}
        </tbody></table></div>
    </div>
  );
}

/** Line-level queue Finance can clear without leaving the page. */
export function FinanceQueue() {
  const { data, error, reload } = useData<any>('/api/finance/lines');
  const [cat, setCat] = useState('all');
  const lines = (data?.lines ?? []).filter((l: any) => cat === 'all' || l.category === cat);
  const cats = ['cannot price', 'needs decision', 'PO disputed', 'not on a packet', 'waiting on held line', 'awaiting PO'];
  return (
    <div>
      <h1>Billing line queue</h1>
      <p className="small muted">Every held billing line with its amount (if known), reason, owner, age and the evidence still missing. Resolve from the line; every price change is kept with who approved it.</p>
      <div className="row tight">
        <button className={cat === 'all' ? '' : 'secondary'} onClick={() => setCat('all')}>All ({data?.lines.length ?? 0})</button>
        {cats.map((c) => <button key={c} className={cat === c ? '' : 'secondary'} onClick={() => setCat(c)}>{c} ({(data?.lines ?? []).filter((l: any) => l.category === c).length})</button>)}
      </div>
      {data && <p className="small">Held lines with unknown amount: <strong>{data.totals.heldUnpricedLines}</strong> · {' '}
        <Drill label="Known amount on held lines" cents={data.totals.knownHeldCents} rows={data.lines.filter((l: any) => l.category !== 'awaiting PO' && l.amountCents != null)} render={(l) => <>{l.caseRef} {l.ref} {money(l.amountCents)} ({l.category})</>} /> · {' '}
        <Drill label="Priced, not yet covered by a PO" cents={data.totals.outstandingCents} rows={data.lines.filter((l: any) => l.outstandingCents)} render={(l) => <>{l.caseRef} {l.ref} {money(l.outstandingCents)}</>} /></p>}
      <Err e={error} />
      {lines.map((l: any) => <QueueLine key={l.chargeId} l={l} owners={data.owners} onDone={reload} />)}
      {data && !lines.length && <p className="ok">Nothing held in this category.</p>}
    </div>
  );
}

function QueueLine({ l, owners, onDone }: { l: any; owners: any[]; onDone: () => void }) {
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const call = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); onDone(); } catch (e: any) { setErr(e.message); } };
  const resolvable = l.status === 'review' || l.status === 'exception';
  return (
    <section className="card" data-charge={l.chargeId}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><Link to={`/cases/${l.caseId}/finance`}><strong>{l.caseRef}</strong></Link> · {l.facility} · <strong>{l.ref}</strong> {l.unit} · {l.disposition.replace('_', ' ')} × {l.qty}</div>
        <div><span className="badge st-review">{l.category}</span> <span className="small">age {l.ageDays} d</span></div>
      </div>
      <div className="small">Amount: <strong>{l.amountCents == null ? 'unknown' : money(l.amountCents)}</strong>{l.creditedCents ? ` (credited ${money(l.creditedCents)})` : ''}{l.outstandingCents != null ? ` · outstanding ${money(l.outstandingCents)}` : ''} · Owner: <strong>{l.ownerName}</strong></div>
      <div className="small"><strong>Missing evidence:</strong> {l.missingEvidence}</div>
      <details><summary className="small">Reason / rule</summary><div className="small">{l.reason}</div></details>
      <div className="row tight" style={{ marginTop: 6 }}>
        {resolvable && <>
          <label className="sr" htmlFor={`p-${l.chargeId}`}>Unit price in dollars</label>
          <input id={`p-${l.chargeId}`} inputMode="decimal" placeholder="Agreed unit price $" style={{ width: 160 }} value={price} onChange={(e) => setPrice(e.target.value)} />
          <label className="sr" htmlFor={`r-${l.chargeId}`}>Reason</label>
          <input id={`r-${l.chargeId}`} placeholder="Reason / source (e.g. contract amendment 4)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="small-btn" disabled={!reason.trim() || (l.amountCents == null && !price)} onClick={() => call(() => post(`/api/charges/${l.chargeId}/resolve`, { decision: 'charge', unitPriceCents: price ? Math.round(Number(price) * 100) : undefined, reason }))}>Approve charge</button>
          <button className="small-btn secondary" disabled={!reason.trim()} onClick={() => call(() => post(`/api/charges/${l.chargeId}/resolve`, { decision: 'no_charge', reason }))}>No charge</button>
        </>}
        {l.category === 'not on a packet' && <button className="small-btn" onClick={() => call(() => post(`/api/cases/${l.caseId}/packet`))}>Add to packet</button>}
        {!resolvable && l.category !== 'not on a packet' && <Link className="btn small-btn secondary" to={`/cases/${l.caseId}/finance`}>Open case billing</Link>}
        <label className="sr" htmlFor={`o-${l.chargeId}`}>Owner</label>
        <select id={`o-${l.chargeId}`} value={l.ownerUserId ?? ''} onChange={(e) => call(() => post(`/api/charges/${l.chargeId}/assign`, { userId: e.target.value }))}>{owners.map((o) => <option key={o.id} value={o.id}>Owner: {o.display_name}</option>)}</select>
      </div>
      {err && <div className="alert small">{err}</div>}
    </section>
  );
}

export function CaseFinance() {
  const { id } = useParams();
  const { can } = useMe();
  const fin = useData<any>(`/api/cases/${id}/financials`);
  const cs = useData<any>(`/api/cases/${id}`);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [po, setPo] = useState({ number: '', lines: {} as Record<string, { qty: number; price: number; include: boolean }> });
  const run = async (fn: () => Promise<any>, ok: (r: any) => string) => { setErr(null); setMsg(null); try { const r = await fn(); setMsg(ok(r)); fin.reload(); } catch (e: any) { setErr(e.message); } };
  if (fin.error) return <Err e={fin.error} />;
  if (!fin.data || !cs.data) return <p>Loading…</p>;
  const f = fin.data; const c = cs.data.case;
  const openPackets = f.packets.filter((p: any) => p.status !== 'void');
  const packet = openPackets.slice(-1)[0];
  const unpacketed = f.charges.filter((x: any) => x.status === 'draft' && !x.packet_id);
  const byItem: Record<string, { ref: string; qty: number; price: number; covered: number }> = {};
  for (const ch of f.charges.filter((x: any) => packet && x.packet_id === packet.id && x.status === 'draft')) {
    const cur = byItem[ch.catalog_item_id] ?? { ref: ch.ref, qty: 0, price: ch.unit_price_cents, covered: 0 };
    byItem[ch.catalog_item_id] = { ...cur, qty: cur.qty + ch.qty, covered: cur.covered + (ch.po_covered_qty ?? 0) };
  }
  const priced = f.charges.filter((x: any) => x.status === 'draft');
  return (
    <div>
      <p><Link to="/finance">← Finance</Link> · <Link to="/finance/queue">Line queue</Link> · <Link to={`/cases/${id}`}>Case</Link></p>
      <h1>{c.case_ref}: billing</h1>
      <p className="small">{c.facility_name} · surgery {fmtTime(c.scheduled_start, c.timezone)} · case {c.status}</p>
      <Stages s={f.stages} />
      {msg && <div className="ok" role="status">{msg}</div>}<Err e={err} />
      <section className="card">
        <h2>Totals (each opens its records)</h2>
        <div className="row">
          <Drill label="Billed (priced lines)" cents={f.grossCents} rows={priced} render={(x) => <>{x.ref} {x.serial_number ?? x.lot_number} {money(x.amount_cents)}</>} />
          <Drill label="Credited" cents={f.creditedCents} rows={f.credits} render={(x) => <>{money(x.amount_cents)} by {x.by_name}: {x.reason}</>} />
          <Drill label="Covered by POs" cents={f.poCoveredCents} rows={priced.filter((x: any) => x.po_covered_cents)} render={(x) => <>{x.ref}: {x.po_covered_qty} × {money(x.po_price_cents)} = {money(x.po_covered_cents)}</>} />
          <Drill label="Outstanding" cents={f.outstandingCents} rows={priced.filter((x: any) => x.outstanding_cents)} render={(x) => <>{x.ref} {x.serial_number ?? x.lot_number}: {money(x.outstanding_cents)}</>} />
        </div>
      </section>
      <section className="card">
        <h2>Billing lines</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Item</th><th>Unit</th><th>Disposition</th><th>Qty</th><th>Price</th><th>Amount</th><th>Credited</th><th>PO covered</th><th>Outstanding</th><th>Status</th><th>Rule, contract, rationale and history</th></tr></thead>
          <tbody>{f.charges.map((ch: any) => (
            <tr key={ch.id}>
              <td><strong>{ch.ref}</strong><div className="small">{ch.description}</div></td><td className="small">{ch.serial_number ? `SN ${ch.serial_number}` : `Lot ${ch.lot_number}`}</td>
              <td>{ch.disposition.replace('_', ' ')}</td><td>{ch.qty}</td><td>{money(ch.unit_price_cents)}</td><td>{money(ch.amount_cents)}</td><td>{money(ch.credited_cents)}</td><td>{money(ch.po_covered_cents)}</td><td>{ch.outstanding_cents == null ? '—' : money(ch.outstanding_cents)}</td><td><Status s={ch.status} /></td>
              <td className="small">{ch.contract_name ? `${ch.contract_name} v${ch.contract_version}` : 'No contract'}{ch.price_date ? ` · price date ${ch.price_date}` : ''}<br />{ch.rationale}
                <details><summary>Price and approval history ({ch.history?.length ?? 0})</summary><ol className="history">{(ch.history ?? []).map((h: any, i: number) => <li key={i}>{fmtTime(h.at)} <strong>{h.kind.replace('_', ' ')}</strong>{h.from != null || h.to != null ? ` ${money(h.from)} → ${money(h.to)}` : ''}{h.by ? ` by ${h.by}` : ''}{h.approved_by ? `, approved by ${h.approved_by}` : ''}{h.reason ? `: ${h.reason}` : ''}</li>)}</ol></details>
                {can('finance.manage') && ch.status === 'draft' && ch.amount_cents - ch.credited_cents > 0 && <CreditForm ch={ch} onDone={(m) => { setMsg(m); fin.reload(); }} onErr={setErr} />}
              </td>
            </tr>))}</tbody>
        </table></div>
        {f.voided.length > 0 && <p className="small muted">Voided lines (usage corrected before billing): {f.voided.map((v: any) => `${v.ref} ${v.serial_number ?? v.lot_number}`).join(', ')}</p>}
        <div className="row" style={{ marginTop: 8 }}>
          <a className="btn secondary" href={`/api/cases/${id}/usage-report.csv`}>Download usage report (CSV)</a>
          {unpacketed.length > 0 && <button onClick={() => run(() => post(`/api/cases/${id}/packet`), (r) => r.supplemental ? 'Supplemental packet prepared.' : r.replayed ? `${r.added} line(s) added to the open draft packet.` : 'Billing packet prepared.')}>{openPackets.length ? 'Prepare packet for new lines' : 'Generate billing packet'}</button>}
          {f.unpricedLines > 0 && <Link className="btn secondary" to="/finance/queue">Resolve {f.unpricedLines} held line(s)</Link>}
        </div>
      </section>
      {openPackets.map((p: any) => (
        <section className="card" key={p.id}>
          <h2>Packet {p.id.slice(0, 8)}: {p.packet_type.replace(/_/g, ' ')} <Status s={p.status} /></h2>
          <p className="small muted">Prepared {fmtTime(p.created_at)}{p.sent_at ? `, sent ${fmtTime(p.sent_at)}` : ''}. Tracewell never records a packet as paid. "ERP received (simulated)" means the mock adapter stored it; it is not an acknowledgment from a real ERP.</p>
          <div className="row">
            <a className="btn secondary" href={`/api/packets/${p.id}/document`}>Download packet</a>
            {p.status === 'draft' && <button onClick={() => run(() => post(`/api/packets/${p.id}/queue`), () => 'Queued to the mock ERP outbox. The worker will deliver it.')}>Send to ERP <Simulated /></button>}
            {p.status === 'po_matched' && <button onClick={() => { const ref = prompt('Customer acceptance reference'); if (ref) run(() => post(`/api/packets/${p.id}/accept`, { customerReference: ref }), () => 'Packet marked accepted by customer.'); }}>Record customer acceptance</button>}
          </div>
          <h3>Customer POs</h3>
          {f.purchaseOrders.filter((x: any) => x.packet_id === p.id).map((x: any) => <div key={x.id} className="small"><Status s={x.match_status === 'partial' ? 'pending' : x.match_status} /> PO {x.po_number} ({x.match_status}){x.match_detail.issues?.length ? `: ${x.match_detail.issues.join('; ')}` : ''}{x.match_detail.outstanding?.length ? ` · still open: ${x.match_detail.outstanding.join('; ')}` : ''}</div>)}
          {p.id === packet?.id && ['erp_received_simulated', 'queued_to_erp', 'po_partial', 'disputed'].includes(p.status) && (
            <div className="card">
              <label className="field">PO number<input value={po.number} onChange={(e) => setPo({ ...po, number: e.target.value })} /></label>
              <p className="small muted">Untick lines the customer PO does not cover yet; they stay outstanding (not disputed).</p>
              {Object.entries(byItem).map(([cid, it]) => {
                const v = po.lines[cid] ?? { qty: Math.max(0, it.qty - it.covered), price: it.price, include: it.qty - it.covered > 0 };
                return <div className="row tight" key={cid}><label><input type="checkbox" checked={v.include} onChange={(e) => setPo({ ...po, lines: { ...po.lines, [cid]: { ...v, include: e.target.checked } } })} /> {it.ref} ({it.covered}/{it.qty} covered)</label>
                  <label>Qty <input type="number" style={{ width: 70 }} value={v.qty} onChange={(e) => setPo({ ...po, lines: { ...po.lines, [cid]: { ...v, qty: Number(e.target.value) } } })} /></label>
                  <label>Unit price $ <input inputMode="decimal" style={{ width: 110 }} value={(v.price / 100).toFixed(2)} onChange={(e) => setPo({ ...po, lines: { ...po.lines, [cid]: { ...v, price: Math.round(Number(e.target.value) * 100) } } })} /></label></div>;
              })}
              <button disabled={!po.number.trim()} onClick={() => run(() => post(`/api/packets/${p.id}/po`, { poNumber: po.number, lines: Object.entries(byItem).map(([cid, it]) => ({ cid, v: po.lines[cid] ?? { qty: Math.max(0, it.qty - it.covered), price: it.price, include: it.qty - it.covered > 0 } })).filter((x) => x.v.include && x.v.qty > 0).map((x) => ({ catalogItemId: x.cid, qty: x.v.qty, unitPriceCents: x.v.price })) }), (r) => `PO recorded: ${r.status}${r.outstanding?.length ? ` (still open: ${r.outstanding.join('; ')})` : ''}${r.issues?.length ? ` (dispute: ${r.issues.join('; ')})` : ''}.`)}>Record PO</button>
            </div>)}
        </section>))}
    </div>
  );
}

function CreditForm({ ch, onDone, onErr }: { ch: any; onDone: (m: string) => void; onErr: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState('');
  const [reason, setReason] = useState('');
  if (!open) return <div><button className="linkish" onClick={() => setOpen(true)}>Correct with a credit</button></div>;
  return (
    <div className="row tight">
      <input inputMode="decimal" placeholder="Credit $" style={{ width: 100 }} value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Credit amount in dollars" />
      <input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Credit reason" />
      <button className="small-btn" disabled={!amt || !reason.trim()} onClick={async () => { try { await post(`/api/charges/${ch.id}/credit`, { amountCents: Math.round(Number(amt) * 100), reason, idempotencyKey: uuid() }); onDone('Credit issued. Inventory is unchanged: a financial correction never returns a consumed implant to stock.'); } catch (e: any) { onErr(e.message); } }}>Issue credit</button>
    </div>
  );
}
