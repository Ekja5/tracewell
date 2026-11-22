import { test, expect, Browser, Page, devices } from '@playwright/test';

/**
 * The ten-minute pilot demo, executed through the real UI. Steps run in order and share database state.
 * Desktop roles use a desktop viewport; the rep's closeout uses an iPhone 13 profile with real offline mode.
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
const caseLink = (p: Page, ref: string) => p.locator(`section[data-case="${ref}"] a`).first();

let xfrUrl = '';
let trayShipUrl = '';
let caseUrl = '';

test('1. Ops sees tomorrow morning case at risk with plain-English blockers', async ({ browser }) => {
  const { page, close } = await as(browser, 'ops@lakeshore.example');
  const row = page.locator('section[data-case="SYN-1001"]');
  await expect(row).toContainText('At risk');
  await expect(row).toContainText('No unit of NP-INS-4-10');
  await expect(row).toContainText('no shipment planned');
  await expect(page.locator('section[data-case="SYN-1002"]')).toContainText('schedule feed (SIMULATED) last synced');
  await caseLink(page, 'SYN-1001').click();
  caseUrl = page.url();
  await close();
});

test('2. Ops runs exact-item rescue: closer units excluded with reasons; reserves trunk unit atomically', async ({ browser }) => {
  const { page, close } = await as(browser, 'ops@lakeshore.example');
  await page.goto(caseUrl);
  await page.getByRole('link', { name: 'Find exact item' }).first().click();
  const excluded = page.locator('table[aria-label="Excluded sources"]');
  await expect(excluded).toContainText('Expires 2026-11-20, before planned use on 2026-11-22');
  await expect(excluded).toContainText('Reserved for case SYN-1003');
  await expect(excluded).toContainText('On quality hold');
  await expect(excluded).toContainText('closer');
  const eligible = page.locator('table[aria-label="Eligible sources"]');
  await expect(eligible).toContainText('INS-0002');
  await expect(eligible).toContainText('Jordan Ames trunk stock');
  await expect(page.getByText('estimates entered for each route').first()).toBeVisible();
  await eligible.getByRole('button', { name: 'Request transfer' }).click();
  await expect(page.locator('dialog')).toContainText('Affected cases');
  await expect(page.locator('dialog')).toContainText('SYN-1001');
  // A transfer is a request with an owner, a pickup plan and a receiver; nothing moves until the holder accepts.
  await expect(page.getByLabel('Who collects it')).toHaveValue('Jordan Ames');
  await page.getByRole('button', { name: 'Reserve & request transfer' }).click();
  await expect(page.locator('h1')).toContainText('TR-0001');
  await expect(page.locator('[data-testid=transfer]')).toHaveAttribute('data-status', 'Requested');
  await expect(page.getByText('Waiting on: Jordan Ames')).toBeVisible();
  await page.getByRole('button', { name: /Accept/ }).click();
  await expect(page.getByRole('alert')).toContainText('Say how they agreed');
  await page.getByLabel('Decision note').fill('Jordan confirmed by phone');
  await page.getByRole('button', { name: /Accept/ }).click();
  await expect(page.locator('[data-testid=transfer]')).toHaveAttribute('data-status', 'Reserved');
  await page.getByRole('link', { name: /XFR-/ }).first().click();
  await expect(page.locator('h1')).toContainText('XFR-');
  xfrUrl = page.url();
  await page.goto(caseUrl);
  await page.getByRole('button', { name: 'Plan delivery for reserved items' }).click();
  await expect(page.getByText('1 delivery shipment(s) planned.')).toBeVisible();
  await expect(page.locator('a[href^="/shipments/"]').filter({ hasText: 'SHP-' })).toHaveCount(1);
  trayShipUrl = await page.locator('a[href^="/shipments/"]').filter({ hasText: 'SHP-' }).first().getAttribute('href') as string;
  await close();
});

test('3. Warehouse picks, packs and dispatches the tray from the cutoff-ordered pick queue; rep dispatches trunk unit', async ({ browser }) => {
  const w = await as(browser, 'warehouse@lakeshore.example');
  await expect(w.page.locator('h1')).toContainText('Pick queue');
  await expect(w.page.locator('table[aria-label="Pick queue"]')).toContainText('SYN-1001');
  await w.page.goto(trayShipUrl);
  await w.page.getByRole('button', { name: 'Pick (verify unit)' }).click();
  await w.page.getByRole('button', { name: 'Pack' }).click();
  await w.page.getByRole('button', { name: 'Dispatch' }).click();
  await expect(w.page.locator('h1')).toContainText('dispatched');
  await w.close();
  const j = await as(browser, 'jordan.rep@lakeshore.example');
  await j.page.goto(xfrUrl);
  await j.page.getByRole('button', { name: 'Pick (verify unit)' }).click();
  await j.page.getByRole('button', { name: 'Dispatch' }).click();
  await expect(j.page.locator('h1')).toContainText('dispatched');
  await j.close();
});

test('4. Courier marks both delivered; the case is still not ready', async ({ browser }) => {
  const c = await as(browser, 'courier@lakeshore.example');
  for (const u of [trayShipUrl, xfrUrl]) {
    await c.page.goto(u);
    await c.page.getByRole('button', { name: 'Mark delivered (courier)' }).click();
    await expect(c.page.getByText('Hospital must still receive and verify')).toBeVisible();
  }
  await c.close();
  const o = await as(browser, 'ops@lakeshore.example');
  const row = o.page.locator('section[data-case="SYN-1001"]');
  await expect(row).toContainText('A courier scan does not make the case ready');
  await expect(row).not.toContainText('Ready');
  await o.close();
});

test('5. Hospital receiving checks in both deliveries and finds the femoral sizer missing', async ({ browser }) => {
  const r = await as(browser, 'receiving@stbrigid.example');
  for (const u of [xfrUrl, trayShipUrl]) {
    await r.page.goto(u);
    await r.page.getByRole('button', { name: 'Record receipt' }).click();
    await expect(r.page.locator('h1')).toContainText('received');
  }
  await r.page.getByRole('link', { name: 'Verify tray contents' }).click();
  await r.page.getByLabel('Actual count for NP-INST-SIZER').fill('0');
  await r.page.getByRole('button', { name: 'Record verification' }).click();
  await expect(r.page.locator('.alert')).toContainText('Femoral sizer');
  await r.page.goto(caseUrl);
  await expect(r.page.locator('h1')).toContainText('Blocked');
  await expect(r.page.getByText('is missing 1 required instrument').first()).toBeVisible();
  await r.close();
});

test('6. The rep cannot record hospital release', async ({ browser }) => {
  const rep = await as(browser, 'riley.rep@lakeshore.example', { viewport: { width: 1280, height: 900 } });
  await rep.page.goto(caseUrl);
  await expect(rep.page.getByText('can only be recorded by authorized personnel')).toBeVisible();
  await expect(rep.page.getByRole('button', { name: 'Record: released for use' })).toHaveCount(0);
  await rep.close();
});

test('7. Ops sends the exact replacement; warehouse ships; receiving re-verifies; SPD records release; case ready', async ({ browser }) => {
  const o = await as(browser, 'ops@lakeshore.example');
  await o.page.goto(caseUrl);
  await o.page.getByRole('button', { name: 'Send exact replacement from warehouse' }).click();
  const msg = o.page.getByText(/Replacement shipment SHP-\d+ created/);
  await expect(msg).toBeVisible();
  const replRef = (await msg.textContent())!.match(/SHP-\d+/)![0];
  const replUrl = await o.page.getByRole('link', { name: replRef }).getAttribute('href') as string;
  await o.close();
  const w = await as(browser, 'warehouse@lakeshore.example');
  await w.page.goto(replUrl);
  await w.page.getByRole('button', { name: 'Pick (verify unit)' }).click();
  await w.page.getByRole('button', { name: 'Dispatch' }).click();
  await expect(w.page.locator('h1')).toContainText('dispatched');
  await w.close();
  const r = await as(browser, 'receiving@stbrigid.example');
  await r.page.goto(replUrl);
  await r.page.getByRole('button', { name: 'Record receipt' }).click();
  await expect(r.page.locator('h1')).toContainText('received');
  await r.page.goto(trayShipUrl);
  await r.page.getByRole('link', { name: 'Verify tray contents' }).click();
  await r.page.getByRole('button', { name: 'Record verification' }).click();
  await expect(r.page.locator('.ok')).toContainText('Verified complete');
  await r.close();
  const s = await as(browser, 'spd@stbrigid.example');
  await s.page.goto(caseUrl);
  await s.page.getByLabel('hospital processing record ref').fill('SBR-LOAD-2211 (synthetic)');
  await s.page.getByRole('button', { name: 'Record: released for use' }).click();
  await expect(s.page.locator('h1')).toContainText('Ready');
  await s.close();
});

test('8. Rep on an iPhone records usage offline, then syncs on reconnect', async ({ browser }) => {
  const rep = await as(browser, 'riley.rep@lakeshore.example', { ...devices['iPhone 13'] });
  const page = rep.page;
  await page.goto('/today');
  await expect(page.locator('h1')).toContainText('My cases');
  const card = page.locator('.casecard', { hasText: 'SYN-1001' });
  await expect(card.getByRole('link', { name: 'Scan' })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Handoff' })).toBeVisible();
  await card.getByRole('link', { name: 'Close case' }).click();
  await expect(page.getByText('Confirmed with server')).toBeVisible();
  await page.context().setOffline(true);
  await page.reload(); // app shell from the service worker, case package from IndexedDB
  await expect(page.getByText('Offline snapshot downloaded')).toBeVisible();
  // Fast scan: choose the disposition once, then scan successive labels; each is saved immediately with feedback.
  await page.getByRole('button', { name: 'Implanted' }).click();
  for (const label of ['NP-INS-4-10 SN INS-0002', 'NP-FEM-4L SN FEM4L-0101', 'NP-TIB-4 SN TIB4-0201']) {
    await page.getByLabel('Scan simulator').selectOption({ label });
    await expect(page.getByTestId('scan-feedback')).toContainText(`Saved on phone (offline): implanted ${label}`);
  }
  // An accidental rescan of a serialized unit is caught on the phone and not saved twice.
  await page.getByLabel('Scan simulator').selectOption({ label: 'NP-FEM-4L SN FEM4L-0101' });
  await expect(page.getByTestId('scan-feedback')).toContainText('Already recorded');
  await expect(page.locator('[data-state="pending"]')).toHaveCount(3);
  // Package-level label requires an explicit unit count; an unsupported HIBCC label is flagged.
  await page.getByLabel('Scan simulator').selectOption({ label: 'HIBCC-format label (unsupported)' });
  await expect(page.getByTestId('parsed')).toContainText('needs reviewed manual entry');
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.locator('[data-state="pending"]')).toHaveCount(3);
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('[data-state="synced"]')).toHaveCount(3, { timeout: 20000 });
  const submit = page.getByRole('button', { name: 'Submit closeout' });
  await expect(submit).toBeEnabled();
  await submit.scrollIntoViewIfNeeded();
  // The page must not be wider than the phone (horizontal overflow makes mobile browsers zoom out).
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await submit.click();
  await expect(page.getByText('Closeout submitted')).toBeVisible();
  await rep.close();
});

test('9. Finance receives one correctly priced bill-and-replace packet and sends it to the simulated ERP', async ({ browser }) => {
  const f = await as(browser, 'finance@lakeshore.example');
  await expect(f.page.locator('table[aria-label="Finance worklist"]')).toContainText('SYN-1001');
  await f.page.getByRole('link', { name: 'SYN-1001' }).click();
  await expect(f.page.locator('td', { hasText: 'St. Brigid Implant Consignment Agreement (synthetic) v3' }).first()).toBeVisible();
  await f.page.getByRole('button', { name: 'Generate billing packet' }).click();
  await expect(f.page.getByRole('button', { name: /Billed \(priced lines\): \$6,780\.00/ })).toBeVisible();
  await expect(f.page.locator('h2', { hasText: 'Packet' })).toContainText('bill and replace');
  const financeUrl = f.page.url();
  await f.page.getByRole('button', { name: /Send to ERP/ }).click();
  await expect(f.page.locator('h2', { hasText: 'Packet' })).toContainText('queued');
  await f.page.goto('/integrations');
  await f.page.getByRole('button', { name: 'Process outbox now' }).click();
  await expect(f.page.locator('table').last()).toContainText('acknowledged');
  await f.page.goto(financeUrl);
  await expect(f.page.locator('h2', { hasText: 'Packet' })).toContainText('erp received simulated');
  await expect(f.page.getByText('never records a packet as paid')).toBeVisible();
  await f.close();
});

test('10. Quality opens a recall on the used lot and traces remaining units and the completed case', async ({ browser }) => {
  const q = await as(browser, 'quality@lakeshore.example');
  await q.page.getByLabel('Device').selectOption({ label: 'NP-INS-4-10: Meridian tibial insert, size 4, 10 mm (Northpoint Ortho Devices (synthetic))' });
  await q.page.getByLabel('Affected lots/serials').fill('L26C014');
  await q.page.getByLabel('Manufacturer notice ref').fill('NP-FSN-2026-11 (synthetic)');
  await q.page.getByLabel('Description').fill('Locking feature out of tolerance (synthetic)');
  await q.page.getByRole('button', { name: 'Create draft recall' }).click();
  await expect(q.page.locator('h1')).toContainText('RCL-001');
  const url = q.page.url();
  await q.close();
  const v = await as(browser, 'quality2@lakeshore.example');
  await v.page.goto(url);
  await v.page.getByPlaceholder('lots / serials').fill('L26C014');
  await v.page.getByRole('button', { name: 'Verify scope' }).click();
  await expect(v.page.locator('h1')).toContainText('verified');
  await expect(v.page.getByText('SYN-1001 at St. Brigid')).toBeVisible();
  await v.page.getByRole('button', { name: /Activate recall/ }).click();
  await expect(v.page.locator('h1')).toContainText('active');
  await expect(v.page.locator('table').first()).toContainText('INS-0001');
  await expect(v.page.locator('table').first()).toContainText('INS-0003');
  await expect(v.page.getByText('completed case trace').first()).toBeVisible();
  await v.close();
});

test('11. A facility user cannot find the other facility case', async ({ browser }) => {
  const r = await as(browser, 'receiving@stbrigid.example');
  await r.page.getByLabel('Exact catalog, lot, serial, GTIN or case search').fill('SYN-1002');
  await r.page.keyboard.press('Enter');
  await expect(r.page.getByText('No visible cases.')).toBeVisible();
  await r.close();
});
