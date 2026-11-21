/**
 * Pilot evaluation: is this worth buying? For each reviewed case the coordinator records
 *   - what their EXISTING process predicted (ready / problem / don't know),
 *   - what THIS APP predicted (captured from the readiness engine at that moment),
 *   - what was verified: was there really a problem; what was done about it; how the case went.
 * Those last three are separate facts, so a shortage the team fixed before surgery still counts as a
 * real problem found, not a false alarm. Everything is append-only; a revision supersedes, never edits.
 */
import { AppError, Db, maybe, rows } from '../db.js';
import { requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit } from '../audit.js';
import { fmtLocal, getVisibleCase, readinessBoard } from '../domain/cases.js';
import { enrichCases } from './tomorrow.js';
import type { AssistantCtx } from '../assistant/types.js';

const PRED = ['ready', 'problem', 'unknown'];
const VERIFIED = ['yes', 'no', 'unknown'];
const OUTCOME = ['on_time', 'delayed', 'cancelled', 'workaround', 'unknown'];
export const OUTCOME_LABEL: Record<string, string> = { on_time: 'Proceeded on time', delayed: 'Delayed', cancelled: 'Cancelled', workaround: 'Proceeded with a workaround', unknown: 'Not known yet' };

async function latest(db: Db, table: 'pilot_predictions' | 'pilot_outcomes', caseId: string, source?: string) {
  return maybe(db, `select x.*, u.display_name by_name from ${table} x join users u on u.id=x.recorded_by where x.case_id=$1 ${source ? 'and x.source=$2' : ''} order by x.recorded_at desc, x.id desc limit 1`, source ? [caseId, source] : [caseId]);
}

/** Snapshot what the app says about a case right now. */
export async function captureAppPrediction(db: Db, actx: AssistantCtx, caseId: string) {
  requirePerm(actx, 'pilot.record');
  const c = await getVisibleCase(db, actx, caseId);
  const board = await readinessBoard(db, actx, 24 * 8);
  const bc = board.cases.find((x: any) => x.id === caseId);
  if (!bc || c.status !== 'scheduled') throw new AppError(409, 'not_upcoming', 'The app prediction can only be captured while the case is still upcoming');
  const [e] = await enrichCases(db, actx, [bc]);
  const prediction = e.status === 'ready' ? 'ready' : e.status === 'needs_information' ? 'unknown' : 'problem';
  const detail = e.blockers.length ? e.blockers.map((b: any) => `${b.typeLabel}: ${b.detail ?? b.message}`).join(' | ').slice(0, 1500) : 'No open blockers; handoff evidence complete.';
  const prev = await latest(db, 'pilot_predictions', caseId, 'app');
  if (prev && prev.prediction === prediction && prev.detail === detail) return prev;
  return (await db.query(`insert into pilot_predictions(tenant_id, case_id, source, prediction, detail, snapshot, supersedes_id, recorded_by, recorded_at) values ($1,$2,'app',$3,$4,$5,$6,$7,$8) returning *`,
    [actx.tenantId, caseId, prediction, detail, { status: e.status, blockers: e.blockers.map((b: any) => ({ type: b.type, code: b.code, message: b.message, actBy: b.actBy })) }, prev?.id ?? null, actx.userId, nowIso()])).rows[0];
}

export async function recordPrediction(db: Db, actx: AssistantCtx, caseId: string, input: { prediction: string; detail?: string }) {
  requirePerm(actx, 'pilot.record');
  await getVisibleCase(db, actx, caseId);
  if (!PRED.includes(input.prediction)) throw new AppError(400, 'bad_prediction', 'Choose ready, problem, or not known');
  const prev = await latest(db, 'pilot_predictions', caseId, 'existing_process');
  const row = (await db.query(`insert into pilot_predictions(tenant_id, case_id, source, prediction, detail, supersedes_id, recorded_by, recorded_at) values ($1,$2,'existing_process',$3,$4,$5,$6,$7) returning *`,
    [actx.tenantId, caseId, input.prediction, String(input.detail ?? '').slice(0, 1500), prev?.id ?? null, actx.userId, nowIso()])).rows[0];
  // Capture the app's view at the same moment so the two predictions are comparable.
  try { await captureAppPrediction(db, actx, caseId); } catch (e) { if (!(e instanceof AppError)) throw e; }
  await audit(db, actx, 'pilot.prediction', 'pilot_prediction', row.id, { prediction: input.prediction, revision_of: prev?.id ?? null }, { caseId });
  return row;
}

export async function recordOutcome(db: Db, actx: AssistantCtx, caseId: string, input: any) {
  requirePerm(actx, 'pilot.record');
  await getVisibleCase(db, actx, caseId);
  if (!VERIFIED.includes(input.verifiedProblem)) throw new AppError(400, 'bad_verified', 'Say whether a real problem was verified: yes, no, or not known');
  if (!OUTCOME.includes(input.caseOutcome)) throw new AppError(400, 'bad_outcome', 'Choose how the case went');
  const int = (v: any, what: string) => { if (v === '' || v == null) return null; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new AppError(400, 'bad_number', `${what} must be zero or more`); return Math.round(n); };
  const minutes = int(input.minutesSaved, 'Minutes saved'); const freight = input.freightAvoided === '' || input.freightAvoided == null ? null : int(Number(input.freightAvoided) * 100, 'Freight avoided');
  const evidence = String(input.savingsEvidence ?? '').trim();
  if ((minutes || freight) && !evidence) throw new AppError(400, 'evidence_required', 'Time or freight savings are only counted with supporting evidence (for example an invoice number or courier quote). Add the evidence or leave the savings blank.');
  if (input.verifiedProblem === 'yes' && !String(input.problemDetail ?? '').trim()) throw new AppError(400, 'detail_required', 'Describe the verified problem');
  const prev = await latest(db, 'pilot_outcomes', caseId);
  const row = (await db.query(`insert into pilot_outcomes(tenant_id, case_id, verified_problem, problem_detail, problem_evidence, intervention, case_outcome, minutes_saved, freight_avoided_cents, savings_evidence, note, supersedes_id, recorded_by, recorded_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [actx.tenantId, caseId, input.verifiedProblem, String(input.problemDetail ?? '').slice(0, 1000), String(input.problemEvidence ?? '').slice(0, 500), String(input.intervention ?? '').slice(0, 1000), input.caseOutcome, minutes, freight, evidence.slice(0, 500), String(input.note ?? '').slice(0, 1000), prev?.id ?? null, actx.userId, nowIso()])).rows[0];
  await audit(db, actx, 'pilot.outcome', 'pilot_outcome', row.id, { verified_problem: input.verifiedProblem, case_outcome: input.caseOutcome, revision_of: prev?.id ?? null }, { caseId });
  return row;
}

export async function reviewList(db: Db, actx: AssistantCtx) {
  requirePerm(actx, 'pilot.record');
  const t = now();
  const cases = await rows(db, `select c.id, c.case_ref, c.scheduled_start, c.status, f.name facility, f.timezone from cases c join facilities f on f.id=c.facility_id
     where c.scheduled_start between $1 and $2 order by c.scheduled_start`, [new Date(t.getTime() - 30 * 86400e3).toISOString(), new Date(t.getTime() + 8 * 86400e3).toISOString()]);
  const preds = await rows(db, `select p.*, u.display_name by_name from pilot_predictions p join users u on u.id=p.recorded_by order by p.recorded_at, p.id`);
  const outs = await rows(db, `select o.*, u.display_name by_name from pilot_outcomes o join users u on u.id=o.recorded_by order by o.recorded_at, o.id`);
  return { outcomeLabels: OUTCOME_LABEL, cases: cases.map((c) => {
    const p = preds.filter((x) => x.case_id === c.id); const o = outs.filter((x) => x.case_id === c.id);
    return { ...c, startLocal: fmtLocal(c.scheduled_start, c.timezone), existing: p.filter((x) => x.source === 'existing_process').at(-1) ?? null, app: p.filter((x) => x.source === 'app').at(-1) ?? null, outcome: o.at(-1) ?? null,
      history: { predictions: p, outcomes: o } };
  }) };
}

/** One-page report. Every count carries the cases behind it. */
export async function report(db: Db, actx: AssistantCtx) {
  const { cases } = await reviewList(db, actx);
  const reviewed = cases.filter((c) => c.existing || c.app);
  const ref = (c: any) => ({ id: c.id, caseRef: c.case_ref, facility: c.facility, startLocal: c.startLocal });
  const classify = (pred: any, out: any) => {
    if (!pred) return 'no_prediction';
    if (!out || out.verified_problem === 'unknown') return 'unknown_outcome';
    if (out.verified_problem === 'yes') return pred.prediction === 'problem' ? 'found' : 'missed';
    return pred.prediction === 'problem' ? 'false_alarm' : 'correct_clear';
  };
  const side = (key: 'app' | 'existing') => {
    const b: Record<string, any[]> = { found: [], false_alarm: [], missed: [], correct_clear: [], unknown_outcome: [], no_prediction: [] };
    for (const c of reviewed) b[classify(c[key], c.outcome)].push(ref(c));
    return b;
  };
  const resolved = reviewed.filter((c) => c.outcome?.verified_problem === 'yes' && c.outcome.intervention.trim() && c.outcome.case_outcome === 'on_time');
  const withEvidence = reviewed.filter((c) => c.outcome && c.outcome.savings_evidence.trim() && (c.outcome.minutes_saved || c.outcome.freight_avoided_cents));
  return {
    generatedAt: nowIso(), reviewed: reviewed.map(ref), app: side('app'), existing: side('existing'),
    verifiedProblems: reviewed.filter((c) => c.outcome?.verified_problem === 'yes').map((c) => ({ ...ref(c), problem: c.outcome.problem_detail, evidence: c.outcome.problem_evidence, intervention: c.outcome.intervention, caseOutcome: OUTCOME_LABEL[c.outcome.case_outcome] })),
    resolvedBeforeSurgery: resolved.map(ref),
    savings: { minutes: withEvidence.reduce((a, c) => a + (c.outcome.minutes_saved ?? 0), 0), freightCents: withEvidence.reduce((a, c) => a + (c.outcome.freight_avoided_cents ?? 0), 0),
      items: withEvidence.map((c) => ({ ...ref(c), minutes: c.outcome.minutes_saved, freightCents: c.outcome.freight_avoided_cents, evidence: c.outcome.savings_evidence })) },
    revisions: { predictions: cases.reduce((a, c) => a + c.history.predictions.filter((p: any) => p.supersedes_id).length, 0), outcomes: cases.reduce((a, c) => a + c.history.outcomes.filter((o: any) => o.supersedes_id).length, 0) },
  };
}
