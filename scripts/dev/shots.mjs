import { chromium } from 'playwright';
const S = process.argv[2]; const B = 'http://127.0.0.1:3210';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(B + '/login'); await p.getByLabel('Email or username').fill('avery.brooks@northline.example'); await p.getByLabel('Password').fill('Pilot-Demo-2026!'); await p.getByRole('button', { name: /sign in/i }).click();
await p.waitForURL('**/attention'); await p.waitForSelector('.q-item'); await p.screenshot({ path: S + '/1-attention.png', fullPage: true });
await p.getByRole('button', { name: '3 PM today' }).click(); await p.waitForTimeout(1500); await p.screenshot({ path: S + '/2-by3.png', fullPage: true });
// evidence
await p.locator('[data-case="NL-3021"] a', { hasText: 'See the evidence' }).click(); await p.waitForSelector('[data-testid=breakdown]'); await p.waitForTimeout(500);
await p.locator('[data-num=reserved]').first().click(); await p.waitForTimeout(300); await p.screenshot({ path: S + '/3-evidence-reserved.png', fullPage: true });
await p.locator('[data-num=short]').first().click(); await p.waitForTimeout(300); await p.locator('[data-testid=breakdown]').first().screenshot({ path: S + '/4-evidence-short.png' });
await p.locator('[data-num=available]').first().click(); await p.waitForTimeout(300);
await p.getByRole('link', { name: /Request transfer from Chris/ }).first().click(); await p.waitForSelector('dialog[open]'); await p.waitForTimeout(500); await p.screenshot({ path: S + '/5-request.png' });
await p.getByRole('button', { name: 'Reserve & request transfer' }).click(); await p.waitForURL('**/transfers/**'); await p.waitForSelector('[data-testid=transfer]'); await p.screenshot({ path: S + '/6-transfer.png', fullPage: true });
await p.getByLabel('Decision note').fill('Chris confirmed by phone at 9:05'); await p.getByRole('button', { name: /Accept/ }).click(); await p.waitForSelector('[data-status="Reserved"]'); await p.screenshot({ path: S + '/7-accepted.png', fullPage: true });
await p.goto(B + '/attention'); await p.waitForSelector('.q-item'); 
await p.locator('[data-case="NL-3026"]').getByRole('button', { name: /Request 1 from Corvid/ }).click(); await p.waitForURL('**/loaners/**'); await p.waitForSelector('[data-testid=loaner]'); await p.screenshot({ path: S + '/8-loaner.png', fullPage: true });
await p.goto(B + '/quality'); await p.getByRole('link', { name: 'RCL-001' }).click(); await p.waitForSelector('[data-testid=recall-summary]'); await p.locator('[data-testid=recall-summary]').screenshot({ path: S + '/9-recall.png' });
for (const [n, u] of [['10-par', '/stock/par'], ['11-exp', '/stock/expiring'], ['12-alloc', '/allocation'], ['13-movein', '/move-in'], ['14-settings', '/settings/ops'], ['15-transfers', '/transfers'], ['16-attention-after', '/attention']]) { await p.goto(B + u); await p.waitForTimeout(1500); await p.screenshot({ path: `${S}/${n}.png`, fullPage: true }); }
console.log('errors', errs);
await b.close();
