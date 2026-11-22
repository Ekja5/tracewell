/**
 * Load files: the coordinator uploads the spreadsheet they already have, picks the worksheet, checks
 * the column mapping, previews how every row will be read, then loads it. The mapping is saved for
 * tomorrow's file. Results show each source row as accepted, held for review, or skipped.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useData, useMe, Err } from '../App';
import { fmtTime, post } from '../lib/api';

const KINDS: [string, string][] = [['inventory', 'Inventory balances'], ['schedule', 'Case schedule'], ['requirements', 'Case requirements']];
const OUTCOME_LABEL: Record<string, string> = { accepted: 'Accepted', held: 'Held for review', skipped: 'Skipped' };
const toLocalInput = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
export const readBase64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(f); });

export function UploadsPage() {
  const { me, can } = useMe();
  const nav = useNavigate();
  const list = useData<any>('/api/uploads');
  const [from, setFrom] = useState(new URLSearchParams(window.location.search).get('from') ?? '');
  const [file, setFile] = useState<any>(null);
  const [sheet, setSheet] = useState(''); const [kind, setKind] = useState('');
  const [sug, setSug] = useState<any>(null); const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [exportedAt, setExportedAt] = useState(''); const [exportEdited, setExportEdited] = useState(false); const [coverage, setCoverage] = useState('partial');
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  const choose = async (f: File | undefined) => {
    if (!f) return; setErr(null); setPreview(null); setSug(null); setFile(null);
    if (f.size > 3.5 * 1024 * 1024) { setErr('This file is larger than 3.5 MB. Export only the worksheets needed, or split it.'); return; }
    try {
      const r = await post('/api/uploads/file', { filename: f.name, contentBase64: await readBase64(f) });
      setFile(r); setExportedAt(toLocalInput(r.modifiedAt ?? me.now)); setExportEdited(false);
      const first = r.sheets.find((s: any) => s.guessKind) ?? r.sheets[0];
      setSheet(first.name); setKind(first.guessKind ?? '');
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => {
    if (!file || !sheet || !kind) { setSug(null); return; }
    setPreview(null);
    post('/api/uploads/suggest', { fileId: file.fileId, worksheet: sheet, kind }).then((s) => { setSug(s); setMapping(s.mapping); if (s.saved?.options?.coverage) setCoverage(s.saved.options.coverage); }).catch((e) => setErr(e.message));
  }, [file?.fileId, sheet, kind]);
  const body = () => ({ fileId: file.fileId, worksheet: sheet, kind, headerRow: sug.headerRow, mapping, // Untouched: the workbook's own saved time if it has one, otherwise "now" (decided by the server). Typed: the end of that minute.
    exportedAt: exportEdited ? new Date(new Date(exportedAt).getTime() + 59_000).toISOString() : (file.modifiedAt ?? null), coverage, sourceSystem: from || null });
  const run = async (mode: 'preview' | 'commit') => {
    setErr(null); setBusy(true);
    try {
      const r = await post(`/api/uploads/${mode}`, body());
      if (mode === 'commit' || r.replayed) nav(`/uploads/runs/${r.run.id}${r.replayed ? '?replayed=1' : ''}`); else setPreview(r);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const missing = sug ? sug.fields.filter((f: any) => f.required && !mapping[f.name]).map((f: any) => f.label) : [];
  const sampleFor = (h: string | null) => { if (!h || !sug) return ''; const i = sug.headers.indexOf(h); return sug.sample.map((r: string[]) => r[i]).filter(Boolean).slice(0, 3).join(' · '); };

  return (
    <div>
      <h1>Load files</h1>
      <p className="muted small">Upload the spreadsheets you already use: inventory balances, the case schedule, and what each case requires. Excel (.xlsx) or CSV. Nothing is saved until you press Load.</p>
      <Err e={err} />
      {can('upload.run') && <section className="card">
        <h2 style={{ marginTop: 0 }}>1. Choose a file</h2>
        <label className="field">Exported from<select aria-label="Exported from" value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); }}><option value="">Not stated</option><option value="redspot">RedSpot</option><option value="salesforce">Salesforce</option><option value="spreadsheet">A spreadsheet we keep</option><option value="other">Another system</option></select></label>
        <input type="file" accept=".xlsx,.xlsm,.csv" aria-label="Spreadsheet file" onChange={(e) => choose(e.target.files?.[0])} />
        {file && <p className="small">{file.filename}{file.duplicate && <> · <strong className="sev-warning">Same contents as a file first uploaded {fmtTime(file.firstUploadedAt)}.</strong> Loading a worksheet that was already loaded returns the original result and changes nothing.</>}</p>}
        {file && <>
          <h2>2. Worksheet and contents</h2>
          <div className="row">
            <label className="field">Worksheet<select aria-label="Worksheet" value={sheet} onChange={(e) => { setSheet(e.target.value); const s = file.sheets.find((x: any) => x.name === e.target.value); if (s?.guessKind) setKind(s.guessKind); }}>{file.sheets.map((s: any) => <option key={s.name} value={s.name}>{s.name} ({s.rowCount} rows)</option>)}</select></label>
            <label className="field">This worksheet contains<select aria-label="Contents of this worksheet" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Choose…</option>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          </div>
        </>}
        {sug && <>
          <h2>3. Columns</h2>
          {sug.saved ? <p className="ok small" data-testid="saved-mapping">Using the column mapping {sug.saved.by} saved {fmtTime(sug.saved.savedAt)} for files with these headings. Change it below if the file changed.</p>
            : <p className="small muted">Suggested from the column headings in row {sug.headerRow}. Check each one; your choices are saved for the next file with the same headings.</p>}
          <div className="table-wrap"><table aria-label="Column mapping"><thead><tr><th>We need</th><th>Column in your file</th><th>Example values</th></tr></thead><tbody>
            {sug.fields.map((f: any) => (
              <tr key={f.name}><td><strong>{f.label}</strong>{f.required && <span className="sev-critical"> *</span>}<div className="tiny muted">{f.help}</div></td>
                <td><select aria-label={`Column for ${f.label}`} value={mapping[f.name] ?? ''} onChange={(e) => { setMapping({ ...mapping, [f.name]: e.target.value || null }); setPreview(null); }}><option value="">— not in this file —</option>{sug.headers.filter(Boolean).map((h: string) => <option key={h} value={h}>{h}</option>)}</select></td>
                <td className="small muted">{sampleFor(mapping[f.name] ?? null)}</td></tr>))}
          </tbody></table></div>
          <h2>4. About this export</h2>
          <div className="row">
            <label className="field">Exported from your system at<input type="datetime-local" value={exportedAt} onChange={(e) => { setExportedAt(e.target.value); setExportEdited(true); setPreview(null); }} /><span className="tiny muted">{!exportEdited && !file.modifiedAt ? 'Assumed: just now. Change it if the file is older. ' : ''}When the file was produced, not when you are uploading it. An older file never overrides newer counts.</span></label>
            {kind === 'inventory' && <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>Does it list everything at the locations it covers?</legend>
              <label className="small"><input type="radio" name="cov" checked={coverage === 'partial'} onChange={() => { setCoverage('partial'); setPreview(null); }} /> No, it is a partial list. Items not listed are left alone.</label><br />
              <label className="small"><input type="radio" name="cov" checked={coverage === 'complete'} onChange={() => { setCoverage('complete'); setPreview(null); }} /> Yes. Stock we hold there that is not listed will be raised as a question (never set to zero).</label></fieldset>}
          </div>
          {missing.length > 0 && <p className="sev-critical small">Choose a column for: {missing.join(', ')}.</p>}
          <div className="row tight" style={{ marginTop: 10 }}>
            <button className="secondary" disabled={busy || missing.length > 0 || !exportedAt} onClick={() => run('preview')}>Preview</button>
            <button disabled={busy || missing.length > 0 || !exportedAt || !preview} onClick={() => run('commit')} title={preview ? '' : 'Preview first'}>Load this worksheet</button>
            {!preview && <span className="small muted">Preview first: it shows exactly how each row will be read.</span>}
          </div>
        </>}
      </section>}
      {preview && <section className="card" data-testid="preview"><h2 style={{ marginTop: 0 }}>Preview: nothing has been saved</h2><RunResult d={preview} preview /></section>}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Example files (synthetic)</h2>
        <ul className="small">{list.data?.samples.map((s: any) => <li key={s.name}><a href={`/api/uploads/samples/${s.name}`} download>{s.label}</a>: {s.description}</li>)}</ul>
        <SampleQty />
      </section>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Loaded so far</h2>
        {list.data?.runs.length ? <div className="table-wrap"><table aria-label="Uploads"><thead><tr><th>File › worksheet</th><th>Contents</th><th>Exported</th><th>Uploaded</th><th>Covers</th><th>Rows</th></tr></thead><tbody>
          {list.data.runs.map((r: any) => <tr key={r.id}><td><Link to={`/uploads/runs/${r.id}`}>{r.filename} › {r.worksheet}</Link></td><td>{list.data.kinds[r.kind]}</td><td className="small">{fmtTime(r.exported_at)}</td><td className="small">{fmtTime(r.created_at)}<div className="tiny muted">{r.by_name}</div></td>
            <td className="small">{r.kind === 'inventory' ? <>{(r.covered_locations ?? []).join(', ') || '—'}<div className="tiny muted">{r.coverage === 'complete' ? 'complete list' : 'partial list'}</div></> : '—'}</td>
            <td className="small">{['accepted', 'held', 'skipped'].map((k) => `${r.counts?.[k] ?? 0} ${OUTCOME_LABEL[k].toLowerCase()}`).join(' · ')}</td></tr>)}
        </tbody></table></div> : <p className="muted">Nothing loaded yet. Start with the inventory balances, then the schedule, then the requirements.</p>}
      </section>
    </div>
  );
}

function SampleQty() {
  const [q, setQ] = useState('6');
  return <p className="small">Second-day snapshot with your own number: tibial insert quantity <input aria-label="Sample quantity" style={{ width: 70 }} inputMode="numeric" value={q} onChange={(e) => setQ(e.target.value.replace(/\D/g, ''))} /> <a href={`/api/uploads/samples/summit-day2-inventory.xlsx?qty=${q || 6}`} download>Download</a></p>;
}

export function RunResult({ d, preview, onChanged }: { d: any; preview?: boolean; onChanged?: () => void }) {
  const [sp] = useSearchParams();
  const hi = Number(sp.get('row') ?? 0);
  const [filter, setFilter] = useState<string>('all');
  const [err, setErr] = useState<string | null>(null);
  const { can } = useMe();
  const mapped = useMemo(() => (d.fields ?? []).map((f: any) => d.run.mapping?.[f.name]).filter(Boolean) as string[], [d.run.mapping, d.fields]);
  useEffect(() => { if (hi) document.getElementById(`row-${hi}`)?.scrollIntoView({ block: 'center' }); }, [hi, d.rows.length]);
  const fix = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); await post(`/api/uploads/runs/${d.run.id}/recheck`); onChanged?.(); } catch (e: any) { setErr(e.message); } };
  const shown = d.rows.filter((r: any) => filter === 'all' || r.outcome === filter);
  return (<>
    <div className="row tight" role="group" aria-label="Row outcomes">
      <button className={filter === 'all' ? '' : 'secondary'} onClick={() => setFilter('all')}>All {d.rows.length}</button>
      {['accepted', 'held', 'skipped'].map((k) => <button key={k} className={filter === k ? '' : 'secondary'} onClick={() => setFilter(k)} data-count={k}>{OUTCOME_LABEL[k]} {d.run.counts?.[k] ?? 0}</button>)}
    </div>
    {d.run.summary?.notes?.map((n: string, i: number) => <p key={i} className="small muted">{n}</p>)}
    {d.run.summary?.created?.length > 0 && <p className="small muted">New in this file: {d.run.summary.created.join(', ')}.</p>}
    <Err e={err} />
    <div className="table-wrap"><table aria-label="Rows"><thead><tr><th>Row</th><th>Result</th><th>What happened / what to do</th><th>Values read</th></tr></thead><tbody>
      {shown.map((r: any) => (
        <tr key={r.row_number} id={`row-${r.row_number}`} className={`${r.row_number === hi ? 'row-hi' : ''} out-${r.outcome}`} data-row={r.row_number} data-outcome={r.outcome}>
          <td className="nowrap"><strong>{r.row_number}</strong><div className="tiny muted">{d.run.worksheet}</div></td>
          <td><span className={`badge st-${r.outcome === 'accepted' ? 'ready' : r.outcome === 'held' ? 'at_risk' : 'closed'}`}>{OUTCOME_LABEL[r.outcome]}</span></td>
          <td>{r.message}{!preview && r.entity?.caseId && <> <Link to={`/cases/${r.entity.caseId}`}>Open case</Link></>}
            {!preview && r.outcome === 'held' && can('upload.run') && <div className="row tight" style={{ marginTop: 6 }}>
              {r.entity?.choices?.map((c: any) => <button key={c.id} className="secondary" onClick={() => fix(() => post('/api/uploads/aliases', { kind: r.entity.aliasKind, aliasText: r.entity.aliasText, targetId: c.id }))}>{c.label}</button>)}
              {r.entity?.conversionId && r.reason_code === 'unverified_package' && <VerifyConversion e={r.entity} onDone={(n) => fix(() => post(`/api/uploads/conversions/${r.entity.conversionId}/verify`, { unitsPer: n }))} />}
              {r.reason_code === 'needs_reconciliation' && <Link className="btn secondary" to={`/reconcile?ref=${r.entity?.discrepancyRef}`}>Reconcile {r.entity?.discrepancyRef}</Link>}
            </div>}
            {preview && r.reason_code === 'needs_reconciliation' && <div className="tiny muted">After loading, this difference waits on the Reconcile screen. Stock does not change until someone decides.</div>}
          </td>
          <td className="small muted">{mapped.map((h) => r.raw[h]).filter((v) => v !== '' && v != null).join(' · ')}</td>
        </tr>))}
    </tbody></table></div>
  </>);
}

function VerifyConversion({ e, onDone }: { e: any; onDone: (n: number) => void }) {
  const [n, setN] = useState(String(e.proposedUnits ?? ''));
  return <span className="row tight"><label className="small">Units in one {e.uom} of {e.itemRef} <input aria-label={`Units per ${e.uom}`} style={{ width: 70 }} inputMode="numeric" value={n} onChange={(ev) => setN(ev.target.value.replace(/\D/g, ''))} /></label><button className="secondary" disabled={!n} onClick={() => onDone(Number(n))}>Verify and re-check</button></span>;
}

export function UploadRun() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const { data, error, reload } = useData<any>(`/api/uploads/runs/${id}`);
  const { can } = useMe();
  if (error) return <Err e={error} />;
  if (!data) return <p>Loading…</p>;
  const r = data.run;
  const heldFixable = data.rows.some((x: any) => x.outcome === 'held' && x.reason_code !== 'needs_reconciliation');
  return (
    <div>
      <p className="small"><Link to="/uploads">← Load files</Link></p>
      <h1>{r.filename} › {r.worksheet}</h1>
      {sp.get('replayed') && <div className="alert" role="status">This exact file and worksheet were already loaded. Nothing was imported again; this is the original result.</div>}
      <p className="small">{KINDS.find(([k]) => k === r.kind)?.[1]}{r.source_system ? ` · from ${r.source_system}` : ''} · exported <strong>{fmtTime(r.exported_at)}</strong> · uploaded {fmtTime(r.created_at)} by {r.by_name}
        {r.kind === 'inventory' && <> · covers {(r.covered_locations ?? []).join(', ') || 'no location'} ({r.coverage === 'complete' ? 'complete list' : 'partial list'})</>}</p>
      <section className="card"><RunResult d={data} onChanged={reload} />
        {heldFixable && can('upload.run') && <p className="small" style={{ marginTop: 10 }}>Fixed something elsewhere (loaded the schedule, verified a conversion)? <button className="secondary" onClick={async () => { await post(`/api/uploads/runs/${id}/recheck`); reload(); }}>Re-check held rows</button> Rows already accepted are never applied twice.</p>}
      </section>
    </div>
  );
}
