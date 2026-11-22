/**
 * Moving from another system (written with RedSpot and Salesforce in mind). File-based: there is no direct
 * connection to either system. The page says what to export, where to load it, and shows where the move stands.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useData, useMe, Err } from '../App';
import { post } from '../lib/api';
import { readBase64 } from './Uploads';

const SYSTEMS: Record<string, { name: string; how: React.ReactNode; onHand: string; cases: string; needs: string; pars: string }> = {
  redspot: { name: 'RedSpot',
    how: <>Export each list to Excel or CSV from the screen where you normally view it. We have not been given a RedSpot export layout, so the first time you load each file you match its columns once (about a minute); the match is remembered for every later file with the same headings.</>,
    onHand: 'Inventory on hand by location: warehouse, each consignment site and each rep or territory, with lot or serial and expiry.',
    cases: 'Open orders / scheduled cases: order number, hospital, surgery date and time, rep.',
    needs: 'What each order needs: order number, catalog number, quantity.', pars: 'Par levels by location and item.' },
  salesforce: { name: 'Salesforce',
    how: <>Run a report for each list and choose <strong>Export → Details Only</strong> as .xlsx or .csv. Standard column names (Account Name, Product Code, Product Name, Quantity On Hand, Start Date Time, Assigned To, Record ID) are recognized automatically; custom fields are matched by you once and remembered.</>,
    onHand: 'A Product Items (inventory) report: Location, Product Code, Product Name, Serial Number or lot, Quantity On Hand.',
    cases: 'Your case or event object: number, Account Name, Start Date Time, Assigned To, and the Record ID.',
    needs: 'Products required per case: case number, Product Code, Quantity Required.', pars: 'If you keep minimums in Salesforce: Location, Product Code, minimum quantity.' },
};

export function MoveIn() {
  const { can } = useMe();
  const { data, error, reload } = useData<any>('/api/move-in');
  const [sys, setSys] = useState('redspot');
  const [res, setRes] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const S = SYSTEMS[sys]; const c = data?.counts;
  const importPars = async (f: File | undefined) => {
    if (!f) return; setErr(null); setRes(null); setBusy(true);
    try { setRes(await post('/api/stock/par/import', { filename: f.name, contentBase64: await readBase64(f) })); reload(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const tick = (ok: boolean) => <span className={`badge ${ok ? 'st-ready' : 'st-closed'}`}>{ok ? 'Done' : 'To do'}</span>;
  return (
    <div style={{ maxWidth: 1000 }}>
      <h1>Move from another system</h1>
      <p className="muted small">Bring your records over from the system you use today, run both side by side until they agree, then switch. This works from exported files: <strong>there is no direct connection to RedSpot or Salesforce</strong>, and nothing is written back to them.</p>
      <div className="row tight" role="group" aria-label="System you are moving from"><span className="small"><strong>Moving from:</strong></span>{Object.entries(SYSTEMS).map(([k, v]) => <button key={k} className={sys === k ? '' : 'secondary'} aria-pressed={sys === k} onClick={() => setSys(k)}>{v.name}</button>)}</div>
      <div className="note">{S.how}</div>
      <Err e={error ?? err} />
      <ol className="review-steps">
        <li className="card"><h2 style={{ marginTop: 0 }}>1. Hospitals, people and stock locations {c && tick(c.hospitals > 0 && c.people > 1)}</h2>
          <p>Set up once by whoever administers the account: each hospital with its receiving rules, each person with a role, the warehouse, and a trunk location per rep.</p>
          {c && <p className="small muted">On file: {c.hospitals} hospital(s), {c.people} people, {c.stock_locations} stock location(s).</p>}</li>
        <li className="card"><h2 style={{ marginTop: 0 }}>2. Inventory on hand {c && tick(c.units > 0)}</h2>
          <p><strong>Export from {S.name}:</strong> {S.onHand}</p>
          <p>The first file for a location becomes its opening balance. Catalog numbers are kept exactly as written (leading zeros matter); names that do not match a location here are held for you to match once.</p>
          {c && <p className="small muted">On file: {c.items} catalog item(s), {c.units} unit(s) in usable locations.{data.lastInventoryLocal ? ` Last inventory file ${data.lastInventoryLocal}.` : ''}</p>}
          {can('upload.run') && <Link className="btn secondary" to={`/uploads?from=${sys}`}>Load an inventory file from {S.name}</Link>}</li>
        <li className="card"><h2 style={{ marginTop: 0 }}>3. Scheduled cases {c && tick(c.cases > 0)}</h2>
          <p><strong>Export from {S.name}:</strong> {S.cases}</p>
          <p>Map the {S.name} record number to <em>ID in your previous system</em>. It is kept on the case, and the search box at the top finds the case by that number, so nobody has to learn new numbers on day one.</p>
          {c && <p className="small muted">On file: {c.cases} scheduled case(s); {c.cases_with_previous_id} carry an ID from a previous system.</p>}
          {can('upload.run') && <Link className="btn secondary" to={`/uploads?from=${sys}`}>Load a schedule from {S.name}</Link>}</li>
        <li className="card"><h2 style={{ marginTop: 0 }}>4. What each case needs {c && tick(c.requirements > 0)}</h2>
          <p><strong>Export from {S.name}:</strong> {S.needs}</p>
          {c && <p className="small muted">On file: {c.requirements} requirement line(s).</p>}
          {can('upload.run') && <Link className="btn secondary" to={`/uploads?from=${sys}`}>Load requirements from {S.name}</Link>}</li>
        <li className="card"><h2 style={{ marginTop: 0 }}>5. Par levels {c && tick(c.pars > 0)}</h2>
          <p><strong>Export from {S.name}:</strong> {S.pars} The file needs three columns: Location, Catalog number, Par.</p>
          {c && <p className="small muted">On file: {c.pars} par level(s). <Link to="/stock/par">Open par levels</Link></p>}
          {can('par.manage') && <label className="field">Par level file (.xlsx or .csv)<input type="file" accept=".xlsx,.csv" disabled={busy} onChange={(e) => importPars(e.target.files?.[0])} /></label>}
          {res && <div className={res.held ? 'alert' : 'ok'} role="status">{res.set} par level(s) set from "{res.worksheet}"{res.held ? `; ${res.held} row(s) not loaded:` : '.'}
            {res.held > 0 && <ul className="small">{res.rows.filter((r: any) => r.outcome === 'held').slice(0, 20).map((r: any) => <li key={r.row}>Row {r.row}: {r.message}</li>)}</ul>}</div>}</li>
        <li className="card"><h2 style={{ marginTop: 0 }}>6. Run side by side, then switch {c && tick(c.inventory_uploads > 1 && c.open_differences === 0 && c.held_rows === 0)}</h2>
          <p>Keep working in {S.name}. Each day, export on-hand again and load it here. A later file never overwrites anything: where it disagrees with this system, the difference waits in <Link to="/reconcile">Reconcile</Link> for a person to decide, with the reason recorded. When a week of files produces no differences, you can stop exporting.</p>
          {c && <p className="small"><strong>{c.open_differences}</strong> difference(s) waiting · <strong>{c.held_rows}</strong> uploaded row(s) held for review · {c.inventory_uploads} inventory file(s) loaded · {c.saved_mappings} column layout(s) remembered.</p>}
          {data?.systems.length > 0 && <div className="table-wrap"><table aria-label="Files loaded by source"><thead><tr><th>Exported from</th><th>Contents</th><th>Files</th><th>Latest</th></tr></thead><tbody>{data.systems.map((x: any, i: number) => <tr key={i}><td>{x.system}</td><td>{x.kind}</td><td>{x.runs}</td><td className="small">{x.lastLocal}</td></tr>)}</tbody></table></div>}</li>
      </ol>
      <section className="card"><h2 style={{ marginTop: 0 }}>What does not come across from a file</h2>
        <ul className="small"><li>History of past cases, bills and purchase orders. Keep {S.name} available for reference.</li><li>Loaners that are already out: enter each open one on <Link to="/loaners">Loaners</Link> so its return date is tracked here.</li><li>Sets in transit on the day you switch: receive them here when they arrive.</li><li>Billing. This pilot tracks inventory and case logistics; it does not replace your billing process.</li></ul></section>
    </div>
  );
}
