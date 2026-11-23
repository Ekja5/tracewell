/**
 * Usage and consumption, from what reps recorded at closeout: what was used, where, by whom, how often,
 * what it is worth at contract price, and which replacements are still owed. These are counts of recorded
 * events over the chosen period. Rates are simple averages over that period, not forecasts.
 */
import { AppError, Db, one, rows } from '../db.js';
import { Ctx, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit } from '../audit.js';
import { fmtLocal } from '../domain/cases.js';
import { localYmd } from '../time.js';

const USED = ['implanted', 'wasted', 'opened_unused', 'damaged', 'missing']; // leaves usable stock; returned_sealed does not

export async function usageReport(db: Db, ctx: Ctx & { tenantTz?: string }, opts: { days?: number } = {}) {
  requirePerm(ctx, 'inventory.view');
  const days = [30, 60, 90].includes(Number(opts.days)) ? Number(opts.days) : 30;
  const t = now(); const tz = ctx.tenantTz ?? 'UTC'; const since = new Date(t.getTime() - days * 86400e3);
  const ev = await rows(db, `select ue.id, ue.disposition, coalesce(ue.reviewed_qty_units, ue.qty_units, 0)::int qty, ue.occurred_at, ue.catalog_item_id, ci.ref, ci.description, c.id case_id, c.case_ref, f.name facility, u.display_name rep,
      coalesce(ch.amount_cents,0)::int amount, ch.status charge_status
    from usage_events ue join cases c on c.id=ue.case_id join facilities f on f.id=c.facility_id join catalog_items ci on ci.id=ue.catalog_item_id left join users u on u.id=c.rep_user_id left join charges ch on ch.usage_event_id=ue.id
    where ue.status='recorded' and ue.occurred_at >= $1 order by ue.occurred_at`, [since.toISOString()]);
  const stock = new Map((await rows(db, `select st.catalog_item_id, coalesce(sum(b.qty),0)::int usable from stock_balances b join stock_items st on st.id=b.stock_item_id join locations l on l.id=b.location_id
     where b.qty>0 and b.condition='sealed' and l.kind in ('warehouse','trunk','consignment','hospital_receiving') and not exists (select 1 from quality_holds h where h.stock_item_id=b.stock_item_id and h.status='active') group by 1`)).map((r) => [r.catalog_item_id, r.usable]));
  const repl = await rows(db, `select rp.id, rp.catalog_item_id, rp.qty, rp.status, rp.created_at, rp.done_at, rp.order_ref, ci.ref, ci.description, c.case_ref, c.id case_id, f.name facility, du.display_name done_by
     from replenishments rp join catalog_items ci on ci.id=rp.catalog_item_id join cases c on c.id=rp.case_id join facilities f on f.id=c.facility_id left join users du on du.id=rp.done_by where rp.action='replace' and rp.status in ('open','done') order by rp.created_at`);
  const weeks = Math.max(1, days / 7);
  const items = new Map<string, any>(); const by = (m: Map<string, any>, k: string) => { if (!m.has(k)) m.set(k, { name: k, cases: new Set<string>(), units: 0, value: 0 }); return m.get(k); };
  const hospitals = new Map<string, any>(), reps = new Map<string, any>(); const disp: Record<string, number> = {}; const caseSet = new Set<string>(); let value = 0;
  for (const e of ev) {
    disp[e.disposition] = (disp[e.disposition] ?? 0) + e.qty; caseSet.add(e.case_id);
    if (!items.has(e.catalog_item_id)) items.set(e.catalog_item_id, { catalogItemId: e.catalog_item_id, ref: e.ref, description: e.description, used: 0, implanted: 0, wasted: 0, openedUnused: 0, returnedSealed: 0, value: 0, cases: new Map<string, string>() });
    const it = items.get(e.catalog_item_id);
    if (e.disposition === 'returned_sealed') { it.returnedSealed += e.qty; continue; }
    if (!USED.includes(e.disposition)) continue;
    it.used += e.qty; if (e.disposition === 'implanted') it.implanted += e.qty; if (e.disposition === 'wasted') it.wasted += e.qty; if (e.disposition === 'opened_unused') it.openedUnused += e.qty;
    it.value += e.amount; value += e.amount; it.cases.set(e.case_id, new Date(e.occurred_at).toISOString());
    for (const g of [by(hospitals, e.facility), by(reps, e.rep ?? 'No rep')]) { g.cases.add(e.case_id); g.units += e.qty; g.value += e.amount; }
  }
  const itemRows = [...items.values()].map((it) => {
    const dates = [...it.cases.values()].sort(); const n = dates.length;
    const gap = n > 1 ? (new Date(dates[n - 1]).getTime() - new Date(dates[0]).getTime()) / 86400e3 / (n - 1) : null;
    const perWeek = it.used / weeks; const usable = stock.get(it.catalogItemId) ?? 0;
    const owed = repl.filter((r) => r.catalog_item_id === it.catalogItemId && r.status === 'open').reduce((a, r) => a + r.qty, 0);
    return { catalogItemId: it.catalogItemId, ref: it.ref, description: it.description, used: it.used, implanted: it.implanted, wasted: it.wasted, openedUnused: it.openedUnused, returnedSealed: it.returnedSealed, cases: n,
      lastUsedLocal: n ? fmtLocal(dates[n - 1], tz) : null, daysBetweenUses: gap != null ? Math.round(gap * 10) / 10 : null, perWeek: Math.round(perWeek * 10) / 10, usableNow: usable,
      weeksOfCover: perWeek > 0 ? Math.round((usable / perWeek) * 10) / 10 : null, replacementsOwed: owed, valueCents: it.value };
  }).sort((a, b) => b.used - a.used || a.ref.localeCompare(b.ref));
  // Units used per calendar week (Monday start), oldest first.
  const wk = new Map<string, number>(); const monday = (d: Date) => { const y = localYmd(d, tz); const dt = new Date(y + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); return dt.toISOString().slice(0, 10); };
  for (let d = new Date(since); d <= t; d = new Date(d.getTime() + 7 * 86400e3)) wk.set(monday(d), 0); wk.set(monday(t), wk.get(monday(t)) ?? 0);
  for (const e of ev) if (USED.includes(e.disposition)) wk.set(monday(new Date(e.occurred_at)), (wk.get(monday(new Date(e.occurred_at))) ?? 0) + e.qty);
  const done = repl.filter((r) => r.status === 'done' && r.done_at);
  const avgReplace = done.length ? Math.round((done.reduce((a, r) => a + (new Date(r.done_at).getTime() - new Date(r.created_at).getTime()) / 86400e3, 0) / done.length) * 10) / 10 : null;
  const open = repl.filter((r) => r.status === 'open');
  const flat = (m: Map<string, any>) => [...m.values()].map((g) => ({ name: g.name, cases: g.cases.size, units: g.units, valueCents: g.value })).sort((a, b) => b.units - a.units);
  const usedTotal = itemRows.reduce((a, r) => a + r.used, 0);
  return { days, sinceLocal: fmtLocal(since, tz), asOfLocal: fmtLocal(t, tz),
    summary: { cases: caseSet.size, unitsUsed: usedTotal, implanted: disp.implanted ?? 0, wasted: disp.wasted ?? 0, openedUnused: disp.opened_unused ?? 0, returnedSealed: disp.returned_sealed ?? 0, valueCents: value,
      wastePct: usedTotal ? Math.round((((disp.wasted ?? 0) + (disp.opened_unused ?? 0)) / usedTotal) * 1000) / 10 : 0, replacementsOwed: open.reduce((a, r) => a + r.qty, 0), avgDaysToReplace: avgReplace, replaced: done.length },
    items: itemRows, hospitals: flat(hospitals), reps: flat(reps), weeks: [...wk.entries()].sort().map(([week, units]) => ({ week, units })),
    owed: open.map((r) => ({ id: r.id, ref: r.ref, description: r.description, qty: r.qty, caseRef: r.case_ref, caseId: r.case_id, facility: r.facility, sinceLocal: fmtLocal(r.created_at, tz), daysOpen: Math.floor((t.getTime() - new Date(r.created_at).getTime()) / 86400e3) })),
    note: 'Counts of what reps recorded at closeout in this period. "Per week" and "weeks of cover" are simple averages over the period, not a forecast. Value is draft charges at contract price, not invoices.' };
}

/** Record that a replacement owed after a case has been restocked. Does not move stock: the units arrive through a count, an upload or a receipt. */
export async function markReplaced(db: Db, ctx: Ctx, input: { ids: string[]; orderRef?: string }) {
  requirePerm(ctx, 'par.manage');
  const ids = [...new Set(input.ids ?? [])];
  if (!ids.length) throw new AppError(400, 'none_selected', 'Choose at least one line');
  const r = await db.query(`update replenishments set status='done', done_at=$2, done_by=$3, order_ref=$4 where id = any($1) and status='open' and action='replace' returning id`, [ids, nowIso(), ctx.userId, input.orderRef?.trim() || null]);
  await audit(db, ctx, 'replenishment.done', 'replenishment', null, { ids: r.rows.map((x) => x.id), orderRef: input.orderRef ?? null });
  return { marked: r.rowCount, remaining: (await one(db, `select coalesce(sum(qty),0)::int n from replenishments where action='replace' and status='open'`)).n };
}
