/**
 * Hosted review: a short guided walkthrough for an outside reviewer, a feedback box on every step and in
 * the header, and a list of what has been sent. Shown only when the server runs with REVIEW_MODE=true.
 */
import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useData, useMe, Err } from '../App';
import { fmtTime, post } from '../lib/api';

export function FeedbackBox({ step, prompt, compact }: { step: string; prompt?: string; compact?: boolean }) {
  const loc = useLocation();
  const [text, setText] = useState(''); const [rating, setRating] = useState(''); const [sent, setSent] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const send = async () => { setErr(null); try { await post('/api/feedback', { text, rating, step, page: loc.pathname }); setSent(text); setText(''); setRating(''); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="fb-box" data-step={step}>
      {prompt && <p className="small"><strong>{prompt}</strong></p>}
      <textarea aria-label={`Feedback: ${step}`} rows={compact ? 2 : 3} value={text} onChange={(e) => setText(e.target.value)} placeholder="A sentence or two is plenty. Blunt is good." maxLength={4000} />
      <div className="row tight">
        <label className="small">How useful is this? <select aria-label={`Rating: ${step}`} value={rating} onChange={(e) => setRating(e.target.value)}><option value="">no rating</option><option value="1">1, not useful</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5, very useful</option></select></label>
        <button disabled={text.trim().length < 2} onClick={send}>Send feedback</button>
        {sent && <span className="txt-ok small" role="status">Sent. Thank you.</span>}{err && <span className="txt-err small" role="alert">{err}</span>}
      </div>
    </div>
  );
}

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="fb-btn" onClick={() => setOpen(true)}>Give feedback</button>
    {open && <div className="ask-overlay" role="dialog" aria-modal="true" aria-label="Give feedback" style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div className="card" style={{ width: 'min(620px, 94vw)', margin: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Feedback on this screen</h2><button className="secondary" onClick={() => setOpen(false)}>Close</button></div>
        <p className="small muted">It goes to the Tracewell team with the name of the screen you are on.</p>
        <FeedbackBox step="Any screen" />
      </div></div>}
  </>);
}

const STEPS: { title: string; do: React.ReactNode; ask: string }[] = [
  { title: "Tomorrow's cases", ask: 'At 9 AM, is this what an operations manager needs to see? What is missing or unclear?',
    do: <>Open <Link to="/tomorrow">Tomorrow's cases</Link>. Five cases are listed in each hospital's local time. Look at the first three: a <em>confirmed shortage</em>, a delivery <em>waiting on the hospital</em>, and a case that is <em>ready</em>. Each open issue names an owner and a latest time to act.</> },
  { title: 'Check the evidence', ask: 'Would your team trust this number? What other evidence would they want to see?',
    do: <>On case <strong>NL-3021</strong>, read the line "5 physically on hand, 4 reserved for other cases, 1 available, 2 required, short 1". Under <em>Evidence</em>, click <strong>"row 2 says 4 on hand"</strong>. It opens the exact spreadsheet row that was loaded. Use the browser Back button to return.</> },
  { title: 'Find another unit and plan a transfer', ask: 'Is this how a transfer between a rep and a hospital really gets arranged? What would stop someone from using it?',
    do: <>Click <strong>NL-3021</strong>, then <strong>Run exact-item rescue search</strong>. One unit qualifies (another rep's trunk stock); the warehouse units are excluded with the reason. Click <strong>Preview transfer</strong>, then <strong>Reserve and create transfer</strong>. The transfer shows as <em>planned</em>: nothing is picked, dispatched or received yet. Go back to <Link to="/tomorrow">Tomorrow's cases</Link> to see the case updated.</> },
  { title: 'Ask a question', ask: 'Which questions would your operations people actually ask? Was the answer useful, and did you believe it?',
    do: <>On <Link to="/tomorrow">Tomorrow's cases</Link> click <strong>Ask operations</strong> and type <em>Which cases need my attention before 3 today?</em> Then open case NL-3021, click <strong>Ask about this case</strong> and type <em>Why is this case short if we have five on hand?</em> Note: in this review the assistant runs in demo mode. It answers a limited set of questions with templated wording; the numbers and links come from the records.</> },
  { title: 'Trace a lot', ask: 'How does this compare with how a field notice is traced today? What would you need before relying on it?',
    do: <>Open <Link to="/quality">Quality</Link> and click <strong>RCL-001</strong>. It lists every unit of lot F4L1 by location and the open cases holding one. Click <strong>Activate recall</strong>, then look at <Link to="/tomorrow">Tomorrow's cases</Link>: both affected cases are flagged.</> },
  { title: 'Overall', ask: 'Would this be worth a pilot with a distributor? What is the one thing that would have to be true first?',
    do: <>Look around anything else you like: <Link to="/uploads">Load files</Link> shows how spreadsheets come in, <Link to="/inventory">Inventory</Link> shows the ledger. Everything here is synthetic and can be restarted, so nothing you click can do harm.</> },
];

export function ReviewGuide() {
  const { me } = useMe();
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const restart = async () => {
    if (!window.confirm('Restart the demo? It returns to 9:00 AM with a fresh set of cases, and you will be asked to sign in again. Feedback already sent is kept.')) return;
    setBusy(true); setErr(null); setMsg('Restarting the demo. This takes about ten seconds…');
    try { await post('/api/review/restart'); window.location.href = '/login'; } catch (e: any) { setErr(e.message); setMsg(null); setBusy(false); }
  };
  return (
    <div style={{ maxWidth: 980 }}>
      <h1>Reviewer guide</h1>
      <p>Thank you for looking at Tracewell, {me.user.displayName.split(' ')[0]}. This takes about fifteen minutes. Each step has a box for your reaction; send as many or as few as you like. The <strong>Give feedback</strong> button at the top works on every screen.</p>
      <p className="small muted">This is a demonstration account. Every hospital, person, product and case is fictional. The demo clock starts at 9:00 AM Central on a weekday and then runs in real time, so deadlines pass as the day goes on.</p>
      {me.user.role === 'admin' && <section className="card"><strong>Before you start, or any time things look stale:</strong> <button className="secondary" onClick={restart} disabled={busy}>Restart the demo</button> <span className="small muted">Resets to 9:00 AM with tomorrow's cases. You will sign in again.</span>
        {msg && <p className="small" role="status">{msg}</p>}<Err e={err} /></section>}
      <ol className="review-steps">{STEPS.map((s, i) => (
        <li key={i} className="card"><h2 style={{ marginTop: 0 }}>{i + 1}. {s.title}</h2><p>{s.do}</p><FeedbackBox step={`${i + 1}. ${s.title}`} prompt={s.ask} compact /></li>))}</ol>
    </div>
  );
}

export function FeedbackList() {
  const { data, error } = useData<any[]>('/api/feedback');
  return (
    <div><h1>Feedback received</h1><Err e={error} />
      {data?.length ? <div className="table-wrap"><table aria-label="Feedback"><thead><tr><th>When</th><th>From</th><th>Step / screen</th><th>Rating</th><th>Feedback</th></tr></thead><tbody>
        {data.map((f, i) => <tr key={i}><td className="small nowrap">{fmtTime(f.at)}</td><td>{f.by}<div className="tiny muted">{f.email}</div></td><td className="small">{f.step}<div className="tiny muted">{f.page}</div></td><td>{f.rating ?? '—'}</td><td style={{ whiteSpace: 'pre-wrap' }}>{f.text}</td></tr>)}
      </tbody></table></div> : <p className="muted">Nothing yet.</p>}
    </div>
  );
}
