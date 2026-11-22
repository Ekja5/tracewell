/**
 * Hosted review mode (REVIEW_MODE=true): one synthetic demo account that an outside reviewer can sign in to,
 * restart to a clean 9:00 AM state, and leave feedback on. Feedback is appended to a file outside the
 * database so that restarting the demo never erases it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppError, q } from '../db.js';
import type { Ctx } from '../perms.js';
import { seedDemoAccount } from './demo-account.js';

export const reviewMode = process.env.REVIEW_MODE === 'true';
const FILE = process.env.FEEDBACK_FILE ?? path.resolve('data/feedback.jsonl');

function person(prefix: string) {
  const email = process.env[`${prefix}_EMAIL`], password = process.env[`${prefix}_PASSWORD`];
  if (!email || !password) return null;
  if (password.length < 12) throw new Error(`${prefix}_PASSWORD must be at least 12 characters`);
  return { email, name: process.env[`${prefix}_NAME`] ?? email.split('@')[0], password };
}
/** Only the account owner reads what reviewers sent. */
export const canReadFeedback = (email: string) => reviewMode && !!process.env.OWNER_EMAIL && email.toLowerCase() === process.env.OWNER_EMAIL.toLowerCase();
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
}

export function addFeedback(ctx: Ctx, email: string, input: { text?: string; rating?: number | string | null; step?: string; page?: string }) {
  const text = String(input.text ?? '').trim();
  if (text.length < 2) throw new AppError(400, 'empty', 'Write a sentence or two before sending');
  const rating = input.rating === '' || input.rating == null ? null : Number(input.rating);
  if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw new AppError(400, 'bad_rating', 'Rating is 1 to 5');
  const row = { at: new Date().toISOString(), by: ctx.displayName, email, role: ctx.role, step: String(input.step ?? '').slice(0, 120), page: String(input.page ?? '').slice(0, 200), rating, text: text.slice(0, 4000) };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify(row) + '\n');
  return { ok: true, at: row.at };
}
export function listFeedback() {
  if (!fs.existsSync(FILE)) return [];
  return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
}
