/**
 * Repeatable workflow exercise (baseline / after). Runs the six operational workflows against an
 * ISOLATED database (EXERCISE_DATABASE_URL, default tracewell_exercise), as separate role accounts,
 * through the real HTTP API, and prints observations: steps, statuses, what the screen data says vs
 * what the database recorded.
 *
 *   npx tsx scripts/exercise.ts > docs/exercise-after.md
 */
process.env.DATABASE_URL = process.env.EXERCISE_DATABASE_URL ?? 'postgres://orthoapp:orthoapp_local_only@127.0.0.1:5433/tracewell_exercise';
process.env.DEMO_DATE = process.env.DEMO_DATE ?? '2026-11-21';
process.env.ACCESS_LOG = 'off';

const { seed, zoned, addDays } = await import('../src/server/seed/seed.js');
const { buildApp } = await import('../src/server/app.js');
const { setClock } = await import('../src/server/clock.js');
const { pool, withTenant } = await import('../src/server/db.js');
const { buildGs1 } = await import('../src/shared/gs1.js');

const out: string[] = [];
const say = (s: string) => out.push(s);
let stepCount = 0;
const step = () => ++stepCount;

const r = await seed({ quiet: true });
const T = r.tenantId;
const D = r.demoDate;
const app = await buildApp();
const sessions = new Map<string, string>();
async function as(email: string) {
  if (!sessions.has(email)) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-tw-csrf': '1' }, payload: { email, password: 'Pilot-Demo-2026!' } });
    sessions.set(email, `tw_session=${res.cookies.find((c: any) => c.name === 'tw_session')!.value}`);
  }
  const cookie = sessions.get(email)!;
  return {
    get: async (url: string) => { step(); const x = await app.inject({ method: 'GET', url, headers: { cookie } }); return { code: x.statusCode, body: safe(x.body) }; },
    post: async (url: string, payload: any = {}) => { step(); const x = await app.inject({ method: 'POST', url, headers: { cookie, 'x-tw-csrf': '1' }, payload }); return { code: x.statusCode, body: safe(x.body) }; },
  };
}
const safe = (b: string) => { try { return JSON.parse(b); } catch { return b; } };
const q1 = async (sql: string, p: any[] = []) => withTenant(T, async (db) => (await db.query(sql, p)).rows);
const id = async (sql: string, p: any[] = []) => (await q1(sql, p))[0]?.id;
const has = (o: any, k: string) => o && typeof o === 'object' && k in o;

const ops = await as('ops@lakeshore.example'), sched = await as('scheduler@lakeshore.example'), riley = await as('riley.rep@lakeshore.example'), jordan = await as('jordan.rep@lakeshore.example');
const wh = await as('warehouse@lakeshore.example'), courier = await as('courier@lakeshore.example'), sbrRecv = await as('receiving@stbrigid.example'), sbrSpd = await as('spd@stbrigid.example');
const fin = await as('finance@lakeshore.example'), qa1 = await as('quality@lakeshore.example'), qa2 = await as('quality2@lakeshore.example');

say(`# Workflow exercise (${new Date().toISOString()})\n\nDataset: demo seed, demo date ${D}, isolated DB. All data synthetic.\n`);

// ---------------- 1. 4 p.m. move of tomorrow's first case ----------------
say('## 1. 4 p.m.: move tomorrow\'s first surgery two hours earlier');
await setClock(zoned(D, '16:00', 'America/Chicago'));
const c1 = await id(`select id from cases where case_ref='SYN-1001'`);
let s0 = stepCount;
await ops.post(`/api/cases/${c1}/plan-delivery`);
const before = (await ops.get('/api/board')).body.cases.find((c: any) => c.caseRef === 'SYN-1001');
const newStart = zoned(addDays(D, 1), '05:30', 'America/Chicago').toISOString();
const mv = await sched.post(`/api/cases/${c1}/move`, { scheduledStart: newStart, reason: 'OR block moved earlier (exercise)' });
say(`- Move API: ${mv.code}; conflicts returned: ${JSON.stringify(mv.body.conflicts?.map((c: any) => c.kind) ?? mv.body)}`);
const after = (await ops.get('/api/board')).body.cases.find((c: any) => c.caseRef === 'SYN-1001');
say(`- Board status before/after: ${before.status} → ${after.status}. Next action: "${after.nextAction?.action}" owner "${after.nextAction?.owner}" act by ${after.nextAction?.actBy}`);
say(`- Next action names a person: ${/[A-Z][a-z]+ [A-Z][a-z]+/.test(after.nextAction?.owner ?? '') ? 'yes' : 'NO (role label only)'}; owner can be assigned/acknowledged from board: ${has(after, 'issues') || has(after.blockers?.[0] ?? {}, 'issueId') ? 'yes' : 'NO'}`);
if (after.nextAction?.explanation) say(`- Board explanation: "${after.nextAction.explanation}"`);
const affected = await q1(`select distinct u.display_name from case_issues i join users u on u.id=i.owner_user_id where i.case_id=$1 and i.status<>'resolved'`, [c1]);
if (affected.length) say(`- People who own an open item on this case after the move: ${affected.map((x: any) => x.display_name).join(', ')}`);
const dl = (await q1(`select count(*)::int n from issue_events e join case_issues i on i.id=e.issue_id where i.case_id=$1 and e.kind='deadline_changed'`, [c1]).catch(() => [{ n: 0 }]))[0].n;
say(`- Issue deadline changes recorded by the move: ${dl}`);
const ship = (await q1(`select ref, due_by from shipments where case_id=$1 and status='planned'`, [c1]))[0];
const trayDue = after.requiredBy.tray;
say(`- Planned tray shipment ${ship?.ref} due_by stored ${ship?.due_by?.toISOString?.() ?? ship?.due_by} vs recomputed tray required-by ${trayDue}: ${new Date(ship?.due_by).toISOString() === trayDue ? 'consistent' : 'STALE (pick queue orders by old cutoff)'}`);
const pq = (await wh.get('/api/pick-queue')).body.find((s: any) => s.case_ref === 'SYN-1001');
say(`- Pick queue dispatch-by for that shipment: ${pq?.dispatch_by}`);
const notes = await q1(`select n.kind, u.display_name from notifications n join users u on u.id=n.user_id where n.case_id=$1 and (n.kind in ('case_moved') or n.message like '%deadline%' or n.message like '%earlier%')`, [c1]);
say(`- People notified of move: ${notes.map((n: any) => n.display_name).join(', ') || 'none'} (warehouse/receiving told: ${notes.some((n: any) => /Sam|Alex/.test(n.display_name)) ? 'yes' : 'no'})`);
const blockerText = after.blockers.map((b: any) => `${b.message} ${b.explanation ?? ''}`).join(' | ');
say(`- Board explains facility receiving hours/time-zone deadline: ${/receiving (closes|hours|by)/i.test(blockerText) ? 'yes' : 'no'}`);
say(`- API calls used: ${stepCount - s0}\n`);

// ---------------- 2. Two reps race for one unit ----------------
say('## 2. Two reps, one eligible unit, simultaneous reserve');
await setClock(zoned(D, '16:05', 'America/Chicago'));
const fac = await id(`select id from facilities where code='PVS'`);
const card = await id(`select id from preference_card_versions where status='approved' limit 1`);
const jordanId = await id(`select id from users where email='jordan.rep@lakeshore.example'`);
const urgent = await sched.post('/api/cases', { facilityId: fac, cardVersionId: card, scheduledStart: zoned(addDays(D, 1), '09:00', 'America/Indiana/Indianapolis').toISOString(), repUserId: jordanId, urgent: true });
const cU = urgent.body.id;
const reqR = await id(`select cr.id from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and ci.ref='NP-INS-4-10'`, [c1]);
const reqJ = await id(`select cr.id from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and ci.ref='NP-INS-4-10'`, [cU]);
const sr = (await riley.get(`/api/cases/${c1}/rescue/${reqR}`)).body;
const sj = (await jordan.get(`/api/cases/${cU}/rescue/${reqJ}`)).body;
say(`- Riley eligible: ${sr.eligible?.map((e: any) => e.label).join(',')}; Jordan eligible: ${sj.eligible?.map((e: any) => e.label).join(',')}`);
const e = sr.eligible?.[0];
const [a, b] = await Promise.all([
  riley.post(`/api/cases/${c1}/rescue/${reqR}/reserve`, { stockItemId: e.stockItemId, locationId: e.locationId, ownerPartyId: e.ownerPartyId, idempotencyKey: 'ex-r' }),
  jordan.post(`/api/cases/${cU}/rescue/${reqJ}/reserve`, { stockItemId: e.stockItemId, locationId: e.locationId, ownerPartyId: e.ownerPartyId, idempotencyKey: 'ex-j' }),
]);
const loser = a.code === 200 ? b : a;
say(`- Results: ${a.code} / ${b.code}. Loser message: "${loser.body.message}"`);
say(`- Loser response includes who won / next eligible option: ${has(loser.body, 'details') && loser.body.details ? JSON.stringify(loser.body.details).slice(0, 200) : 'NO'}`);
const active = (await q1(`select count(*)::int n from reservations where stock_item_id=$1 and status='active'`, [e.stockItemId]))[0].n;
say(`- Active reservations on unit: ${active}\n`);

// ---------------- 3. Tray missing an instrument ----------------
say('## 3. Tray missing a required instrument → assignment → resolution → re-verify → release');
s0 = stepCount;
const trayShip = await id(`select id from shipments where case_id=$1 and kind='case_delivery' and status='planned'`, [c1]);
let d = (await wh.get(`/api/shipments/${trayShip}`)).body;
for (const l of d.lines) await wh.post(`/api/shipments/${trayShip}/pick`, { lineId: l.id, qty: l.qty_expected, serial: l.serial_number });
await wh.post(`/api/shipments/${trayShip}/dispatch`, {});
await courier.post(`/api/shipments/${trayShip}/courier`, { type: 'delivered' });
d = (await sbrRecv.get(`/api/shipments/${trayShip}`)).body;
await sbrRecv.post(`/api/shipments/${trayShip}/receive`, { lines: d.lines.map((l: any) => ({ lineId: l.id, qtyReceived: l.qty_dispatched, sealIntact: true })) });
const tray = await id(`select id from stock_items where serial_number='TRY-K-002'`);
const man = (await sbrRecv.get(`/api/trays/${tray}`)).body;
const sizer = await id(`select id from catalog_items where ref='NP-INST-SIZER'`);
await sbrRecv.post(`/api/trays/${tray}/verify`, { caseId: c1, sealIntact: true, lines: man.lines.map((l: any) => ({ catalogItemId: l.catalog_item_id, actualQty: l.catalog_item_id === sizer ? 0 : l.qty })) });
const repView = (await riley.get(`/api/cases/${c1}`)).body;
say(`- Rep sees: status ${repView.readiness.status}; top blocker: "${repView.readiness.blockers[0]?.message}" owner ${repView.readiness.blockers[0]?.owner}`);
const disc = (await q1(`select * from discrepancies where kind='missing_instrument' and status='open'`))[0];
const trayIssue = repView.readiness.blockers.find((b: any) => b.code === 'tray_incomplete');
say(`- Discrepancy has a named owner: ${trayIssue?.issueId ? `yes (${trayIssue.owner})` : 'NO'}; can be acknowledged: ${trayIssue?.issueId ? `ack → ${(await ops.post(`/api/issues/${trayIssue.issueId}/ack`, { note: 'sending replacement' })).code}` : 'NO endpoint'}`);
if (trayIssue?.issueId) { const st = (await q1(`select status from case_issues where id=$1`, [trayIssue.issueId]))[0].status; say(`- After acknowledgment the issue is "${st}" (not resolved) and the case is still ${(await riley.get(`/api/cases/${c1}`)).body.readiness.status}`); }
const repl = await ops.post(`/api/discrepancies/${disc.id}/replacement`);
d = (await wh.get(`/api/shipments/${repl.body.id}`)).body;
await wh.post(`/api/shipments/${repl.body.id}/pick`, { lineId: d.lines[0].id, qty: 1 });
await wh.post(`/api/shipments/${repl.body.id}/dispatch`, {});
d = (await sbrRecv.get(`/api/shipments/${repl.body.id}`)).body;
await sbrRecv.post(`/api/shipments/${repl.body.id}/receive`, { lines: [{ lineId: d.lines[0].id, qtyReceived: 1, sealIntact: true }] });
const repMid = (await riley.get(`/api/cases/${c1}`)).body;
say(`- Rep sees after replacement received, before re-verify: "${repMid.readiness.blockers[0]?.message?.slice(0, 120)}"`);
await sbrRecv.post(`/api/trays/${tray}/verify`, { caseId: c1, sealIntact: true, lines: man.lines.map((l: any) => ({ catalogItemId: l.catalog_item_id, actualQty: l.qty })) });
const relRep = await riley.post(`/api/cases/${c1}/release`, { trayStockItemId: tray, decision: 'released', evidence: { hospital_processing_record_ref: 'x' } });
say(`- Rep attempts hospital release: ${relRep.code}`);
await sbrSpd.post(`/api/cases/${c1}/release`, { trayStockItemId: tray, decision: 'released', evidence: { hospital_processing_record_ref: 'SBR-LOAD-1' } });
const fin3 = (await riley.get(`/api/cases/${c1}`)).body.readiness;
say(`- After SPD release: status ${fin3.status}; remaining blockers: ${fin3.blockers.map((b: any) => b.code).join(',') || 'none'}`);
say(`- API calls used: ${stepCount - s0}\n`);

// ---------------- 4. Offline usage + recall + reconnect ----------------
say('## 4. Offline implanted + opened-unused, recall from another account, reconnect');
// Ensure the trunk unit reached the hospital (won reservation above may be Riley's or Jordan's)
const xfr = await id(`select s.id from shipments s join cases c on c.id=s.case_id where s.kind='rescue_transfer' and c.case_ref='SYN-1001'`);
if (xfr) {
  d = (await jordan.get(`/api/shipments/${xfr}`)).body;
  await jordan.post(`/api/shipments/${xfr}/pick`, { lineId: d.lines[0].id, qty: 1 }); await jordan.post(`/api/shipments/${xfr}/dispatch`, {});
  d = (await sbrRecv.get(`/api/shipments/${xfr}`)).body;
  await sbrRecv.post(`/api/shipments/${xfr}/receive`, { lines: [{ lineId: d.lines[0].id, qtyReceived: 1, sealIntact: true }] });
}
const pkg = await riley.get(`/api/offline/cases/${c1}/package`);
say(`- Offline package download: ${pkg.code}`);
const fem = (await q1(`select * from stock_items where serial_number='FEM4L-0101'`))[0];
const tib = (await q1(`select * from stock_items where serial_number='TIB4-0201'`))[0];
const usedAt = new Date(zoned(D, '16:10', 'America/Chicago')).toISOString();
const evs = [
  { clientEventId: 'ex-off-1', caseId: c1, disposition: 'implanted', entryMethod: 'simulator', occurredAt: usedAt, rawScan: buildGs1({ gtin: (await q1(`select unit_gtin from catalog_items where ref='NP-FEM-4L'`))[0].unit_gtin, lot: fem.lot_number, serial: fem.serial_number, expiry: fem.expiry_date }, { symbologyId: true }) },
  { clientEventId: 'ex-off-2', caseId: c1, disposition: 'opened_unused', entryMethod: 'simulator', occurredAt: usedAt, rawScan: buildGs1({ gtin: (await q1(`select unit_gtin from catalog_items where ref='NP-TIB-4'`))[0].unit_gtin, lot: tib.lot_number, serial: tib.serial_number, expiry: tib.expiry_date }, { symbologyId: true }) },
];
await setClock(zoned(D, '16:20', 'America/Chicago'));
const item = (await q1(`select id, manufacturer_party_id from catalog_items where ref='NP-FEM-4L'`))[0];
const rc = await qa1.post('/api/recalls', { manufacturerPartyId: item.manufacturer_party_id, catalogItemId: item.id, scopeType: 'lot', scopeValues: [fem.lot_number], noticeRef: 'EX-1', description: 'exercise recall' });
await qa2.post(`/api/recalls/${rc.body.id}/verify`, { confirmScope: [fem.lot_number] });
await qa1.post(`/api/recalls/${rc.body.id}/activate`);
const sync1 = await riley.post('/api/offline/sync', { events: evs });
const sync2 = await riley.post('/api/offline/sync', { events: evs });
say(`- Sync results: ${JSON.stringify(sync1.body.results?.map((x: any) => x.state))}; retry: ${JSON.stringify(sync2.body.results?.map((x: any) => (x.replayed ? 'replayed' : x.state)))}`);
for (const ev of evs) {
  const ue = (await q1(`select id, status, disposition from usage_events where client_event_id=$1`, [ev.clientEventId]))[0];
  const mvN = (await q1(`select count(*)::int n from inventory_movements where usage_event_id=$1`, [ue?.id]))[0].n;
  const chN = (await q1(`select count(*)::int n from charges where usage_event_id=$1`, [ue?.id]))[0].n;
  say(`  - ${ev.disposition}: usage ${ue?.status}, movements ${mvN}, charges ${chN}`);
}
const qTask = (await q1(`select count(*)::int n from recall_tasks where task_type='late_usage_review'`))[0].n;
const qHome = (await qa1.get('/api/quality')).body;
say(`- Quality late-usage review tasks: ${qTask}; visible on Quality home tasks: ${qHome.tasks?.some((t: any) => t.task_type === 'late_usage_review') ? 'yes' : 'NO'}`);
// Lost-usage probe: an event the server cannot accept (case reassigned / wrong rep)
const lost = await jordan.post('/api/offline/sync', { events: [{ ...evs[0], clientEventId: 'ex-lost-1', rawScan: evs[0].rawScan }] });
const persisted = (await q1(`select count(*)::int n from usage_events where client_event_id='ex-lost-1'`))[0].n + (await q1(`select count(*)::int n from information_schema.tables where table_name='sync_quarantine'`))[0].n && (await q1(`select count(*)::int n from sync_quarantine where client_event_id='ex-lost-1'`).catch(() => [{ n: 0 }]))[0].n;
say(`- Event the server rejects (rep not assigned): phone told "${lost.body.results?.[0]?.state}: ${lost.body.results?.[0]?.reason}"; persisted on server for review: ${persisted ? 'yes' : 'NO (usage exists only on the phone)'}`);
// Duplicate serial rescan
const dup = await riley.post('/api/offline/sync', { events: [{ ...evs[0], clientEventId: 'ex-dup-1' }] });
say(`- Accidental rescan of the same serial: server says "${dup.body.results?.[0]?.state}: ${dup.body.results?.[0]?.reason?.slice(0, 140)}"\n`);

// ---------------- 5. Missing price → packet → partial PO → correction ----------------
say('## 5. Missing contract price, packet, partial PO, one correction');
s0 = stepCount;
const c903 = await id(`select id from cases where case_ref='SYN-0903'`);
const wl = (await fin.get('/api/finance/worklist')).body.find((x: any) => x.caseRef === 'SYN-0903');
say(`- Worklist row: net ${wl?.netCents}, holding: ${JSON.stringify(wl?.holdingUp)}`);
const finD = (await fin.get(`/api/cases/${c903}/financials`)).body;
const exc = finD.charges.find((c: any) => c.status === 'exception');
const qLines = await fin.get('/api/finance/lines');
const ql = qLines.code === 200 ? qLines.body.lines.find((l: any) => l.chargeId === exc.id) : null;
say(`- Held line shows owner/age/missing evidence fields: ${ql ? `yes (owner ${ql.ownerName}, age ${ql.ageDays} d, missing: ${ql.missingEvidence})` : 'NO'}`);
await fin.post(`/api/charges/${exc.id}/resolve`, { decision: 'charge', unitPriceCents: 205000, reason: 'Price per PVS amendment (exercise)' });
const hist = await q1(`select count(*)::int n from information_schema.tables where table_name='charge_events'`);
say(`- Price change history table exists: ${hist[0].n ? 'yes' : 'NO (only appended rationale text)'}`);
const pk = await fin.post(`/api/cases/${c903}/packet`);
await fin.post(`/api/packets/${pk.body.packet.id}/queue`);
const lines = (await q1(`select catalog_item_id, sum(qty)::int qty, max(unit_price_cents) p from charges where packet_id=$1 group by 1`, [pk.body.packet.id]));
const po = await fin.post(`/api/packets/${pk.body.packet.id}/po`, { poNumber: 'EX-PO-1', lines: lines.slice(0, 2).map((l: any) => ({ catalogItemId: l.catalog_item_id, qty: l.qty, unitPriceCents: l.p })) });
say(`- Partial PO (2 of ${lines.length} lines): ${po.code}; issues ${JSON.stringify(po.body.issues)}; packet status ${(await q1(`select status from billing_packets where id=$1`, [pk.body.packet.id]))[0].status}`);
const ch1 = (await q1(`select id, amount_cents, usage_event_id from charges where packet_id=$1 order by amount_cents desc limit 1`, [pk.body.packet.id]))[0];
const mvBefore = (await q1(`select count(*)::int n from inventory_movements`))[0].n;
await fin.post(`/api/charges/${ch1.id}/credit`, { amountCents: 10000, reason: 'Price correction (exercise)', idempotencyKey: 'ex-cr-1' });
const mvAfter = (await q1(`select count(*)::int n from inventory_movements`))[0].n;
const f2 = (await fin.get(`/api/cases/${c903}/financials`)).body;
say(`- After credit: net ${f2.netCents}; remaining after PO shown: ${has(f2, 'outstandingCents') ? f2.outstandingCents : 'NOT SHOWN'}; inventory movements changed by credit: ${mvAfter - mvBefore}`);
if (f2.stages) say(`- Lifecycle shown: ${Object.entries(f2.stages).map(([k, v]: any) => `${k}=${v.done ? 'yes' : 'no'}`).join(', ')}`);
const consumedLoc = (await q1(`select l.kind from stock_balances b join locations l on l.id=b.location_id join usage_events ue on ue.stock_item_id=b.stock_item_id where ue.id=$1 and b.qty>0`, [ch1.usage_event_id]))[0];
say(`- Corrected implant location after credit: ${consumedLoc?.kind}`);
say(`- API calls used: ${stepCount - s0}\n`);

// ---------------- 6. Hospital A boundaries ----------------
say('## 6. Hospital A (St. Brigid) probing Hospital B (Prairie Valley)');
const c2 = await id(`select id from cases where case_ref='SYN-1002'`);
const probes: [string, (x: any) => boolean][] = [
  [`/api/cases/${c2}`, (x) => x.code !== 200],
  ['/api/search?q=SYN-1002', (x) => !JSON.stringify(x.body).includes('SYN-1002')],
  ['/api/exports/cases.csv?facility=PVS', (x) => !String(x.body).includes('SYN-1002')],
  ['/api/notifications', (x) => !JSON.stringify(x.body).includes('SYN-1002')],
  ['/api/integrations', (x) => !JSON.stringify(x.body).includes('SYN-1002') && !JSON.stringify(x.body).includes('SYN-0903')],
  [`/api/cards/${card}`, (x) => x.code !== 200],
  ['/api/exceptions', (x) => !JSON.stringify(x.body).match(/SYN-1002|SYN-0903|Prairie/)],
  ['/api/meta', (x) => !JSON.stringify(x.body.facilities ?? '').includes('Prairie')],
];
for (const [u, ok] of probes) { const x = await sbrRecv.get(u); say(`- ${u}: ${x.code} → ${ok(x) ? 'no Hospital B data' : 'LEAK: Hospital B data visible'}`); }

say(`\nTotal API calls: ${stepCount}`);
console.log(out.join('\n'));
await app.close();
await pool.end();
