import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError, Db, maybe, one, q, rows, withTenant } from './db.js';
import { config } from './config.js';
import { COOKIE, createSession, login, logout, publicUser, sessionCtx } from './auth.js';
import { can, caseScope, Ctx, isFacilityUser, PERMS, requirePerm } from './perms.js';
import { now, refreshClock, nowIso } from './clock.js';
import { audit } from './audit.js';
import { runImport, suggestMapping, templateCsv, TEMPLATES, ImportKind, csvCell } from './domain/imports.js';
import { readinessWithIssues, cancelCase, caseReadiness, createCase, getVisibleCase, moveCase, readinessBoard, updateRequirement, analyzeConflicts, fmtLocal, getPolicy } from './domain/cases.js';
import { previewTransfer, reserveAndTransfer, rescueSearch, exactItemAvailability } from './domain/rescue.js';
import * as ship from './domain/shipments.js';
import { closeoutState, recordInstrumentReturn, recordUsage, reviewUsage, submitCloseout, voidUsage, quarantineSyncEvent } from './domain/closeout.js';
import * as bill from './domain/billing.js';
import * as rec from './domain/recall.js';
import * as counts from './domain/counts.js';
import { ingestAck, integrationStatus, processOutboxForTenant, runSimulatedScheduleSync } from './domain/erp.js';
import { computeMetrics } from './domain/metrics.js';
import * as issues from './domain/issues.js';
import { AVAILABILITY_SQL, ledgerReconciliation, reverseMovement, reserve } from './domain/inventory.js';
import { parseScan } from '../shared/gs1.js';

type H = (db: Db, ctx: Ctx, req: FastifyRequest<any>, reply: FastifyReply) => Promise<any>;

export async function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);

  // Minimal access log: no bodies, no query strings, no cookies (avoid sensitive data in logs).
  app.addHook('onResponse', async (req, reply) => {
    if (process.env.ACCESS_LOG === 'off') return;
    if (req.url.startsWith('/api/')) console.log(`${new Date().toISOString()} ${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin').header('X-Frame-Options', 'DENY')
      .header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'");
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    // CSRF defense: state-changing API calls must carry a custom header (not settable cross-site without CORS).
    if (req.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-tw-csrf'] !== '1') {
      reply.code(403).send({ error: 'csrf', message: 'Missing anti-CSRF header' });
    }
    await refreshClock();
  });
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err.code === '23505') return reply.code(409).send({ error: 'conflict', message: 'That change conflicts with an existing record (duplicate prevented).' });
    if (err.code === '40001' || err.code === '40P01') return reply.code(409).send({ error: 'retry', message: 'Concurrent update; please retry.' });
    if (err.code === '22P02') return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    console.error(`[error] ${req.method} ${req.routeOptions.url ?? ''}: ${err.code ?? ''} ${err.message}`);
    return reply.code(500).send({ error: 'server_error', message: 'Unexpected server error' });
  });

  const auth = async (req: FastifyRequest): Promise<Ctx> => {
    const ctx = await sessionCtx(req.cookies[COOKIE]);
    if (!ctx) throw new AppError(401, 'unauthenticated', 'Please sign in');
    return ctx;
  };
  const r = (method: 'GET' | 'POST', url: string, perm: string | null, h: H) => {
    app.route({ method, url, handler: async (req, reply) => {
      const ctx = await auth(req);
      if (perm) requirePerm(ctx, perm);
      return withTenant(ctx.tenantId, (db) => h(db, ctx, req, reply));
    } });
  };
  const B = (req: FastifyRequest<any>) => (req.body ?? {}) as any;
  const P = (req: FastifyRequest<any>) => req.params as any;
  const Q = (req: FastifyRequest<any>) => req.query as any;

  // ---------------- Auth ----------------
  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = B(req);
    const s = await login(email, password);
    reply.setCookie(COOKIE, s.token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: config.sessionHours * 3600 });
    return { user: s.user };
  });
  app.post('/api/auth/logout', async (req, reply) => { await logout(req.cookies[COOKIE]); reply.clearCookie(COOKIE, { path: '/' }); return { ok: true }; });
  app.get('/api/auth/me', async (req) => {
    const ctx = await auth(req);
    const [u] = await q(`select u.*, f.name facility_name, f.timezone facility_tz, t.name tenant_name from users u join tenants t on t.id=u.tenant_id left join facilities f on f.id=u.facility_id where u.id=$1`, [ctx.userId]);
    const perms = Object.keys(PERMS).filter((p) => can(ctx, p));
    return { user: { ...publicUser(u), facilityName: u.facility_name, facilityTimezone: u.facility_tz, tenantName: u.tenant_name }, perms, now: nowIso(), demoClock: config.demoClock, demoShortcuts: config.demoLoginShortcuts };
  });
  // Development-only demo shortcuts. Disabled (404) whenever NODE_ENV=production.
  app.get('/api/auth/demo-accounts', async (req, reply) => {
    if (!config.demoLoginShortcuts) return reply.code(404).send({ error: 'not_found' });
    return q(`select u.email, u.display_name, u.role, f.name facility, t.name tenant from users u join tenants t on t.id=u.tenant_id left join facilities f on f.id=u.facility_id where u.active order by t.slug, u.role, u.email`);
  });
  app.post('/api/auth/demo-login', async (req, reply) => {
    if (!config.demoLoginShortcuts) return reply.code(404).send({ error: 'not_found' });
    const [u] = await q(`select * from users where lower(email)=lower($1) and active`, [B(req).email]);
    if (!u) throw new AppError(404, 'not_found', 'Unknown demo account');
    const s = await createSession(u);
    reply.setCookie(COOKIE, s.token, { httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: config.sessionHours * 3600 });
    return { user: s.user };
  });
  app.get('/api/health', async () => { await q('select 1'); return { ok: true, now: nowIso() }; });

  // ---------------- Reference data ----------------
  r('GET', '/api/meta', null, async (db, ctx) => {
    const facilities = await rows(db, `select f.*, (select row_to_json(p) from facility_policies p where p.facility_id=f.id order by version desc limit 1) policy from facilities f ${isFacilityUser(ctx) ? 'where f.id=$1' : ''} order by f.code`, isFacilityUser(ctx) ? [ctx.facilityId] : []);
    const locations = isFacilityUser(ctx) ? await rows(db, `select * from locations where facility_id=$1`, [ctx.facilityId]) : await rows(db, `select l.*, u.display_name holder from locations l left join users u on u.id=l.holder_user_id order by l.code`);
    const reps = isFacilityUser(ctx) ? [] : await rows(db, `select id, display_name, territory_id from users where role='rep' and active and tenant_id=$1 order by display_name`, [ctx.tenantId]);
    const parties = await rows(db, `select * from parties order by name`);
    const catalog = await rows(db, `select ci.*, p.name manufacturer from catalog_items ci left join parties p on p.id=ci.manufacturer_party_id order by ci.item_type, ci.ref`);
    const cards = isFacilityUser(ctx) ? [] : await rows(db, `select pc.*, v.id version_id, v.version, v.status, v.approved_at, u.display_name approved_by_name from preference_cards pc join preference_card_versions v on v.card_id=pc.id left join users u on u.id=v.approved_by order by pc.code, v.version`);
    const assignable = isFacilityUser(ctx) ? [] : await rows(db, `select id, display_name, role, facility_id from users where active and tenant_id=$1 order by role, display_name`, [ctx.tenantId]);
    return { facilities, locations, reps, parties, catalog, cards, assignable, now: nowIso() };
  });
  r('GET', '/api/cards/:versionId', 'card.view', async (db, ctx, req) => {
    const v = await one(db, `select v.*, pc.code, pc.surgeon_ref, pc.procedure, u.display_name approved_by_name from preference_card_versions v join preference_cards pc on pc.id=v.card_id left join users u on u.id=v.approved_by where v.id=$1`, [P(req).versionId]);
    const lines = await rows(db, `select l.*, ci.ref, ci.description, ci.item_type, b.id backup_for, bci.ref backup_for_ref from preference_card_lines l join catalog_items ci on ci.id=l.catalog_item_id left join preference_card_lines b on b.id=l.backup_for_line_id left join catalog_items bci on bci.id=b.catalog_item_id where l.card_version_id=$1 order by l.mandatory desc, ci.item_type desc`, [v.id]);
    return { version: v, lines };
  });
  r('POST', '/api/cards/:versionId/approve', 'card.approve', async (db, ctx, req) => {
    const v = await one(db, `select * from preference_card_versions where id=$1 for update`, [P(req).versionId]);
    if (v.status !== 'draft') throw new AppError(409, 'bad_state', `Version is ${v.status}`);
    await db.query(`update preference_card_versions set status='superseded' where card_id=$1 and status='approved'`, [v.card_id]);
    await db.query(`update preference_card_versions set status='approved', approved_by=$2, approved_at=$3 where id=$1`, [v.id, ctx.userId, nowIso()]);
    await audit(db, ctx, 'card.approve', 'preference_card_version', v.id, { version: v.version });
    return { ok: true };
  });

  // ---------------- Board & cases ----------------
  r('GET', '/api/board', 'board.view', async (db, ctx, req) => readinessBoard(db, ctx, Math.min(168, Number(Q(req).hours ?? 72))));
  r('GET', '/api/cases', 'board.view', async (db, ctx, req) => {
    const [scope, sp] = caseScope(ctx, 1);
    const mine = Q(req).mine === '1';
    const params = mine ? [...sp, ctx.userId] : sp;
    const mineSql = mine ? ` and c.rep_user_id = $${params.length}` : '';
    return rows(db, `select c.id, c.case_ref, c.status, c.scheduled_start, c.procedure, c.urgent, f.name facility, f.timezone, u.display_name rep_name, c.rep_user_id
       from cases c join facilities f on f.id=c.facility_id left join users u on u.id=c.rep_user_id where ${scope}${mineSql} order by c.scheduled_start`, params);
  });
  r('POST', '/api/cases', 'case.manage', async (db, ctx, req) => createCase(db, ctx, B(req)));
  r('GET', '/api/cases/:id', 'board.view', async (db, ctx, req) => {
    const c = await getVisibleCase(db, ctx, P(req).id);
    const readiness = await readinessWithIssues(db, ctx.tenantId, c.id);
    const caseIssues = await issues.issuesForCase(db, c.id);
    const policy = await getPolicy(db, c.facility_id);
    const requirements = await rows(db, `select cr.*, ci.ref, ci.description, ci.item_type from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and cr.active order by cr.mandatory desc, ci.item_type desc, ci.ref`, [c.id]);
    const reservations = await rows(db, `select r.*, ci.ref, ci.item_type, s.serial_number, s.lot_number, s.expiry_date, l.name location_name from reservations r join stock_items s on s.id=r.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join locations l on l.id=r.location_id where r.case_id=$1 order by r.created_at`, [c.id]);
    const shipments = await rows(db, `select s.*, fl.name from_name, tl.name to_name from shipments s join locations fl on fl.id=s.from_location_id join locations tl on tl.id=s.to_location_id where s.case_id=$1 order by s.created_at`, [c.id]);
    const discrepancies = await rows(db, `select d.*, ci.ref, ci.description from discrepancies d left join catalog_items ci on ci.id=d.catalog_item_id where d.case_id=$1 order by d.reported_at`, [c.id]);
    const releases = await rows(db, `select rd.*, u.display_name recorder from release_decisions rd join users u on u.id=rd.recorded_by where rd.case_id=$1 order by rd.recorded_at`, [c.id]);
    const card = c.preference_card_version_id ? await maybe(db, `select v.version, v.approved_at, pc.code, u.display_name approved_by_name from preference_card_versions v join preference_cards pc on pc.id=v.card_id left join users u on u.id=v.approved_by where v.id=$1`, [c.preference_card_version_id]) : null;
    const timeline = can(ctx, 'audit.view') || ctx.role === 'rep' ? await rows(db, `select a.action, a.occurred_at, a.recorded_at, a.reason, u.display_name actor from audit_log a left join users u on u.id=a.actor_user_id where a.case_id=$1 order by a.recorded_at desc limit 100`, [c.id]) : [];
    const trays = reservations.filter((x) => x.item_type === 'tray' && x.status === 'active');
    const assignable = isFacilityUser(ctx) ? [] : await rows(db, `select id, display_name, role from users where active and (facility_id is null or facility_id=$1) order by role, display_name`, [c.facility_id]);
    return { case: c, readiness, issues: caseIssues, assignable, policy, requirements, reservations, shipments, discrepancies, releases, card, timeline, trays };
  });
  r('POST', '/api/cases/:id/move', 'case.manage', async (db, ctx, req) => moveCase(db, ctx, P(req).id, B(req)));
  r('POST', '/api/cases/:id/cancel', 'case.manage', async (db, ctx, req) => cancelCase(db, ctx, P(req).id, B(req)));
  r('POST', '/api/cases/:id/requirements', 'case.manage', async (db, ctx, req) => updateRequirement(db, ctx, P(req).id, B(req)));
  r('GET', '/api/cases/:id/conflicts', 'board.view', async (db, ctx, req) => { await getVisibleCase(db, ctx, P(req).id); return analyzeConflicts(db, P(req).id); });
  r('POST', '/api/cases/:id/plan-delivery', 'shipment.plan', async (db, ctx, req) => ship.planCaseDelivery(db, ctx, P(req).id));
  r('POST', '/api/cases/:id/reserve', 'reservation.manage', async (db, ctx, req) => { await getVisibleCase(db, ctx, P(req).id); return reserve(db, ctx, { ...B(req), caseId: P(req).id }); });
  r('POST', '/api/cases/:id/release', 'hospital.release', async (db, ctx, req) => ship.recordRelease(db, ctx, P(req).id, B(req)));

  // ---------------- Issues (ownership, acknowledgment, handoff) ----------------
  r('POST', '/api/issues/:id/ack', null, async (db, ctx, req) => issues.acknowledgeIssue(db, ctx, P(req).id, B(req)));
  r('POST', '/api/issues/:id/assign', 'issue.assign', async (db, ctx, req) => issues.assignIssue(db, ctx, P(req).id, B(req)));
  r('POST', '/api/issues/:id/note', null, async (db, ctx, req) => issues.noteIssue(db, ctx, P(req).id, B(req)));
  r('GET', '/api/handoff', 'board.view', async (db, ctx, req) => issues.handoff(db, ctx, Math.min(72, Number(Q(req).hours ?? 12))));

  // ---------------- Rescue ----------------
  r('GET', '/api/availability', 'rescue.search', async (db, ctx, req) => exactItemAvailability(db, ctx, { q: Q(req).q, caseId: Q(req).caseId || null }));
  r('GET', '/api/cases/:id/rescue/:reqId', 'rescue.search', async (db, ctx, req) => rescueSearch(db, ctx, P(req).id, P(req).reqId));
  r('POST', '/api/cases/:id/rescue/:reqId/preview', 'rescue.search', async (db, ctx, req) => previewTransfer(db, ctx, P(req).id, P(req).reqId, B(req)));
  r('POST', '/api/cases/:id/rescue/:reqId/reserve', 'rescue.reserve', async (db, ctx, req) => reserveAndTransfer(db, ctx, P(req).id, P(req).reqId, B(req)));

  // ---------------- Shipments / custody / trays ----------------
  r('GET', '/api/pick-queue', 'shipment.pick', async (db, ctx) => ship.pickQueue(db, ctx));
  r('GET', '/api/shipments', null, async (db, ctx) => {
    const fac = isFacilityUser(ctx) ? ctx.facilityId : null;
    return rows(db, `select s.*, fl.name from_name, tl.name to_name, c.case_ref from shipments s join locations fl on fl.id=s.from_location_id join locations tl on tl.id=s.to_location_id left join cases c on c.id=s.case_id
       where ($1::uuid is null or tl.facility_id=$1 or fl.facility_id=$1) and ($2::boolean is false or s.status in ('dispatched','delivered')) order by s.created_at desc limit 200`, [fac, ctx.role === 'courier']);
  });
  r('POST', '/api/shipments', 'shipment.plan', async (db, ctx, req) => ship.createShipment(db, ctx, B(req)));
  r('GET', '/api/shipments/:id', null, async (db, ctx, req) => ship.shipmentDetail(db, ctx, P(req).id));
  r('POST', '/api/shipments/:id/pick', 'shipment.pick', async (db, ctx, req) => ship.pickLine(db, ctx, P(req).id, B(req)));
  r('POST', '/api/shipments/:id/pack', 'shipment.pick', async (db, ctx, req) => ship.packShipment(db, ctx, P(req).id));
  r('POST', '/api/shipments/:id/dispatch', 'shipment.dispatch', async (db, ctx, req) => ship.dispatchShipment(db, ctx, P(req).id, B(req)));
  r('POST', '/api/shipments/:id/courier', 'shipment.courier', async (db, ctx, req) => ship.courierEvent(db, ctx, P(req).id, B(req)));
  r('POST', '/api/shipments/:id/receive', 'shipment.receive', async (db, ctx, req) => ship.receiveShipment(db, ctx, P(req).id, B(req)));
  r('POST', '/api/shipments/:id/reject', 'shipment.receive', async (db, ctx, req) => ship.rejectShipment(db, ctx, P(req).id, B(req)));
  r('POST', '/api/shipments/:id/close', 'shipment.receive', async (db, ctx, req) => ship.closeHandoff(db, ctx, P(req).id));
  r('POST', '/api/custody/:id/ack', null, async (db, ctx, req) => ship.ackCustody(db, ctx, P(req).id, B(req)));
  r('GET', '/api/trays/:id', null, async (db, ctx, req) => {
    const m = await ship.trayManifest(db, P(req).id);
    const loc = await maybe(db, `select l.* from stock_balances b join locations l on l.id=b.location_id where b.stock_item_id=$1 and b.qty>0 limit 1`, [P(req).id]);
    if (isFacilityUser(ctx) && loc?.facility_id !== ctx.facilityId) throw new AppError(404, 'not_found', 'Tray not found');
    return { ...m, location: loc };
  });
  r('POST', '/api/trays/:id/verify', 'tray.verify', async (db, ctx, req) => ship.verifyTray(db, ctx, P(req).id, B(req)));
  r('POST', '/api/discrepancies/:id/replacement', 'shipment.plan', async (db, ctx, req) => ship.sendReplacement(db, ctx, P(req).id));
  r('POST', '/api/discrepancies/:id/resolve', 'discrepancy.resolve', async (db, ctx, req) => ship.resolveDiscrepancy(db, ctx, P(req).id, B(req)));

  // ---------------- Closeout & offline ----------------
  r('GET', '/api/cases/:id/closeout', 'closeout.record', async (db, ctx, req) => closeoutState(db, ctx, P(req).id));
  r('POST', '/api/cases/:id/usage', 'closeout.record', async (db, ctx, req) => recordUsage(db, ctx, { ...B(req), caseId: P(req).id, offline: false }));
  r('POST', '/api/cases/:id/instrument-return', 'closeout.record', async (db, ctx, req) => recordInstrumentReturn(db, ctx, P(req).id, B(req)));
  r('POST', '/api/cases/:id/closeout/submit', 'closeout.record', async (db, ctx, req) => submitCloseout(db, ctx, P(req).id, B(req)));
  r('POST', '/api/usage/:id/void', 'usage.void', async (db, ctx, req) => voidUsage(db, ctx, P(req).id, B(req)));
  r('GET', '/api/sync-quarantine', 'usage.review', async (db) => rows(db, `select q.*, u.display_name actor from sync_quarantine q join users u on u.id=q.actor_user_id order by q.received_at desc limit 200`));
  r('POST', '/api/usage/:id/review', 'usage.review', async (db, ctx, req) => reviewUsage(db, ctx, P(req).id, B(req)));
  r('POST', '/api/scan/parse', null, async (db, ctx, req) => {
    const p = parseScan(String(B(req).raw ?? ''), { referenceYear: now().getUTCFullYear() });
    let match: any = null;
    if (p.gtin) {
      match = await maybe(db, `select ci.id, ci.ref, ci.description, ci.tracking, 1 units_per_package, null package_gtin, 'each' level from catalog_items ci where ci.unit_gtin=$1`, [p.gtin])
        ?? await maybe(db, `select ci.id, ci.ref, ci.description, ci.tracking, p.units_per_package, p.gtin package_gtin, p.level from packages p join catalog_items ci on ci.id=p.catalog_item_id where p.gtin=$1`, [p.gtin]);
    }
    return { parsed: p, catalogMatch: match };
  });
  // Offline package: only the assigned rep, only the requested case, only what closeout needs.
  r('GET', '/api/offline/cases/:id/package', 'closeout.record', async (db, ctx, req) => {
    const c = await getVisibleCase(db, ctx, P(req).id);
    if (c.rep_user_id !== ctx.userId) throw new AppError(403, 'not_assigned', 'Offline packages are limited to the assigned rep');
    const st = await closeoutState(db, ctx, c.id);
    const items = await rows(db, `select distinct ci.id, ci.ref, ci.description, ci.tracking, ci.unit_gtin, ci.item_type from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1`, [c.id]);
    const pkgs = await rows(db, `select p.gtin, p.units_per_package, p.level, p.uom, p.catalog_item_id from packages p where p.catalog_item_id = any($1)`, [items.map((i) => i.id)]);
    await audit(db, ctx, 'offline.download', 'case', c.id, {}, { caseId: c.id });
    return { downloadedAt: nowIso(), case: { id: c.id, case_ref: c.case_ref, facility_name: c.facility_name, timezone: c.timezone, scheduled_start: c.scheduled_start, procedure: c.procedure, status: c.status, rep_user_id: c.rep_user_id },
      reservations: st.reservations, usage: st.usage, catalog: items, packages: pkgs,
      note: 'Balances in this package are a snapshot as of downloadedAt, not confirmed current availability.' };
  });
  r('POST', '/api/offline/sync', 'closeout.record', async (db, ctx, req) => {
    const events = (B(req).events ?? []) as any[];
    if (events.length > 200) throw new AppError(413, 'too_many', 'Sync at most 200 events per request');
    const results: any[] = [];
    for (const e of events) {
      try {
        await db.query('savepoint ev');
        const res = await recordUsage(db, ctx, { ...e, offline: true });
        await db.query('release savepoint ev');
        results.push({ clientEventId: e.clientEventId, state: res.status === 'recorded' ? 'synced' : res.status === 'rejected' ? 'rejected' : res.status === 'voided' ? 'voided' : 'needs_review', replayed: res.replayed, reason: res.reviewReason, usageEventId: res.usageEvent.id });
      } catch (err: any) {
        await db.query('rollback to savepoint ev');
        const reason = err instanceof AppError ? err.message : 'Server could not apply this event';
        await quarantineSyncEvent(db, ctx, e, reason);
        results.push({ clientEventId: e.clientEventId, state: 'needs_review', quarantined: true, reason: `${reason}. Held on the server for ops review; not lost.` });
      }
    }
    return { serverTime: nowIso(), results };
  });

  // ---------------- Finance ----------------
  r('GET', '/api/finance/worklist', 'finance.manage', async (db, ctx) => bill.financeWorklist(db, ctx));
  r('GET', '/api/finance/lines', 'finance.manage', async (db, ctx) => bill.financeLines(db, ctx));
  r('POST', '/api/charges/:id/assign', 'finance.manage', async (db, ctx, req) => bill.assignCharge(db, ctx, P(req).id, B(req)));
  r('GET', '/api/cases/:id/financials', null, async (db, ctx, req) => {
    if (!can(ctx, 'finance.manage') && !can(ctx, 'closeout.record')) throw new AppError(403, 'forbidden', 'Not permitted');
    await getVisibleCase(db, ctx, P(req).id);
    return bill.caseFinancials(db, P(req).id);
  });
  r('POST', '/api/cases/:id/packet', 'finance.manage', async (db, ctx, req) => bill.generatePacket(db, ctx, P(req).id));
  r('POST', '/api/charges/:id/resolve', 'finance.manage', async (db, ctx, req) => bill.resolveCharge(db, ctx, P(req).id, B(req)));
  r('POST', '/api/charges/:id/credit', 'finance.manage', async (db, ctx, req) => bill.issueCredit(db, ctx, P(req).id, B(req)));
  r('POST', '/api/packets/:id/queue', 'finance.manage', async (db, ctx, req) => bill.queuePacketToErp(db, ctx, P(req).id));
  r('POST', '/api/packets/:id/po', 'finance.manage', async (db, ctx, req) => bill.enterPO(db, ctx, P(req).id, B(req)));
  r('POST', '/api/packets/:id/accept', 'finance.manage', async (db, ctx, req) => bill.acceptPacket(db, ctx, P(req).id, B(req)));
  r('GET', '/api/packets/:id/document', null, async (db, ctx, req, reply) => {
    if (!can(ctx, 'finance.manage') && !can(ctx, 'closeout.record')) throw new AppError(403, 'forbidden', 'Not permitted');
    reply.header('Content-Type', 'text/html; charset=utf-8').header('Content-Disposition', `attachment; filename="packet-${P(req).id.slice(0, 8)}.html"`);
    return bill.packetDocument(db, ctx, P(req).id);
  });
  r('GET', '/api/cases/:id/usage-report.csv', null, async (db, ctx, req, reply) => {
    if (!can(ctx, 'finance.manage') && !can(ctx, 'closeout.record')) throw new AppError(403, 'forbidden', 'Not permitted');
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="usage-${P(req).id.slice(0, 8)}.csv"`);
    return bill.usageReportCsv(db, ctx, P(req).id);
  });

  // ---------------- Quality ----------------
  r('GET', '/api/quality', 'recall.task', async (db, ctx) => rec.qualityHome(db, ctx));
  r('POST', '/api/recalls', 'recall.manage', async (db, ctx, req) => rec.createRecall(db, ctx, B(req)));
  r('GET', '/api/recalls/:id', 'recall.task', async (db, ctx, req) => rec.recallDetail(db, P(req).id));
  r('POST', '/api/recalls/:id/verify', 'recall.manage', async (db, ctx, req) => rec.verifyRecall(db, ctx, P(req).id, B(req)));
  r('POST', '/api/recalls/:id/activate', 'recall.manage', async (db, ctx, req) => rec.activateRecall(db, ctx, P(req).id));
  r('POST', '/api/recalls/:id/close', 'recall.manage', async (db, ctx, req) => rec.closeRecall(db, ctx, P(req).id, B(req)));
  r('POST', '/api/recall-tasks/:id/ack', 'recall.task', async (db, ctx, req) => rec.ackRecallTask(db, ctx, P(req).id));
  r('POST', '/api/recall-tasks/:id/quarantine', 'recall.task', async (db, ctx, req) => rec.quarantineTask(db, ctx, P(req).id));
  r('POST', '/api/recall-tasks/:id/disposition', 'recall.manage', async (db, ctx, req) => rec.dispositionTask(db, ctx, P(req).id, B(req)));

  // ---------------- Counts ----------------
  r('GET', '/api/counts', 'count.perform', async (db) => rows(db, `select cs.*, l.name location_name, u.display_name counter, (select count(*)::int from count_lines cl where cl.session_id=cs.id) lines,
     (select count(*)::int from count_lines cl where cl.session_id=cs.id and cl.expected_qty is not null and cl.counted_qty<>cl.expected_qty) variances from count_sessions cs join locations l on l.id=cs.location_id join users u on u.id=cs.created_by order by cs.created_at desc`));
  app.get('/api/counts/review', async (req) => { const ctx = await auth(req); requirePerm(ctx, 'count.approve'); return withTenant(ctx.tenantId, (db) => rows(db, `select cs.*, l.name location_name, u.display_name counter from count_sessions cs join locations l on l.id=cs.location_id join users u on u.id=cs.created_by where cs.status='submitted' order by cs.submitted_at`)); });
  r('POST', '/api/counts', 'count.perform', async (db, ctx, req) => counts.startCount(db, ctx, B(req)));
  r('GET', '/api/counts/:id', null, async (db, ctx, req) => { if (!can(ctx, 'count.perform') && !can(ctx, 'count.approve')) throw new AppError(403, 'forbidden', 'Not permitted'); return counts.countSession(db, ctx, P(req).id); });
  r('POST', '/api/counts/:id/lines', 'count.perform', async (db, ctx, req) => counts.addCountLine(db, ctx, P(req).id, B(req)));
  r('POST', '/api/counts/:id/submit', 'count.perform', async (db, ctx, req) => counts.submitCount(db, ctx, P(req).id));
  r('POST', '/api/counts/:id/review', 'count.approve', async (db, ctx, req) => counts.reviewCount(db, ctx, P(req).id, B(req)));

  // ---------------- Imports ----------------
  app.get('/api/imports/templates/:kind', async (req: any, reply) => {
    const ctx = await auth(req); requirePerm(ctx, 'import.run');
    const kind = String(req.params.kind).replace(/\.csv$/, '') as ImportKind;
    if (!TEMPLATES[kind]) throw new AppError(404, 'not_found', 'Unknown template');
    reply.header('Content-Type', 'text/csv').header('Content-Disposition', `attachment; filename="${kind}_template.csv"`);
    return templateCsv(kind);
  });
  r('GET', '/api/imports/spec', 'import.run', async () => TEMPLATES);
  r('POST', '/api/imports/headers', 'import.run', async (db, ctx, req) => {
    const { kind, csv } = B(req);
    const headers = String(csv ?? '').split(/\r?\n/)[0].split(',').map((h: string) => h.trim().replace(/^"|"$/g, ''));
    return { headers, suggested: suggestMapping(kind, headers) };
  });
  r('POST', '/api/imports/run', 'import.run', async (db, ctx, req) => runImport(db, ctx, B(req)));
  r('GET', '/api/imports', 'import.run', async (db) => rows(db, `select b.id, b.kind, b.filename, b.source_system, b.mode, b.created_at, b.report->'counts' counts, b.report->'reconciliation' reconciliation, u.display_name by_name from import_batches b join users u on u.id=b.created_by order by b.created_at desc limit 50`));

  // ---------------- Inventory, ledger, search ----------------
  r('GET', '/api/inventory', 'inventory.view', async (db, ctx, req) => {
    const qy = String(Q(req).q ?? '').trim();
    const repOnly = ctx.role === 'rep' && Q(req).mine === '1';
    return rows(db, `select a.*, s.serial_number, s.lot_number, s.expiry_date, ci.ref, ci.description, ci.item_type, ci.unit_gtin, p.name owner,
        (select max(m.recorded_at) from inventory_movements m where m.id = (select last_movement_id from stock_balances b where b.stock_item_id=a.stock_item_id and b.location_id=a.location_id and b.owner_party_id=a.owner_party_id and b.condition=a.condition)) last_movement_at
      from (${AVAILABILITY_SQL}) a join stock_items s on s.id=a.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join parties p on p.id=a.owner_party_id
      where ($1 = '' or ci.ref ilike $1 or s.serial_number = $1 or s.lot_number = $1 or ci.unit_gtin = $1 or ci.description ilike '%'||$1||'%')
        and ($2::uuid is null or a.holder_user_id=$2) order by ci.ref, a.location_code limit 500`, [qy, repOnly ? ctx.userId : null]);
  });
  r('GET', '/api/ledger', 'inventory.view', async (db, ctx, req) => rows(db, `select m.*, ci.ref, s.serial_number, s.lot_number, fl.code from_code, tl.code to_code, u.display_name actor from inventory_movements m join stock_items s on s.id=m.stock_item_id
      join catalog_items ci on ci.id=s.catalog_item_id left join locations fl on fl.id=m.from_location_id left join locations tl on tl.id=m.to_location_id join users u on u.id=m.actor_user_id
      where ($1::uuid is null or m.stock_item_id=$1) and ($2::uuid is null or m.from_location_id=$2 or m.to_location_id=$2) and ($3::text is null or m.movement_type=$3) and ($4::uuid is null or m.case_id=$4) order by m.id desc limit 500`,
    [Q(req).stockItemId ?? null, Q(req).locationId ?? null, Q(req).type ?? null, Q(req).caseId ?? null]));
  r('GET', '/api/ledger/reconcile', 'inventory.view', async (db) => ledgerReconciliation(db));
  r('POST', '/api/movements/:id/reverse', 'count.approve', async (db, ctx, req) => {
    if (!B(req).reason?.trim()) throw new AppError(400, 'reason_required', 'Reason is required');
    const res = await reverseMovement(db, ctx, Number(P(req).id), B(req).reason);
    await audit(db, ctx, 'movement.reverse', 'inventory_movement', String(P(req).id), { reversal_id: res.id }, { reason: B(req).reason });
    return res;
  });
  r('GET', '/api/search', null, async (db, ctx, req) => {
    const qy = String(Q(req).q ?? '').trim();
    if (qy.length < 2) return { cases: [], stock: [], catalog: [] };
    const [scope, sp] = caseScope(ctx, 2);
    const cases = await rows(db, `select c.id, c.case_ref, c.status, c.scheduled_start, f.name facility, f.timezone from cases c join facilities f on f.id=c.facility_id where (c.case_ref ilike $1 or c.procedure ilike '%'||$1||'%') and ${scope} order by c.scheduled_start limit 20`, [qy, ...sp]);
    if (isFacilityUser(ctx)) {
      const stock = await rows(db, `select a.*, s.serial_number, s.lot_number, s.expiry_date, ci.ref, ci.description from (${AVAILABILITY_SQL}) a join stock_items s on s.id=a.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id
         where a.location_facility_id=$2 and (ci.ref ilike $1 or s.serial_number=$1 or s.lot_number=$1 or ci.unit_gtin=$1)`, [qy, ctx.facilityId]);
      return { cases, stock, catalog: [] };
    }
    const catalog = await rows(db, `select id, ref, description, unit_gtin, tracking, item_type from catalog_items where ref ilike $1 or unit_gtin=$1 or description ilike '%'||$1||'%' limit 20`, [qy]);
    const stock = await rows(db, `select a.*, s.serial_number, s.lot_number, s.expiry_date, ci.ref, ci.description from (${AVAILABILITY_SQL}) a join stock_items s on s.id=a.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id
       where ci.ref ilike $1 or s.serial_number=$1 or s.lot_number=$1 or ci.unit_gtin=$1 limit 50`, [qy]);
    return { cases, stock, catalog };
  });

  // ---------------- Exceptions, notifications, audit ----------------
  r('GET', '/api/exceptions', null, async (db, ctx, req) => {
    const fac = isFacilityUser(ctx);
    return rows(db, `select e.*, c.case_ref from exceptions e left join cases c on c.id=e.case_id where ($1::text is null or e.status=$1)
       and ($2::boolean is false or e.facility_id=$3 or c.facility_id=$3) and ($4::text is null or e.owner_role=$4) order by e.status, e.severity desc, e.created_at desc limit 300`,
      [Q(req).status ?? 'open', fac, ctx.facilityId, Q(req).role ?? null]);
  });
  r('POST', '/api/exceptions/:id/resolve', 'exception.resolve', async (db, ctx, req) => {
    const e = await one(db, `select * from exceptions where id=$1`, [P(req).id]);
    if (['discrepancies', 'charges', 'usage_events', 'count_sessions'].includes(e.ref_table) && e.kind !== 'usage_review') throw new AppError(409, 'resolve_at_source', `Resolve this from its source record (${e.ref_table}); it closes automatically`);
    if (e.kind === 'usage_review') throw new AppError(409, 'resolve_at_source', 'Review the usage event to resolve this');
    if (!B(req).resolution?.trim()) throw new AppError(400, 'resolution_required', 'Resolution note required');
    await db.query(`update exceptions set status='resolved', resolved_by=$2, resolved_at=$3, resolution=$4 where id=$1 and status='open'`, [e.id, ctx.userId, nowIso(), B(req).resolution]);
    await audit(db, ctx, 'exception.resolve', 'exception', e.id, {}, { caseId: e.case_id, reason: B(req).resolution });
    return { ok: true };
  });
  r('GET', '/api/notifications', null, async (db, ctx) => rows(db, `select n.*, c.case_ref, i.status issue_status, i.escalation_level from notifications n left join cases c on c.id=n.case_id left join case_issues i on i.id=n.issue_id
     where n.user_id=$1 order by (n.status='active') desc, coalesce(n.last_at, n.created_at) desc limit 150`, [ctx.userId]));
  r('POST', '/api/notifications/read', null, async (db, ctx) => { await db.query(`update notifications set read_at=$2 where user_id=$1 and read_at is null`, [ctx.userId, nowIso()]); return { ok: true }; });
  r('GET', '/api/audit', 'audit.view', async (db, ctx, req) => rows(db, `select a.*, u.display_name actor from audit_log a left join users u on u.id=a.actor_user_id where ($1::uuid is null or a.case_id=$1) order by a.id desc limit 300`, [Q(req).caseId ?? null]));
  r('GET', '/api/usage-review', 'usage.review', async (db) => rows(db, `select ue.*, c.case_ref, ci.ref from usage_events ue join cases c on c.id=ue.case_id left join catalog_items ci on ci.id=ue.catalog_item_id where ue.status='needs_review' order by ue.recorded_at`));

  // ---------------- Integrations (all simulated) ----------------
  r('GET', '/api/integrations', 'integration.view', async (db) => integrationStatus(db));
  r('POST', '/api/integrations/:feedId/simulate-sync', 'integration.manage', async (db, ctx, req) => runSimulatedScheduleSync(db, ctx, P(req).feedId));
  r('POST', '/api/integrations/erp/fail-next', 'integration.manage', async (db, ctx, req) => {
    await db.query(`update integration_feeds set mock_fail_next=$1 where code='erp-mock'`, [Math.min(10, Number(B(req).count ?? 1))]);
    await audit(db, ctx, 'integration.inject_failure', 'integration_feed', 'erp-mock', { count: B(req).count });
    return { ok: true };
  });
  app.post('/api/integrations/erp/run', async (req) => { const ctx = await auth(req); requirePerm(ctx, 'integration.manage'); return processOutboxForTenant(ctx.tenantId); });
  r('POST', '/api/integrations/erp/replay-ack', 'integration.manage', async (db, ctx, req) => {
    const ack = await one(db, `select * from erp_acks where outbox_id=$1 order by received_at limit 1`, [B(req).outboxId]);
    return ingestAck(db, ctx.tenantId, { outboxId: ack.outbox_id, externalDocRef: ack.external_doc_ref, ackType: ack.ack_type, payload: ack.payload });
  });

  // ---------------- Metrics & exports ----------------
  r('GET', '/api/metrics', 'metrics.view', async (db, ctx, req) => computeMetrics(db, Math.min(365, Number(Q(req).days ?? 30))));
  r('GET', '/api/exports/:name', 'export.run', async (db, ctx, req, reply) => {
    const name = P(req).name;
    let head: string[] = []; let data: any[] = [];
    if (name === 'cases.csv') {
      const [scope, sp] = caseScope(ctx, 1);
      // Optional facility filter (code) is intersected with, never substituted for, the caller's scope.
      const facFilter = Q(req).facility ? String(Q(req).facility) : null;
      const fi = sp.length + 1;
      data = await rows(db, `select c.case_ref, f.name facility, c.status, c.scheduled_start, c.procedure, c.surgeon_ref, u.display_name rep from cases c join facilities f on f.id=c.facility_id left join users u on u.id=c.rep_user_id where ${scope} and ($${fi}::text is null or f.code=$${fi}) order by c.scheduled_start`, [...sp, facFilter]);
      head = ['case_ref', 'facility', 'status', 'scheduled_start', 'procedure', 'surgeon_ref', 'rep'];
    } else if (name === 'balances.csv' && !isFacilityUser(ctx)) {
      data = await rows(db, `select ci.ref, s.serial_number, s.lot_number, s.expiry_date, l.code location, p.name owner, b.condition, b.qty from stock_balances b join stock_items s on s.id=b.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join locations l on l.id=b.location_id join parties p on p.id=b.owner_party_id where b.qty>0 order by ci.ref, l.code`);
      head = ['ref', 'serial_number', 'lot_number', 'expiry_date', 'location', 'owner', 'condition', 'qty'];
    } else if (name === 'balances.csv') {
      data = await rows(db, `select ci.ref, s.serial_number, s.lot_number, s.expiry_date, l.code location, p.name owner, b.condition, b.qty from stock_balances b join stock_items s on s.id=b.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id join locations l on l.id=b.location_id join parties p on p.id=b.owner_party_id where b.qty>0 and l.facility_id=$1 order by ci.ref`, [ctx.facilityId]);
      head = ['ref', 'serial_number', 'lot_number', 'expiry_date', 'location', 'owner', 'condition', 'qty'];
    } else if (name === 'ledger.csv' && !isFacilityUser(ctx)) {
      data = await rows(db, `select m.id, m.movement_type, ci.ref, s.serial_number, s.lot_number, m.qty, fl.code from_location, m.from_condition, tl.code to_location, m.to_condition, m.reason, m.occurred_at, m.recorded_at, m.reverses_movement_id, m.import_batch_id from inventory_movements m join stock_items s on s.id=m.stock_item_id join catalog_items ci on ci.id=s.catalog_item_id left join locations fl on fl.id=m.from_location_id left join locations tl on tl.id=m.to_location_id order by m.id`);
      head = ['id', 'movement_type', 'ref', 'serial_number', 'lot_number', 'qty', 'from_location', 'from_condition', 'to_location', 'to_condition', 'reason', 'occurred_at', 'recorded_at', 'reverses_movement_id', 'import_batch_id'];
    } else throw new AppError(404, 'not_found', 'Unknown export');
    await audit(db, ctx, 'export.download', 'export', name, { rows: data.length });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}"`);
    return ['# SYNTHETIC PILOT DATA', head.join(','), ...data.map((d) => head.map((h) => csvCell(d[h] instanceof Date ? d[h].toISOString() : d[h])).join(','))].join('\n') + '\n';
  });

  // ---------------- Static web app ----------------
  const webDir = fileURLToPath(new URL('../../dist/web/', import.meta.url));
  if (existsSync(webDir)) {
    await app.register(fstatic, { root: webDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
      return reply.type('text/html').sendFile('index.html');
    });
  }
  return app;
}
