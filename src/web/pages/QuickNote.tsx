/**
 * Field rep quick note (mobile handoff). The rep types or dictates what happened; the server turns it
 * into a structured draft (tray, facility, time, counts, discrepancy) that the rep reviews and approves.
 * Offline: the note is saved on the phone under the signed-in user and case, shown as pending, and
 * sent when the connection returns. Each note has one client id, so retries never create a second handoff.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useData, useMe, Err } from '../App';
import { api, fmtTime, post, uuid } from '../lib/api';
import { isOnline, listNotes, LocalNote, saveNote, syncNotes } from '../lib/offline';

const ANSWER_KEY: Record<string, string> = { tray: 'trayStockItemId', facility: 'facilityId', time: 'droppedAt' };
const EXAMPLE = 'Dropped Tray 14 at St. Brigid receiving at 7:40. Jamie counted 23 pieces. The count sheet says 24. Jamie couldn\'t identify which one was missing.';

function serverNow(): string {
  const skew = Number(localStorage.getItem('tw-skew') ?? 0);
  return new Date(Date.now() + skew).toISOString();
}

export function QuickNote() {
  const { id } = useParams();
  const { me } = useMe();
  const userId = me.user.id;
  const cs = useData<any>(isOnline() ? `/api/cases/${id}` : null);
  const [text, setText] = useState('');
  const [local, setLocal] = useState<LocalNote[]>([]);
  const [server, setServer] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  const refresh = useCallback(async () => {
    try { setLocal(await listNotes(userId, id)); } catch { /* idb unavailable */ }
    if (isOnline()) { try { setServer(await api(`/api/cases/${id}/handoff-notes`)); } catch (e: any) { setErr(e.message); } }
  }, [userId, id]);
  useEffect(() => {
    refresh();
    const f = async () => { if (isOnline()) { await syncNotes(userId).catch(() => {}); } refresh(); };
    window.addEventListener('tw-connectivity', f); window.addEventListener('online', f); window.addEventListener('tw-notes-synced', refresh);
    return () => { window.removeEventListener('tw-connectivity', f); window.removeEventListener('online', f); window.removeEventListener('tw-notes-synced', refresh); };
  }, [refresh, userId]);

  const submit = async () => {
    setErr(null); setMsg(null);
    const t = text.trim(); if (!t) return;
    // Saved locally first, always; the sync step sends it (now if online, later if not).
    await saveNote({ clientNoteId: uuid(), userId, caseId: id!, text: t, capturedAt: serverNow() });
    setText('');
    if (isOnline()) { await syncNotes(userId).catch(() => {}); setMsg('Note sent. Review the draft below.'); }
    else setMsg('Offline: note saved on this phone (pending). It will be sent when you reconnect.');
    refresh();
  };

  const dictate = () => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) { setErr("This browser has no dictation API; use your keyboard's microphone key."); return; }
    const r = new SR(); r.lang = 'en-US'; r.interimResults = false;
    r.onresult = (e: any) => setText((t) => `${t}${t ? ' ' : ''}${e.results[0][0].transcript}`);
    r.onend = () => setListening(false); r.onerror = () => setListening(false);
    setListening(true); r.start();
  };

  const pending = local.filter((n) => n.state === 'pending');
  const failed = local.filter((n) => n.state === 'failed');
  const c = cs.data?.case;
  return (
    <div className="quicknote">
      <p className="small"><Link to={`/cases/${id}`}>← Case</Link></p>
      <h1>Handoff note{c ? `: ${c.case_ref}` : ''}</h1>
      {c && <p className="small muted">{c.facility_name} · {fmtTime(c.scheduled_start, c.timezone)}</p>}
      <Err e={err} />{msg && <div className="ok" role="status">{msg}</div>}
      <section className="card">
        <label htmlFor="qn-text"><strong>What happened?</strong> <span className="small muted">Type or dictate. Tray, place, time and counts are enough.</span></label>
        <textarea id="qn-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} maxLength={2000} />
        <div className="big-actions" style={{ marginTop: 8 }}>
          <button onClick={submit} disabled={!text.trim()}>Save note</button>
          <button className="secondary" onClick={dictate} disabled={listening}>{listening ? 'Listening…' : 'Dictate'}</button>
        </div>
        <p className="tiny muted">Your words are kept with the record exactly as written. A count by hospital staff that you report is recorded as your report, not as their sign-off.</p>
      </section>

      {pending.length > 0 && <section className="card pending-notes" data-testid="pending-notes">
        <h2>Saved on this phone ({pending.length} pending)</h2>
        {pending.map((n) => <p key={n.clientNoteId} className="small"><span className="badge st-at_risk">PENDING</span> {fmtTime(n.capturedAt)}: “{n.text}”</p>)}
        <p className="tiny muted">Sends automatically when the connection returns.</p>
      </section>}
      {failed.map((n) => <div key={n.clientNoteId} className="alert">Not accepted: {n.error} (“{n.text.slice(0, 80)}…”)</div>)}

      {server.map((n) => <NoteDraft key={n.id} n={n} onChange={refresh} />)}
    </div>
  );
}

function NoteDraft({ n, onChange }: { n: any; onChange: () => void }) {
  const s = n.structured ?? {};
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [counts, setCounts] = useState({ expectedCount: s.expectedCount ?? '', observedCount: s.observedCount ?? '' });
  useEffect(() => { setCounts({ expectedCount: s.expectedCount ?? '', observedCount: s.observedCount ?? '' }); }, [n.structured]);
  const run = async (fn: () => Promise<any>) => { if (busy) return; setBusy(true); setErr(null); try { await fn(); onChange(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const draft = n.status === 'draft';
  const countsChanged = String(counts.expectedCount) !== String(s.expectedCount ?? '') || String(counts.observedCount) !== String(s.observedCount ?? '');
  return (
    <section className="card note-draft" data-note-status={n.status}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{draft ? 'Draft from your note' : 'Approved handoff'}</h2>
        <span className={`badge ${draft ? 'st-at_risk' : 'st-ready'}`}>{n.status.toUpperCase()}</span>
      </div>
      <dl className="draft-fields">
        <dt>Tray</dt><dd>{s.tray ? `${s.tray.label} · ${s.tray.description}` : <em>not identified</em>}</dd>
        <dt>Where</dt><dd>{s.facility?.name ?? <em>not identified</em>}</dd>
        <dt>When</dt><dd>{s.droppedAtLocal ?? <em>time not stated</em>}</dd>
        <dt>Expected</dt><dd data-field="expected">{draft ? <input inputMode="numeric" aria-label="Expected count" value={counts.expectedCount} onChange={(e) => setCounts({ ...counts, expectedCount: e.target.value })} /> : s.expectedCount}</dd>
        <dt>Observed</dt><dd data-field="observed">{draft ? <input inputMode="numeric" aria-label="Observed count" value={counts.observedCount} onChange={(e) => setCounts({ ...counts, observedCount: e.target.value })} /> : s.observedCount}</dd>
        <dt>Discrepancy</dt><dd data-field="discrepancy"><strong>{s.discrepancy ?? '—'}</strong></dd>
        <dt>Component</dt><dd data-field="component">{typeof s.component === 'object' && s.component ? s.component.description : s.component}</dd>
        <dt>Release</dt><dd data-field="release">Unchanged (decided by hospital sterile processing)</dd>
        {s.hospitalContact && <><dt>Hospital staff</dt><dd>{s.hospitalContact.name}: <span className="small">{s.hospitalContact.basis}</span></dd></>}
      </dl>
      {s.caveats?.length > 0 && <ul className="ask-caveats small">{s.caveats.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>}
      {draft && n.questions?.map((q: any) => (
        <div key={q.field} className="ask-gap" role="group" aria-label={q.question}>
          <p><strong>{q.question}</strong></p>
          <div className="ask-choices">{q.options.map((o: any) => <button key={o.value} className="secondary" disabled={busy} onClick={() => run(() => post(`/api/handoff-notes/${n.id}/revise`, { [ANSWER_KEY[q.field] ?? q.field]: o.value }))}>{o.label}</button>)}</div>
        </div>))}
      <details open={!draft ? false : undefined}><summary className="small">Original note ({fmtTime(n.captured_at)})</summary><blockquote className="small">{n.original_text}</blockquote></details>
      {err && <div className="alert" role="alert">{err}</div>}
      {draft && <div className="big-actions">
        {countsChanged && <button className="secondary" disabled={busy} onClick={() => run(() => post(`/api/handoff-notes/${n.id}/revise`, { expectedCount: counts.expectedCount === '' ? null : counts.expectedCount, observedCount: counts.observedCount === '' ? null : counts.observedCount }))}>Update counts</button>}
        <button disabled={busy || n.questions?.length > 0 || countsChanged} onClick={() => run(() => post(`/api/handoff-notes/${n.id}/approve`))} data-testid="approve-note">Approve handoff</button>
      </div>}
      {!draft && n.discrepancy_id && <p className="small">Missing-instrument discrepancy opened; the tray stays blocked until it is re-verified. <Link to="/exceptions">Open exceptions</Link></p>}
    </section>
  );
}
