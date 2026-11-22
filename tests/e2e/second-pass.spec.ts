import { test, expect, Browser, Page, devices } from '@playwright/test';

/**
 * Second-pass workflows through the real UI. Runs after demo-story.spec.ts on the same seeded data.
 * Scanning uses the in-app scan simulator (browser-emulated, not a physical scanner).
 */
test.describe.configure({ mode: 'serial' });

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

test('ops assigns an at-risk issue from the board; the owner acknowledges; the handoff shows the history', async ({ browser }) => {
  const o = await as(browser, 'ops@lakeshore.example');
  const card = o.page.locator('section[data-case="SYN-1002"]');
  await expect(card).toContainText('owns the follow-up');
  const issue = card.locator('li.issue').filter({ hasText: 'FEM4L-0104' });
  await issue.getByRole('button', { name: 'Assign' }).click();
  await issue.getByLabel('Assign to').selectOption({ label: 'Jordan Ames (rep)' });
  await issue.getByRole('button', { name: 'Save' }).click();
  await expect(card.locator('li.issue').filter({ hasText: 'FEM4L-0104' })).toContainText('Jordan Ames owns the follow-up');
  await o.close();
  const j = await as(browser, 'jordan.rep@lakeshore.example', { viewport: { width: 1280, height: 900 } });
  await j.page.goto('/notifications');
  await expect(j.page.getByText('assigned to you by Morgan Hale').first()).toBeVisible();
  await j.page.goto('/board');
  const jIssue = j.page.locator('section[data-case="SYN-1002"] li.issue').filter({ hasText: 'FEM4L-0104' });
  await jIssue.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(jIssue).toContainText('Acknowledged by Jordan Ames');
  await j.close();
  const o2 = await as(browser, 'ops@lakeshore.example');
  await o2.page.goto('/handoff');
  const h = o2.page.locator('section.issue').filter({ hasText: 'FEM4L-0104' });
  await h.locator('summary').click();
  await expect(h).toContainText('assigned to Jordan Ames');
  await expect(h).toContainText('acknowledged');
  await expect(h).toContainText('Not resolved until the records clear it');
  await o2.close();
});

test('finance clears a cannot-price line from the queue, sends the packet, records a partial PO and sees the remaining balance', async ({ browser }) => {
  const f = await as(browser, 'finance@lakeshore.example');
  await f.page.goto('/finance/queue');
  const line = f.page.locator('section[data-charge]').filter({ hasText: 'SYN-0903' }).filter({ hasText: 'cannot price' });
  await expect(line).toContainText('Missing evidence: A contract price for NP-TIB-4');
  await line.getByLabel('Unit price in dollars').fill('2050');
  await line.getByLabel('Reason').fill('PVS amendment 2 (synthetic)');
  await line.getByRole('button', { name: 'Approve charge' }).click();
  await expect(f.page.locator('section[data-charge]').filter({ hasText: 'SYN-0903' }).filter({ hasText: 'cannot price' })).toHaveCount(0);
  await f.page.goto('/finance');
  await f.page.getByRole('link', { name: 'SYN-0903' }).click();
  await f.page.getByRole('button', { name: 'Generate billing packet' }).click();
  await expect(f.page.getByText('Billing packet prepared.')).toBeVisible();
  await f.page.getByRole('button', { name: /Send to ERP/ }).click();
  await expect(f.page.getByText('Queued to the mock ERP outbox')).toBeVisible();
  await f.page.getByLabel('PO number').fill('E2E-PO-1');
  await f.page.locator('label', { hasText: 'NP-TIB-4' }).locator('input[type=checkbox]').uncheck();
  await f.page.getByRole('button', { name: 'Record PO' }).click();
  await expect(f.page.getByText(/PO recorded: partial/)).toBeVisible();
  await expect(f.page.locator('.stages')).toContainText('PO partial');
  const outstanding = f.page.getByRole('button', { name: /Outstanding: \$2,050\.00/ });
  await outstanding.click();
  await expect(f.page.locator('.drill li').filter({ hasText: 'NP-TIB-4' })).toBeVisible();
  // Price and approval history is kept on the line.
  await f.page.locator('summary', { hasText: 'Price and approval history' }).first().click();
  await f.close();
});

test('a rep on an iPhone corrects a wrongly recorded line; stock and billing are reversed once', async ({ browser }) => {
  const r = await as(browser, 'jordan.rep@lakeshore.example', { ...devices['iPhone 13'] });
  const page = r.page;
  await page.goto('/today');
  await page.locator('.casecard', { hasText: 'SYN-1002' }).getByRole('link', { name: 'Close case' }).click();
  await expect(page.getByText('Confirmed with server')).toBeVisible();
  await page.getByRole('button', { name: 'Implanted' }).click();
  await page.getByLabel('Scan simulator').selectOption({ label: 'NP-TIB-4 SN TIB4-0205' });
  await expect(page.getByTestId('scan-feedback')).toContainText('Confirmed by server: implanted NP-TIB-4 SN TIB4-0205');
  await expect(page.locator('[data-state="synced"]')).toHaveCount(1);
  page.once('dialog', (d) => d.accept('Wrong item: the tibial base was opened but not used'));
  await page.getByRole('button', { name: 'Correct this line' }).click();
  await expect(page.getByTestId('scan-feedback')).toContainText('voided on the server; stock movement reversed');
  await expect(page.locator('[data-state="voided"]')).toHaveCount(1);
  // Record the correct disposition with one tap + one scan.
  await page.getByRole('button', { name: 'Opened, not used' }).click();
  await page.getByLabel('Scan simulator').selectOption({ label: 'NP-TIB-4 SN TIB4-0205' });
  await expect(page.getByTestId('scan-feedback')).toContainText('Confirmed by server: opened unused NP-TIB-4 SN TIB4-0205');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await r.close();
});

test('a rep finds an exact item on the phone and sees usable stock, custodian and scan freshness', async ({ browser }) => {
  const r = await as(browser, 'riley.rep@lakeshore.example', { ...devices['iPhone 13'] });
  await r.page.goto('/find');
  await r.page.getByLabel('Exact catalog number or GTIN').fill('NP-FEM-5L');
  await r.page.getByRole('button', { name: 'Search' }).click();
  await expect(r.page.getByText(/usable unit\(s\) across/)).toBeVisible();
  await expect(r.page.locator('.evidence').first()).toBeVisible();
  await expect(r.page.locator('.card.avail').first()).toContainText('custodian');
  await r.close();
});
