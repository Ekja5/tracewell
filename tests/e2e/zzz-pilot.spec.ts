import { test, expect, Browser, Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * The distributor pilot, from an EMPTY tenant, entirely through the screens.
 *   Part 1 (the day before): load the day-1 workbook, fix held rows, reserve, ship, deliver, receive.
 *   Part 2 (the ten-minute demo): Tomorrow board, the four questions, second workbook, reconcile,
 *           the changed answer, re-upload, pilot review and report.
 * Assistant mode: DEMO (deterministic planner, same tools and database; no model call).
 * Timings are written to docs/pilot/e2e-timings.json. They are machine-paced, not human-paced.
 */
test.describe.configure({ mode: 'serial' });
const SHOTS = 'docs/screenshots'; const TMP = 'test-results/pilot-files';
const U = { coord: 'casey.coordinator@summit.example', ops: 'avery.ops@summit.example', wh: 'warehouse@summit.example', courier: 'courier@summit.example', recvMed: 'receiving@ridgeline-medical.example', recvEast: 'receiving@ridgeline-east.example' };
const QTY = 7; // the buyer types seven instead of six
const timings: Record<string, number> = {}; const shipUrls: Record<string, string> = {};

test.beforeAll(async () => {
  fs.mkdirSync(TMP, { recursive: true }); fs.mkdirSync('docs/pilot', { recursive: true });
  execSync('npx tsx scripts/pilot-reset.ts', { env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL! }, stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 2500));
});
test.afterAll(() => { fs.writeFileSync('docs/pilot/e2e-timings.json', JSON.stringify({ note: 'Playwright, machine-paced, assistant in demo mode', buyerQuantity: QTY, seconds: timings }, null, 2)); });

async function as(browser: Browser, email: string, opts: any = {}): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.click(`button[data-email="${email}"]`);
  await expect(page.locator('header.top')).toBeVisible();
  await page.waitForLoadState('networkidle');
  if (/\/attention$/.test(page.url())) await page.goto('/board'); // managers now land on the work queue; these stories start from the readiness board
  return { page, close: () => ctx.close() };
}
const panel = (page: Page) => page.getByRole('dialog', { name: 'Ask operations' });
async function askQ(page: Page, q: string) {
  await panel(page).getByLabel('Question').fill(q);
  await panel(page).getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(panel(page).getByText('Checking records…')).toHaveCount(0);
}
async function download(page: Page, linkName: string | RegExp, saveAs: string) {
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: linkName }).click()]);
  await d.saveAs(`${TMP}/${saveAs}`); return `${TMP}/${saveAs}`;
}
/** Choose file -> worksheet -> (mapping shown) -> preview -> load. Returns on the run page. */
async function loadSheet(page: Page, path: string, sheet: string, opts: { complete?: boolean } = {}) {
  await page.goto('/uploads');
  await page.getByLabel('Spreadsheet file').setInputFiles(path);
  await page.getByLabel('Worksheet', { exact: true }).selectOption(sheet);
  await expect(page.locator('table[aria-label="Column mapping"]')).toBeVisible();
  if (opts.complete) await page.getByRole('radio', { name: /Stock we hold there/ }).check();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('preview')).toBeVisible();
}
const rowOf = (page: Page, n: number, scope = 'main') => page.locator(`${scope} tr[data-row="${n}"]`).last();

test('Part 1: from an empty account, a coordinator loads the day-1 workbook and the team completes the handoffs', async ({ browser }) => {
  const t0 = Date.now();
  const c = await as(browser, U.coord); const page = c.page;
  await page.goto('/tomorrow');
  await expect(page.getByText('No cases are scheduled for tomorrow')).toBeVisible(); // empty account
  await page.goto('/uploads');
  await expect(page.getByText('Nothing loaded yet')).toBeVisible();
  const day1 = await download(page, 'Day 1 workbook (Excel)', 'summit-day1.xlsx');

  // Inventory: worksheet picked, columns mapped from headings, preview shows how each row is read.
  await loadSheet(page, day1, 'Inventory', { complete: true });
  await expect(page.getByLabel('Column for Catalog number')).toHaveValue('Cat No');
  await expect(page.getByLabel('Column for Quantity on hand')).toHaveValue('Qty On Hand');
  const pv = page.getByTestId('preview');
  await expect(pv.locator('tr[data-row="2"]')).toContainText('Opening balance: 5 units of 00417 lot T10A'); // leading zeros kept
  await expect(pv.locator('tr[data-row="4"]')).toContainText('counts 2 BX, not single units');
  await expect(pv.locator('tr[data-row="5"]')).toContainText('No lot or serial number');
  await expect(pv.locator('tr[data-row="6"]')).toContainText('Same as row 3 in this file; counted once.');
  await page.screenshot({ path: `${SHOTS}/pilot-1-upload-preview.png`, fullPage: true });
  await page.getByRole('button', { name: 'Load this worksheet' }).click();
  await expect(page.locator('h1')).toContainText('summit-day1.xlsx › Inventory');
  await expect(page.locator('button[data-count="accepted"]')).toContainText('2');
  await expect(page.locator('button[data-count="held"]')).toContainText('2');
  await expect(page.locator('button[data-count="skipped"]')).toContainText('1');
  // Box conversion: a person verifies 1 BX = 5 units; the row is re-checked.
  await expect(rowOf(page, 4).getByLabel('Units per BX')).toHaveValue('5');
  await rowOf(page, 4).getByRole('button', { name: 'Verify and re-check' }).click();
  await expect(rowOf(page, 4)).toContainText('2 BX × 5 = 10 units (verified conversion)');
  await expect(rowOf(page, 4)).toHaveAttribute('data-outcome', 'accepted');

  // Schedule: ambiguous hospital name is held with choices; the choice is remembered.
  await loadSheet(page, day1, 'Schedule');
  await page.getByRole('button', { name: 'Load this worksheet' }).click();
  await expect(rowOf(page, 7)).toContainText('"Ridgeline" could mean Ridgeline Medical Center or Ridgeline Surgery Center East');
  await rowOf(page, 7).getByRole('button', { name: 'Ridgeline Medical Center' }).click();
  await expect(rowOf(page, 7)).toHaveAttribute('data-outcome', 'accepted');
  const caseUrl: Record<string, string> = {};
  for (const [n, ref] of [[2, 'SC-24031'], [3, 'SC-24032'], [4, 'SC-24033'], [5, 'SC-24040'], [6, 'SC-24041']] as const) caseUrl[ref] = (await rowOf(page, n).getByRole('link', { name: 'Open case' }).getAttribute('href'))!;

  // Requirements.
  await loadSheet(page, day1, 'Requirements');
  await page.getByRole('button', { name: 'Load this worksheet' }).click();
  await expect(page.locator('button[data-count="accepted"]')).toContainText('6');
  await page.screenshot({ path: `${SHOTS}/pilot-2-run-result.png`, fullPage: true });

  // Reservations: later-week cases take four of the five inserts; tomorrow's B and C get theirs and a delivery.
  for (const ref of ['SC-24040', 'SC-24041', 'SC-24032', 'SC-24033']) {
    await page.goto(caseUrl[ref]);
    await page.getByRole('button', { name: 'Reserve available units' }).click();
    await expect(page.getByText(/Reserved [12] unit\(s\)\./)).toBeVisible();
    if (ref === 'SC-24032' || ref === 'SC-24033') {
      await page.getByRole('button', { name: 'Plan delivery for reserved items' }).click();
      await expect(page.getByText('1 delivery shipment(s) planned.')).toBeVisible();
    }
  }
  await page.goto('/shipments');
  for (const ref of ['SC-24032', 'SC-24033']) shipUrls[ref] = (await page.locator('tr', { hasText: ref }).getByRole('link').first().getAttribute('href'))!;
  await c.close();

  const w = await as(browser, U.wh);
  for (const ref of ['SC-24032', 'SC-24033']) {
    await w.page.goto(shipUrls[ref]);
    await w.page.getByRole('button', { name: /^Pick/ }).first().click();
    await w.page.getByRole('button', { name: 'Pack' }).click();
    await w.page.getByRole('button', { name: 'Dispatch' }).click();
    await expect(w.page.locator('h1')).toContainText('dispatched');
  }
  await w.close();
  const k = await as(browser, U.courier);
  for (const ref of ['SC-24032', 'SC-24033']) { await k.page.goto(shipUrls[ref]); await k.page.getByRole('button', { name: 'Mark delivered (courier)' }).click(); await expect(k.page.getByText('Hospital must still receive and verify')).toBeVisible(); }
  await k.close();
  const h = await as(browser, U.recvMed);
  await h.page.goto(shipUrls['SC-24033']);
  await h.page.getByRole('button', { name: 'Record receipt' }).click();
  await expect(h.page.locator('h1')).toContainText('received');
  await h.close();
  timings.part1_from_empty_setup = Math.round((Date.now() - t0) / 100) / 10;
});

test('Part 2: the ten-minute demo. Board and assistant agree, the buyer changes the answer, the evidence is one click away', async ({ browser }) => {
  const t0 = Date.now();
  const o = await as(browser, U.ops, { deviceScaleFactor: 2 }); let page = o.page;
  await page.goto('/tomorrow');
  const A = page.locator('section[data-case="SC-24031"]'), B = page.locator('section[data-case="SC-24032"]'), C = page.locator('section[data-case="SC-24033"]');
  const SHORT5 = '5 physically on hand, 4 reserved for other cases, 1 available, 2 required, short 1.';
  await expect(A).toHaveAttribute('data-status', 'needs_attention');
  await expect(A).toContainText(`Confirmed shortage: ${SHORT5}`);
  await expect(A).toContainText('7:30 AM CST'); await expect(A).toContainText('Owner: Dana Whitfield');
  await expect(A).toContainText(/Latest time to act: \w+, \w+ \d+, 3:00 PM CST/); // facility-local deadline (receiving closes at 3 PM)
  await expect(A.locator('[data-evidence="spreadsheet_row"]')).toContainText('summit-day1.xlsx › Inventory › row 2 says 5 on hand');
  await expect(A.locator('[data-evidence="reservation"]')).toHaveCount(2);
  await expect(B).toHaveAttribute('data-status', 'in_progress');
  await expect(B).toContainText('Waiting on hospital'); await expect(B).toContainText('10:00 AM EST');
  await expect(B).toContainText('Can resolve: Marcus Hall');
  await expect(B.locator('[data-evidence="courier_scan"]')).toContainText('Lee Tran (courier) recorded');
  await expect(C).toHaveAttribute('data-status', 'ready');
  await expect(C).toContainText('Priya Nair (hospital receiving) checked in');
  await page.screenshot({ path: `${SHOTS}/pilot-3-tomorrow-before.png`, fullPage: true });

  // The manager challenges an answer: the evidence link opens the exact spreadsheet row.
  await A.locator('[data-evidence="spreadsheet_row"] a').click();
  await expect(page.locator('tr.row-hi')).toContainText('Opening balance: 5 units of 00417');
  await page.goBack();

  // The four questions.
  await page.getByRole('button', { name: 'Ask operations' }).click();
  await expect(page.getByTestId('assistant-mode')).toContainText('DEMO MODE');
  await panel(page).getByRole('button', { name: 'Which cases do I need to make calls on before 3 today?' }).click();
  const calls = panel(page).locator('[data-card="call_list"]');
  await expect(calls.locator('tbody tr')).toHaveCount(2);
  await expect(calls.locator('tbody tr').nth(0)).toContainText('SC-24032'); await expect(calls.locator('tbody tr').nth(0)).toContainText('Waiting on hospital');
  await expect(calls.locator('tbody tr').nth(1)).toContainText('SC-24031'); await expect(calls.locator('tbody tr').nth(1)).toContainText('Confirmed shortage');
  await askQ(page, 'The spreadsheet says five are on hand. Why are we short?');
  await expect(panel(page).getByTestId('shortage-arith')).toHaveText(SHORT5);
  const sh = panel(page).locator('[data-card="shortage"]');
  await expect(sh.locator('a[data-kind="spreadsheet_row"]')).toHaveAttribute('href', /\/uploads\/runs\/.+\?row=2/);
  await expect(sh).toContainText('2 reserved for SC-24040 by Casey Lindqvist');
  await askQ(page, 'Which case still needs someone at the hospital to confirm receipt?');
  await expect(panel(page).locator('[data-await="SC-24032"]')).toContainText('Can confirm receipt: Marcus Hall');
  await askQ(page, 'What changed since the previous upload?');
  await expect(panel(page).locator('[data-card="changes"]')).toContainText('Only one inventory file has been loaded');
  await page.screenshot({ path: `${SHOTS}/pilot-4-questions.png` });
  await o.close();
  timings.demo_a_board_and_four_questions = Math.round((Date.now() - t0) / 100) / 10;

  // The buyer's second workbook, with their own number, through the normal screen.
  const t1 = Date.now();
  const c = await as(browser, U.coord, { deviceScaleFactor: 2 }); page = c.page;
  await page.goto('/uploads');
  await page.getByLabel('Sample quantity').fill(String(QTY));
  const day2 = await download(page, 'Download', `summit-day2-${QTY}.xlsx`);
  await loadSheet(page, day2, 'Inventory', { complete: true });
  await expect(page.getByTestId('saved-mapping')).toContainText('Using the column mapping Casey Lindqvist saved'); // yesterday's mapping
  const pv = page.getByTestId('preview');
  await expect(pv.locator('tr[data-row="2"]')).toContainText(`The file says ${QTY}; the system has 5`);
  await expect(pv.locator('tr[data-row="3"]')).toContainText('Recorded movements explain the change');
  await page.getByRole('button', { name: 'Load this worksheet' }).click();
  await expect(rowOf(page, 2)).toContainText('Stock was not changed. Reconcile DISC-0001');
  await page.screenshot({ path: `${SHOTS}/pilot-5-second-upload.png`, fullPage: true });
  // Until someone decides, the board says "missing information", not a new number.
  await page.goto('/tomorrow');
  await expect(page.getByTestId('pending-reconcile')).toContainText('1 spreadsheet difference waiting');
  await expect(page.locator('section[data-case="SC-24031"] li.issue')).toHaveAttribute('data-type', 'missing_information');
  await page.getByRole('link', { name: 'Open Reconcile' }).click();
  const d = page.locator('section[data-disc="DISC-0001"]');
  await expect(d).toContainText(`Spreadsheet says ${QTY} · system had 5 · difference +${QTY - 5}`);
  await expect(d).toContainText('Previous file said 5');
  await d.getByLabel('Cause for DISC-0001').selectOption('receipt');
  await d.getByLabel('Note for DISC-0001').fill('Counted the shelf with Sam; receipt PO-7781 was never keyed.');
  await page.screenshot({ path: `${SHOTS}/pilot-6-reconcile.png`, fullPage: true });
  await d.getByRole('button', { name: `Accept ${QTY} as the current balance` }).click();
  await expect(page.locator('section[data-disc="DISC-0001"]')).toHaveAttribute('data-status', 'resolved');
  await expect(page.locator('section[data-disc="DISC-0001"]')).toContainText(`Casey Lindqvist · accepted the spreadsheet quantity (5 → ${QTY})`);
  await c.close();
  timings.demo_b_second_workbook_and_reconcile = Math.round((Date.now() - t1) / 100) / 10;

  // Board and assistant now agree on the new number; B and C are unchanged.
  const t2 = Date.now();
  const o2 = await as(browser, U.ops, { deviceScaleFactor: 2 }); page = o2.page;
  await page.goto('/tomorrow');
  const NOW = `${QTY} physically on hand, 4 reserved for other cases, ${QTY - 4} available, 2 required, not short.`;
  await expect(page.locator('section[data-case="SC-24031"]')).toContainText(`Enough stock exists but none is reserved yet: ${NOW}`);
  await expect(page.locator('section[data-case="SC-24031"]')).not.toContainText('Confirmed shortage');
  await expect(page.locator('section[data-case="SC-24032"]')).toHaveAttribute('data-status', 'in_progress');
  await expect(page.locator('section[data-case="SC-24033"]')).toHaveAttribute('data-status', 'ready');
  await page.screenshot({ path: `${SHOTS}/pilot-7-tomorrow-after.png`, fullPage: true });
  await page.getByRole('button', { name: 'Ask operations' }).click();
  await askQ(page, 'The spreadsheet says five are on hand. Why are we short?');
  await expect(panel(page).getByTestId('shortage-arith')).toHaveText(NOW);
  await askQ(page, 'What changed since the previous upload?');
  const ch = panel(page).locator('[data-card="changes"]');
  await expect(ch.locator('tr[data-change="00417"]')).toHaveAttribute('data-status', 'accepted');
  await expect(ch.locator('tr[data-change="00417"]')).toContainText(`5 → ${QTY}`);
  await expect(ch.locator('tr[data-change="00417"]')).toContainText(`Casey Lindqvist accepted ${QTY} as the current balance (DISC-0001`);
  await expect(ch).toContainText(`SC-24031`); await expect(ch).toContainText(NOW);
  await expect(ch.locator('.ask-sources a[data-kind="reconciliation"]')).toHaveAttribute('href', '/reconcile?ref=DISC-0001');
  await ch.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/pilot-8-what-changed.png` });
  // The source link in the answer opens the exact row of the second workbook.
  await ch.locator('tr[data-change="00417"] a').first().click();
  await expect(page.locator('tr.row-hi')).toContainText(`Reconciled DISC-0001 by Casey Lindqvist: ${QTY} accepted as the current balance`);
  await o2.close();
  timings.demo_c_changed_answer_and_evidence = Math.round((Date.now() - t2) / 100) / 10;

  // Same workbook again: nothing changes. Then the pilot review and one-page report.
  const t3 = Date.now();
  const c2 = await as(browser, U.coord, { deviceScaleFactor: 2 }); page = c2.page;
  await page.goto('/uploads');
  await page.getByLabel('Spreadsheet file').setInputFiles(day2);
  await expect(page.getByText('Same contents as a file first uploaded')).toBeVisible();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page).toHaveURL(/replayed=1/);
  await expect(page.getByText('Nothing was imported again; this is the original result.')).toBeVisible();
  await page.goto('/tomorrow');
  await expect(page.locator('section[data-case="SC-24031"]')).toContainText(NOW);
  await page.goto('/pilot');
  const rv = (ref: string) => page.locator(`section[data-review="${ref}"]`);
  await rv('SC-24031').getByLabel('Existing process prediction for SC-24031').selectOption('ready');
  await rv('SC-24031').getByRole('button', { name: 'Record', exact: true }).click();
  await expect(rv('SC-24031').getByTestId('app-prediction')).toBeVisible();
  await rv('SC-24032').getByLabel('Existing process prediction for SC-24032').selectOption('ready');
  await rv('SC-24032').getByRole('button', { name: 'Record', exact: true }).click();
  await expect(rv('SC-24032').getByTestId('app-prediction')).toHaveText('Problem expected');
  await rv('SC-24032').getByLabel('Verified problem for SC-24032').selectOption('yes');
  await rv('SC-24032').getByLabel('Verified problem detail').fill('Delivery was sitting on the dock, not checked in');
  await rv('SC-24032').getByLabel('Intervention').fill('Called Marcus; checked in at 1:40 PM');
  await rv('SC-24032').getByLabel('Case outcome for SC-24032').selectOption('on_time');
  await rv('SC-24032').getByRole('button', { name: 'Record outcome' }).click();
  await expect(rv('SC-24032')).toContainText('Recorded');
  await page.getByRole('link', { name: 'One-page report' }).click();
  await expect(page.locator('[data-metric="reviewed"]')).toHaveText('2');
  await expect(page.locator('tr[data-metric="found"] [data-side="app"]')).toHaveText('1');
  await expect(page.locator('tr[data-metric="missed"] [data-side="existing"]')).toHaveText('1');
  await expect(page.locator('tr[data-metric="unknown_outcome"] [data-side="app"]')).toHaveText('1');
  await expect(page.getByText('No savings are reported')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/pilot-9-report.png`, fullPage: true });
  await c2.close();
  timings.demo_d_reupload_review_report = Math.round((Date.now() - t3) / 100) / 10;
  timings.demo_total = Math.round((Date.now() - t0) / 100) / 10;

  // A hospital user sees only their own facility.
  const e = await as(browser, U.recvEast);
  await e.page.goto('/tomorrow');
  await expect(e.page.locator('section[data-case]')).toHaveCount(1);
  await expect(e.page.locator('section[data-case="SC-24032"]')).toBeVisible();
  await expect(e.page.getByRole('link', { name: 'Load files' })).toHaveCount(0);
  await e.close();
});
