import { test, expect, Browser, Page, devices } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Ask operations + field quick note through the real UI, desktop and phone.
 * Runs last and starts from a fresh seed (the earlier specs have moved the clock and closed cases).
 * The assistant runs in DEMO MODE here (deterministic; no model call).
 */
test.describe.configure({ mode: 'serial' });
const SHOTS = 'docs/screenshots';

test.beforeAll(async () => {
  execSync('npx tsx src/server/seed/seed.ts', { env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL!, DEMO_DATE: '2026-11-21', DEMO_TIME: '08:00' }, stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 2500)); // server re-reads the demo clock within 2 s
});

async function as(browser: Browser, email: string, opts: any = {}): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext(opts);
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

test('desktop: 3 p.m. call list, shortage arithmetic, transfer draft, and the answer changes after approval', async ({ browser }) => {
  const o = await as(browser, 'ops@lakeshore.example', { viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = o.page;
  await page.getByRole('button', { name: 'Ask operations' }).click();
  await expect(page.getByTestId('assistant-mode')).toContainText('DEMO MODE');
  await panel(page).getByRole('button', { name: /make calls on before 3 today/ }).click();
  const list = panel(page).locator('[data-card="call_list"]');
  await expect(list).toContainText('Calls for tomorrow\'s cases before Sat, Nov 21, 3:00 PM CST');
  await expect(list.locator('tr.unassigned')).toContainText('Unassigned');
  await expect(list.locator('tr.unassigned')).toContainText('TIB4-0205');
  await expect(list).toContainText('Deadline already passed (1)');
  await expect(list.locator('table.passed')).toContainText('SYN-1004');
  await expect(list.locator('tbody tr').first()).toContainText('10:30 AM EST'); // earliest act-by first, facility-local
  await expect(list.locator('.ask-sources a').first()).toHaveAttribute('href', /\/cases\//);
  await page.screenshot({ path: `${SHOTS}/assistant-1-call-list.png` });
  // Unassigned -> draft an assignment, review, confirm.
  await list.getByRole('button', { name: /Draft assignment: SYN-1002/ }).click();
  const ad = panel(page).locator('[data-draft-kind="assign_followup"]');
  await ad.getByLabel('Owner').selectOption({ label: 'Jordan Ames (rep)' });
  await ad.getByTestId('confirm-draft').click();
  await expect(ad).toContainText('assigned to Jordan Ames');
  await panel(page).getByRole('button', { name: 'Close Ask operations' }).click();
  await expect(page.locator('section[data-case="SYN-1002"]')).toBeVisible();

  // Open one case; follow-ups never repeat the case number.
  await page.locator('section[data-case="SYN-1005"]').getByRole('link', { name: 'SYN-1005' }).click();
  await page.getByRole('button', { name: 'Ask about this case' }).click();
  await askQ(page, 'We have five of these patella buttons on hand. Why does this case still show short?');
  await expect(panel(page).getByTestId('shortage-arith')).toHaveText('6 physically on hand, 4 reserved for other cases, 1 on quality hold, 1 available, 2 required, short 1.');
  const sh = panel(page).locator('[data-card="shortage"]');
  await expect(sh.locator('a[data-kind="requirement"]')).toHaveAttribute('href', /\/cases\//);
  await expect(sh.locator('a[data-kind="balance"]')).toHaveAttribute('href', /\/inventory\?q=NP-PAT-32/);
  await expect(sh.locator('a[data-kind="reservation"]')).toHaveCount(2);
  await page.screenshot({ path: `${SHOTS}/assistant-2-shortage.png` });
  await askQ(page, 'Where can I get one more of this exact item before receiving closes?');
  const av = panel(page).locator('[data-card="availability"]');
  await expect(av).toContainText('Best: SN PAT-0005');
  await expect(av).toContainText('SN PAT-0006 at Riley Novak trunk stock');
  await expect(av).toContainText('On quality hold');
  await askQ(page, 'Draft the transfer and give me a text I can send Jordan.');
  const td = panel(page).locator('[data-draft-kind="transfer"]');
  await expect(td).toContainText('NP-PAT-32 (Northpoint Ortho Devices (synthetic)) · SN PAT-0005 · qty 1');
  await expect(td).toContainText('Jordan Ames trunk stock');
  await expect(td).toContainText('St. Brigid Regional Medical Center (synthetic) receiving');
  await expect(td).toContainText('SYN-1005');
  const md = panel(page).locator('[data-draft-kind="message"]');
  await expect(md.locator('textarea')).toHaveValue(/Hi Jordan, please send NP-PAT-32 SN PAT-0005/);
  await md.locator('textarea').fill('Jordan, please bring PAT-0005 to St. Brigid receiving this morning. Thanks, Morgan');
  await md.getByRole('button', { name: 'Copy text' }).click();
  await expect(md.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('bring PAT-0005');
  await expect(md).toContainText('Not sent');
  await td.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/assistant-3-transfer-draft.png` });
  await td.getByTestId('confirm-draft').dblclick(); // repeated taps
  await expect(td).toHaveAttribute('data-draft-status', 'confirmed');
  await expect(td).toContainText('Confirmed through the normal transfer');
  await askQ(page, 'Why does this case still show short?');
  await expect(panel(page).getByTestId('shortage-arith').last()).toHaveText('6 physically on hand, 4 reserved for other cases, 1 on quality hold, 1 already reserved for this case, 0 available, 2 required, short 1.');
  await page.screenshot({ path: `${SHOTS}/assistant-4-after-transfer.png` });
  // Exactly one transfer exists for this unit.
  await panel(page).getByRole('button', { name: 'Close Ask operations' }).click();
  await page.goto('/shipments');
  await expect(page.locator('tr', { hasText: 'SYN-1005' })).toHaveCount(1);

  // Two manufacturers share a catalog number: the panel asks, then keeps the choice.
  await page.goto('/board');
  await page.getByRole('button', { name: 'Ask operations' }).click();
  await askQ(page, 'Where is NP-PAT-32 available?');
  await expect(panel(page).locator('.ask-choices button')).toHaveCount(2);
  await panel(page).locator('.ask-choices button', { hasText: 'Westbrook' }).click();
  await expect(panel(page).locator('[data-card="availability"]').last()).toContainText('SN WB-PAT-01');
  await expect(panel(page).locator('.ask-ctx')).toContainText('NP-PAT-32 (Westbrook Surgical (synthetic))');
  await askQ(page, 'If I move Tray 14 to the urgent case, which other cases would I put at risk?');
  await expect(panel(page).locator('[data-card="impact"]')).toContainText('SYN-1005');
  await expect(panel(page).locator('[data-card="impact"]')).toContainText('AT RISK');
  await askQ(page, 'What changed since I checked SYN-1004 yesterday afternoon?');
  await expect(panel(page).locator('[data-card="history"]')).toContainText('History gap');
  await page.screenshot({ path: `${SHOTS}/assistant-5-impact-history.png` });
  await o.close();
});

test('desktop: when the assistant cannot answer, the user is told and the board keeps working', async ({ browser }) => {
  const o = await as(browser, 'ops@lakeshore.example', { viewport: { width: 1280, height: 900 } });
  const page = o.page;
  await page.route('**/api/assistant/ask', (r) => r.abort());
  await page.getByRole('button', { name: 'Ask operations' }).click();
  await askQ(page, 'Which cases are at risk tomorrow?');
  await expect(panel(page)).toContainText("I can't answer right now");
  await expect(panel(page)).toContainText('The readiness board, Item finder and draft review still work');
  await panel(page).getByRole('button', { name: 'Close Ask operations' }).click();
  await expect(page.locator('section[data-case="SYN-1005"]')).toBeVisible();
  await page.goto('/find');
  await expect(page.locator('h1')).toBeVisible();
  await o.close();
});

test('desktop: a hospital user asking about "the region" only gets their own facility', async ({ browser }) => {
  const h = await as(browser, 'receiving@stbrigid.example', { viewport: { width: 1280, height: 900 } });
  await h.page.getByRole('button', { name: 'Ask operations' }).click();
  await askQ(h.page, 'Which cases in the region are at risk tomorrow?');
  await expect(panel(h.page).locator('[data-card="call_list"]')).toContainText('SYN-1005');
  await expect(panel(h.page)).not.toContainText('Prairie Valley');
  await expect(panel(h.page)).not.toContainText('SYN-1002');
  await h.close();
});

test('phone: rep quick note saved offline, sent once on reconnect, follow-up questions, approved with the original attached', async ({ browser }) => {
  const rep = await as(browser, 'riley.rep@lakeshore.example', { ...devices['iPhone 13'] });
  const page = rep.page;
  await page.goto('/today');
  await page.locator('.casecard', { hasText: 'SYN-1005' }).getByRole('link', { name: 'Handoff note' }).click();
  await expect(page.locator('h1')).toContainText('Handoff note: SYN-1005');
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const note = "Dropped Tray 14 at North receiving at 2:10. Jamie counted 23 pieces. The count sheet says 24. Jamie couldn't identify which one was missing.";
  await page.getByLabel(/What happened/).fill(note);
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByTestId('pending-notes')).toContainText('1 pending');
  await expect(page.getByTestId('pending-notes')).toContainText('Dropped Tray 14 at North receiving');
  await page.screenshot({ path: `${SHOTS}/assistant-6-phone-note-pending.png` });
  await page.reload(); // still pending after a reload while offline
  await expect(page.getByTestId('pending-notes')).toContainText('1 pending');
  await page.context().setOffline(false);
  // A flaky reconnect fires more than once; the note must still arrive exactly once.
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online')); });
  const draft = page.locator('.note-draft');
  await expect(draft).toHaveCount(1, { timeout: 20000 });
  await expect(page.getByTestId('pending-notes')).toHaveCount(0);
  await expect(draft.locator('[data-field="discrepancy"]')).toHaveText('1');
  await expect(draft.locator('[data-field="component"]')).toHaveText('unknown');
  await expect(draft.locator('[data-field="release"]')).toContainText('Unchanged');
  await expect(draft).toContainText("Not this person's authenticated acknowledgment");
  await expect(draft.getByTestId('approve-note')).toBeDisabled(); // questions first
  await draft.getByRole('group', { name: /Which facility is "North receiving"/ }).getByRole('button', { name: /St\. Brigid.*this case/ }).click();
  await draft.getByRole('group', { name: /When was 2:10/ }).getByRole('button', { name: /Fri, Nov 20, 2:10 PM CST/ }).click();
  await expect(draft).toContainText('Fri, Nov 20, 2:10 PM CST');
  await expect(draft.getByLabel('Expected count')).toHaveValue('24');
  await expect(draft.getByLabel('Observed count')).toHaveValue('23');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/assistant-7-phone-note-draft.png`, fullPage: true });
  await draft.getByTestId('approve-note').dblclick();
  await expect(draft).toHaveAttribute('data-note-status', 'approved');
  await draft.locator('summary').click();
  await expect(draft.locator('blockquote')).toHaveText(note);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.reload();
  await expect(page.locator('.note-draft')).toHaveCount(1);
  // The phone can also ask about this case; the panel fits the screen.
  await page.getByRole('link', { name: '← Case' }).click();
  await page.getByRole('button', { name: 'Ask about this case' }).click();
  await askQ(page, 'What is blocking this case?');
  await expect(panel(page).locator('[data-card="readiness"]')).toContainText(/missing|discrepancy|verified/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/assistant-8-phone-ask.png` });
  await rep.close();
});
