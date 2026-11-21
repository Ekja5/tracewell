import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useData, useMe, Status, Err } from '../App';
import { api, fmtTime, post, uuid } from '../lib/api';
import { enqueue, isOnline, listQueue, loadPackage, savePackage, syncQueue, QueuedEvent, removePending, update as updateQueued } from '../lib/offline';
import { buildGs1, parseScan, ParsedScan } from '../../shared/gs1';

const DISPOSITIONS = [
  ['implanted', 'Implanted'], ['opened_unused', 'Opened, not used'], ['wasted', 'Wasted'], ['damaged', 'Damaged'], ['returned_sealed', 'Returned sealed'], ['missing', 'Missing'],
] as const;

/** Device time aligned to server time (handles device clock drift and the demo clock). */
function serverNow(): string {
  const skew = Number(localStorage.getItem('tw-skew') ?? 0);
  return new Date(Date.now() + skew).toISOString();
}

export function MobileHome() {
  const { me } = useMe();
  const { data, error } = useData<any[]>('/api/cases?mine=1');
  useEffect(() => { localStorage.setItem('tw-skew', String(new Date(me.now).getTime() - Date.now())); }, [me.now]);
  const now = new Date(me.now).getTime();
  const cases = (data ?? []).filter((c) => c.status === 'scheduled' && new Date(c.scheduled_start).getTime() > now - 18 * 3600e3 && new Date(c.scheduled_start).getTime() < now + 48 * 3600e3);
  return (
    <div>
      <h1>My cases: today and tomorrow</h1>
      <Err e={error && !isOnline() ? 'Offline: showing only cases you previously opened. Open a case below if it was downloaded.' : error} />
      {cases.map((c) => (
        <div key={c.id} className="card casecard">
          <div className="row" style={{ justifyContent: 'space-between' }}><strong style={{ fontSize: '1.15rem' }}>{c.case_ref}</strong>{c.urgent && <span className="badge st-blocked">URGENT</span>}</div>
          <div>{fmtTime(c.scheduled_start, c.timezone)}</div>
          <div className="small muted">{c.procedure} · {c.facility}</div>
          <div className="big-actions" style={{ marginTop: 10 }}>
            <Link className="btn" to={`/cases/${c.id}/closeout?scan=1`}>Scan</Link>
            <Link className="btn secondary" to={`/cases/${c.id}`}>Handoff</Link>
            <Link className="btn" to={`/cases/${c.id}/closeout`}>Close case</Link>
          </div>
        </div>))}
      {data && !cases.length && <p className="muted">No assigned cases in this window.</p>}
    </div>
  );
}

export function Closeout() {
  const { id } = useParams();
  const { me } = useMe();
  const [pkg, setPkg] = useState<any>(null);
  const [live, setLive] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueuedEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [disp, setDisp] = useState<string>('implanted');
  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState<{ p: ParsedScan; match: any; raw: string; method: string } | null>(null);
  const [qty, setQty] = useState<string>('');
  const [manual, setManual] = useState({ ref: '', lot: '', serial: '', expiry: '', qty: '1' });
  const [fast, setFast] = useState(() => localStorage.getItem('tw-fastscan') !== 'off');
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'dup' | 'warn'; text: string; id?: string } | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const userId = me.user.id;

  const refreshQueue = useCallback(async () => setQueue(await listQueue(userId, id)), [userId, id]);
  const loadAll = useCallback(async () => {
    setErr(null);
    if (isOnline()) {
      try {
        const p = await api(`/api/offline/cases/${id}/package`);
        await savePackage(userId, id!, p); setPkg(p); setLive(p.downloadedAt);
        localStorage.setItem('tw-skew', String(new Date(p.downloadedAt).getTime() - Date.now()));
      } catch (e: any) {
        const cached = await loadPackage(userId, id!); if (cached) { setPkg(cached); setLive(null); } else setErr(e.message);
      }
    } else {
      const cached = await loadPackage(userId, id!);
      if (cached) { setPkg(cached); setLive(null); } else setErr('This case was not downloaded to this device before going offline.');
    }
    refreshQueue();
  }, [id, userId, refreshQueue]);
  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    const f = () => { refreshQueue(); if (isOnline()) loadAll(); };
    window.addEventListener('tw-synced', f); window.addEventListener('tw-connectivity', f); window.addEventListener('online', f);
    return () => { window.removeEventListener('tw-synced', f); window.removeEventListener('tw-connectivity', f); window.removeEventListener('online', f); };
  }, [refreshQueue, loadAll]);
  useEffect(() => { if (new URLSearchParams(location.search).get('scan')) scanRef.current?.focus(); }, [pkg]);

  const lookup = (p: ParsedScan) => {
    if (!pkg || !p.gtin) return null;
    const unit = pkg.catalog.find((c: any) => c.unit_gtin === p.gtin);
    if (unit) return { ...unit, level: 'each', units_per_package: 1 };
    const pk = pkg.packages.find((x: any) => x.gtin === p.gtin);
    if (pk) { const c = pkg.catalog.find((c: any) => c.id === pk.catalog_item_id); return { ...c, level: pk.level, units_per_package: pk.units_per_package, package_gtin: pk.gtin }; }
    return null;
  };
  const live_entries = (q: QueuedEvent[]) => q.filter((e) => !['voided', 'rejected'].includes(e.state));
  /** Same serial already captured on this phone or recorded on the server for this case? */
  const priorSerial = (serial?: string) => {
    if (!serial) return null;
    const local = live_entries(queue).find((e) => e.meta?.serial === serial);
    if (local) return `at ${fmtTime(local.payload.occurredAt)} on this phone`;
    const srv = (pkg?.usage ?? []).find((u: any) => u.serial_number === serial && u.status === 'recorded');
    return srv ? `by the server at ${fmtTime(srv.occurred_at)}` : null;
  };
  const onScan = (value: string, method: string) => {
    setMsg(null); setErr(null);
    const p = parseScan(value, { referenceYear: new Date(serverNow()).getUTCFullYear() });
    const match = lookup(p);
    // Fast mode: a clean unit-level label is recorded immediately and the scanner stays ready for the next item.
    if (fast && p.ok && match && match.units_per_package === 1 && match.item_type !== 'tray') {
      const dup = match.tracking === 'serial' ? priorSerial(p.serial) : null;
      if (dup) { setFeedback({ kind: 'dup', text: `Already recorded: ${match.ref} SN ${p.serial} was captured ${dup}. A serialized unit is used once, so this rescan was NOT saved again.` }); setRaw(''); setParsed(null); scanRef.current?.focus(); try { navigator.vibrate?.([80, 60, 80]); } catch { /* not supported */ } return; }
      record({ entryMethod: method, rawScan: value }, { ref: match.ref, serial: p.serial, lot: p.lot, label: `${match.ref} ${p.serial ? 'SN ' + p.serial : 'lot ' + p.lot}` });
      return;
    }
    setParsed({ p, match, raw: value, method }); setQty('');
  };
  const record = async (payload: any, meta: any = {}) => {
    const clientEventId = uuid();
    const body = { clientEventId, caseId: id, disposition: disp, occurredAt: serverNow(), ...payload };
    await enqueue({ clientEventId, userId, caseId: id!, payload: body, meta });
    window.dispatchEvent(new Event('tw-queue'));
    setParsed(null); setRaw(''); setQty('');
    const nth = meta.lot && !meta.serial ? live_entries(await listQueue(userId, id)).filter((e) => e.meta?.lot === meta.lot && !e.meta?.serial).length : 0;
    const what = `${disp.replace('_', ' ')} ${meta.label ?? (payload.manual ? payload.manual.ref : 'item')}${nth > 1 ? ` (unit ${nth} of lot ${meta.lot} on this case)` : ''}`;
    setFeedback({ kind: 'ok', text: `Saved on phone: ${what}.`, id: clientEventId });
    try { navigator.vibrate?.(40); } catch { /* not supported */ }
    if (isOnline()) {
      try {
        const r = await syncQueue(userId); const res = r.results.find((x) => x.clientEventId === clientEventId);
        if (res) setFeedback({ kind: res.state === 'synced' ? 'ok' : res.state === 'rejected' ? 'dup' : 'warn', text: res.state === 'synced' ? `Confirmed by server: ${what}.` : `${res.state === 'rejected' ? 'Not posted' : 'Waiting for review'}: ${what}. ${res.reason ?? ''}`, id: clientEventId });
      } catch { setFeedback({ kind: 'ok', text: `Saved on phone: ${what}. Will send when the connection returns.`, id: clientEventId }); }
    } else setFeedback({ kind: 'ok', text: `Saved on phone (offline): ${what}. Original time kept; it will send automatically.`, id: clientEventId });
    refreshQueue(); scanRef.current?.focus();
  };
  const removeEntry = async (e: QueuedEvent) => {
    try { await removePending(e.clientEventId); setFeedback({ kind: 'warn', text: `Removed from phone: ${e.meta?.label ?? 'entry'} (it was never sent).` }); window.dispatchEvent(new Event('tw-queue')); refreshQueue(); }
    catch (x: any) { setErr(x.message); }
  };
  const correctEntry = async (e: QueuedEvent) => {
    const reason = prompt('Why is this line wrong? (e.g. scanned the wrong box)');
    if (!reason) return;
    try {
      await post(`/api/usage/${e.usageEventId}/void`, { reason });
      await updateQueued({ ...e, state: 'voided', reason: `Corrected: ${reason}` });
      setFeedback({ kind: 'warn', text: `Corrected: ${e.meta?.label ?? 'line'} voided on the server; stock movement reversed and any draft charge voided.` });
      refreshQueue(); loadAll();
    } catch (x: any) { setErr(x.message); }
  };
  const recordScan = () => {
    if (!parsed) return;
    const isPkg = parsed.match && parsed.match.units_per_package > 1;
    if (isPkg && !qty) { setErr(`Package label (${parsed.match.units_per_package} units per package). Enter the number of individual units.`); return; }
    if (parsed.match?.tracking === 'serial' && priorSerial(parsed.p.serial)) { setFeedback({ kind: 'dup', text: `Already recorded: SN ${parsed.p.serial} was captured ${priorSerial(parsed.p.serial)}. Not saved again.` }); setParsed(null); return; }
    record({ entryMethod: parsed.method, rawScan: parsed.raw, qtyUnits: qty ? Number(qty) : undefined }, parsed.match ? { ref: parsed.match.ref, serial: parsed.p.serial, lot: parsed.p.lot, label: `${parsed.match.ref} ${parsed.p.serial ? 'SN ' + parsed.p.serial : 'lot ' + parsed.p.lot}` } : { label: 'unrecognized label' });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Many keyboard-wedge scanners emit the GS1 group separator (FNC1) as Ctrl+].
    if (e.ctrlKey && e.key === ']') { e.preventDefault(); setRaw((r) => r + String.fromCharCode(29)); }
    if (e.key === 'Enter') { e.preventDefault(); if (raw.trim()) onScan(raw, 'scanner'); }
  };

  const reservations = pkg?.reservations ?? [];
  const sims = pkg ? [
    ...reservations.filter((r: any) => r.item_type !== 'tray' && r.unit_gtin).map((r: any) => ({ label: `${r.ref} ${r.serial_number ? 'SN ' + r.serial_number : 'lot ' + r.lot_number}`, value: buildGs1({ gtin: r.unit_gtin, expiry: r.expiry_date ?? undefined, lot: r.lot_number ?? undefined, serial: r.serial_number ?? undefined }, { symbologyId: true }) })),
    ...pkg.packages.map((p: any) => ({ label: `Package label: ${pkg.catalog.find((c: any) => c.id === p.catalog_item_id)?.ref} box of ${p.units_per_package} (lot S26B088)`, value: buildGs1({ gtin: p.gtin, lot: 'S26B088', expiry: '2028-10-31' }, { symbologyId: true }) })),
    { label: 'HIBCC-format label (unsupported)', value: '+H629NPINS4101/$$3271231L26C014Y' },
    { label: 'GS1 label with bad check digit', value: ']d20100614141100102' + '17281231' + '10LBAD' },
    { label: 'GS1 label, GTIN not in catalog', value: buildGs1({ gtin: '09506000134352', lot: 'ABC123', expiry: '2027-12-31' }, { symbologyId: true }) },
  ] : [];

  const canSubmit = isOnline() && pkg?.case?.status === 'scheduled';
  const pendingHere = queue.filter((q) => q.state === 'pending').length;
  return (
    <div style={{ maxWidth: 720 }}>
      <p><Link to="/today">← My cases</Link></p>
      <h1>Close case {pkg?.case?.case_ref ?? ''}</h1>
      {pkg && <p className="small">{pkg.case.facility_name} · {fmtTime(pkg.case.scheduled_start, pkg.case.timezone)}</p>}
      {pkg && (live ? <div className="ok small" role="status">Confirmed with server at {fmtTime(live)}. Reservation locations below are current as of that time.</div>
        : <div className="alert small" role="status">Offline snapshot downloaded {fmtTime(pkg.downloadedAt)}. Locations and balances are NOT confirmed current availability.</div>)}
      {msg && <div className="note" role="status" aria-live="polite">{msg}</div>}<Err e={err} />

      <section className="card">
        <h2>1. What happened to the item?</h2>
        <div className="disp-grid" role="group" aria-label="Disposition">
          {DISPOSITIONS.map(([k, label]) => <button key={k} className="secondary" aria-pressed={disp === k} onClick={() => setDisp(k)}>{label}</button>)}
        </div>
        <p className="small muted">Only "Implanted" means placed in a patient. Reusable instruments are returned with the tray, recorded separately below.</p>
      </section>

      <section className="card">
        <h2>2. Scan the labels</h2>
        <label className="row tight small"><input type="checkbox" checked={fast} onChange={(e) => { setFast(e.target.checked); localStorage.setItem('tw-fastscan', e.target.checked ? 'on' : 'off'); }} /> Fast scan: save each clean label immediately and stay ready for the next one</label>
        {feedback && <div className={`scan-feedback fb-${feedback.kind}`} role="status" aria-live="assertive" data-testid="scan-feedback">{feedback.kind === 'ok' ? '✓ ' : feedback.kind === 'dup' ? '⚠ ' : '• '}{feedback.text}</div>}
        <label className="field" htmlFor="scan">Scanner input (keyboard wedge; press Enter)</label>
        <input id="scan" ref={scanRef} className="scanbox" autoComplete="off" autoCapitalize="off" spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} onKeyDown={onKeyDown} placeholder="Focus here and scan a GS1 DataMatrix" />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="secondary" onClick={() => raw.trim() && onScan(raw, 'scanner')}>Parse</button>
          <CameraScan onResult={(v) => onScan(v, 'camera')} />
          <select aria-label="Scan simulator" onChange={(e) => { if (e.target.value) { onScan(e.target.value, 'simulator'); e.target.value = ''; } }} defaultValue="">
            <option value="">Scan simulator (seeded labels)…</option>
            {sims.map((s, i) => <option key={i} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        {parsed && (
          <div className="card" style={{ marginTop: 10 }} data-testid="parsed">
            <div><strong>Format:</strong> {parsed.p.format} {parsed.p.ok ? <span className="badge st-ready">parsed</span> : <span className="badge st-blocked">needs reviewed manual entry</span>}</div>
            <div className="small">Raw (preserved): <code>{parsed.raw.replace(/\x1d/g, '<GS>')}</code></div>
            {parsed.p.ok && <div className="small">DI/GTIN {parsed.p.gtin} · Lot {parsed.p.lot ?? '—'} · Serial {parsed.p.serial ?? '—'} · Expiry {parsed.p.expiry ?? '—'}</div>}
            {parsed.p.errors.map((e, i) => <div key={i} className="small sev-critical">{e}</div>)}
            {parsed.match ? <div className="small">Catalog: <strong>{parsed.match.ref}</strong> {parsed.match.description} · label level: <strong>{parsed.match.level}</strong>{parsed.match.units_per_package > 1 && ` (${parsed.match.units_per_package} units per package)`}</div>
              : parsed.p.ok && <div className="small sev-warning">GTIN not in this case's catalog; the server will route it to review.</div>}
            {parsed.match?.units_per_package > 1 && <label className="field">Individual units {disp.replace('_', ' ')} from this package (required)<input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></label>}
            {parsed.match && parsed.match.units_per_package === 1 && parsed.match.tracking === 'lot' && <label className="field">Units (default 1 per scan)<input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="1" /></label>}
            <div className="row" style={{ marginTop: 8 }}><button onClick={recordScan}>Record {disp.replace('_', ' ')}</button><button className="secondary" onClick={() => setParsed(null)}>Discard</button></div>
          </div>)}
      </section>

      <section className="card">
        <h2>Manual entry (fallback)</h2>
        <p className="small muted">Use when a label is damaged or unsupported (e.g. HIBCC). Lot and serial must match a validated inventory record or the line goes to review; nothing is guessed.</p>
        <div className="row">
          <label className="field">Catalog ref<select value={manual.ref} onChange={(e) => setManual({ ...manual, ref: e.target.value })}><option value="">Select…</option>{(pkg?.catalog ?? []).filter((c: any) => c.item_type !== 'tray').map((c: any) => <option key={c.id} value={c.ref}>{c.ref}: {c.description}</option>)}</select></label>
          <label className="field">Lot<input value={manual.lot} onChange={(e) => setManual({ ...manual, lot: e.target.value })} /></label>
          <label className="field">Serial<input value={manual.serial} onChange={(e) => setManual({ ...manual, serial: e.target.value })} /></label>
          <label className="field">Expiry<input type="date" value={manual.expiry} onChange={(e) => setManual({ ...manual, expiry: e.target.value })} /></label>
          <label className="field">Units<input type="number" min={1} value={manual.qty} onChange={(e) => setManual({ ...manual, qty: e.target.value })} /></label>
        </div>
        <p><button className="secondary" disabled={!manual.ref} onClick={() => { record({ entryMethod: 'manual', manual: { ref: manual.ref, lot: manual.lot || undefined, serial: manual.serial || undefined, expiry: manual.expiry || undefined }, qtyUnits: Number(manual.qty) }); setManual({ ref: '', lot: '', serial: '', expiry: '', qty: '1' }); }}>Record manual entry</button></p>
      </section>

      <section className="card">
        <h2>Captured for this case ({queue.filter((q) => !['voided'].includes(q.state)).length}{pendingHere ? `, ${pendingHere} only on this phone` : ''})</h2>
        <p className="small muted"><strong>Saved on phone</strong> = not yet sent. <strong>Confirmed by server</strong> = stock and billing posted once. <strong>Waiting for review</strong> = held for a coordinator; nothing guessed.</p>
        {queue.map((q) => {
          const label: Record<string, string> = { pending: 'Saved on phone', synced: 'Confirmed by server', needs_review: 'Waiting for review', rejected: 'Not posted', voided: 'Corrected (voided)' };
          const cls: Record<string, string> = { pending: 'pending', synced: 'synced', needs_review: 'needs_review', rejected: 'rejected', voided: 'cancelled' };
          return (
            <div key={q.clientEventId} className="small entry" data-state={q.state}>
              <span className={`badge st-${cls[q.state]}`}>{label[q.state] ?? q.state}</span> <strong>{q.payload.disposition.replace('_', ' ')}</strong> {q.meta?.label ?? (q.payload.manual ? `manual ${q.payload.manual.ref}` : 'label')} · {fmtTime(q.payload.occurredAt)}
              {q.reason && <div className={q.state === 'voided' ? 'muted' : 'sev-warning'}>{q.reason}</div>}
              <div className="row tight">
                {q.state === 'pending' && <button className="small-btn secondary" onClick={() => removeEntry(q)}>Remove (never sent)</button>}
                {(q.state === 'synced' || q.state === 'needs_review') && q.usageEventId && isOnline() && <button className="small-btn secondary" onClick={() => correctEntry(q)}>Correct this line</button>}
              </div>
            </div>);
        })}
        {!queue.length && <p className="muted small">Nothing captured yet.</p>}
        {pendingHere > 0 && isOnline() && <button className="secondary" onClick={async () => { await syncQueue(userId); refreshQueue(); loadAll(); }}>Send now</button>}
      </section>

      <section className="card">
        <h2>Reserved for this case {live ? '(confirmed)' : '(snapshot)'}</h2>
        {reservations.map((r: any) => <div key={r.id} className="small">{r.ref} {r.serial_number ? `SN ${r.serial_number}` : `lot ${r.lot_number}`} · {r.location_name} · reservation {r.status}</div>)}
        <h3>Server-recorded usage</h3>
        {(pkg?.usage ?? []).map((u: any) => <div key={u.id} className="small"><Status s={u.status} /> {u.disposition.replace('_', ' ')} {u.ref ?? ''} {u.serial_number ?? u.lot_number ?? ''} {u.recorded_offline ? '(captured offline)' : ''}</div>)}
      </section>

      {pkg && <InstrumentReturns caseId={id!} reservations={reservations} />}
      <section className="card">
        <h2>Submit closeout</h2>
        <p className="small muted">Every reserved implant needs a disposition (use "Returned sealed" for unused units). Requires a connection.</p>
        <button disabled={!canSubmit || pendingHere > 0} onClick={async () => { setErr(null); try { const r = await post(`/api/cases/${id}/closeout/submit`, {}); setMsg(`Closeout submitted${r.pendingReview ? `; ${r.pendingReview} line(s) under review` : ''}. Finance has been notified.`); loadAll(); } catch (e: any) { setErr(e.message); } }}>Submit closeout</button>
        {pendingHere > 0 && <p className="small sev-warning">Sync pending events first.</p>}
      </section>
    </div>
  );
}

function InstrumentReturns({ caseId, reservations }: { caseId: string; reservations: any[] }) {
  const trays = reservations.filter((r) => r.item_type === 'tray');
  const [msg, setMsg] = useState<string | null>(null);
  if (!trays.length) return null;
  return (
    <section className="card">
      <h2>Reusable instruments (tracked separately from implant use)</h2>
      {trays.map((t) => (
        <div key={t.id} className="row">
          <span>{t.ref} {t.serial_number}</span>
          <button className="secondary" onClick={async () => { try { await post(`/api/cases/${caseId}/instrument-return`, { trayStockItemId: t.stock_item_id, status: 'returned', clientEventId: `ret-${t.id}` }); setMsg('Tray return recorded.'); } catch (e: any) { setMsg(e.message); } }}>Tray returned complete</button>
          <button className="secondary" onClick={async () => { try { await post(`/api/cases/${caseId}/instrument-return`, { trayStockItemId: t.stock_item_id, status: 'missing_items', note: 'Rep reported missing instruments', clientEventId: `ret-miss-${t.id}` }); setMsg('Missing instruments reported to ops.'); } catch (e: any) { setMsg(e.message); } }}>Instruments missing</button>
        </div>))}
      {msg && <p className="small">{msg}</p>}
    </section>
  );
}

function CameraScan({ onResult }: { onResult: (v: string) => void }) {
  const [on, setOn] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const last = useRef<{ v: string; t: number }>({ v: '', t: 0 });
  const stop = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setOn(false); };
  useEffect(() => stop, []);
  const start = async () => {
    const BD = (window as any).BarcodeDetector;
    if (!BD) { setNote('Camera barcode detection is not available in this browser (for example iOS Safari). Use a scanner, the simulator, or manual entry.'); return; }
    const fmts: string[] = await BD.getSupportedFormats();
    if (!fmts.includes('data_matrix')) { setNote('This device cannot decode DataMatrix with the camera. Use a scanner or manual entry.'); return; }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      setOn(true);
      setTimeout(async () => {
        if (!video.current || !stream.current) return;
        video.current.srcObject = stream.current; await video.current.play();
        const det = new BD({ formats: ['data_matrix'] });
        const loop = async () => {
          if (!stream.current || !video.current) return;
          const codes = await det.detect(video.current).catch(() => []);
          // Continuous: keep the camera open for the next label; ignore the same code for 2.5 s.
          if (codes.length) { const v = codes[0].rawValue; if (v !== last.current.v || Date.now() - last.current.t > 2500) { last.current = { v, t: Date.now() }; onResult(v); } }
          setTimeout(loop, 250);
        };
        loop();
      }, 50);
    } catch { setNote('Camera permission denied or unavailable.'); }
  };
  return (
    <>
      <button className="secondary" onClick={on ? stop : start}>{on ? 'Stop camera' : 'Camera'}</button>
      {on && <video ref={video} playsInline muted style={{ width: '100%', maxHeight: 260, background: '#000' }} aria-label="Camera preview" />}
      {note && <span className="small sev-warning">{note}</span>}
    </>
  );
}
