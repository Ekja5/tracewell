// Walks the reviewer guide exactly as written, as the reviewer sign-in. Usage: REVIEW_USER=... REVIEW_PASS=... node scripts/dev/review-walk.mjs <outDir> [baseUrl]
import { chromium } from 'playwright';
const S = process.argv[2]; const B = process.argv[3] ?? 'http://127.0.0.1:4311';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(B + '/login'); await p.getByLabel('Email or username').fill(process.env.REVIEW_USER); await p.getByLabel('Password').fill(process.env.REVIEW_PASS); await p.getByRole('button', { name: /sign in/i }).click();
await p.waitForURL('**/review'); await p.screenshot({ path: S + '/r0-guide.png', fullPage: true });
await p.getByRole('link', { name: 'Needs attention' }).first().click(); await p.waitForSelector('.q-item');
await p.getByRole('button', { name: '3 PM today' }).click(); await p.waitForTimeout(1200);
await p.getByRole('button', { name: 'Ask operations' }).click(); await p.getByLabel('Question').fill('What do I need to fix before 3 today?'); await p.getByRole('button', { name: 'Ask', exact: true }).click();
await p.waitForSelector('.ask-queue'); await p.waitForTimeout(500); await p.screenshot({ path: S + '/r1-ask.png' });
await p.getByRole('button', { name: /close/i }).first().click();
await p.locator('[data-case="NL-3021"] a', { hasText: 'See the evidence' }).click(); await p.waitForSelector('[data-testid=breakdown]');
for (const k of ['onHand', 'reserved', 'short', 'available']) { await p.locator(`[data-num=${k}]`).first().click(); await p.waitForTimeout(250); }
await p.getByRole('link', { name: 'Request transfer from Chris Okafor' }).first().click(); await p.waitForSelector('dialog[open]');
await p.getByRole('button', { name: 'Reserve & request transfer' }).click(); await p.waitForSelector('[data-testid=transfer][data-status=Requested]');
await p.getByLabel('Decision note').fill('Chris confirmed by phone at 9:05'); await p.getByRole('button', { name: /Accept/ }).click(); await p.waitForSelector('[data-status="Reserved"]');
await p.goto(B + '/attention'); await p.waitForSelector('.q-item');
p.once('dialog', (d) => d.accept()); await p.locator('[data-case="NL-3021"][data-kind=uncovered]').getByRole('button', { name: 'Move 1 from NL-3031' }).click(); await p.getByText('Moved 1 from NL-3031').waitFor();
await p.locator('[data-case="NL-3026"]').getByRole('button', { name: 'Reserve 1 for this case' }).click(); await p.getByText('Reserved 1 unit').waitFor();
await p.locator('[data-case="NL-3026"]').getByRole('button', { name: 'Request 1 from Corvid loaner desk' }).click(); await p.waitForSelector('[data-testid=loaner]'); await p.screenshot({ path: S + '/r2-loaner.png', fullPage: true });
await p.goto(B + '/quality'); await p.getByRole('link', { name: 'RCL-001' }).click(); await p.waitForSelector('[data-testid=recall-summary]');
await p.getByRole('button', { name: 'Activate recall' }).click(); await p.waitForTimeout(1500);
await p.goto(B + '/attention'); await p.waitForSelector('.q-item'); await p.screenshot({ path: S + '/r3-after.png', fullPage: true });
for (const u of ['/allocation', '/stock/par', '/stock/expiring', '/move-in', '/settings/ops', '/tomorrow', '/board']) { await p.goto(B + u); await p.waitForTimeout(1200); if (await p.getByRole('alert').count()) errs.push(u + ': ' + await p.getByRole('alert').first().innerText()); }
console.log('page errors:', errs);
await b.close();
