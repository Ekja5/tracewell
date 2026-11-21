import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useData, useMe, Status, Err, Simulated } from '../App';
import { fmtTime, money, post, uuid } from '../lib/api';

export function Finance() {
  const { data, error } = useData<any[]>('/api/finance/worklist');
  const total = (data ?? []).reduce((a, r) => a + r.netCents, 0);
  return (
    <div>
      <h1>Unbilled and disputed cases</h1>
      <p className="small muted">Completed cases whose billing packet is not yet accepted, oldest first, then by dollars. Amounts are draft charges net of credits; nothing here is a payment record. Total outstanding (draft, priced): <strong>{money(total)}</strong>.</p>
      <Err e={error} />
      <div className="table-wrap"><table aria-label="Finance worklist">
        <thead><tr><th>Case</th><th>Facility</th><th>Surgery</th><th>Age (days)</th><th>Draft net</th><th>Unpriced lines</th><th>Packet</th><th>What is holding it up</th></tr></thead>
        <tbody>{(data ?? []).map((r) => (
          <tr key={r.caseId}><td><Link to={`/cases/${r.caseId}/finance`}>{r.caseRef}</Link></td><td className="small">{r.facility}</td><td className="small">{r.surgeryLocal}</td><td>{r.ageDays}</td><td>{money(r.netCents)}</td><td>{r.unpricedLines}</td><td><Status s={r.packetStatus} /></td>
            <td className="small"><ul className="blockers">{r.holdingUp.map((h: string, i: number) => <li key={i}>{h}</li>)}</ul></td></tr>))}
          {data && !data.length && <tr><td colSpan={8} className="muted">Nothing outstanding.</td></tr>}
        </tbody></table></div>
    </div>
  );
}

export function CaseFinance() {
  const { id } = useParams();
  const { can } = useMe();
  const fin = useData<any>(`/api/cases/${id}/financials`);
  const cs = useData<any>(`/api/cases/${id}`);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [po, setPo] = useState({ number: '', lines: {} as Record<string, { qty: number; price: number }> });
  const run = async (fn: () => Promise<any>, ok: string) => { setErr(null); setMsg(null); try { await fn(); setMsg(ok); fin.reload(); } catch (e: any) { setErr(e.message); } };
  if (fin.error) return <Err e={fin.error} />;
  if (!fin.data || !cs.data) return <p>Loading…</p>;
  const f = fin.data; const c = cs.data.case;
  const packet = f.packets.find((p: any) => p.status !== 'void');
  const byItem: Record<string, { ref: string; qty: number; price: number }> = {};
  for (const ch of f.charges.filter((x: any) => packet && x.packet_id === packet.id)) byItem[ch.catalog_item_id] = { ref: ch.ref, qty: (byItem[ch.catalog_item_id]?.qty ?? 0) + ch.qty, price: ch.unit_price_cents };
  return (
    <div>
      <p><Link to="/finance">← Finance worklist</Link> · <Link to={`/cases/${id}`}>Case</Link></p>
      <h1>{c.case_ref}: charges and packet</h1>
      <p className="small">{c.facility_name} · surgery {fmtTime(c.scheduled_start, c.timezone)} · case {c.status}</p>
      {msg && <div className="ok" role="status">{msg}</div>}<Err e={err} />
      <section className="card">
        <h2>Draft charges (derived from contract rules)</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Item</th><th>Unit</th><th>Disposition</th><th>Qty</th><th>Price</th><th>Amount</th><th>Credits</th><th>Status</th><th>Rule, contract version, price date, rationale</th><th>Replenishment</th><th></th></tr></thead>
          <tbody>{f.charges.map((ch: any) => <ChargeRow key={ch.id} ch={ch} can={can('finance.manage')} onDone={(m) => { setMsg(m); fin.reload(); }} onErr={setErr} />)}</tbody>
        </table></div>
        <p>Gross {money(f.grossCents)} · credits {money(f.creditedCents)} · <strong>net {money(f.netCents)}</strong></p>
        <div className="row">
          <a className="btn secondary" href={`/api/cases/${id}/usage-report.csv`}>Download usage report (CSV)</a>
          {!packet && <button onClick={() => run(() => post(`/api/cases/${id}/packet`), 'Draft packet generated.')}>Generate billing packet</button>}
        </div>
      </section>
      {packet && (
        <section className="card">
          <h2>Packet: {packet.packet_type.replace(/_/g, ' ')} <Status s={packet.status} /></h2>
          <p className="small muted">Drafted {fmtTime(packet.created_at)}. Tracewell never records a packet as paid. "ERP received (simulated)" means the mock adapter stored it; it is not an acknowledgment from a real ERP.</p>
          <div className="row">
            <a className="btn secondary" href={`/api/packets/${packet.id}/document`}>Download packet</a>
            {packet.status === 'draft' && <button onClick={() => run(() => post(`/api/packets/${packet.id}/queue`), 'Queued to the mock ERP outbox. The worker will deliver it.')}>Send to ERP <Simulated /></button>}
          </div>
          <h3>Customer PO</h3>
          {f.purchaseOrders.map((p: any) => <div key={p.id} className="small"><Status s={p.match_status} /> PO {p.po_number}: {p.match_detail.issues?.join('; ') || 'matches packet'}</div>)}
          {['erp_received_simulated', 'queued_to_erp', 'draft', 'disputed'].includes(packet.status) && (
            <div className="card">
              <label className="field">PO number<input value={po.number} onChange={(e) => setPo({ ...po, number: e.target.value })} /></label>
              {Object.entries(byItem).map(([cid, it]) => {
                const v = po.lines[cid] ?? { qty: it.qty, price: it.price };
                return <div className="row" key={cid}><span>{it.ref}</span>
                  <label>Qty <input type="number" style={{ width: 80 }} value={v.qty} onChange={(e) => setPo({ ...po, lines: { ...po.lines, [cid]: { ...v, qty: Number(e.target.value) } } })} /></label>
                  <label>Unit price (cents) <input type="number" style={{ width: 120 }} value={v.price} onChange={(e) => setPo({ ...po, lines: { ...po.lines, [cid]: { ...v, price: Number(e.target.value) } } })} /></label></div>;
              })}
              <button onClick={() => run(() => post(`/api/packets/${packet.id}/po`, { poNumber: po.number, lines: Object.entries(byItem).map(([cid, it]) => ({ catalogItemId: cid, qty: (po.lines[cid] ?? { qty: it.qty }).qty, unitPriceCents: (po.lines[cid] ?? { price: it.price }).price })) }), 'PO recorded and compared.')}>Record PO</button>
            </div>)}
          {packet.status === 'po_matched' && <button onClick={() => { const ref = prompt('Customer acceptance reference'); if (ref) run(() => post(`/api/packets/${packet.id}/accept`, { customerReference: ref }), 'Packet marked accepted by customer.'); }}>Record customer acceptance</button>}
        </section>)}
      {f.credits.length > 0 && <section className="card"><h2>Credits and corrections</h2>{f.credits.map((cr: any) => <div key={cr.id} className="small">{money(cr.amount_cents)} by {cr.by_name} {fmtTime(cr.created_at)}: {cr.reason}. Inventory unaffected.</div>)}</section>}
    </div>
  );
}

function ChargeRow({ ch, can, onDone, onErr }: { ch: any; can: boolean; onDone: (m: string) => void; onErr: (e: string) => void }) {
  const [price, setPrice] = useState('');
  const call = async (fn: () => Promise<any>, ok: string) => { try { await fn(); onDone(ok); } catch (e: any) { onErr(e.message); } };
  return (
    <tr>
      <td><strong>{ch.ref}</strong><div className="small">{ch.description}</div></td><td className="small">{ch.serial_number ? `SN ${ch.serial_number}` : `Lot ${ch.lot_number}`}</td>
      <td>{ch.disposition.replace('_', ' ')}</td><td>{ch.qty}</td><td>{money(ch.unit_price_cents)}</td><td>{money(ch.amount_cents)}</td><td>{money(ch.credited_cents)}</td><td><Status s={ch.status} /></td>
      <td className="small">{ch.contract_name ? `${ch.contract_name} v${ch.contract_version}` : 'No contract'}{ch.price_date ? ` · price date ${ch.price_date}` : ''}<br />{ch.rationale}</td>
      <td className="small">{ch.replenish_action} ({ch.replenish_status})</td>
      <td>{can && ['review', 'exception'].includes(ch.status) && !ch.packet_id && <div className="small">
        <input placeholder="Unit price cents" style={{ width: 120 }} value={price} onChange={(e) => setPrice(e.target.value)} />
        <button className="secondary" onClick={() => { const reason = prompt('Reason for decision'); if (reason) call(() => post(`/api/charges/${ch.id}/resolve`, { decision: 'charge', unitPriceCents: price ? Number(price) : undefined, reason }), 'Charge resolved as chargeable.'); }}>Charge</button>
        <button className="secondary" onClick={() => { const reason = prompt('Reason for no charge'); if (reason) call(() => post(`/api/charges/${ch.id}/resolve`, { decision: 'no_charge', reason }), 'Resolved as no charge.'); }}>No charge</button></div>}
        {can && ch.status === 'draft' && ch.amount_cents - ch.credited_cents > 0 && <button className="link" onClick={() => { const amt = prompt('Credit amount in dollars'); const reason = amt && prompt('Credit reason'); if (amt && reason) call(() => post(`/api/charges/${ch.id}/credit`, { amountCents: Math.round(Number(amt) * 100), reason, idempotencyKey: uuid() }), 'Credit issued. Inventory unchanged.'); }}>Issue credit</button>}</td>
    </tr>
  );
}
