/**
 * Records the buyer video scene by scene from the running application.
 *
 *   node video/record.mjs main              # reset the demo account, record every main scene
 *   node video/record.mjs preview           # same for the short preview
 *   node video/record.mjs main m4_solution  # re-record one scene: earlier scenes are replayed off camera first
 *
 * Each scene is saved separately under video/takes/<scene>/ (frames + timings) so a take can be replaced.
 * Pacing comes from the narration audio lengths (video/audio/durations.json): run `python tts.py` first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, Scene, sleep, BASE } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUR = JSON.parse(fs.readFileSync(`${HERE}/audio/durations.json`, 'utf8'));
const d = (id) => DUR[id].seconds;
const U = { ops: 'avery.brooks@northline.example', dana: 'dana.whitfield@northline.example', quality: 'mina.castell@northline.example' };
const SLIDE = `${HERE}/slides/slide.html`;
const Q1 = 'Which cases need my attention before 3 today?';
const Q2 = 'Why is this case short if we have five on hand?';
const A = 'section[data-case="NL-3021"]', B = 'section[data-case="NL-3022"]', C = 'section[data-case="NL-3025"]';

async function caseUrl(s, ref) { const r = await s.ctx.request.get(`${BASE}/api/cases`); const c = (await r.json()).find((x) => x.case_ref === ref); return `/cases/${c.id}`; }
const panel = (p) => p.getByRole('dialog', { name: 'Ask operations' });
async function askIn(s, p, q, delay = 34) {
  await s.type(panel(p).getByLabel('Question'), q, delay);
  await sleep(250);
  await s.click(panel(p).getByRole('button', { name: 'Ask', exact: true }));
  await panel(p).getByText('Checking records…').waitFor({ state: 'detached' }).catch(() => {});
  await sleep(500);
}
const toTop = (loc) => loc.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));

const SCENES = {
  // ---------------- main ----------------
  m1_intro: async (s) => {
    const p = await s.open({ file: SLIDE }); await p.evaluate(() => { document.getElementById('sub').textContent = 'Case Logistics'; });
    await s.start();
    await s.beat('m1a', d('m1a'), async () => { await p.evaluate(() => { show('rule'); show('l1', "Tomorrow's surgical schedule is full."); }); await sleep(2600); await p.evaluate(() => show('l2', 'Inventory is spread across the warehouse, hospitals, and sales reps.')); });
    await s.beat('m1b', d('m1b'), async () => { await p.evaluate(() => brand()); });
  },
  m2_board: async (s) => {
    const p = await s.open({ user: U.ops, path: '/tomorrow' }); await p.waitForSelector(A);
    await s.start();
    await s.beat('m2a', d('m2a'), async () => {
      await s.point(p.locator('h1'), 700, 60, 0); await sleep(2600);
      await s.scrollTo(p.locator(C), 420); await sleep(1500); await s.scrollTo(p.locator('section[data-case="NL-3024"]'), 420); await sleep(1300); await s.scrollTop();
    });
    await s.beat('m2b', d('m2b'), async () => { await s.ring(p.locator(`${A} li.issue > div`).first()); await s.point(p.locator(`${A} li.issue .badge`).first(), 700, 40, 6); });
    await s.beat('m2c', d('m2c'), async () => { const o = p.locator(`${A} li.issue div.small`, { hasText: 'Owner:' }).first(); await s.ring(o); await s.point(o, 700, -330, 4); await sleep(2800); await s.point(o, 900, -40, 4); });
    await s.beat('m2d', d('m2d'), async () => { await s.scrollTo(p.locator(B), 150); await s.ring(p.locator(`${B} li.issue`).first()); await s.point(p.locator(`${B} li.issue .badge`).first(), 700, 30, 6); await sleep(4200); await s.point(p.locator(`${B} [data-evidence="courier_scan"]`).first(), 800, -120, 0); });
    await s.beat('m2e', d('m2e'), async () => { await s.scrollTo(p.locator(C), 150); await s.ring(p.locator(`${C} .ok`).first()); await s.point(p.locator(`${C} .badge`).first(), 700, 0, 4); });
  },
  m3_shortage: async (s) => {
    const p = await s.open({ user: U.ops, path: '/tomorrow' }); await p.waitForSelector(A);
    await s.start();
    await s.beat('m3a', d('m3a'), async () => { const t = p.locator(`${A} li.issue > div`).first(); await s.ring(t); await s.point(t, 800, -200, 2); await sleep(1500); await s.point(t, 4200, 380, 2); });
    await s.beat('m3b', d('m3b'), async () => { const ev = p.locator(`${A} ul.ev-list`).first(); await s.ring(ev); await s.point(ev.locator('li').nth(1), 800, -260, 0); await sleep(2200); await s.point(ev.locator('li').nth(3), 700, -330, 0); await sleep(1800); await s.point(ev.locator('li').nth(4), 700, -300, 0); });
    await s.beat('m3c', d('m3c'), async () => { await s.unring(); await s.click(p.locator(`${A} ul.ev-list a`, { hasText: 'row 2 says 4 on hand' })); await p.locator('tr.row-hi').waitFor(); await sleep(500); await s.ring(p.locator('tr.row-hi')); });
  },
  m4_solution: async (s) => {
    const p = await s.open({ user: U.ops, path: '/tomorrow' }); await p.waitForSelector(A);
    await s.start();
    await s.beat('m4a', d('m4a'), async () => {
      await s.click(p.locator(`${A} a`).first()); await p.getByRole('link', { name: 'Run exact-item rescue search' }).first().waitFor(); await sleep(900);
      await s.click(p.getByRole('link', { name: 'Run exact-item rescue search' }).first()); await p.getByText('Eligible sources').waitFor(); await sleep(400);
    });
    const row = p.locator('table').first().locator('tbody tr').first();
    await s.beat('m4b', d('m4b'), async () => {
      await s.scrollTo(p.getByText('Eligible sources'), 120); await s.ring(row);
      await s.point(row.locator('td').nth(2), 700); await sleep(2300); await s.point(row.locator('td').nth(8), 700); await sleep(2300); await s.point(row.locator('td').nth(6), 700); await sleep(2600); await s.point(row.locator('td').nth(5), 700);
    });
    await s.beat('m4c', d('m4c'), async () => { await s.scrollTo(p.getByText('Excluded sources'), 130); const ex = p.locator('table').nth(1).locator('tbody tr').first(); await s.ring(ex); await s.point(ex.locator('td').last(), 800, -60, 0); });
    await s.beat('m4d', d('m4d'), async () => {
      await s.scrollTo(p.getByText('Eligible sources'), 120); await s.click(p.getByRole('button', { name: 'Preview transfer' })); await p.locator('dialog[open]').waitFor(); await s.raise(); await sleep(300);
      await s.ring(p.locator('dialog[open] ul').first()); await s.point(p.locator('dialog[open] ul li').first(), 700, -200, 0);
    });
    await s.beat('m4e', d('m4e'), async () => {
      await s.unring(); await s.click(p.getByRole('button', { name: 'Reserve and create transfer' })); await p.locator('h1', { hasText: 'planned' }).waitFor(); await sleep(500);
      await s.ring(p.locator('h1')); await s.point(p.locator('h1 .badge'), 700, 30, 4); await sleep(2600);
      const line = p.locator('table').first().locator('tbody tr').first(); await s.ring(line); await s.point(line.locator('td').nth(4), 800);
    });
    await s.beat('m4f', d('m4f'), async () => {
      await s.unring(); await s.click(p.getByRole('link', { name: "Tomorrow's cases" })); await p.waitForSelector(`${A} li.issue`); await sleep(500);
      const iss = p.locator(`${A} li.issue`); await s.ring(iss.first()); await s.point(iss.first().locator('div.small', { hasText: 'Owner:' }), 800, -300, 4); await sleep(4300);
      await s.ring(iss.nth(1).locator('> div').first()); await s.point(iss.nth(1).locator('.badge').first(), 800, 30, 6);
    });
  },
  m5_assistant: async (s) => {
    const p = await s.open({ user: U.ops, path: '/tomorrow' }); await p.waitForSelector(A);
    await s.start();
    await s.beat('m5a', d('m5a'), async () => { await s.click(p.getByRole('button', { name: 'Ask operations' })); await panel(p).waitFor(); await sleep(500); await askIn(s, p, Q1); });
    await s.beat('m5b', d('m5b'), async () => {
      const card = panel(p).locator('[data-card="call_list"]'); await toTop(card); await sleep(800);
      const rows = card.locator('table').first().locator('tbody tr'); await s.ring(card.locator('.table-wrap').first());
      for (let i = 0; i < 3; i++) { await s.point(rows.nth(i).locator('td').last(), 800, -40, 0); await sleep(1700); }
      await sleep(1500); await s.point(page_mode(p), 900);
    });
    await s.beat('m5c', d('m5c'), async () => { await s.unring(); const src = panel(p).locator('[data-card="call_list"] .ask-sources a', { hasText: 'Case NL-3021' }).first(); await src.scrollIntoViewIfNeeded(); await sleep(500); await s.ring(panel(p).locator('[data-card="call_list"] .ask-sources')); await sleep(1300); await s.unring(); await s.click(src); await p.getByRole('button', { name: 'Ask about this case' }).waitFor(); await sleep(600); });
    await s.beat('m5d', d('m5d'), async () => { await s.click(p.getByRole('button', { name: 'Ask about this case' })); await panel(p).waitFor(); await sleep(400); await askIn(s, p, Q2); });
    await s.beat('m5e', d('m5e'), async () => { const card = panel(p).locator('[data-card="shortage"]'); await toTop(card); await sleep(700); await s.ring(panel(p).getByTestId('shortage-arith')); await s.point(panel(p).getByTestId('shortage-arith'), 800, 0, 4); });
  },
  m6_rep: async (s) => {
    const p = await s.open({ user: U.dana, phone: true, path: '/today' }); await p.locator('.casecard').first().waitFor();
    const card = p.locator('.casecard', { hasText: 'NL-3018' });
    await s.start();
    await s.beat('m6a', d('m6a'), async () => { await s.ring(card, 4); await sleep(4200); await s.unring(); await s.click(card.getByRole('link', { name: 'Close case' })); await p.getByRole('button', { name: 'Implanted' }).waitFor(); await sleep(700); });
    const sim = p.getByLabel('Scan simulator');
    await s.beat('m6b', d('m6b'), async () => {
      await s.scrollTo(p.getByText('1. What happened to the item?'), 150); await s.click(p.getByRole('button', { name: 'Implanted' })); await sleep(1500);
      await s.scrollTo(p.getByText('2. Scan the labels'), 150); await sleep(600); await s.mark(sim); await sim.selectOption({ label: '00233 lot F4L1' });
      await p.getByTestId('scan-feedback').waitFor(); await sleep(800); await s.ring(p.getByTestId('scan-feedback'), 6);
    });
    await s.beat('m6c', d('m6c'), async () => { await sleep(700); await s.mark(sim); await sim.selectOption({ label: '08810 lot S65B' }); await sleep(900); await s.ring(p.getByTestId('scan-feedback'), 6); });
    await s.beat('m6c2', d('m6c2'), async () => {
      await s.unring(); await s.scrollTo(p.getByText(/Captured for this case/), 140); await sleep(1300);
      const btn = p.getByRole('button', { name: 'Submit closeout' }); await s.scrollTo(btn, 520); await s.click(btn); await p.getByText('Closeout submitted').waitFor(); await sleep(300);
      await s.scrollTo(p.getByText('Closeout submitted'), 330); await s.ring(p.getByText('Closeout submitted'), 6);
    });
  },
  m6_ops: async (s) => {
    const p = await s.open({ user: U.ops }); await p.goto(BASE + await caseUrl(s, 'NL-3018')); await p.locator('h1').waitFor(); await p.waitForLoadState('networkidle');
    await s.start();
    await s.beat('m6d', d('m6d'), async () => {
      await s.ring(p.locator('h1')); await s.point(p.locator('h1 .badge'), 600, 30, 4); await sleep(1300);
      const u = p.getByTestId('recorded-usage'); await s.scrollTo(u, 150); await s.ring(u.locator('.table-wrap')); const r = u.locator('tbody tr').first();
      await s.point(r.locator('td').nth(0), 600); await sleep(500); await s.point(r.locator('td').nth(1), 500); await sleep(600); await s.point(r.locator('td').nth(4), 600); await sleep(600); await s.point(r.locator('td').nth(5), 500);
    });
  },
  m7_recall: async (s) => {
    const p = await s.open({ user: U.quality, path: '/quality' }); await p.getByRole('link', { name: /RCL-001/ }).first().waitFor();
    await s.start();
    await s.beat('m7a', d('m7a'), async () => {
      const row = p.locator('tr', { hasText: 'RCL-001' }).first(); await s.ring(row); await s.point(row, 800, -200, 0); await sleep(4200); await s.unring();
      await s.click(p.getByRole('link', { name: /RCL-001/ }).first()); await p.getByText('Preview of matches').waitFor(); await sleep(500); await s.ring(p.locator('main p.small').first());
    });
    await s.beat('m7b', d('m7b'), async () => {
      const tbl = p.locator('table').first(); await s.scrollTo(p.getByText('Preview of matches'), 130); await s.ring(tbl);
      for (let i = 0; i < 3; i++) { await s.point(tbl.locator('tbody tr').nth(i).locator('td').nth(1), 650); await sleep(950); }
      const oc = p.getByText('Open cases holding affected units'); await s.scrollTo(oc, 140);
      const sib = (h, n) => h.locator(`xpath=following-sibling::div[${n}]`);
      await s.ringAll([oc, sib(oc, 1), sib(oc, 2)]); await s.point(sib(oc, 1), 700, -240, 0); await sleep(2300);
      const cc = p.getByText(/Completed case references/); await s.ringAll([cc, sib(cc, 1)]); await s.point(sib(cc, 1), 700, -240, 0);
    });
    await s.beat('m7c', d('m7c'), async () => {
      await s.unring(); const btn = p.getByRole('button', { name: /Activate recall/ }); await s.scrollTo(btn, 420); await s.click(btn); await p.locator('h1', { hasText: 'active' }).waitFor(); await sleep(400);
      const tasks = p.locator('section.card', { has: p.locator('h2', { hasText: 'Tasks' }) }); await s.scrollTo(tasks, 130); await s.ring(tasks); await s.point(tasks.locator('h2'), 700, 120, 60);
    });
  },
  m7_board: async (s) => {
    const p = await s.open({ user: U.ops, path: '/tomorrow' }); await p.waitForSelector(B);
    await s.start();
    await s.beat('m7d', d('m7d'), async () => {
      await s.scrollTo(p.locator(B), 150); await s.ring(p.locator(`${B} li.issue`).first()); await s.point(p.locator(`${B} li.issue .badge`).first(), 700, 60, 6); await sleep(2600);
      const c23 = 'section[data-case="NL-3023"]'; await s.scrollTo(p.locator(c23), 150); await s.ring(p.locator(`${c23} li.issue`).first()); await s.point(p.locator(`${c23} li.issue .badge`).first(), 700, 60, 6);
    });
  },
  m8_close: async (s) => {
    const p = await s.open({ file: SLIDE }); await p.evaluate(() => { document.getElementById('sub').textContent = 'Case Logistics'; });
    await s.start();
    await s.beat('m8a', d('m8a'), async () => { await p.evaluate(() => { show('rule'); show('l1', "Tomorrow's cases in one place."); }); await sleep(2100); await p.evaluate(() => show('l2', 'The evidence behind every answer.')); await sleep(2000); await p.evaluate(() => show('l3', 'Who needs to act, and by when.')); });
    await s.beat('m8b', d('m8b'), async () => { await p.evaluate(() => { brand(); cta(); }); }, { gap: 1.6 });
  },

  // ---------------- 45-60 second preview ----------------
  p1_intro: async (s) => {
    const p = await s.open({ file: SLIDE }); await p.evaluate(() => { document.getElementById('sub').textContent = 'Case Logistics'; });
    await s.start();
    await s.beat('p1a', d('p1a'), async () => { await p.evaluate(() => { show('rule'); show('l1', "Tomorrow's surgical schedule is full."); }); await sleep(2300); await p.evaluate(() => show('l2', 'Inventory is spread across the warehouse, hospitals, and sales reps.')); await sleep(3900); await p.evaluate(() => brand()); });
  },
  p2_board: async (s) => {
    const p = await s.open({ user: U.ops, path: '/tomorrow' }); await p.waitForSelector(A);
    await s.start();
    await s.beat('p2a', d('p2a'), async () => { await sleep(900); await s.ring(p.locator(`${A} li.issue > div`).first()); await s.point(p.locator(`${A} li.issue .badge`).first(), 700, 40, 6); });
    await s.beat('p2b', d('p2b'), async () => {
      await s.scrollTo(p.locator(B), 150); await s.ring(p.locator(`${B} li.issue`).first()); await s.point(p.locator(`${B} li.issue .badge`).first(), 600, 30, 6); await sleep(900);
      await s.scrollTo(p.locator(C), 150); await s.ring(p.locator(`${C} .ok`).first()); await sleep(700);
      await s.scrollTop(); const o = p.locator(`${A} li.issue div.small`, { hasText: 'Owner:' }).first(); await s.ring(o); await s.point(o, 600, -200, 4);
    });
  },
  p3_assistant: async (s) => {
    const p = await s.open({ user: U.ops, path: '/tomorrow' }); await p.waitForSelector(A);
    await s.click(p.getByRole('button', { name: 'Ask operations' })); await panel(p).waitFor(); await sleep(400);
    await s.start();
    await s.beat('p3a', d('p3a'), async () => { await askIn(s, p, Q1, 20); });
    await s.beat('p3b', d('p3b'), async () => { const card = panel(p).locator('[data-card="call_list"]'); await toTop(card); await sleep(700); await s.ring(card.locator('.table-wrap').first()); const rows = card.locator('table').first().locator('tbody tr'); await s.point(rows.nth(0).locator('td').last(), 700, -40, 0); await sleep(1500); await s.point(rows.nth(1).locator('td').last(), 700, -40, 0); });
  },
  p4_solution: async (s) => {
    const p = await s.open({ user: U.ops }); await p.goto(BASE + await caseUrl(s, 'NL-3021')); await p.getByRole('link', { name: 'Run exact-item rescue search' }).first().click(); await p.getByText('Eligible sources').waitFor(); await p.waitForLoadState('networkidle');
    await p.getByText('Eligible sources').evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 120 })); await sleep(300);
    const row = p.locator('table').first().locator('tbody tr').first();
    await s.start();
    await s.beat('p4a', d('p4a'), async () => { await s.ring(row); await s.point(row.locator('td').nth(2), 700); await sleep(1100); await s.point(row.locator('td').nth(6), 700); });
    await s.beat('p4b', d('p4b'), async () => {
      await s.unring(); await s.click(p.getByRole('button', { name: 'Preview transfer' })); await p.locator('dialog[open]').waitFor(); await s.raise(); await sleep(700);
      await s.click(p.getByRole('button', { name: 'Reserve and create transfer' })); await p.locator('h1', { hasText: 'planned' }).waitFor(); await sleep(400); await s.ring(p.locator('h1')); await s.point(p.locator('h1 .badge'), 700, 30, 4);
    });
  },
  p5_close: async (s) => {
    const p = await s.open({ file: SLIDE }); await p.evaluate(() => { document.getElementById('sub').textContent = 'Case Logistics'; });
    await s.start();
    await s.beat('p5a', d('p5a'), async () => { await p.evaluate(() => { show('rule'); show('l1', 'See what needs attention.'); show('l2', 'Act before the deadline.'); }); await sleep(2900); await p.evaluate(() => { brand(); cta(); }); }, { gap: 1.6 });
  },
};
function page_mode(p) { return panel(p).getByTestId('assistant-mode'); }

const ORDER = { main: ['m1_intro', 'm2_board', 'm3_shortage', 'm4_solution', 'm5_assistant', 'm6_rep', 'm6_ops', 'm7_recall', 'm7_board', 'm8_close'], preview: ['p1_intro', 'p2_board', 'p3_assistant', 'p4_solution', 'p5_close'] };
const MUTATES = new Set(['m4_solution', 'm6_rep', 'm7_recall', 'p4_solution']);

const [set = 'main', ...only] = process.argv.slice(2);
if (!ORDER[set]) { console.error('usage: node record.mjs main|preview [scene ...]'); process.exit(1); }
execSync(`${HERE}/reset.sh`, { stdio: 'inherit' });   // every recording run starts from the same demo account
const browser = await launch();
const last = only.length ? Math.max(...only.map((n) => ORDER[set].indexOf(n))) : ORDER[set].length - 1;
for (const [i, name] of ORDER[set].entries()) {
  if (i > last) break;
  const record = !only.length || only.includes(name);
  if (!record && !MUTATES.has(name)) continue;          // nothing later depends on it
  const s = new Scene(browser, name, `${HERE}/takes`); s.dry = !record;
  try { await SCENES[name](s); const r = await s.stop(); console.log(record ? `recorded ${name}: ${r.duration.toFixed(1)} s, ${r.frames} frames` : `replayed ${name} off camera`); }
  catch (e) { console.error(`FAILED ${name}: ${e.message.split('\n')[0]}`); await s.page?.screenshot({ path: `${HERE}/takes/${name}-error.png` }).catch(() => {}); await s.ctx?.close().catch(() => {}); process.exitCode = 1; break; }
}
await browser.close();
