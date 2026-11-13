#!/usr/bin/env node
// Behaviour check for the History desk. Zero dependencies (Node 22+).
//
//   node apps/backoffice/desk/check.mjs
//       Mock mode: tests/mock-server.mjs (contracts/history.md with fictional fixtures, owner auth,
//       recorded requests, injected delays and failures) serves this folder at "/". Driven through
//       the real api.js in isolated headless Chromium whose clock zone differs from the server's.
//   node apps/backoffice/desk/check.mjs --live http://127.0.0.1:3211 --token-file <admin-token> [--dist]
//       Live mode: the same UI against a LOCAL server seeded with tests/seed-dev.mjs (its private
//       state file names the fixture devices). Refuses non-loopback URLs. Reads only, apart from one
//       fictional ingest through a seeded device key, which changes the generation to provoke a 410.
//       By default this folder's source files are served through a same-origin proxy in front of
//       the server, so the built dist is not needed; --dist tests the server's own build instead.
//
// Chromium blocks every non-loopback host, so thumbnails never leave the machine. Screenshots go to
// $OWNTUBE_CHECK_OUT or <os tmpdir>/owntube-desk-check.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './tests/mock-server.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const LIVE = arg('--live');
const TOKEN_FILE = arg('--token-file');
const OUT = process.env.OWNTUBE_CHECK_OUT || path.join(os.tmpdir(), 'owntube-desk-check');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
setTimeout(() => { console.error('check timed out'); process.exit(2); }, 300_000).unref();

if (LIVE && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(LIVE).hostname)) {
  console.error('Live mode only runs against a loopback server.');
  process.exit(2);
}

/* ------------------------------------------------------------------ browser */

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => b.split('-')[1] - a.split('-')[1]) : [];
  for (const b of builds) {
    for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux64/chrome']) {
      const p = path.join(cache, b, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('No Chromium found: set CHROME_BIN');
}

class Page {
  static async open(port) {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const p = new Page();
    p.ws = new WebSocket(t.webSocketDebuggerUrl);
    p.n = 0; p.pending = new Map(); p.errors = []; p.loads = [];
    await new Promise((res, rej) => { p.ws.onopen = res; p.ws.onerror = rej; });
    p.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && p.pending.has(m.id)) { const { res, rej } = p.pending.get(m.id); p.pending.delete(m.id); return m.error ? rej(new Error(m.error.message)) : res(m.result); }
      if (m.method === 'Runtime.exceptionThrown') p.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Page.loadEventFired') p.loads.splice(0).forEach((f) => f());
    };
    for (const d of ['Page.enable', 'Runtime.enable']) await p.send(d);
    return p;
  }
  send(method, params = {}) { const id = ++this.n; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async size(width, height, scale = 1) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }); }
  async scheme(value) { await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] }); }
  async go(url) {
    // A query that changes every time forces a real load even when only the hash differs.
    this.nav = (this.nav || 0) + 1;
    const u = new URL(url);
    u.searchParams.set('n', String(this.nav));
    const loaded = new Promise((r) => this.loads.push(r));
    await this.send('Page.navigate', { url: u.toString() });
    await Promise.race([loaded, sleep(8000)]);
    await sleep(300);
  }
  async eval(fn, ...args) {
    const r = await this.send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(fn, ...args) {
    for (let i = 0; i < 80; i++) { if (await this.eval(fn, ...args)) return true; await sleep(100); }
    return false;
  }
  async click(sel) {
    const found = await this.waitFor((s) => !!document.querySelector(s), sel);
    if (!found) throw new Error(`missing ${sel}`);
    const pt = await this.eval((s) => { const el = document.querySelector(s); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1 });
    await sleep(120);
  }
  async key(key, keyCode) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: keyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode });
    await sleep(150);
  }
  async type(text) { await this.send('Input.insertText', { text }); await sleep(60); }
  async select(sel, value) {
    await this.eval((s, v) => { const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, sel, value);
    await sleep(120);
  }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  }
}

// Serve this folder's runtime files at "/" and pass everything else (the API, Languages, legacy)
// to the live server, so cookies and paths behave as in production.
async function startProxy(target) {
  const files = { '/': 'index.html', '/index.html': 'index.html', '/desk.css': 'desk.css', '/desk.js': 'desk.js', '/api.js': 'api.js', '/shared/recorded-versions.js': '../shared/recorded-versions.js' };
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
  const server = http.createServer((req, res) => {
    const file = files[new URL(req.url, 'http://proxy').pathname];
    if (file) { res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store' }); fs.createReadStream(path.join(DIR, file)).pipe(res); return; }
    const t = new URL(req.url, target);
    const up = http.request(t, { method: req.method, headers: { ...req.headers, host: t.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

/* ------------------------------------------------------------------ run */

let passed = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) passed++; else failures.push(msg); console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`); };
fs.mkdirSync(OUT, { recursive: true });
const mockServer = LIVE ? null : await startMock(DIR);
const proxy = LIVE && !argv.includes('--dist') ? await startProxy(LIVE) : null;
const BASE = proxy?.base || LIVE || mockServer.base;
const KEY = LIVE ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : mockServer.key;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'owntube-desk-profile-'));
const chrome = spawn(findChrome(), ['--headless=new', '--use-mock-keychain', '--password-store=basic', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--hide-scrollbars',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'], { stdio: 'ignore' });
const portFile = path.join(profile, 'DevToolsActivePort');
for (let i = 0; i < 300 && !fs.existsSync(portFile); i++) await sleep(50);
const p = await Page.open(fs.readFileSync(portFile, 'utf8').split('\n')[0]);

const seen = [];
const control = (body) => fetch(`${BASE}/__mock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const requests = async () => { const r = await (await fetch(`${BASE}/__mock/requests`)).json(); seen.push(...r); return r; };
const lastOf = (list, pathname) => list.filter((r) => r.path === pathname).at(-1);
const inPage = (pathname, query) => p.eval(async (u, q) => (await fetch(`${u}?${new URLSearchParams(q)}`, { credentials: 'same-origin' })).json(), pathname, query);
const settled = () => p.waitFor(() => document.querySelector('.history')?.getAttribute('aria-busy') === 'false' && !document.querySelector('[data-loading]'));
const text = (sel) => p.eval((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() ?? null, sel);
const rowIds = () => p.eval(() => [...document.querySelectorAll('[data-row]')].map((r) => r.dataset.row));
const overflow = () => p.eval(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(
  [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
    .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).trim().replace(/\s+/g, '.')} “${e.textContent.trim().slice(0, 40)}”`).slice(0, 5),
)))));
const signIn = async () => {
  await p.waitFor(() => !!document.getElementById('owner-key'));
  await p.click('#owner-key');
  await p.type(KEY);
  await p.click('form[data-form="login"] button[type="submit"]');
  return p.waitFor(() => !!document.querySelector('[data-ledger], [data-search-ledger]'));
};
const typeFilter = async (value) => {
  await p.eval(() => { const i = document.getElementById('f-q'); i.value = ''; i.focus(); });
  await p.type(value);
  await sleep(500);
  await settled();
};

try {
  await p.size(1440, 900);
  await p.scheme('light');
  if (!LIVE) {
    const { fx } = mockServer;
    const dayN = (n) => fx.z.addDays(fx.today, -n);
    // The browser runs in another zone than the server: every date and time must still be the server's.
    await p.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });

    console.log('Sign-in gate');
    await requests();
    await p.go(`${BASE}/`);
    ok(await p.waitFor(() => !!document.getElementById('owner-key')), 'without a session the desk asks for the owner key');
    ok((await requests()).every((r) => r.path === '/api/session'), 'nothing but the session check is requested before sign-in');
    await p.click('#owner-key');
    await p.type('wrong key');
    await p.click('form[data-form="login"] button[type="submit"]');
    ok(await p.waitFor(() => /wasn’t accepted/.test(document.querySelector('.login__error')?.textContent || '')), 'a wrong key is refused with an explanation');
    await p.eval(() => { document.getElementById('owner-key').value = ''; });
    ok(await signIn(), 'the owner key signs in and opens Watched');
    await settled();
    ok((await p.eval(() => location.hash)) === '#/history', 'the root opens History · Watched at #/history');
    let req = await requests();
    ok(JSON.stringify(lastOf(req, '/api/history')?.query) === JSON.stringify({ days: '7', device: '', person: '', query: '', page: '1' }), 'the first request carries the default scope and no snapshot pair');

    console.log('Ledger and server dates');
    const api7 = await inPage('/api/history', { days: 7, device: '', person: '', query: '', page: 1 });
    const ledger = await p.eval(() => ({ ...document.querySelector('[data-ledger]').dataset }));
    ok(Number(ledger.seconds) === api7.seconds && Number(ledger.videos) === api7.videoCount && Number(ledger.perDay) === api7.perCalendarDaySeconds, 'the ledger shows the server’s scope totals');
    ok(/÷ 7 calendar days/.test(await text('[data-ledger] .fig__div')), 'per calendar day divides by all 7 calendar days');
    const split = await p.eval(() => ({ ...document.querySelector('[data-split]').dataset, text: document.querySelector('[data-split]').textContent }));
    ok(Number(split.fg) + Number(split.bg) + Number(split.un) === api7.seconds && /on-tab \/ foreground/.test(split.text), 'the context sentence covers the whole total and names a mixed scope “on-tab / foreground”');
    ok((await p.eval(() => [...document.querySelectorAll('.day')].slice(0, 2).map((d) => [d.dataset.date, d.querySelector('.day__title').textContent]))).join() === [fx.today, 'Today', dayN(1), 'Yesterday'].join(), 'day groups are the server’s dates, Today and Yesterday included, with the browser in another zone');
    ok((await p.eval(() => document.querySelector('[data-row="w-t7"]')?.closest('.day')?.dataset.date)) === fx.today && (await p.eval(() => [...document.querySelectorAll('[data-row="w-t7"] .hrow__time time')].map((t) => t.textContent).join('–'))) === '00:20–00:35', 'a viewing just after server midnight stays on the server’s day, shown in server time');
    ok((await p.eval(() => document.querySelector('[data-row="w-y1"]')?.closest('.day')?.dataset.date)) === dayN(1), 'the same viewing before midnight is its own entry on the previous day');
    ok(await p.eval((days) => days.every((d) => { const head = document.querySelector(`.day[data-date="${d.date}"] [data-day-seconds]`); return !head || Number(head.dataset.daySeconds) === d.seconds; }), api7.daily), 'each day header shows that day’s whole total from the server');

    console.log('Entries');
    ok(JSON.stringify(await rowIds()) === JSON.stringify(api7.rows.map((r) => r.id)), 'rows keep the server’s order');
    ok(await p.eval(() => [...document.querySelectorAll('[data-row]')].every((r) => Number(r.dataset.fg) + Number(r.dataset.bg) + Number(r.dataset.un) === Number(r.dataset.s))), 'every entry’s context adds up to its watched time');
    const ctx = await p.eval(() => Object.fromEntries(['w-t1', 'w-t2', 'w-t5', 'w-t10', 'w-t3'].map((id) => [id, document.querySelector(`[data-row="${id}"] [data-ctx]`)?.textContent])));
    ok(ctx['w-t1'] === '20 min on-tab · 5 min background' && ctx['w-t2'] === 'all foreground', 'a browser entry says on-tab and a TV entry says foreground');
    ok(ctx['w-t5'] === '25 min on-tab / foreground · 15 min background' && ctx['w-t10'] === 'all on-tab / foreground', 'mixed and unidentified sources name both');
    ok(ctx['w-t3'] === 'context not recorded', 'missing context reads “context not recorded”, never foreground');
    const cov = await p.eval(() => Object.fromEntries(['w-t1', 'w-t5', 'w-t3', 'w-t6', 'w-t10'].map((id) => [id, document.querySelector(`[data-row="${id}"] [data-cov]`)?.textContent.trim()])));
    ok(cov['w-t1'] === '83% covered' && cov['w-t5'] === 'at least 40% covered' && cov['w-t3'] === '15 min covered' && cov['w-t6'] === 'coverage not recorded' && cov['w-t10'] === '<1% covered', `coverage wording: complete, partial (“at least”), no duration, not recorded, under 1% ${JSON.stringify(cov)}`);
    ok(await p.eval(() => !!document.querySelector('[data-row="w-t1"] .art__cov') && !!document.querySelector('[data-row="w-t5"] .art__cov--partial') && !document.querySelector('[data-row="w-t3"] .art__cov')), 'the thumbnail bar appears only with a percentage, with a dotted end when partial');
    ok((await text('[data-row="w-t4"] .art__badge')) === 'SHORT · 0:58', 'a Short carries its badge and duration');
    ok(await p.eval(() => !!document.querySelector('[data-row="w-y2"]') && !document.querySelector('[data-row="w-y3"]') && Number(document.querySelector('[data-row="w-y2"]').dataset.s) === 1500), 'a metadata change stays in one entry with all watched time');
    ok(await p.eval(() => window.__deskXss === undefined && document.querySelector('[data-row="w-t6"] .hrow__title').textContent.includes('<img src=x') && !document.querySelector('img[src="x"]')), 'hostile titles and channels show literally and never run');

    console.log('Paging through one snapshot');
    ok(/42 recorded entries · page 1 of 3/.test(await text('[data-status]')), 'the status counts every entry in scope and the pages');
    ok(/continues on the next page/.test(await text(`.day[data-date="${dayN(1)}"] .day__head`)), 'a day split by the page says it continues on the next page');
    await requests();
    await p.click('[data-key="page:next"]');
    await settled();
    req = await requests();
    ok(lastOf(req, '/api/history')?.query.page === '2' && lastOf(req, '/api/history')?.query.generation === String(api7.generation) && lastOf(req, '/api/history')?.query.until === String(api7.until), 'page 2 reads the same snapshot (generation + until)');
    ok(/continued from the previous page/.test(await text('.day .day__head')) && (await p.eval(() => location.hash)).includes('page=2'), 'page 2 says the day is continued, and the page is in the URL');
    ok(await p.eval(() => document.activeElement?.dataset.key === 'page:next'), 'focus stays on the pager');
    await typeFilter('derby');
    req = await requests();
    const fq = lastOf(req, '/api/history')?.query;
    ok(fq?.query === 'derby' && fq.page === '1' && fq.generation === String(api7.generation) && fq.until === String(api7.until), 'filtering keeps the snapshot pair and starts at page 1');
    const apiDerby = await inPage('/api/history', { days: 7, device: '', person: '', query: 'derby', page: 1, generation: api7.generation, until: api7.until });
    ok(Number(await p.eval(() => document.querySelector('[data-ledger]').dataset.seconds)) === api7.seconds, 'filtering never changes the scope numbers');
    ok(apiDerby.filteredCount === 2 && (await text('[data-status]')).startsWith('2 of 42 recorded entries match derby') && /1 of 11 entries match/.test(await text('.day__head')), 'the status and day headers count grouped entries');
    await p.eval(() => { const i = document.getElementById('f-q'); i.value = 'no such words'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(500); await settled();
    ok(/Nothing in this period matches/.test(await text('[data-empty="filter"]')), 'no match says so and offers to clear the filter');
    await p.click('[data-key="clear-q"]');
    await settled();
    ok((await p.eval(() => document.getElementById('f-q').value)) === '' && /42 recorded entries/.test(await text('[data-status]')), 'clearing the filter restores the list');
    await control({ slow: [{ path: '/api/history', when: { query: 'lathe' }, ms: 1000 }] });
    await p.eval(() => { const i = document.getElementById('f-q'); i.value = 'lathe'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(550);
    ok(await p.eval(() => { const s = document.querySelector('[data-status]')?.textContent || ''; return /updating/.test(s) && !/lathe/.test(s) && /^42 recorded entries/.test(s); }), 'while a new filter loads, the status keeps describing the rows on screen');
    await settled();
    await control({ slow: [] });
    await p.eval(() => { const i = document.getElementById('f-q'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(500);
    await settled();

    console.log('Scope changes, loading and races');
    await requests();
    await p.select('#f-device', 'd-laptop');
    await settled();
    req = await requests();
    ok(lastOf(req, '/api/history')?.query.device === 'd-laptop' && !('generation' in lastOf(req, '/api/history').query), 'changing the device starts a fresh snapshot');
    ok(/on-tab/.test(await text('[data-split]')) && !/foreground/.test(await text('[data-split]')), 'a browser-only scope says on-tab');
    ok(await p.eval(() => [...document.querySelectorAll('#f-person option')].some((o) => o.value === 'unassigned')), 'Unassigned devices is offered when a device has no person');
    await requests();
    await p.select('#f-person', 'p-guest');
    await settled();
    req = await requests();
    ok(lastOf(req, '/api/history')?.query.person === 'p-guest' && lastOf(req, '/api/history')?.query.device === '', 'choosing a person clears a device that isn’t theirs');
    ok(await p.eval(() => [...document.querySelectorAll('#f-device option')].map((o) => o.value).filter(Boolean).join() === 'd-bedroom,d-shared'), 'the device list narrows to that person’s devices');
    await p.select('#f-person', '');
    await settled();
    await control({ slow: [{ path: '/api/history', when: { days: '30' }, ms: 1200 }] });
    await p.click('[data-key="f:days:30"]');
    await sleep(150);
    ok(await p.eval(() => !document.querySelector('[data-ledger]') && /Loading the last 30 days on all devices/.test(document.querySelector('[data-loading]')?.textContent || '')), 'while a new scope loads, the previous numbers are not shown under the new labels');
    await p.click('[data-key="f:days:90"]');
    await settled();
    await sleep(1300);
    const api90 = await inPage('/api/history', { days: 90, device: '', person: '', query: '', page: 1 });
    ok((await p.eval(() => document.querySelector('[data-ledger]')?.dataset.days)) === '90' && Number(await p.eval(() => document.querySelector('[data-ledger]').dataset.seconds)) === api90.seconds, 'a slower earlier answer (30 days) never replaces the latest scope (90 days)');
    const asOf90 = await p.eval(() => document.querySelector('[data-as-of]')?.dataset.asOf);
    await requests();
    await p.click('[data-key="page:next"]');
    await settled();
    req = await requests();
    ok(lastOf(req, '/api/history')?.query.days === '90' && lastOf(req, '/api/history')?.query.until === asOf90 && 'generation' in lastOf(req, '/api/history').query, 'and paging the latest scope still uses its own snapshot');
    await p.click('[data-key="page:prev"]');
    await settled();
    ok(await p.eval(() => [...document.querySelectorAll('#f-device option')].some((o) => /revoked/.test(o.textContent))), 'revoked devices stay selectable, marked revoked');
    await control({ slow: [], fail: [{ path: '/api/history', when: { days: '7' }, status: 500, error: 'Database is busy.', once: true }] });
    await p.click('[data-key="f:days:7"]');
    await settled();
    ok(await p.eval(() => /Database is busy/.test(document.querySelector('.problem')?.textContent || '') && !document.querySelector('[data-ledger]')), 'a failed scope load shows the server’s error and no old numbers');
    await p.click('[data-key="retry"]');
    await settled();
    ok(Number(await p.eval(() => document.querySelector('[data-ledger]')?.dataset.seconds)) === api7.seconds, 'Try again recovers');
    await control({ fail: [{ path: '/api/history', when: { days: '30' }, status: 200, raw: '<html>maintenance</html>', once: true }] });
    await p.click('[data-key="f:days:30"]');
    await settled();
    ok(await p.eval(() => /couldn’t be read/.test(document.querySelector('.problem')?.textContent || '') && !document.querySelector('[data-ledger]')), 'an unreadable successful answer is an error, not zero data');
    await p.click('[data-key="f:days:7"]');
    await settled();

    console.log('Refresh and an expired snapshot (410)');
    await p.click('[data-key="page:next"]');
    await settled();
    await requests();
    await p.click('[data-key="refresh:watched"]');
    await settled();
    req = await requests();
    ok(lastOf(req, '/api/history')?.query.page === '1' && !('generation' in lastOf(req, '/api/history').query), 'Refresh starts a fresh snapshot at page 1');
    await p.click('[data-key="page:next"]');
    await settled();
    const before410 = await inPage('/api/history', { days: 7, device: '', person: '', query: '', page: 1 });
    await control({ bump: true });
    await requests();
    await p.click('[data-key="page:next"]');
    await settled();
    req = (await requests()).filter((r) => r.path === '/api/history');
    ok(req.length >= 2 && req[0].query.page === '3' && req[0].query.generation === String(before410.generation) && req.at(-1).query.page === '1' && !('generation' in req.at(-1).query), 'a 410 drops the pair and reloads page 1 from current records');
    ok(/no longer available/.test(await text('[data-notice]') || '') && /43 recorded entries · page 1/.test(await text('[data-status]')) && !!(await p.eval(() => document.querySelector('[data-row^="w-new-"]'))), 'the notice says the saved list is gone, and the new upload is now counted');
    ok(/no longer available/.test(await p.eval(() => document.getElementById('sr').textContent)), 'the restart is announced');

    console.log('Searches');
    await requests();
    await p.click('[data-key="tab:d:searches"]');
    await p.waitFor(() => !!document.querySelector('[data-search-ledger]'));
    await settled();
    req = await requests();
    const sq = lastOf(req, '/api/history/searches')?.query;
    ok((await p.eval(() => location.hash)) === '#/history/searches' && JSON.stringify(sq) === JSON.stringify({ days: '7', device: '', person: '', query: '', page: '1' }), 'the Searches tab is a link that reads its own snapshot');
    ok(await p.eval(() => document.activeElement?.dataset.key === 'tab:d:searches' && document.querySelector('[data-key="tab:d:searches"]').getAttribute('aria-current') === 'page'), 'switching keeps focus on the tab, marked current');
    const s7 = await inPage('/api/history/searches', { days: 7, device: '', person: '', query: '', page: 1 });
    ok(Number(await p.eval(() => document.querySelector('[data-search-ledger]').dataset.count)) === s7.count && s7.count === 33, 'the count covers every search in scope');
    ok(await p.eval((daily) => daily.every((d) => { const h = document.querySelector(`.day[data-date="${d.date}"] [data-day-count]`); return !h || Number(h.dataset.dayCount) === d.count; }), s7.daily), 'each day header shows that day’s whole search count');
    const note = await text('[data-source-note]');
    ok(/Searches come from Laptop, Shared Chromebook in the hallway and Old phone/.test(note) && /Living room TV and Bedroom TV record playback only/.test(note) && /No search capture has been seen from Tablet/.test(note), 'the source note names recording, playback-only and unidentified devices precisely');
    const langs = await p.eval(() => [...document.querySelectorAll('.srow')].map((r) => [r.querySelector('.srow__text').textContent, r.querySelector('.srow__lang')?.firstChild?.textContent || '']));
    const langOf = (q) => langs.find(([t]) => t === q)?.[1];
    ok(langOf('wetter zürich') === 'de' && langOf('Ђердапска клисура из ваздуха') === 'sr' && langOf('zxcvb qwerty') === '' && langOf('kombu dashi') === '', `a known query language shows as a quiet code; “other” and empty stay hidden ${JSON.stringify(langs.slice(0, 3))}`);
    ok(langs.filter(([t]) => t === 'wetter zürich' || t === 'wetter bern').length === 2, 'two searches in the same second stay two events');
    ok(await p.eval(() => window.__deskXss === undefined && [...document.querySelectorAll('.srow__text')].some((s) => s.textContent.startsWith('<img src=x'))), 'a hostile query shows literally and never runs');
    await requests();
    await p.click('[data-key="page:next"]');
    await settled();
    req = await requests();
    ok(lastOf(req, '/api/history/searches')?.query.before === String(s7.before) && lastOf(req, '/api/history/searches')?.query.until === String(s7.until), 'Searches page 2 keeps before + until');
    await typeFilter('zahnrad');
    req = await requests();
    const zq = lastOf(req, '/api/history/searches')?.query;
    ok(zq?.page === '1' && zq.before === String(s7.before) && Number(await p.eval(() => document.querySelector('[data-search-ledger]').dataset.count)) === 33 && /^8 of 33 searches match zahnrad/.test(await text('[data-status]')), 'filtering searches keeps the pair, starts at page 1 and keeps the count');
    await control({ gone: 'searches' });
    await requests();
    await typeFilter('rail');
    req = (await requests()).filter((r) => r.path === '/api/history/searches');
    ok(req.length >= 2 && req.at(-1).query.before === undefined && /no longer available/.test(await text('[data-notice]') || ''), 'a 410 on Searches is handled the same way');
    await p.select('#f-device', 'd-living');
    await settled();
    ok((await text('[data-search-ledger] .fig__n')) === '—' && /not recorded on TVs/.test(await text('[data-search-ledger]')) && /Living room TV doesn’t record searches/.test(await text('[data-empty="not-recorded"]')), 'a TV says “not recorded”, never 0');
    await p.click('[data-key="all-devices"]');
    await settled();
    ok((await p.eval(() => document.getElementById('f-device').value)) === '', '“Show all devices” resets the device');
    await p.select('#f-device', 'd-tablet');
    await settled();
    ok((await text('[data-search-ledger] .fig__n')) === '0' && /No searches recorded in the last 7 days on Tablet/.test(await text('[data-empty="none"]')) && /can’t say whether it records searches/.test(await text('[data-empty="none"]')), 'an unidentified device shows no searches recorded, without claiming it can’t record them');
    await p.select('#f-device', '');
    await settled();
    // A stale link can combine a person with someone else's device: the scope is their intersection.
    await p.go(`${BASE}/#/history/searches?person=p-guest&device=d-laptop`);
    await settled();
    ok(!/Laptop/.test(await text('[data-source-note]')) && /Device not in the list/.test(await p.eval(() => document.getElementById('f-device').selectedOptions[0]?.textContent || '')), 'person and device together mean their intersection; the source note never names a device outside it');
    await p.go(`${BASE}/#/history/searches?q=rail`);
    await settled();

    console.log('Independent filters, shared scope');
    await p.click('[data-key="tab:d:watched"]');
    await settled();
    ok((await p.eval(() => document.getElementById('f-q').value)) === '', 'the Searches filter never leaks into Watched');
    await typeFilter('rhine');
    await p.click('[data-key="tab:d:searches"]');
    await settled();
    ok((await p.eval(() => document.getElementById('f-q').value)) === 'rail', 'Searches keeps its own filter');
    await requests();
    await p.click('[data-key="f:days:30"]');
    await settled();
    await p.click('[data-key="tab:d:watched"]');
    await settled();
    req = await requests();
    ok(lastOf(req, '/api/history')?.query.days === '30' && lastOf(req, '/api/history')?.query.query === 'rhine' && (await p.eval(() => document.getElementById('f-q').value)) === 'rhine', 'period, device and person are shared; each view keeps its own filter');
    ok(!seen.some((r) => r.path.startsWith('/api/modules/languages')), 'History never calls the Languages module');
    await p.eval(() => { const i = document.getElementById('f-q'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(500);
    await p.click('[data-key="f:days:7"]');
    await settled();

    console.log('Evidence inspector');
    await requests();
    await p.click('[data-key="ev:w-t1"]');
    ok(await p.waitFor(() => !!document.querySelector('#dlg[open] [data-ev-collector]')), 'Evidence opens the inspector');
    req = await requests();
    ok(JSON.stringify(lastOf(req, '/api/history/evidence')?.query) === JSON.stringify({ device: 'd-laptop', metadata: 'm-mockLaptop1-chrome1' }), 'the inspector asks for exactly this entry’s device and version');
    ok(await p.eval(() => document.activeElement?.dataset.key === 'dlg:close'), 'focus starts on Close');
    ok(await p.eval(() => { const q = (k) => Number(document.querySelector(`#dlg [data-ev-${k}]`)?.dataset[`ev${k[0].toUpperCase()}${k.slice(1)}`]); return q('fg') === 1200 && q('bg') === 300 && q('un') === 0 && q('total') === 1500; }), 'the context facts are this entry’s');
    ok(/19:40–20:05 first and last recorded playback, not when a session started or ended/.test(await text('#dlg [data-ev-recorded]')) && /one recorded viewing of this video/.test(await text('#dlg [data-ev-scope]')), 'recorded times and the entry’s scope are named precisely');
    ok(/English \(en\) · high confidence · from the selected audio track/.test(await text('#dlg [data-ev-estimate]')), 'the collector’s estimate is shown as derived, with its signal');
    ok((await p.eval(() => document.querySelector('#dlg a[data-key="dlg:languages"]')?.getAttribute('href'))) === 'modules/languages/#device=d-laptop&query=mockLaptop1&metadata=m-mockLaptop1-chrome1', 'the inspector links to this version in Languages, where corrections live');
    await p.click('#dlg [data-raw-details] > summary');
    const exact = mockServer.fx.evidence[mockServer.fx.rows.find((r) => r.id === 'w-t1').evidenceId];
    ok((await p.eval(() => document.querySelector('#dlg code[data-raw="exact"]')?.textContent)) === exact, 'the raw view is the exact saved text');
    ok(await p.waitFor(() => /Matches/.test(document.querySelector('#dlg [data-digest]')?.textContent || '')), 'its SHA-256, recomputed in the browser, matches the evidence ID');
    await p.click('#dlg [data-key="raw:formatted"]');
    ok(/not byte-identical/.test(await text('#dlg [data-raw-details] .ev__note')) && !!(await p.eval(() => document.querySelector('#dlg code[data-raw="formatted"]'))), 'the formatted view says it is re-encoded');
    await p.key('Escape', 27);
    ok(await p.eval(() => !document.getElementById('dlg').open && document.activeElement?.dataset.key === 'ev:w-t1'), 'Esc closes and returns focus to the entry’s Evidence button');
    const inspect = async (id) => { await p.click(`[data-key="ev:${id}"]`); await p.waitFor(() => !!document.querySelector('#dlg[open] [data-ev-collector]') || !!document.querySelector('#dlg[open] .problem')); await sleep(150); };
    await inspect('w-y2');
    ok(await p.eval(() => document.querySelectorAll('#f-version option').length === 2 && document.querySelector('#f-version').value === 'd-laptop:m-meta-b' && Number(document.querySelector('[data-ev-total]').dataset.evTotal) === 1500), 'group inspector starts on newest evidence and keeps whole-entry time');
    ok(/60% covered/.test(await text('[data-ev-covered]')), 'entry coverage unions overlapping version ranges');
    await requests();
    await p.select('#f-version', 'd-laptop:m-meta-a');
    await p.waitFor(() => document.querySelector('#dlg [data-ev-description]')?.textContent === 'First upload.');
    req = await requests();
    ok(lastOf(req, '/api/history/evidence')?.query.metadata === 'm-meta-a' && (await p.eval(() => document.querySelector('#dlg code[data-raw="exact"]')?.textContent)) === fx.evidence[fx.rows.find((r) => r.id === 'w-y3').evidenceId], 'selecting the earlier version retrieves its exact saved evidence');
    ok(await p.waitFor(() => /Matches/.test(document.querySelector('#dlg [data-digest]')?.textContent || '')) && /metadata=m-meta-a/.test(await p.eval(() => document.querySelector('[data-key="dlg:languages"]').getAttribute('href'))), 'selected-version digest and Languages link use the same identity');
    await control({ slow: [{ path: '/api/history/evidence', when: { metadata: 'm-meta-b' }, ms: 900 }] });
    await p.select('#f-version', 'd-laptop:m-meta-b');
    await p.select('#f-version', 'd-laptop:m-meta-a');
    await sleep(1100);
    ok((await text('#dlg [data-ev-description]')) === 'First upload.' && Number(await p.eval(() => document.querySelector('[data-ev-total]').dataset.evTotal)) === 1500, 'late version responses cannot replace the selection or change entry totals');
    await control({ slow: [] });
    await p.key('Escape', 27);
    await inspect('w-t5');
    await p.click('#dlg [data-raw-details] > summary');
    ok(await p.waitFor(() => /Does not match/.test(document.querySelector('#dlg [data-digest]')?.textContent || '')) && /shown exactly as stored/.test(await text('#dlg [data-digest]')), 'a saved text that differs from its ID is shown as a mismatch, unchanged');
    await p.key('Escape', 27);
    await inspect('w-t2');
    ok(/decoder label/.test(await text('#dlg')) && /doesn’t expose it/.test(await text('#dlg')) && !!(await p.eval(() => document.querySelector('#dlg [data-ev-mapping]'))), 'Android evidence: decoder label, default audio not exposed, failed getter stated');
    await p.key('Escape', 27);
    await inspect('w-t3');
    ok(!!(await p.eval(() => document.querySelector('#dlg [data-ev-missing]'))) && /15 min covered/.test(await text('#dlg [data-ev-covered]')), 'no snapshot is stated, with nothing inferred');
    await p.key('Escape', 27);
    await inspect('w-t8');
    ok(!!(await p.eval(() => document.querySelector('#dlg [data-ev-invalid]'))) && (await p.eval(() => document.querySelector('#dlg code[data-raw="exact"]')?.textContent.startsWith('{"schemaVersion":1,"title":"Cut off'))), 'invalid JSON is stated and its exact text kept');
    await p.key('Escape', 27);
    await inspect('w-t6');
    await p.click('#dlg [data-raw-details] > summary');
    ok(await p.eval(() => window.__deskXss === undefined && !document.querySelector('#dlg script, #dlg img') && document.querySelector('#dlg [data-ev-description]').textContent.includes('<script>') && document.querySelector('#dlg [data-ev-heading]').textContent.startsWith('<img src=x')), 'hostile evidence text shows literally and never runs');
    await p.key('Escape', 27);
    await p.click('[data-key="page:next"]');
    await settled();
    await inspect('w-l1');
    ok(/older collector recorded for this video/.test(await text('#dlg [data-ev-scope]')) && /not separate plays/.test(await text('#dlg [data-ev-scope]')) && /First sample 09:12, latest 21:47/.test(await text('#dlg [data-ev-recorded]')), 'a legacy day explains itself: one day’s record, first and latest samples, not plays');
    ok((await text('[data-row="w-l1"] .hrow__time')) === 'Recorded that day' && !(await p.eval(() => document.querySelector('[data-row="w-l1"] time'))), 'legacy rows read “Recorded that day”, with no time of day');
    await p.key('Escape', 27);
    await p.click('[data-key="page:prev"]');
    await settled();
    // A slow answer for a closed inspector must never land in the next one.
    await control({ slow: [{ path: '/api/history/evidence', when: { metadata: 'm-mockLaptop1-chrome1' }, ms: 900 }] });
    await p.click('[data-key="ev:w-t1"]');
    await sleep(100);
    await p.key('Escape', 27);
    await inspect('w-t9');
    await p.click('#dlg [data-raw-details] > summary');
    await sleep(1100);
    // Re-render the open inspector after the late answer, so a misplaced write would show.
    await p.click('#dlg [data-key="raw:formatted"]');
    await p.click('#dlg [data-key="raw:exact"]');
    ok((await text('#dlg [data-ev-heading]')).startsWith('Restoration_notes_without') && /Matches/.test(await text('#dlg [data-digest]')) && (await p.eval(() => document.querySelector('#dlg code[data-raw="exact"]').textContent.includes('Long names on purpose'))), 'a slow answer for a closed inspector never replaces the open one');
    await p.key('Escape', 27);
    await control({ slow: [], fail: [{ path: '/api/history/evidence', status: 500, error: 'Evidence store is busy.', once: true }] });
    await inspect('w-t1');
    ok(/Evidence store is busy/.test(await text('#dlg .problem') || ''), 'an evidence failure shows the server’s error inside the inspector');
    await p.click('#dlg [data-key="dlg:retry"]');
    ok(await p.waitFor(() => !!document.querySelector('#dlg [data-ev-collector]')), 'and Try again loads it');
    await p.key('Escape', 27);
    await p.shot('mock-desktop');

    console.log('Session, sign-out, navigation');
    await control({ expire: true });
    await p.click('[data-key="refresh:watched"]');
    ok(await p.waitFor(() => !!document.getElementById('owner-key')), 'an expired session returns to sign-in');
    ok(await signIn() && (await p.eval(() => location.hash)) === '#/history', 'signing in again restores the same view');
    await settled();
    await control({ logoutFail: true });
    await p.click('[data-key="mast:logout"]');
    ok(await p.waitFor(() => !!document.querySelector('[data-logout-error]')) && !!(await p.eval(() => document.querySelector('[data-ledger]'))), 'a failed sign-out keeps you signed in and says so');
    await p.click('[data-key="logout:retry"]');
    ok(await p.waitFor(() => !!document.getElementById('owner-key')) && !(await p.eval(() => document.querySelector('[data-ledger], .hrow'))), 'signing out again succeeds and leaves no history on screen');
    await signIn();
    await settled();
    const links = await p.eval(() => ({ languages: document.querySelector('[data-key="nav:languages"]').getAttribute('href'), current: document.querySelector('[data-key="nav:history"]').getAttribute('aria-current'), legacy: document.querySelector('[data-key="mast:legacy"]').getAttribute('href'), side: [...document.querySelectorAll('.side__links a')].map((a) => a.getAttribute('href')) }));
    const statuses = await Promise.all(['modules/languages/', 'legacy/', 'diagnostics.html', 'android-integration.html'].map(async (u) => (await fetch(`${BASE}/${u}`)).status));
    ok(links.languages === 'modules/languages/' && links.current === 'page' && links.legacy === 'legacy/' && links.side.join() === 'legacy/,diagnostics.html,android-integration.html' && statuses.every((s) => s === 200), 'the masthead and side note link to Languages, the legacy dashboard, Diagnostics and the Android guide');
    await p.go(`${BASE}/#/curation`);
    await settled();
    ok((await p.eval(() => location.hash)) === '#/history', 'an unknown route opens History');
    await requests();
    await p.go(`${BASE}/#/history?days=30&page=2`);
    await settled();
    req = await requests();
    ok(lastOf(req, '/api/history')?.query.days === '30' && lastOf(req, '/api/history')?.query.page === '2' && !('generation' in lastOf(req, '/api/history').query), 'a deep link with period and page loads that page fresh');
    await p.eval(() => document.querySelector('.skip').focus());
    await p.key('Enter', 13);
    ok(await p.eval(() => document.activeElement?.id === 'main' && location.hash.startsWith('#/history')), 'the skip link moves focus to the content without changing the route');

    console.log('Phone');
    await p.go(`${BASE}/#/history`);
    await settled();
    await p.size(390, 844, 2);
    await sleep(300);
    let over = await overflow();
    ok(over.length === 0, `phone: nothing is wider than the screen in Watched ${over.length ? JSON.stringify(over) : ''}`);
    ok(await p.eval(() => { const h = [...document.querySelectorAll('[data-heading]')].find((x) => x.offsetParent); const tabs = [...document.querySelectorAll('.htabs')].find((x) => x.offsetParent); return !!h && !!tabs && tabs.getBoundingClientRect().top < document.getElementById('f-q').getBoundingClientRect().top; }), 'phone: heading and the Watched/Searches switch come before the filters');
    ok(await p.eval(() => ['w-t9', 'w-t10'].every((id) => { const row = document.querySelector(`[data-row="${id}"]`); const b = row.querySelector('.hrow__body').getBoundingClientRect(); return [...row.querySelectorAll('.meta > span')].every((s) => s.getBoundingClientRect().right <= b.right + 0.5); })), 'phone: long channel and device names wrap inside their rows');
    await p.eval(() => document.querySelector('[data-row="w-t9"]').scrollIntoView({ block: 'center' }));
    await p.shot('mock-phone-watched');
    await p.click('[data-key="ev:w-t9"]');
    await p.waitFor(() => !!document.querySelector('#dlg[open] [data-ev-collector]'));
    ok(await p.eval(() => { const d = document.getElementById('dlg'); return d.scrollWidth <= d.clientWidth + 1; }), 'phone: the inspector is a sheet that fits the width');
    await p.shot('mock-phone-inspector');
    await p.key('Escape', 27);
    await p.click('[data-key="tab:m:searches"]');
    await settled();
    over = await overflow();
    ok(over.length === 0, `phone: nothing is wider than the screen in Searches ${over.length ? JSON.stringify(over) : ''}`);
    await p.shot('mock-phone-searches');
    await p.size(1440, 900);
    await p.scheme('dark');
    await p.click('[data-key="tab:d:watched"]');
    await settled();
    await p.shot('mock-desktop-dark');
    await p.scheme('light');

    await requests();
    ok(seen.every((r) => r.method === 'GET' || (r.method === 'POST' && ['/api/login', '/api/logout'].includes(r.path))), 'the desk only reads: every request is a GET, apart from sign-in and sign-out');
  } else {
    // Live mode: the fixture devices come from the seed's private state file (keys never printed).
    const stateFile = arg('--seed-state') || path.join(os.tmpdir(), 'owntube-desk-seed', `${new URL(LIVE).hostname}-${new URL(LIVE).port}.json`);
    if (!fs.existsSync(stateFile)) throw new Error(`No seed state at ${stateFile}: run tests/seed-dev.mjs first.`);
    const seed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const dev = (role) => seed.devices.find((d) => d.role === role);
    console.log(`Live: ${BASE} (fixture devices from the seed)`);
    await p.go(`${BASE}/`);
    ok(await signIn(), 'signs in with the owner key and opens Watched');
    await settled();
    const all = await inPage('/api/history', { days: 7, device: '', person: '', query: '', page: 1 });
    ok(Number(await p.eval(() => document.querySelector('[data-ledger]').dataset.seconds)) === all.seconds && all.seconds > 0, `the ledger matches the server (${all.seconds} s, ${all.count} entries)`);
    ok(JSON.stringify(await rowIds()) === JSON.stringify(all.rows.map((r) => r.id)), 'rows match the server page, in its order');
    ok(await p.eval(() => [...document.querySelectorAll('[data-row]')].every((r) => Number(r.dataset.fg) + Number(r.dataset.bg) + Number(r.dataset.un) === Number(r.dataset.s))), 'every entry’s context adds up to its watched time');
    const laptop = dev('browser');
    await p.select('#f-device', laptop.deviceId);
    await settled();
    const lap = await inPage('/api/history', { days: 7, device: laptop.deviceId, person: '', query: '', page: 1 });
    ok(Number(await p.eval(() => document.querySelector('[data-ledger]').dataset.seconds)) === lap.seconds && lap.pages > 1, `the fixture browser scope matches the server and spans ${lap.pages} pages`);
    ok(/on-tab/.test(await text('[data-split]')) && !/foreground/.test(await text('[data-split]')), 'the browser fixture is named on-tab (kind inferred by the server)');
    const days = await p.eval(() => [...document.querySelectorAll('.day')].map((d) => d.dataset.date));
    ok(days.length && days.every((d, i) => i === 0 || d < days[i - 1]) && days.every((d) => lap.rows.some((r) => r.date === d)), 'day groups follow the server’s dates, newest first');
    const lapAll = [];
    for (let pg = 1; pg <= lap.pages; pg++) lapAll.push(...(await inPage('/api/history', { days: 7, device: laptop.deviceId, person: '', query: '', page: pg, generation: lap.generation, until: lap.until })).rows);
    const legacy = lapAll.find((r) => r.rowKind === 'legacy-day');
    const split = lapAll.filter((r) => r.viewingId && r.viewingId === lapAll.find((x) => x.title?.includes('(revised)'))?.viewingId);
    ok(!!legacy && legacy.viewingId === null, 'the legacy fixture is grouped as a legacy day with no viewing identity');
    ok(split.length === 1 && split[0].versionCount === 2 && new Set(split[0].versions.map((r) => r.metadataId)).size === 2, 'the metadata change stays within one viewing with two evidence versions');
    const midnight = lapAll.filter((r) => r.title === 'Night train across midnight');
    ok(midnight.length === 2 && midnight[0].viewingId === midnight[1].viewingId && midnight[0].date !== midnight[1].date, 'the viewing across midnight gives one entry per server date');
    ok(lapAll.some((r) => r.coverageComplete === false), 'a viewing with a slice without ranges is reported as partial coverage');
    await p.click('[data-key="page:next"]');
    await settled();
    ok((await p.eval(() => location.hash)).includes('page=2') && JSON.stringify(await rowIds()) === JSON.stringify((await inPage('/api/history', { days: 7, device: laptop.deviceId, person: '', query: '', page: 2, generation: lap.generation, until: lap.until })).rows.map((r) => r.id)), 'page 2 shows the server’s page 2 of the same snapshot');
    if (legacy) {
      const pageOf = Math.floor(lapAll.indexOf(legacy) / 20) + 1;
      if (pageOf !== 2) { await p.go(`${BASE}/#/history?device=${encodeURIComponent(laptop.deviceId)}&page=${pageOf}`); await settled(); }
      ok((await text(`[data-row="${legacy.id}"] .hrow__time`)) === 'Recorded that day', 'the legacy entry reads “Recorded that day”');
    }
    // A new upload changes the generation; the next page of the old snapshot must be refused.
    await p.go(`${BASE}/#/history?device=${encodeURIComponent(laptop.deviceId)}`);
    await settled();
    await p.click('[data-key="page:next"]');
    await settled();
    const t = Date.now() - 60000;
    const ingest = await fetch(`${LIVE}/api/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${laptop.token}` }, body: JSON.stringify({ deviceId: laptop.deviceId, events: [{ eventId: `desk-check-${t}`, kind: 'viewing', viewingId: `desk-check-${t}-v`, revision: 1, bucket: Math.floor(t / 900000) * 900000, t, lastWatched: t + 30000, seconds: 30, videoId: 'fxDeskChk01', title: 'Arrived while the desk check was paging', channel: 'Desk check', isShort: false, lang: 'en', source: 'audio-track', conf: 'high', durationSeconds: 600, coverage: [[0, 30]], playbackContext: 'foreground' }], evidence: {} }) });
    ok(ingest.ok, 'a fictional upload through the seeded browser device is accepted');
    await p.click('[data-key="page:prev"]');
    await settled();
    ok(/no longer available/.test(await text('[data-notice]') || '') && /page 1 of/.test(await text('[data-status]')), 'the next page of the old snapshot is refused (410) and the desk restarts at page 1 with a notice');
    // Evidence: exact text and digest from the real server.
    const withEvidence = (await inPage('/api/history', { days: 7, device: laptop.deviceId, person: '', query: '', page: 1 })).rows.find((r) => r.evidenceId);
    await p.click(`[data-key="ev:${withEvidence.id}"]`);
    await p.waitFor(() => !!document.querySelector('#dlg[open] [data-ev-collector]'));
    await p.click('#dlg [data-raw-details] > summary');
    const ev = await inPage('/api/history/evidence', { device: withEvidence.deviceId, metadata: withEvidence.metadataId });
    ok((await p.eval(() => document.querySelector('#dlg code[data-raw="exact"]')?.textContent)) === ev.evidenceText && sha256(ev.evidenceText) === ev.evidenceId, 'the raw view is the server’s exact text and its SHA-256 is the evidence ID');
    ok(await p.waitFor(() => /Matches/.test(document.querySelector('#dlg [data-digest]')?.textContent || '')), 'the browser’s digest check agrees');
    await p.key('Escape', 27);
    // Searches on the fixture devices.
    await p.click('[data-key="tab:d:searches"]');
    await settled();
    const ls = await inPage('/api/history/searches', { days: 7, device: laptop.deviceId, person: '', query: '', page: 1 });
    ok(Number(await p.eval(() => document.querySelector('[data-search-ledger]').dataset.count)) === ls.count && ls.count > 20 && ls.searchCapability === 'recorded', `Searches matches the server for the browser fixture (${ls.count} searches, recorded)`);
    await typeFilter('zahnrad');
    const lz = await inPage('/api/history/searches', { days: 7, device: laptop.deviceId, person: '', query: 'zahnrad', page: 1 });
    ok((await text('[data-status]')).startsWith(`${lz.filteredCount} of ${ls.count} searches match`), 'the server filters every search, not just the loaded page');
    ok(await p.eval(() => window.__deskXss === undefined), 'hostile fixture text never runs');
    await p.select('#f-device', dev('tv').deviceId);
    await settled();
    ok((await text('[data-search-ledger] .fig__n')) === '—' && /doesn’t record searches/.test(await text('[data-empty="not-recorded"]')), 'the TV fixture is “not recorded on TVs” (inferred from its evidence)');
    await p.select('#f-device', dev('unknown').deviceId);
    await settled();
    ok(/No searches recorded/.test(await text('[data-empty="none"]')) && /can’t say/.test(await text('[data-empty="none"]')), 'the unidentified fixture shows no searches recorded, without a capability claim');
    await p.size(390, 844, 2);
    await p.click('[data-key="tab:m:watched"]');
    await settled();
    const over = await overflow();
    ok(over.length === 0, `phone: nothing is wider than the screen with the long fixture names ${over.length ? JSON.stringify(over) : ''}`);
    await p.shot('live-phone-watched');
    await p.size(1440, 900);
  }
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.log(`  FAIL threw: ${error.message}`);
} finally {
  ok(p.errors.length === 0, `no page errors${p.errors.length ? `:\n${p.errors.join('\n')}` : ''}`);
  console.log(`\n${passed} passed, ${failures.length} failed · screenshots: ${OUT}`);
  chrome.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
  await mockServer?.close();
  await proxy?.close();
  process.exit(failures.length ? 1 : 0);
}
