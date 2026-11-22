/**
 * Hosted review mode (REVIEW_MODE=true): one synthetic demo account that an outside reviewer can sign in to,
 * restart to a clean 9:00 AM state, and leave feedback on. Feedback is kept in a separate database
 * schema so that restarting the demo never erases it.
 */
import { AppError, q, withTenant } from '../db.js';
import { hashPassword } from '../auth.js';
import type { Ctx } from '../perms.js';
import { seedDemoAccount } from './demo-account.js';

export const reviewMode = process.env.REVIEW_MODE === 'true';

/** Why a named sign-in is not active (shown on the health check; never includes the values). */
export const problems: Record<string, string> = {};
function person(prefix: string) {
  delete problems[prefix];
  const email = process.env[`${prefix}_LOGIN`] ?? process.env[`${prefix}_EMAIL`], password = process.env[`${prefix}_PASSWORD`];
  if (!email || !password) { problems[prefix] = `${!email ? 'sign-in name' : 'password'} is not set`; return null; }
  if (password.length < 12) { problems[prefix] = 'password is shorter than 12 characters'; return null; }
  return { email, name: process.env[`${prefix}_NAME`] ?? email.split('@')[0], password };
}
/** Only the account owner reads what reviewers sent. */
export const canReadFeedback = (email: string) => reviewMode && !!(process.env.OWNER_LOGIN ?? process.env.OWNER_EMAIL) && email.toLowerCase() === (process.env.OWNER_LOGIN ?? process.env.OWNER_EMAIL)!.toLowerCase();
let busy = false;
export async function restartDemo() {
  if (!reviewMode) throw new AppError(404, 'not_found', 'Not available');
  if (busy) throw new AppError(409, 'busy', 'The demo is already restarting. Try again in a few seconds.');
  busy = true;
  try { return await seedDemoAccount({ reviewer: person('REVIEWER'), owner: person('OWNER'), lockPersonas: true }); } finally { busy = false; }
}
/** First start of a review deployment: build the demo account if the database is empty. */
export async function ensureDemo() {
  if (!reviewMode) return;
  const n = await q(`select to_regclass('public.tenants') t`);
  const empty = !n[0].t || Number((await q(`select count(*) n from tenants`))[0].n) === 0;
  if (empty) { const r = await restartDemo(); console.log(`[review] demo account built for ${r.day}`); }
  else await syncPeople();
  console.log(`[review] reviewer sign-in: ${problems.REVIEWER ?? 'active'}; owner sign-in: ${problems.OWNER ?? 'active'}`);
}
/** Applies the reviewer/owner sign-ins from the host's settings to the existing demo account (so a changed password takes effect on the next deploy). */
async function syncPeople() {
  const [t] = await q(`select id from tenants order by created_at limit 1`);
  for (const p of [person('REVIEWER'), person('OWNER')]) {
    if (!p) continue;
    const hash = await hashPassword(p.password);
    await withTenant(t.id, (db) => db.query(`insert into users(tenant_id,email,display_name,password_hash,role) values ($1,$2,$3,$4,'admin')
      on conflict (email) do update set password_hash=excluded.password_hash, display_name=excluded.display_name, active=true`, [t.id, p.email.toLowerCase(), p.name, hash]));
  }
}
export const signInStatus = () => (reviewMode ? { reviewer: problems.REVIEWER ?? 'active', owner: problems.OWNER ?? 'active' } : undefined);

// Feedback lives in its own schema, which a demo restart (drop of schema "public") never touches.
let ready = false;
async function table() {
  if (ready) return;
  await q(`create schema if not exists review_keep`);
  await q(`create table if not exists review_keep.feedback (id bigserial primary key, at timestamptz not null default now(), by_name text not null, login text not null, role text not null, step text not null, page text not null, rating int, body text not null)`);
  ready = true;
}
export async function addFeedback(ctx: Ctx, login: string, input: { text?: string; rating?: number | string | null; step?: string; page?: string }) {
  const text = String(input.text ?? '').trim();
  if (text.length < 2) throw new AppError(400, 'empty', 'Write a sentence or two before sending');
  const rating = input.rating === '' || input.rating == null ? null : Number(input.rating);
  if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw new AppError(400, 'bad_rating', 'Rating is 1 to 5');
  await table();
  const [r] = await q(`insert into review_keep.feedback(by_name, login, role, step, page, rating, body) values ($1,$2,$3,$4,$5,$6,$7) returning at`, [ctx.displayName, login, ctx.role, String(input.step ?? '').slice(0, 120), String(input.page ?? '').slice(0, 200), rating, text.slice(0, 4000)]);
  return { ok: true, at: r.at };
}
export async function listFeedback() {
  await table();
  return q(`select at, by_name as by, login as email, role, step, page, rating, body as text from review_keep.feedback order by at desc limit 500`);
}
