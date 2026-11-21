import React, { useState } from 'react';
import { useData, Err, Status } from '../App';
import { fmtTime, post } from '../lib/api';

export function ImportPage() {
  const spec = useData<any>('/api/imports/spec');
  const history = useData<any[]>('/api/imports');
  const [kind, setKind] = useState('opening_balances');
  const [source, setSource] = useState('LEGACY-SPREADSHEET');
  const [filename, setFilename] = useState('');
  const [csv, setCsv] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [report, setReport] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const fields = spec.data?.[kind]?.fields ?? [];

  const loadCsv = async (text: string, name: string) => {
    setCsv(text); setFilename(name); setReport(null); setErr(null);
    try { const r = await post('/api/imports/headers', { kind, csv: text }); setHeaders(r.headers); setMapping(r.suggested); } catch (e: any) { setErr(e.message); }
  };
  const run = async (mode: 'dry_run' | 'commit') => {
    setErr(null);
    try { setReport(await post('/api/imports/run', { kind, filename: filename || 'pasted.csv', sourceSystem: source, csv, mapping, mode })); history.reload(); } catch (e: any) { setErr(e.message); }
  };
  return (
    <div>
      <h1>Import catalog and opening balances</h1>
      <p className="small muted">Steps: download a template, load your CSV, confirm the column mapping, run a dry run, then commit. Re-importing the same source rows is skipped, never double-posted. Source IDs and batch provenance are preserved.</p>
      <section className="card">
        <div className="row">
          <label className="field">Import type<select value={kind} onChange={(e) => { setKind(e.target.value); setReport(null); if (csv) loadCsv(csv, filename); }}>
            <option value="catalog">Catalog items</option><option value="packages">Package configurations (UOM)</option><option value="opening_balances">Opening balances</option></select></label>
          <label className="field">Source system (provenance)<input value={source} onChange={(e) => setSource(e.target.value)} /></label>
          <a className="btn secondary" href={`/api/imports/templates/${kind}.csv`} style={{ alignSelf: 'flex-end' }}>Download CSV template</a>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <label className="field">CSV file<input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) loadCsv(await f.text(), f.name); }} /></label>
        </div>
        <label className="field" style={{ marginTop: 10 }}>…or paste CSV<textarea rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} onBlur={() => csv && loadCsv(csv, filename || 'pasted.csv')} /></label>
      </section>
      {headers.length > 0 && (
        <section className="card"><h2>Column mapping preview</h2>
          <div className="table-wrap"><table><thead><tr><th>Target field</th><th>Required</th><th>Source column</th><th>Help</th></tr></thead>
            <tbody>{fields.map((f: any) => (
              <tr key={f.name}><td><code>{f.name}</code></td><td>{f.required ? 'Yes' : ''}</td>
                <td><select aria-label={`Source column for ${f.name}`} value={mapping[f.name] ?? ''} onChange={(e) => setMapping({ ...mapping, [f.name]: e.target.value || null })}><option value="">(not mapped)</option>{headers.map((h) => <option key={h} value={h}>{h}</option>)}</select></td>
                <td className="small">{f.help}</td></tr>))}</tbody></table></div>
          <div className="row" style={{ marginTop: 10 }}><button className="secondary" onClick={() => run('dry_run')}>Dry run</button><button onClick={() => run('commit')}>Commit import</button></div>
        </section>)}
      <Err e={err} />
      {report && (
        <section className="card" data-testid="import-report">
          <h2>{report.mode === 'dry_run' ? 'Dry run' : 'Import'} reconciliation report</h2>
          <p>Batch {report.batch_id.slice(0, 8)} · {report.filename} · source {report.source_system} · SHA-256 {report.file_sha256.slice(0, 12)}… · {report.rows_read} rows read · {report.committed ? <strong>committed</strong> : 'nothing written to stock'}</p>
          <p>{Object.entries(report.counts).map(([k, v]) => <span key={k} style={{ marginRight: 12 }}><Status s={k === 'accepted' ? 'ready' : k === 'already_imported' ? 'scheduled' : 'blocked'} /> {k.replace(/_/g, ' ')}: {String(v)}</span>)}</p>
          {report.missing_required_mappings.length > 0 && <div className="alert">Required fields not mapped: {report.missing_required_mappings.join(', ')}</div>}
          {report.reconciliation && <div className="note">Accepted units {report.reconciliation.accepted_units}; units posted to ledger {report.reconciliation.units_posted_to_ledger}; {report.reconciliation.ledger_matches === null ? 'dry run: ledger untouched' : report.reconciliation.ledger_matches ? 'ledger matches accepted rows' : 'LEDGER MISMATCH'}.
            {report.reconciliation.by_location.length > 0 && <div className="small">{report.reconciliation.by_location.map((l: any) => `${l.location}: ${l.before} → ${l.after}`).join(' · ')}</div>}</div>}
          <div className="table-wrap"><table><thead><tr><th>Row</th><th>Source ID</th><th>Status</th><th>Units</th><th>Errors / detail</th></tr></thead>
            <tbody>{report.rows.map((r: any) => <tr key={r.row_number}><td>{r.row_number}</td><td>{r.source_id}</td><td>{r.status.replace(/_/g, ' ')}</td><td>{r.units ?? ''}</td><td className="small">{r.errors.join('; ')}{r.detail ? ` ${r.detail}` : ''}</td></tr>)}</tbody></table></div>
        </section>)}
      <section className="card"><h2>Import history</h2>
        {(history.data ?? []).map((b) => <div key={b.id} className="small">{fmtTime(b.created_at)} · {b.kind} · {b.mode} · {b.filename} · {b.source_system} · {JSON.stringify(b.counts)} · by {b.by_name}</div>)}
      </section>
    </div>
  );
}
