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

const STEPS: { title: string; changed: string; do: React.ReactNode; ask: string }[] = [
  { title: 'The command center', changed: 'You said: make it the operations manager\'s command center; prioritize the real work, say why, recommend the safest fix and give the action.',
    ask: 'Is this the list an operations manager would work from at 9 AM? Is the ranking right? What is missing?',
    do: <>Open <Link to="/attention">Needs attention</Link> (it is now the home page). Items are ranked Critical, High, Medium. Each has <em>Why</em>, the <em>Safest fix</em>, an act-by time and the buttons to do it. Tap <strong>3 PM today</strong> to see only what must be fixed before 3. Then click <strong>Ask operations</strong> and type <em>What do I need to fix before 3 today?</em> It returns the same list in the same order.</> },
  { title: 'The evidence, as five numbers', changed: 'You said: show Required, On hand, Reserved, Available and Short, and let me expand each one.',
    ask: 'Would your team trust these numbers? Is anything missing from what each number opens to?',
    do: <>On <strong>NL-3021</strong> click <strong>See the evidence</strong>. Tap each number: <em>Physical on hand</em> shows every unit with its source spreadsheet row and last physical check; <em>Reserved</em> shows which cases hold them, when they were entered and reserved; <em>Available</em> shows where the free unit is and when it could arrive; <em>Short</em> lists the ways to cover it, safest first, including the loaner cutoff.</> },
  { title: 'Reserve & request transfer', changed: 'You said: a button does not mean a transfer is happening. Require an owner, pickup plan, required-by time and receiving confirmation; check the donor\'s upcoming cases; show Requested through Received.',
    ask: 'Is this how a transfer really gets arranged? Who should be allowed to accept on a rep\'s behalf?',
    do: <>Under <em>Available</em> click <strong>Request transfer from Chris Okafor</strong>. The form asks for the owner, who collects it, when it leaves and who receives it, and shows the other rep\'s own upcoming cases. Click <strong>Reserve &amp; request transfer</strong>. The unit is held, but the status is only <em>Requested</em>, waiting on Chris. As a manager you can record his answer: type how he agreed and click <strong>Accept</strong>. The chain then follows the shipment through pickup, transit, delivery and the hospital\'s check-in.</> },
  { title: 'Cover the rest: a later case, or a loaner', changed: 'You said: check other territories, then whether a corporate loaner must be requested, and by when.',
    ask: 'Is moving a unit from a later case something your team would do? Are the loaner steps and cutoff handled the way they are in practice?',
    do: <>Back on <Link to="/attention">Needs attention</Link>, NL-3021 still needs one more: click <strong>Move 1 from NL-3031</strong> (a case six days out that can be resupplied). Then on <strong>NL-3026</strong> click <strong>Reserve 1 for this case</strong> and <strong>Request 1 from Corvid loaner desk</strong>. The loaner page tracks confirmation, shipping, check-in and the return date. The loaner source, its daily cutoff and transit time are <Link to="/settings/ops">settings</Link>, not built in.</> },
  { title: 'Recall: what to do first', changed: 'You said: tell Operations how many units, how many are accounted for, which cases are affected, and the recommended actions.',
    ask: 'Are these the right actions in the right order? What would you need before relying on it?',
    do: <>Open <Link to="/quality">Quality</Link> and click <strong>RCL-001</strong>. The top of the page now gives the counts and a numbered action list with links to each affected case. Click <strong>Activate recall</strong>, then return to <Link to="/attention">Needs attention</Link>: the affected cases are flagged.</> },
  { title: 'The rest of the inventory lifecycle, and moving from RedSpot or Salesforce', changed: 'You said: par levels, expiration, allocation by priority rule, one system for the whole lifecycle.',
    ask: 'Overall: is this closer to worth a pilot? What is the one thing that would still have to be true first?',
    do: <>New since your review: <Link to="/tracker">Case tracker</Link> (each case from entry to close, with what it is waiting on), <Link to="/stock/where">Where everything is</Link> (warehouse, reps, hospitals, in transit) and the <Link to="/run-sheet">Run sheet</Link> (what must leave, in deadline order). Also look at <Link to="/allocation">Allocation</Link> (demand against stock, first case entered served first), <Link to="/stock/par">Par levels</Link>, <Link to="/stock/expiring">Expiring stock</Link>, and <Link to="/move-in">Move from another system</Link>, which shows how records come across from RedSpot or Salesforce exports. Two things are deliberately not built yet because they need real history to be honest: demand forecasting and courier route optimization.</> },
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
      <p>Thank you for looking at Tracewell, {me.user.displayName.split(' ')[0]}. This version was rebuilt around your first round of feedback; each step quotes what you asked for. It takes about fifteen minutes. Each step has a box for your reaction; send as many or as few as you like. The <strong>Give feedback</strong> button at the top works on every screen.</p>
      <p className="small muted">This is a demonstration account. Every hospital, person, product and case is fictional. The demo clock starts at 9:00 AM Central on a weekday and then runs in real time, so deadlines pass as the day goes on.</p>
      {me.user.role === 'admin' && <section className="card"><strong>Before you start, or any time things look stale:</strong> <button className="secondary" onClick={restart} disabled={busy}>Restart the demo</button> <span className="small muted">Resets to 9:00 AM with tomorrow's cases. You will sign in again.</span>
        {msg && <p className="small" role="status">{msg}</p>}<Err e={err} /></section>}
      <ol className="review-steps">{STEPS.map((s, i) => (
        <li key={i} className="card"><h2 style={{ marginTop: 0 }}>{i + 1}. {s.title}</h2><p className="small muted">{s.changed}</p><p>{s.do}</p><FeedbackBox step={`${i + 1}. ${s.title}`} prompt={s.ask} compact /></li>))}</ol>
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
