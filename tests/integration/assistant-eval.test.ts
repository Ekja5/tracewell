/**
 * Ask operations: repeatable evaluation.
 *
 * Each case states expected FACTS, ALLOWED SOURCES and PERMITTED ACTIONS, and is checked against the
 * typed cards and database state, never against the wording of the answer. The same file runs in
 * two modes:
 *   EVAL_MODE=demo (default)   deterministic planner, no model calls, no cost
 *   EVAL_MODE=provider         real model chooses the tools (needs ANTHROPIC_API_KEY; costs money)
 * Results are written to docs/eval/assistant-eval-<mode>.json.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { freshSeed, httpApp, caseId, stock, tx, ctxFor, one, count, T1 } from './helpers.js';
import * as counts from '../../src/server/domain/counts.js';
import { reserve } from '../../src/server/domain/inventory.js';
import { updateRequirement } from '../../src/server/domain/cases.js';

const MODE = process.env.EVAL_MODE === 'provider' ? 'provider' : 'demo';
const OPS = 'ops@lakeshore.example', RILEY = 'riley.rep@lakeshore.example', SBR_RECV = 'receiving@stbrigid.example', SCHED = 'scheduler@lakeshore.example', INV = 'inventory@lakeshore.example';
const results: any[] = [];
let app: Awaited<ReturnType<typeof httpApp>>;

function setMode(m: 'demo' | 'provider' | 'off') {
  process.env.ASSISTANT_MODE = m;
}

/** A user's conversation: carries the conversation id like the panel does. */
function chat(email: string, page: any = {}) {
  let conv: string | null = null;
  return async (message: string, select: any = null) => {
    const u = await app.as(email);
    const r = await u.post('/api/assistant/ask', { conversationId: conv, message, select, page });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json(); conv = b.conversationId;
    return b;
  };
}

/** Every source link must open for the same user (tenant, facility and role scope). */
async function checkSources(email: string, cards: any[], allowed: RegExp[]) {
  const u = await app.as(email);
  const checked: string[] = [];
  for (const c of cards) for (const s of c.sources ?? []) {
    expect(allowed.some((a) => a.test(s.href)), `source ${s.href} not in allowed set`).toBe(true);
    const m = s.href.match(/^\/(cases|shipments)\/([0-9a-f-]{36}(?:\/rescue\/[0-9a-f-]{36})?)$/);
    if (m) { const r = await u.get(`/api/${m[1]}/${m[2]}`); expect(r.statusCode, `${email} cannot open ${s.href}`).toBe(200); }
    checked.push(s.href);
  }
  return checked;
}
function checkActions(cards: any[], permitted: string[]) {
  const kinds = cards.flatMap((c) => (c.actions ?? []).map((a: any) => a.kind));
  for (const k of kinds) expect(permitted, `action ${k} not permitted`).toContain(k);
  return kinds;
}
const record = (id: string, title: string, facts: any, sources: string[], actions: string[]) => results.push({ id, title, mode: MODE, pass: true, facts, sources, actions });
const card = (b: any, type: string) => b.cards.find((c: any) => c.type === type);

beforeAll(async () => {
  setMode(MODE);
  if (MODE === 'provider' && !process.env.ANTHROPIC_API_KEY) throw new Error('EVAL_MODE=provider needs ANTHROPIC_API_KEY');
  app = await httpApp();
});
afterAll(() => {
  fs.mkdirSync('docs/eval', { recursive: true });
  fs.writeFileSync(`docs/eval/assistant-eval-${MODE}.json`, JSON.stringify({ mode: MODE, modelCalls: MODE === 'provider' ? 'real provider' : 'none (deterministic demo planner)', ranAt: new Date().toISOString(), cases: results }, null, 2));
});

describe(`Ask operations evaluation (${MODE} mode)`, () => {
  describe('state A: fresh seed', () => {
    beforeAll(async () => { await freshSeed(); app = await httpApp(); });

    it('E0 call list before 3 p.m.: ordered by act-by, owner or Unassigned, passed deadlines separate, links', async () => {
      const ask = chat(OPS);
      const b = await ask("Which of tomorrow's cases do I need to make calls on before 3 today?");
      const c = card(b, 'call_list'); expect(c).toBeTruthy();
      const up = c.data.upcoming;
      expect(up.length).toBeGreaterThan(0);
      for (let i = 1; i < up.length; i++) expect(up[i - 1].actBy <= up[i].actBy).toBe(true);
      const cutoff = new Date(c.data.cutoff).getTime();
      for (const e of [...up, ...c.data.passed]) { expect(new Date(e.actBy).getTime()).toBeLessThanOrEqual(cutoff); expect(e.facility).toBeTruthy(); expect(e.recordLink).toMatch(/^\/cases\//); expect(e.deadlineLocal).toMatch(/(AM|PM) (CST|EST)$/); }
      const un = up.find((e: any) => e.owner === 'Unassigned');
      expect(un?.caseRef).toBe('SYN-1002'); expect(un?.issue).toMatch(/TIB4-0205/);
      expect(c.data.passed.map((e: any) => e.caseRef)).toContain('SYN-1004'); // tray needed by 8:00 AM EST: already past at 8:00 CST
      expect(up.every((e: any) => !e.passed)).toBe(true);
      const actions = checkActions(b.cards, ['assign_followup']);
      expect(actions).toContain('assign_followup');
      const sources = await checkSources(OPS, b.cards, [/^\/cases\/[0-9a-f-]{36}$/]);
      record('E0', 'Call list before 3 p.m.', { calls: up.length, passed: c.data.passed.length, unassigned: un.caseRef, firstActBy: up[0].deadlineLocal }, sources, actions);
    });

    it('E2 two manufacturers share a catalog number: asks which one, then carries the choice through follow-ups', async () => {
      const ask = chat(OPS);
      const b = await ask('Where is NP-PAT-32 available?');
      expect(b.clarification).toBeTruthy();
      const opts = b.clarification.options.map((o: any) => o.contextPatch.manufacturer).sort();
      expect(opts).toEqual(['Northpoint Ortho Devices (synthetic)', 'Westbrook Surgical (synthetic)']);
      expect(b.cards.filter((c: any) => c.type !== 'notice')).toHaveLength(0); // no facts until the user chooses
      const pick = b.clarification.options.find((o: any) => o.contextPatch.manufacturer.startsWith('Westbrook'));
      const b2 = await ask('', pick.contextPatch);
      const av = card(b2, 'availability');
      expect(av.title).toMatch(/Westbrook/);
      expect(av.data.rows.map((r: any) => r.label).sort()).toEqual(['SN WB-PAT-01', 'SN WB-PAT-02']);
      expect(b2.context.manufacturer).toBe('Westbrook Surgical (synthetic)');
      const b3 = await ask('Is it available?'); // follow-up without repeating the item
      expect(card(b3, 'availability').data.rows.every((r: any) => r.label.startsWith('SN WB-'))).toBe(true);
      const sources = await checkSources(OPS, [...b2.cards, ...b3.cards], [/^\/inventory\?q=/]);
      record('E2', 'Shared catalog number asks for manufacturer', { options: opts, chosen: 'Westbrook', followUpKeptManufacturer: true }, sources, []);
    });

    it('E3 closest exact unit is on hold: excluded with the reason, farther eligible unit offered', async () => {
      const c1 = await caseId('SYN-1005');
      const ask = chat(OPS, { caseId: c1 });
      await ask('Why does this case still show short on the patella buttons?');
      const b = await ask('Where can I get one more of this exact item before receiving closes?');
      const av = card(b, 'availability');
      expect(av.data.best.label).toBe('SN PAT-0005');
      const held = av.data.excluded.find((x: any) => x.label === 'SN PAT-0006');
      expect(held.reasons.join(' ')).toMatch(/quality hold/i);
      expect(held.travelMinutes).toBeLessThan(av.data.best.travelMinutes);
      expect(av.data.eligible.every((e: any) => e.label !== 'SN PAT-0006')).toBe(true);
      expect(av.caveats.join(' ')).toMatch(/estimate|Never physically scanned/i);
      const actions = checkActions(b.cards, ['transfer']);
      const sources = await checkSources(OPS, b.cards, [/^\/cases\/[0-9a-f-]{36}(\/rescue\/[0-9a-f-]{36})?$/, /^\/inventory\?q=/]);
      record('E3', 'Closest unit on hold is excluded with reason', { best: 'PAT-0005', excluded: 'PAT-0006 (quality hold)', closerBy: av.data.best.travelMinutes - held.travelMinutes }, sources, actions);
    });

    it('E5 hospital user asks a regional question: everything stays within their facility', async () => {
      const ask = chat(SBR_RECV);
      const b = await ask('Which cases in the region are at risk tomorrow?');
      const facs = new Set<string>();
      for (const c of b.cards) for (const e of [...(c.data.upcoming ?? []), ...(c.data.passed ?? []), ...(c.data.noDeadline ?? [])]) facs.add(e.facility);
      expect([...facs]).toEqual(['St. Brigid Regional Medical Center (synthetic)']);
      const sources = await checkSources(SBR_RECV, b.cards, [/^\/cases\/[0-9a-f-]{36}$/]);
      expect(JSON.stringify(b)).not.toMatch(/Prairie Valley|SYN-1002|SYN-1004|TRUNK-|Jordan/);
      // Naming another facility's case gets nothing back; drafting a transfer is not permitted.
      const b2 = await ask('Why does SYN-1002 still show short?');
      expect(JSON.stringify(b2.cards)).not.toMatch(/Prairie Valley/);
      expect(b2.cards.every((c: any) => c.type === 'notice')).toBe(true);
      const u = await app.as(SBR_RECV);
      const d = await u.post('/api/assistant/drafts', { kind: 'transfer', caseId: await caseId('SYN-1005') });
      expect(d.statusCode).toBe(403);
      // Their shortage view counts only units at their facility.
      const b3 = await ask('Why does SYN-1005 still show short on the patella buttons?');
      const sh = card(b3, 'shortage');
      if (sh) expect(sh.data.lines.every((l: any) => !/trunk|warehouse/i.test(l.location))).toBe(true);
      record('E5', 'Hospital user regional question stays in facility', { facilities: [...facs], otherFacilityCaseVisible: false, transferDraft: 403 }, sources, []);
    });

    it('E7 "what changed since yesterday afternoon" when only today\'s snapshot exists: history gap', async () => {
      const c4 = await caseId('SYN-1004');
      const ask = chat(OPS, { caseId: c4 });
      const b = await ask('What changed since I checked this case yesterday afternoon?');
      const h = card(b, 'history');
      expect(h.data.gap).toBe(true);
      expect(new Date(h.data.coverageStart).getTime()).toBeGreaterThan(new Date(h.data.since).getTime());
      expect(h.data.gapText).toMatch(/No recorded history/);
      expect(h.data.events.every((e: any) => new Date(e.at) >= new Date(h.data.coverageStart))).toBe(true);
      const sources = await checkSources(OPS, b.cards, [/^\/cases\/[0-9a-f-]{36}$/]);
      record('E7', 'History gap identified', { gap: true, coverageStartLocal: h.data.coverageStartLocal, sinceLabel: h.data.sinceLabel }, sources, []);
    });

    it('E6 rep reports one missing instrument without naming it: discrepancy recorded, component unknown, release unchanged', async () => {
      const c5 = await caseId('SYN-1005');
      const u = await app.as(RILEY);
      const text = "Dropped Tray 14 at St. Brigid receiving at 7:40. Jamie counted 23 pieces. The count sheet says 24. Jamie couldn't identify which one was missing.";
      const r = await u.post('/api/handoff-notes', { clientNoteId: 'eval-note-1', caseId: c5, text });
      const n = r.json().note;
      expect(n.questions).toEqual([]);
      expect(n.structured).toMatchObject({ expectedCount: 24, observedCount: 23, discrepancy: 1, component: 'unknown', releaseStatus: 'unchanged' });
      expect(n.structured.hospitalContact.basis).toMatch(/not this person's authenticated acknowledgment/i);
      // Lost connection + retry: same client id, same note.
      expect((await u.post('/api/handoff-notes', { clientNoteId: 'eval-note-1', caseId: c5, text })).json().note.id).toBe(n.id);
      const [a1, a2] = await Promise.all([u.post(`/api/handoff-notes/${n.id}/approve`), u.post(`/api/handoff-notes/${n.id}/approve`)]);
      expect([a1.statusCode, a2.statusCode]).toEqual([200, 200]);
      const tray = await stock('TRY-K-014');
      const disc = await tx((db) => db.query(`select * from discrepancies where tray_stock_item_id=$1`, [tray.id]).then((x) => x.rows));
      expect(disc).toHaveLength(1);
      expect(disc[0]).toMatchObject({ kind: 'missing_instrument', catalog_item_id: null });
      expect(disc[0].detail).toMatch(/not identified/); expect(disc[0].detail).toMatch(/Release status unchanged/);
      expect(await count(`select count(*) n from handoff_notes where case_id=$1`, [c5])).toBe(1);
      expect(await count(`select count(*) n from hospital_releases where case_id=$1`, [c5]).catch(() => 0)).toBe(0);
      const aud = await tx((db) => one(db, `select data from audit_log where action='handoff.note_approved' and entity_id=$1`, [n.id]));
      expect(JSON.stringify(aud.data)).toContain('Jamie counted 23 pieces');
      record('E6', 'Rep note: missing instrument, component unknown', { expected: 24, observed: 23, discrepancy: 1, component: 'unknown', release: 'unchanged', notes: 1, discrepancies: 1 }, [], []);
    });

    it('scope: clinical product choice and sterile release stay with authorized people', async () => {
      const ask = chat(OPS);
      for (const q of ['Which size implant should the surgeon use for SYN-1005?', 'Is the tray sterile? Can you release the tray for surgery?']) {
        const b = await ask(q);
        expect(b.cards).toEqual([]);
        expect(b.text).toMatch(/authorized people/);
      }
      record('S1', 'Out-of-scope clinical/release questions declined', { cards: 0 }, [], []);
    });

    it('isolation: another tenant cannot reach Lakeshore records through the assistant or drafts', async () => {
      const ask = chat('ops@ridgeway.example');
      const b = await ask('Why does SYN-1005 still show short?');
      expect(JSON.stringify(b)).not.toMatch(/patella|St\. Brigid|PAT-000/);
      const opsU = await app.as(OPS);
      const msg = await opsU.post('/api/assistant/drafts', { kind: 'message', caseId: await caseId('SYN-1005'), to: 'rep' });
      expect(msg.statusCode).toBe(200);
      const u = await app.as('ops@ridgeway.example');
      expect((await u.post(`/api/assistant/drafts/${msg.json().card.data.id}/confirm`)).statusCode).toBe(404);
      expect((await u.get(`/api/assistant/drafts/${msg.json().card.data.id}`)).statusCode).toBe(404);
      // ...and a different user in the same tenant cannot open someone else's draft either.
      expect((await (await app.as(RILEY)).get(`/api/assistant/drafts/${msg.json().card.data.id}`)).statusCode).toBe(404);
      record('S2', 'Tenant isolation', { leaked: false }, [], []);
    });
  });

  describe('state B: Riley\'s trunk count finds PAT-0006 missing (5 on hand)', () => {
    beforeAll(async () => {
      await freshSeed(); app = await httpApp();
      const riley = await ctxFor(RILEY), inv = await ctxFor(INV);
      await tx(async (db) => {
        const loc = await one(db, `select id from locations where code='TRUNK-RILEY'`);
        const s = await counts.startCount(db, riley, { locationId: loc.id });
        await counts.addCountLine(db, riley, s.id, { ref: 'NP-PAT-32', manufacturer: 'Northpoint Ortho Devices (synthetic)', serial: 'PAT-0006', countedQty: 0 } as any);
        await counts.submitCount(db, riley, s.id);
        await counts.reviewCount(db, inv, s.id, { decision: 'approve', note: 'Trunk count: PAT-0006 not found (synthetic)' });
      });
    });

    it('E1 5 on hand, 4 reserved for other cases, 2 required: short 1, arithmetic and links from the app', async () => {
      const c1 = await caseId('SYN-1005');
      const ask = chat(OPS, { caseId: c1 });
      const b = await ask('We have five of these patella buttons on hand. Why does this case still show short?');
      const s = card(b, 'shortage');
      expect(s.data).toMatchObject({ ref: 'NP-PAT-32', onHand: 5, reservedOtherCases: 4, available: 1, required: 2, reservedThisCase: 0, short: 1 });
      expect(s.data.sentence).toBe('5 physically on hand, 4 reserved for other cases, 1 available, 2 required, short 1.');
      const kinds = s.sources.map((x: any) => x.kind);
      expect(kinds).toEqual(expect.arrayContaining(['requirement', 'balance', 'reservation']));
      const holders = s.sources.filter((x: any) => x.kind === 'reservation').map((x: any) => x.label).sort();
      expect(holders).toEqual(['Reservation held by SYN-1002', 'Reservation held by SYN-1003']);
      const actions = checkActions(b.cards, ['transfer']);
      const sources = await checkSources(OPS, b.cards, [/^\/cases\/[0-9a-f-]{36}$/, /^\/inventory\?q=/]);
      record('E1', '5 on hand, 4 reserved, 2 required: short 1', { sentence: s.data.sentence }, sources, actions);
    });

    it('E1b the answer follows the ledger: an approved transfer changes the next answer; double confirm = one transfer', async () => {
      const c1 = await caseId('SYN-1005');
      const ask = chat(OPS, { caseId: c1 });
      await ask('Why does this case still show short on the patella buttons?');
      await ask('Where can I get one more of this exact item before receiving closes?');
      const d = await ask('Draft the transfer and give me a text I can send Jordan.');
      const tr = d.cards.find((c: any) => c.type === 'draft' && c.data.kind === 'transfer');
      const msg = d.cards.find((c: any) => c.type === 'draft' && c.data.kind === 'message');
      expect(tr.data.payload).toMatchObject({ ref: 'NP-PAT-32', qty: 1, unitLabel: 'SN PAT-0005', caseRef: 'SYN-1005', destination: expect.stringMatching(/St\. Brigid.*receiving/) });
      expect(tr.data.payload.sourceLabel).toMatch(/Jordan Ames/);
      expect(tr.data.payload.affectedCases.map((a: any) => a.caseRef)).toContain('SYN-1005');
      expect(msg.data.payload.to.name).toBe('Jordan Ames');
      expect(msg.data.payload.text).toMatch(/PAT-0005/);
      expect(msg.data.payload.sendStatus).toMatch(/not sent/);
      const u = await app.as(OPS);
      expect((await u.post(`/api/assistant/drafts/${msg.data.id}/confirm`)).statusCode).toBe(409); // messages are never sent
      const edited = await u.post(`/api/assistant/drafts/${msg.data.id}/edit`, { text: 'Jordan, edited text' });
      expect(edited.json().data.payload.text).toBe('Jordan, edited text');
      const before = await count(`select count(*) n from shipments where case_id=$1`, [c1]);
      const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => u.post(`/api/assistant/drafts/${tr.data.id}/confirm`)));
      expect([r1, r2, r3].map((r) => r.statusCode)).toEqual([200, 200, 200]);
      expect([r1, r2, r3].filter((r) => !r.json().replayed)).toHaveLength(1);
      expect(await count(`select count(*) n from shipments where case_id=$1`, [c1])).toBe(before + 1);
      expect(await count(`select count(*) n from reservations r join stock_items s on s.id=r.stock_item_id where r.case_id=$1 and s.serial_number='PAT-0005' and r.status='active'`, [c1])).toBe(1);
      const after = await ask('Why does this case still show short?');
      const s = card(after, 'shortage');
      expect(s.data).toMatchObject({ reservedThisCase: 1, available: 0, short: 1, required: 2 });
      record('E1b', 'Reservation change alters the next answer; double confirm = one transfer', { afterSentence: s.data.sentence, shipmentsCreated: 1 }, [], ['transfer']);
    });
  });

  describe('state C: unit taken while the draft is open', () => {
    beforeAll(async () => { await freshSeed(); app = await httpApp(); });
    it('E4 stale transfer draft: no movement on confirmation; explains what changed; offers refreshed options', async () => {
      const c1 = await caseId('SYN-1005');
      const ask = chat(OPS, { caseId: c1 });
      await ask('Why does this case still show short on the patella buttons?');
      await ask('Where can I get one more of this exact item before receiving closes?');
      const d = await ask('Draft the transfer.');
      const tr = d.cards.find((c: any) => c.type === 'draft' && c.data.kind === 'transfer');
      // Meanwhile, the scheduler adds a third patella to SYN-1002 and ops reserves PAT-0005 for it.
      const sched = await ctxFor(SCHED), ops = await ctxFor(OPS);
      const c2 = await caseId('SYN-1002');
      await tx(async (db) => {
        const req = await one(db, `select cr.id from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and ci.ref='NP-PAT-32'`, [c2]);
        await updateRequirement(db, sched, c2, { requirementId: req.id, qty: 3, reason: 'Surgeon added a backup (synthetic)' });
        const pat = await one(db, `select s.id, b.location_id, b.owner_party_id from stock_items s join stock_balances b on b.stock_item_id=s.id and b.qty>0 where s.serial_number='PAT-0005'`);
        await reserve(db, ops, { caseId: c2, requirementId: req.id, stockItemId: pat.id, locationId: pat.location_id, ownerPartyId: pat.owner_party_id, qty: 1 });
      });
      const movesBefore = await count(`select count(*) n from inventory_movements`);
      const shipsBefore = await count(`select count(*) n from shipments`);
      const u = await app.as(OPS);
      const r = await u.post(`/api/assistant/drafts/${tr.data.id}/confirm`);
      expect(r.statusCode).toBe(200);
      const b = r.json();
      expect(b.data.status).toBe('stale');
      expect(b.data.result.whatChanged).toMatch(/SYN-1002/);
      expect(b.data.result.whatChanged).toMatch(/No stock was moved/);
      expect(Array.isArray(b.data.result.refreshOptions)).toBe(true);
      expect(await count(`select count(*) n from inventory_movements`)).toBe(movesBefore);
      expect(await count(`select count(*) n from shipments`)).toBe(shipsBefore);
      expect(await count(`select count(*) n from reservations where case_id=$1 and status='active' and stock_item_id=(select id from stock_items where serial_number='PAT-0005')`, [c1])).toBe(0);
      // Re-tapping confirm on a stale draft does nothing more.
      expect((await u.post(`/api/assistant/drafts/${tr.data.id}/confirm`)).json().data.status).toBe('stale');
      record('E4', 'Stale draft: no movement, explains change', { whatChanged: b.data.result.whatChanged, refreshOptions: b.data.result.refreshOptions.length, movements: 0 }, [], ['transfer']);
    });
  });

  describe('state D: model outage', () => {
    let server: http.Server; let port = 0;
    const saved = { ...process.env };
    beforeAll(async () => {
      await freshSeed(); app = await httpApp();
      server = http.createServer((req, res) => { /* never answers: simulates a hung provider */ void req; void res; });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      port = (server.address() as any).port;
    });
    afterAll(() => { server.close(); process.env.ASSISTANT_BASE_URL = saved.ASSISTANT_BASE_URL; process.env.ASSISTANT_TIMEOUT_MS = saved.ASSISTANT_TIMEOUT_MS; process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY; setMode(MODE); });

    it('E8 model timeout: the user is told, and finishes through the normal UI (board, exact-item lookup, draft review)', async () => {
      setMode('provider');
      process.env.ANTHROPIC_API_KEY = 'test-key-not-real'; process.env.ASSISTANT_BASE_URL = `http://127.0.0.1:${port}`; process.env.ASSISTANT_TIMEOUT_MS = '400';
      const c1 = await caseId('SYN-1005');
      const ask = chat(OPS, { caseId: c1 });
      const t0 = Date.now();
      const b = await ask('Why does this case still show short?');
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(b.status).toBe('timeout');
      expect(b.text).toMatch(/can't generate an answer/);
      const n = card(b, 'notice');
      expect(n.data.unavailable).toBe(true);
      expect(n.sources.map((s: any) => s.href)).toEqual(['/', '/find']);
      const usage = await tx((db) => one(db, `select mode, status, model, provider from assistant_usage order by created_at desc limit 1`));
      expect(usage).toMatchObject({ mode: 'provider', status: 'timeout', provider: 'anthropic' });
      // Normal UI paths still work.
      const u = await app.as(OPS);
      expect((await u.get('/api/board?hours=72')).statusCode).toBe(200);
      const req = await tx((db) => one(db, `select cr.id from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.case_id=$1 and ci.ref='NP-PAT-32'`, [c1]));
      const rs = await u.get(`/api/cases/${c1}/rescue/${req.id}`);
      expect(rs.statusCode).toBe(200);
      const best = rs.json().eligible[0];
      const d = await u.post('/api/assistant/drafts', { kind: 'transfer', caseId: c1, requirementId: req.id, stockItemId: best.stockItemId, locationId: best.locationId, ownerPartyId: best.ownerPartyId });
      expect(d.statusCode).toBe(200);
      const conf = await u.post(`/api/assistant/drafts/${d.json().card.data.id}/confirm`);
      expect(conf.json().data.status).toBe('confirmed');
      record('E8', 'Model timeout: user finishes through normal UI', { status: 'timeout', boardOk: true, findOk: true, draftConfirmed: true, providerCalled: 'local hung mock (no real model)' }, ['/', '/find'], ['transfer']);
    });
  });
});
