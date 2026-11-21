import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { AppError, q } from './db.js';
import { config } from './config.js';
import type { Ctx } from './perms.js';

export const COOKIE = 'tw_session';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const attempts = new Map<string, { n: number; until: number }>();

export async function login(email: string, password: string) {
  const key = String(email ?? '').toLowerCase().trim();
  const a = attempts.get(key);
  if (a && a.until > Date.now()) throw new AppError(429, 'locked', 'Too many attempts. Try again in a few minutes.');
  const [u] = await q(`select * from users where lower(email)=$1 and active`, [key]);
  const ok = u && (await bcrypt.compare(String(password ?? ''), u.password_hash));
  if (!ok) {
    const n = (a?.n ?? 0) + 1;
    attempts.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
    throw new AppError(401, 'bad_credentials', 'Email or password is incorrect');
  }
  attempts.delete(key);
  return createSession(u);
}

export async function createSession(u: any) {
  const token = randomBytes(32).toString('base64url');
  await q(`insert into sessions(token_hash, user_id, tenant_id, expires_at) values ($1,$2,$3, now() + make_interval(hours => $4))`, [sha(token), u.id, u.tenant_id, config.sessionHours]);
  return { token, user: publicUser(u) };
}

export async function logout(token: string | undefined) {
  if (token) await q(`update sessions set revoked_at=now() where token_hash=$1`, [sha(token)]);
}

export async function sessionCtx(token: string | undefined): Promise<Ctx | null> {
  if (!token) return null;
  const [r] = await q(`select u.*, t.name tenant_name from sessions s join users u on u.id=s.user_id join tenants t on t.id=s.tenant_id
    where s.token_hash=$1 and s.revoked_at is null and s.expires_at > now() and u.active and u.tenant_id = s.tenant_id`, [sha(token)]);
  if (!r) return null;
  return { userId: r.id, tenantId: r.tenant_id, role: r.role, facilityId: r.facility_id, territoryId: r.territory_id, displayName: r.display_name };
}

export function publicUser(u: any) {
  return { id: u.id, email: u.email, displayName: u.display_name, role: u.role, facilityId: u.facility_id, territoryId: u.territory_id, tenantId: u.tenant_id };
}

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
