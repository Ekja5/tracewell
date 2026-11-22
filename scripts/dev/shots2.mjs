import { chromium } from 'playwright';
const S = process.argv[2]; const B = 'http://127.0.0.1:3210';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(B + '/login'); await p.getByLabel('Email or username').fill('avery.brooks@northline.example'); await p.getByLabel('Password').fill('Pilot-Demo-2026!'); await p.getByRole('button', { name: /sign in/i }).click();
await p.waitForURL('**/attention'); await p.waitForSelector('.q-item');
for (const [n, u] of [['v1-where', '/stock/where'], ['v2-tracker', '/tracker'], ['v3-run', '/run-sheet'], ['v4-queue', '/attention']]) { await p.goto(B + u); await p.waitForTimeout(1500); if (await p.getByRole('alert').count()) errs.push(u + ': ' + await p.getByRole('alert').first().innerText()); await p.screenshot({ path: `${S}/${n}.png`, fullPage: true }); }
console.log('errors', errs); await b.close();
