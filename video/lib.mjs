/**
 * Recording helpers. The real application is driven with Playwright and captured frame by frame through
 * the browser's screencast (sharp 1920-wide frames with timestamps). A drawn cursor and a highlight ring
 * are injected into the page so the viewer can follow each action. Nothing here fakes application output.
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs';

export const BASE = process.env.DEMO_URL ?? 'http://127.0.0.1:3210';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The screencast captures CSS pixels, so the page itself is enlarged (body zoom) inside a full-size viewport.
const DESKTOP = { viewport: { width: 1920, height: 972 }, deviceScaleFactor: 1 };                       // app laid out at 1280 x 648, shown 1.5x
const PHONE = { viewport: { width: 750, height: 1624 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: devices['iPhone 13'].userAgent }; // 375 x 812 shown 2x
const ZOOM = { desktop: 1.5, phone: 2 };

const OVERLAY = `(() => {
  if (window.__demo) return; window.__demo = true;
  const css = document.createElement('style');
  css.textContent = '#__cur{position:fixed;left:0;top:0;width:36px;height:36px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:none}' +
    '#__cur svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}' +
    '#__tap{position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:rgba(18,122,111,.35);border:2px solid rgba(18,122,111,.9);z-index:2147483646;pointer-events:none;opacity:0;transform:translate(-100px,-100px) scale(.4)}' +
    '#__tap.go{animation:__tap .45s ease-out}@keyframes __tap{0%{opacity:.95;scale:.35}100%{opacity:0;scale:1.25}}' +
    '#__ring{position:fixed;z-index:2147483645;pointer-events:none;border:3px solid #e8a33d;border-radius:10px;box-shadow:0 0 0 4px rgba(232,163,61,.28),0 0 0 9999px rgba(15,32,43,.16);opacity:0;transition:opacity .25s, left .35s, top .35s, width .35s, height .35s}' +
    '#__ring.on{opacity:1}';
  const add = () => {
    document.head.appendChild(css);
    const c = document.createElement('div'); c.id = '__cur';
    c.innerHTML = '<svg width="36" height="36" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.6 14.9 L11.6 21.6 L14.3 20.4 L11.4 13.8 L17.6 13.8 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const t = document.createElement('div'); t.id = '__tap';
    const r = document.createElement('div'); r.id = '__ring';
    // Outside <body> (so page zoom does not scale it) and in the top layer (so it stays above modal dialogs).
    const ov = document.createElement('div'); ov.id = '__ov'; ov.setAttribute('popover', 'manual');
    ov.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none';
    ov.append(r, t, c); document.documentElement.append(ov); try { ov.showPopover(); } catch {}
    const at = (x, y) => { c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; t.style.left = x + 'px'; t.style.top = y + 'px'; t.style.transform = 'none'; };
    window.addEventListener('mousemove', (e) => at(e.clientX, e.clientY), true);
    window.addEventListener('mousedown', () => { t.classList.remove('go'); void t.offsetWidth; t.classList.add('go'); }, true);
    window.addEventListener('touchstart', (e) => { const p = e.touches[0]; at(p.clientX, p.clientY); t.classList.remove('go'); void t.offsetWidth; t.classList.add('go'); }, true);
    if (window.__lastCur) at(window.__lastCur[0], window.__lastCur[1]);
  };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();`;

export class Scene {
  constructor(browser, name, outDir) { this.browser = browser; this.name = name; this.dir = `${outDir}/${name}`; this.frames = []; this.beats = []; this.pos = [640, 360]; }

  /** Signs in off camera (no login screen, no credentials on screen) and opens a page. */
  async open({ user, phone = false, path = null, file = null }) {
    this.phone = phone;
    this.ctx = await this.browser.newContext({ ...(phone ? PHONE : DESKTOP), locale: 'en-US', timezoneId: 'America/Chicago' });
    if (user) { const r = await this.ctx.request.post(BASE + '/api/auth/demo-login', { data: { email: user }, headers: { 'x-tw-csrf': '1' } }); if (!r.ok()) throw new Error(`sign-in failed for ${user}`); }
    this.page = await this.ctx.newPage();
    await this.page.addInitScript(OVERLAY);
    const z = phone ? ZOOM.phone : ZOOM.desktop;
    await this.page.addInitScript((zoom) => { const s = document.createElement('style'); s.textContent = `body{zoom:${zoom}}`; const add = () => document.head.appendChild(s); if (document.head) add(); else document.addEventListener('DOMContentLoaded', add); }, file ? 1 : z);
    if (phone) await this.page.addInitScript(() => { const s = document.createElement('style'); s.textContent = '#__cur{display:none}#__ring{box-shadow:0 0 0 5px rgba(232,163,61,.3)!important;border-width:4px!important}'; document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s)); });
    if (file) await this.page.goto('file://' + file); else if (path) await this.page.goto(BASE + path);
    await this.page.waitForLoadState('networkidle').catch(() => {});
    if (file) await this.page.addStyleTag({ content: '#__cur,#__tap{display:none}' });
    else if (!phone) await this.page.mouse.move(this.pos[0], this.pos[1]);
    return this.page;
  }

  async start() {
    if (this.dry) { this.t0 = Date.now(); return; }
    fs.rmSync(this.dir, { recursive: true, force: true }); fs.mkdirSync(`${this.dir}/frames`, { recursive: true });
    this.cdp = await this.ctx.newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', (f) => { this.frames.push({ t: f.metadata.timestamp, data: f.data }); this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
    const size = this.phone ? { maxWidth: 750, maxHeight: 1624 } : { maxWidth: 1920, maxHeight: 972 };
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 93, everyNthFrame: 1, ...size });
    await this.nudge(); await sleep(350);
    this.t0 = Date.now(); this.f0 = null;
  }
  /** Forces a repaint so a frame exists even when the page is static. */
  async nudge() { await this.page.evaluate(() => { let n = document.getElementById('__nudge'); if (!n) { n = document.createElement('div'); n.id = '__nudge'; n.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;z-index:2147483647;pointer-events:none'; document.documentElement.append(n); } n.style.background = '#888'; n.style.opacity = n.style.opacity === '0.02' ? '0.03' : '0.02'; }).catch(() => {}); }
  now() { return (Date.now() - this.t0) / 1000; }

  /** One narrated beat: the action starts with the narration; the beat lasts at least as long as the audio. */
  async beat(id, audioSeconds, action, { gap = 0.45 } = {}) {
    const start = this.now();
    this.beats.push({ id, start });
    if (action) await action();
    if (this.dry) return;
    const left = start + audioSeconds + gap - this.now();
    if (left > 0) { const until = Date.now() + left * 1000; while (Date.now() < until) { await sleep(Math.min(400, until - Date.now())); await this.nudge(); } }
    this.beats.at(-1).end = this.now();
  }

  async stop() {
    if (this.dry) { await this.ctx.close(); return { dry: true }; }
    await sleep(450); await this.nudge(); await sleep(150);
    const total = this.now();
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    const wall0 = this.t0 / 1000;
    // Keep frames from just before recording start; rebase timestamps to scene time.
    const fr = this.frames.filter((f) => f.t >= wall0 - 0.5);
    const list = [];
    fr.forEach((f, i) => { const file = `frames/${String(i).padStart(6, '0')}.jpg`; fs.writeFileSync(`${this.dir}/${file}`, Buffer.from(f.data, 'base64')); list.push({ file, t: Math.max(0, f.t - wall0) }); });
    fs.writeFileSync(`${this.dir}/scene.json`, JSON.stringify({ name: this.name, phone: !!this.phone, duration: total, beats: this.beats, frames: list }, null, 1));
    await this.ctx.close();
    return { duration: total, frames: list.length };
  }

  // ---- deliberate pointer movement ----
  async moveTo(x, y, ms = 650) {
    if (this.phone) { this.pos = [x, y]; return; }
    if (this.dry) { await this.page.mouse.move(x, y); this.pos = [x, y]; return; }
    const [x0, y0] = this.pos; const steps = Math.max(8, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) { const k = i / steps; const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; await this.page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e); await sleep(14); }
    this.pos = [x, y];
    await this.page.evaluate(([a, b]) => { window.__lastCur = [a, b]; }, [x, y]).catch(() => {});
  }
  async center(loc) { await loc.scrollIntoViewIfNeeded().catch(() => {}); const b = await loc.boundingBox(); if (!b) throw new Error('not visible: ' + loc); return [b.x + b.width / 2, b.y + b.height / 2, b]; }
  async point(loc, ms = 650, dx = 0, dy = 0) { const [x, y] = await this.center(loc); await this.moveTo(x + dx, y + dy, ms); }
  async click(loc, { pause = 280 } = {}) {
    const [x, y] = await this.center(loc);
    if (this.phone) { await sleep(200); await this.page.touchscreen.tap(x, y); await sleep(pause); return; }
    await this.moveTo(x, y); await sleep(160); await this.page.mouse.down(); await sleep(70); await this.page.mouse.up(); await sleep(pause);
  }
  async type(loc, text, delay = 34) { await this.click(loc, { pause: 150 }); await this.page.keyboard.type(text, { delay }); }
  /** Highlight ring around one element (the detail being discussed). */
  async ring(loc, pad = 8) {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const place = async () => { const b = await loc.boundingBox(); if (!b) return; await this.page.evaluate(([x, y, w, h]) => { const r = document.getElementById('__ring'); r.style.left = x + 'px'; r.style.top = y + 'px'; r.style.width = w + 'px'; r.style.height = h + 'px'; r.classList.add('on'); }, [b.x - pad, b.y - pad, b.width + pad * 2 - 6, b.height + pad * 2 - 6]); };
    await place(); await sleep(320); await place();   // once more after the page settles
  }
  /** Re-raise the pointer overlay above a dialog that has just opened. */
  async raise() { await this.page.evaluate(() => { const o = document.getElementById('__ov'); try { o.hidePopover(); o.showPopover(); } catch {} }).catch(() => {}); }
  /** Shows the tap mark on an element without sending a real tap (used for native pickers, which headless browsers do not draw). */
  async mark(loc) { const [x, y] = await this.center(loc); await this.page.evaluate(([a, b]) => { const t = document.getElementById('__tap'); t.style.left = a + 'px'; t.style.top = b + 'px'; t.style.transform = 'none'; t.classList.remove('go'); void t.offsetWidth; t.classList.add('go'); }, [x, y]); await sleep(350); }
  /** Ring around several adjacent elements (their combined box). */
  async ringAll(locs, pad = 8) {
    const bs = []; for (const l of locs) { const b = await l.boundingBox(); if (b) bs.push(b); } if (!bs.length) return;
    const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y)), r = Math.max(...bs.map((b) => b.x + b.width)), bt = Math.max(...bs.map((b) => b.y + b.height));
    await this.page.evaluate(([x, y, w, h]) => { const e = document.getElementById('__ring'); e.style.left = x + 'px'; e.style.top = y + 'px'; e.style.width = w + 'px'; e.style.height = h + 'px'; e.classList.add('on'); }, [x - pad, y - pad, r - x + pad * 2 - 6, bt - y + pad * 2 - 6]);
  }
  async unring() { await this.page.evaluate(() => document.getElementById('__ring')?.classList.remove('on')).catch(() => {}); await sleep(200); }
  async scrollTo(loc, offset = 110) {
    await this.unring();
    await loc.evaluate((el, off) => { const y = el.getBoundingClientRect().top + window.scrollY - off; window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' }); }, offset);
    await sleep(750);
  }
  async scrollTop() { await this.unring(); await this.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await sleep(650); }
}

export async function launch() { return chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] }); }
