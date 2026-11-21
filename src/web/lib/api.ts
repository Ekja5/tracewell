export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-tw-csrf': '1' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Request failed (${res.status})`);
  return data as T;
}
export const post = <T = any>(path: string, body: any = {}) => api<T>(path, { method: 'POST', body });

export function uuid() {
  return (crypto as any).randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

let defaultTz: string | undefined;
/** The signed-in user's home time zone (facility for hospital users, otherwise the distributor's). */
export function setDefaultTz(tz: string | undefined) { defaultTz = tz; }
export function fmtTime(iso: string | null | undefined, tz?: string, opts: Intl.DateTimeFormatOptions = {}) {
  if (!iso) return '—';
  tz = tz ?? defaultTz;
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...opts }).format(new Date(iso));
}
export const money = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export function relMinutes(iso: string | null | undefined, nowIso: string) {
  if (!iso) return '';
  const m = Math.round((new Date(iso).getTime() - new Date(nowIso).getTime()) / 60000);
  const a = Math.abs(m); const s = a >= 120 ? `${Math.round(a / 6) / 10} h` : `${a} min`;
  return m >= 0 ? `in ${s}` : `${s} ago`;
}
export const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator', ops_manager: 'Operations manager', inventory_coordinator: 'Inventory coordinator', scheduler: 'Scheduler', rep: 'Sales rep',
  warehouse: 'Warehouse', courier: 'Courier', hospital_receiving: 'Hospital receiving', hospital_spd: 'Hospital SPD', finance: 'Finance', quality_manager: 'Quality manager',
};
