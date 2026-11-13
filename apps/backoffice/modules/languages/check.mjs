#!/usr/bin/env node
// Behaviour check for the Languages module. Zero dependencies (Node 22+).
//
//   node apps/backoffice/modules/languages/check.mjs
//       Mock mode: an in-process mock of contracts/languages.md (video groups and the bulk
//       endpoint, served by the demo adapter) on an ephemeral loopback port, with auth, recorded
//       requests and injected failures, driven through the real api.js in an isolated headless Chromium.
//   node apps/backoffice/modules/languages/check.mjs --live http://127.0.0.1:3211 --token-file <admin-token>
//       Live mode: the same UI against a real LOCAL server seeded with fictional fixtures
//       (tests/seed-dev.mjs and apps/backoffice/desk/tests/seed-dev.mjs). Refuses non-loopback URLs.
//       Performs real, audited assessment actions on those fixtures.
//
// Chromium blocks every non-loopback host, so thumbnails never leave the machine. Screenshots go
// to $OWNTUBE_CHECK_OUT or <os tmpdir>/owntube-languages-check.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const LIVE = argv.includes('--live') ? argv[argv.indexOf('--live') + 1] : null;
const TOKEN_FILE = argv.includes('--token-file') ? argv[argv.indexOf('--token-file') + 1] : null;
const OUT = process.env.OWNTUBE_CHECK_OUT || path.join(os.tmpdir(), 'owntube-languages-check');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
setTimeout(() => { console.error('check timed out'); process.exit(2); }, 240_000).unref();

if (LIVE && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(LIVE).hostname)) {
  console.error('Live mode only runs against a loopback server.');
  process.exit(2);
}

/* ------------------------------------------------------------------ mock contract server */

async function startMock() {
  const { createDemoApi } = await import(path.join(DIR, 'demo.js'));
  const api = await createDemoApi({ external: true });
  const KEY = 'correct horse battery';
  // ungrouped: answer like a server that ignores group=video (one row per version).
  // comparison: a fixed GET response for the comparison view, to render states the demo data cannot produce.
  const mock = { fail: null, expire: false, external: false, xss: false, long: false, ungrouped: false, comparison: null, requests: [] };
  // Worst case for phone wrapping: an unbroken 60-character channel token and a long device label.
  const longRow = () => ({
    deviceId: 'demo-laptop', deviceLabel: 'Laptop in the guest apartment upstairs (Chrome profile two)', metadataId: 'mock-long', videoId: 'longLong001',
    title: 'Restoration notes', channel: 'Restoration_and_repair_notes_from_a_small_workshop_in_the_alps', seconds: 120,
    foregroundSeconds: 100, backgroundSeconds: 20, unspecifiedSeconds: 0, lastWatched: Date.now() - 120000, evidenceId: null,
    recorded: { lang: 'en', source: 'collector-source-name-that-is-unusually-long-and-unbroken', conf: 'medium' },
    assessment: { lang: 'en', status: 'estimated', source: 'collector:collector-source-name-that-is-unusually-long-and-unbroken', confidence: 'medium', reason: 'Original collector estimate.' },
    revision: 0, needsReview: true, contextOverride: null,
  });
  const xssText = JSON.stringify({ schemaVersion: 1, algorithmVersion: 'language-v2', title: '<img src=x onerror="window.__langXss=4">', description: '</pre><script>window.__langXss=5</script> & <b>text</b>', descriptionSource: 'videoDetails.shortDescription', descriptionTruncated: false, selectedAudioLanguage: '', defaultAudioLanguage: '', captions: [] });
  const xssRow = () => ({
    deviceId: 'demo-laptop', deviceLabel: 'Laptop', metadataId: 'mock-xss', videoId: 'xssXss00001', title: '<img src=x onerror="window.__langXss=1"> Hostile title',
    channel: '<b>Bold channel</b>', seconds: 60, foregroundSeconds: 60, backgroundSeconds: 0, unspecifiedSeconds: 0, lastWatched: Date.now() - 60000,
    evidenceId: sha256(xssText), recorded: { lang: '', source: '<script>window.__langXss=2</script>', conf: '' },
    assessment: { lang: 'und', status: 'undetermined', source: 'collector', confidence: 'unavailable', reason: '<img src=x onerror="window.__langXss=3">' }, revision: 0, needsReview: true, contextOverride: null,
  });
  // One version as a video group, shaped like the server's group=video rows.
  const groupOf = (r) => ({
    id: r.videoId, videoId: r.videoId, title: r.title, channel: r.channel, seconds: r.seconds, foregroundSeconds: r.foregroundSeconds,
    backgroundSeconds: r.backgroundSeconds, unspecifiedSeconds: r.unspecifiedSeconds, lastWatched: r.lastWatched, deviceLabel: r.deviceLabel,
    devices: [{ id: r.deviceId, label: r.deviceLabel, contextOverride: null }], versionCount: 1, matchedVersionCount: 1, versions: [r],
    assessment: r.assessment, recorded: r.recorded, needsReview: r.needsReview,
  });
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : null); } catch { resolve(s); } }); });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const body = req.method === 'POST' ? await readBody(req) : null;
    if (url.pathname === '/__mock') { Object.assign(mock, body || {}); return send(res, 200, { ok: true }); }
    if (url.pathname === '/__mock/requests') { const r = mock.requests; mock.requests = []; return send(res, 200, r); }
    if (url.pathname === '/__mock/bump') { // another tab changed one version
      const ev = await api.evidence(body.deviceId, body.metadataId);
      await api.assess({ deviceId: body.deviceId, metadataId: body.metadataId, baseRevision: ev.revision, action: 'reset', note: 'changed elsewhere' });
      return send(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) {
      mock.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      const authed = /(?:^|;\s*)observer_session=ok/.test(req.headers.cookie || '') && !mock.expire;
      if (url.pathname === '/api/login') {
        if (body?.token !== KEY) return send(res, 401, { error: 'Unauthorized' });
        mock.expire = false;
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'observer_session=ok; Path=/api; HttpOnly; SameSite=Strict' });
      }
      if (url.pathname === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'observer_session=; Path=/api; Max-Age=0' });
      if (!authed) return send(res, 401, { error: 'Unauthorized' });
      if (url.pathname === '/api/session') return send(res, 200, { ok: true });
      try {
        if (url.pathname === '/api/modules/languages/comparison') {
          if (req.method !== 'POST' && mock.comparison) return send(res, 200, mock.comparison);
          return send(res, 200, req.method === 'POST' ? await api.saveComparison(body) : await api.comparison(Object.fromEntries(url.searchParams)));
        }
        if (url.pathname === '/api/modules/languages') {
          if (mock.fail === 'list500') return send(res, 500, { error: 'Database is busy.' });
          const params = Object.fromEntries(url.searchParams);
          if (mock.ungrouped) delete params.group;
          const data = await api.languages(params);
          if (!mock.external) data.providers = data.providers.filter((p) => p.id !== 'external');
          const wrap = params.group === 'video' ? groupOf : (r) => r;
          if (mock.xss) data.videos.unshift(wrap(xssRow()));
          if (mock.long) data.videos.unshift(wrap(longRow()));
          return send(res, 200, data);
        }
        if (url.pathname === '/api/modules/languages/evidence') {
          if (url.searchParams.get('metadata') === 'mock-xss') {
            const r = xssRow();
            return send(res, 200, { videoId: r.videoId, title: r.title, deviceId: r.deviceId, metadataId: r.metadataId, evidenceId: r.evidenceId, evidenceText: xssText, evidence: JSON.parse(xssText), recorded: r.recorded, assessment: r.assessment, revision: 0, history: [{ revision: 1, action: 'manual', lang: 'en', status: 'confirmed', source: 'manual', confidence: 'human', reason: '<script>window.__langXss=6</script>', note: '<img src=x onerror="window.__langXss=7">', createdAt: Date.now() }], historyLimit: 100, historyHasMore: true });
          }
          if (url.searchParams.get('metadata') === 'mock-long') {
            const r = longRow();
            return send(res, 200, { videoId: r.videoId, title: r.title, deviceId: r.deviceId, metadataId: r.metadataId, evidenceId: null, evidenceText: null, evidence: null, recorded: r.recorded, assessment: r.assessment, revision: 0, history: [], historyLimit: 100, historyHasMore: false });
          }
          return send(res, 200, await api.evidence(url.searchParams.get('device'), url.searchParams.get('metadata')));
        }
        if (url.pathname === '/api/modules/languages/assessment') return send(res, 200, await api.assess(body));
        if (url.pathname === '/api/modules/languages/assessment/bulk') {
          if (mock.saveDelay) await sleep(mock.saveDelay);
          if (mock.fail === 'save500') return send(res, 500, { error: 'Could not save classification.' });
          return send(res, 200, await api.assessBulk(body));
        }
      } catch (error) {
        return send(res, error.status || 500, { error: error.message });
      }
      return send(res, 404, { error: 'Not found' });
    }
    if (url.pathname === '/shared/recorded-versions.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return fs.createReadStream(path.join(DIR, '../../shared/recorded-versions.js')).pipe(res);
    }
    const rel = url.pathname.replace(/^\/modules\/languages\/?/, '') || 'index.html';
    const file = path.join(DIR, rel);
    if (!url.pathname.startsWith('/modules/languages/') || !file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, key: KEY, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
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
  if (fs.existsSync('/Applications/Helium.app/Contents/MacOS/Helium')) return '/Applications/Helium.app/Contents/MacOS/Helium';
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
  async size(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    await this.send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  }
  async go(url) {
    this.nav = (this.nav || 0) + 1;
    const u = new URL(url);
    u.searchParams.set('n', String(this.nav));
    const loaded = new Promise((r) => this.loads.push(r));
    await this.send('Page.navigate', { url: u.toString() });
    await Promise.race([loaded, sleep(8000)]);
    await sleep(400);
  }
  async eval(fn, ...args) {
    const r = await this.send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(fn, ...args) {
    for (let i = 0; i < 60; i++) { if (await this.eval(fn, ...args)) return true; await sleep(100); }
    return false;
  }
  async click(sel) {
    const ok = await this.waitFor((s) => !!document.querySelector(s), sel);
    if (!ok) throw new Error(`missing ${sel}`);
    const pt = await this.eval((s) => { const el = document.querySelector(s); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1 });
    await sleep(250);
  }
  async key(key, keyCode) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: keyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode });
    await sleep(150);
  }
  async type(text) { await this.send('Input.insertText', { text }); await sleep(80); }
  async select(sel, value) {
    await this.eval((s, v) => { const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, sel, value);
    await sleep(300);
  }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  }
}

/* ------------------------------------------------------------------ run */

let passed = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) passed++; else failures.push(msg); console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`); };
fs.mkdirSync(OUT, { recursive: true });
const mockServer = LIVE ? null : await startMock();
const BASE = LIVE || mockServer.base;
const KEY = LIVE ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : mockServer.key;
const MODULE = `${BASE}/modules/languages/`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'owntube-languages-profile-'));
const chrome = spawn(findChrome(), ['--headless=new', '--use-mock-keychain', '--password-store=basic', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--hide-scrollbars',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'], { stdio: 'ignore' });
const portFile = path.join(profile, 'DevToolsActivePort');
for (let i = 0; i < 300 && !fs.existsSync(portFile); i++) await sleep(50);
const p = await Page.open(fs.readFileSync(portFile, 'utf8').split('\n')[0]);

const control = (body) => fetch(`${BASE}/__mock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const requests = async () => (await fetch(`${BASE}/__mock/requests`)).json();
const inPage = (p2, q) => p.eval(async (pathname, query) => (await fetch(`${pathname}?${new URLSearchParams(query)}`, { credentials: 'same-origin' })).json(), p2, q);
const ledgerSeconds = () => p.eval(() => Number(document.querySelector('[data-ledger]')?.dataset.seconds));
const signIn = async () => {
  await p.waitFor(() => !!document.getElementById('owner-key'));
  await p.click('#owner-key');
  await p.type(KEY);
  await p.click('form[data-form="login"] button[type="submit"]');
  return p.waitFor(() => !!document.querySelector('[data-ledger]'));
};

try {
  await p.size(1440, 900);
  if (!LIVE) {
    console.log('Sign-in gate');
    await requests();
    await p.go(MODULE);
    ok(await p.waitFor(() => !!document.getElementById('owner-key')), 'without a session the module asks for the owner key');
    ok((await requests()).every((r) => r.path === '/api/session'), 'nothing but the session check is requested before sign-in');
    await p.click('#owner-key');
    await p.type('wrong key');
    await p.click('form[data-form="login"] button[type="submit"]');
    ok(await p.waitFor(() => /wasn’t accepted/.test(document.querySelector('.login__error')?.textContent || '')), 'a wrong key is refused with an explanation');
    await p.eval(() => { document.getElementById('owner-key').value = ''; });
    ok(await signIn(), 'the owner key signs in and loads Languages');
    const first = (await requests()).filter((r) => r.path === '/api/modules/languages');
    ok(first.length >= 1 && JSON.stringify(first.at(-1).query) === JSON.stringify({ days: '7', device: '', person: '', language: 'all', status: 'all', query: '', page: '1', group: 'video' }), 'first request carries the contract’s default parameters and asks for video groups');
    ok(await p.eval(() => document.getElementById('demo').hidden && !/Demo data|Sample data/.test(document.body.textContent)), 'live mode shows no demo or sample labels');
    ok(await p.eval(() => document.querySelector('#nav [data-nav="history"]')?.getAttribute('href') === '../../#/history' && document.querySelector('#nav [data-nav="languages"]')?.getAttribute('aria-current') === 'page' && document.querySelector('[data-key="mast:legacy"]')?.getAttribute('href') === '../../legacy/'), 'live navigation leads to the History desk and the legacy dashboard');

    console.log('One row per video');
    const g7 = await inPage('/api/modules/languages', { days: 7, device: '', person: '', language: 'all', status: 'all', query: '', page: 1, group: 'video' });
    const g7b = await inPage('/api/modules/languages', { days: 7, device: '', person: '', language: 'all', status: 'all', query: '', page: 2, group: 'video' });
    const groups = [...g7.videos, ...g7b.videos];
    const nachr = groups.find((g) => g.videoId === 'demoNachr17');
    const nachrRow = await p.eval(() => { const r = document.querySelector('[data-row="demoNachr17"]'); return r && { versions: Number(r.dataset.versions), seconds: Number(r.dataset.seconds), meta: r.querySelector('.meta').textContent, count: document.querySelectorAll('[data-row="demoNachr17"]').length }; });
    ok(nachrRow?.count === 1 && nachrRow.versions === 17 && /17 recorded versions/.test(nachrRow.meta), 'one video with 17 recorded versions is one row');
    ok(nachrRow.seconds === nachr.versions.reduce((s, v) => s + v.seconds, 0) && nachrRow.seconds === nachr.seconds, 'the row’s time is the sum of all its versions');
    const onPage = await p.eval(() => ({ rows: document.querySelectorAll('[data-videos] .vrow').length, versions: [...document.querySelectorAll('[data-videos] .vrow')].reduce((s, r) => s + Number(r.dataset.versions), 0), count: document.querySelector('[data-count]')?.textContent }));
    ok(onPage.rows === 20 && onPage.versions > 20 && onPage.count.startsWith(`${g7.count} videos`), `videos page independently of their versions (20 videos holding ${onPage.versions} versions; “${onPage.count}”)`);
    ok(g7b.videos.length === g7.count - 20 && !g7b.videos.some((g) => g7.videos.some((x) => x.id === g.id)), 'page 2 continues with the next videos, none repeated');
    const weekly = await p.eval(() => { const r = document.querySelector('[data-row="demoWeekly05"]'); return r && { text: r.querySelector('.assess').textContent, review: !!r.querySelector('.flag-review') }; });
    ok(weekly && /English\s*en/.test(weekly.text) && /Estimated/.test(weekly.text) && /from the selected audio track/.test(weekly.text) && !weekly.review, 'five versions whose saved selected audio says English read “English · Estimated” and need no review');
    const stalker = await p.eval(() => document.querySelector('[data-row="demoStalker11"] .assess')?.textContent || '');
    ok(/Mixed/.test(stalker) && /versions differ/.test(stalker) && /German ×1/.test(stalker) && /English ×1/.test(stalker), 'versions that disagree show Mixed with quiet counts, never one confident language');
    ok(await p.eval(() => { const r = document.querySelector('[data-row="demoBrahms006"]'); return !!r && /Mixed/.test(r.textContent) && !!r.querySelector('.flag-review'); }), 'a video with one classified and two unknown versions is Mixed and still needs review');
    ok(await p.eval(() => /Living room TV, Laptop|Laptop, Living room TV/.test(document.querySelector('[data-row="demoStalker11"] .meta').textContent)), 'a row names every device its versions played on');
    await p.click('[data-key="f:status:confirmed"]');
    ok(await p.waitFor(() => /1 of 3 versions match/.test(document.querySelector('[data-row="demoBrahms006"] [data-matched]')?.textContent || '')), 'a filter that matches some versions keeps the whole video and says how many match');
    await p.click('[data-key="f:status:all"]');
    await p.eval(() => document.getElementById('videos-h').scrollIntoView({ block: 'start' }));
    await p.shot('mock-videos');

    console.log('Scope and filters');
    const api7 = g7;
    ok((await ledgerSeconds()) === api7.seconds, 'ledger shows the response’s scope total');
    ok(await p.eval((d) => { const c = document.querySelector('[data-context]'); return !c || Number(c.dataset.fg) + Number(c.dataset.bg) + Number(c.dataset.un) === d; }, api7.seconds), 'context split covers the whole total');
    ok(await p.eval(() => document.querySelectorAll('[data-languages] .lang').length > 0 && !!document.querySelector('.lang--und') && /Not one spoken language/.test(document.querySelector('[data-languages]').textContent)), 'mixed, no speech and unknown are listed apart from spoken languages');
    await requests();
    await p.click('[data-key="f:status:review"]');
    let last = (await requests()).filter((r) => r.path === '/api/modules/languages').at(-1);
    ok(last?.query.status === 'review' && last.query.page === '1' && last.query.group === 'video', 'status filter is sent to the server');
    ok((await ledgerSeconds()) === api7.seconds, 'status filter never changes the scope numbers');
    await p.click('[data-key="lang:de"]');
    last = (await requests()).filter((r) => r.path === '/api/modules/languages').at(-1);
    ok(last?.query.language === 'de' && (await p.eval(() => document.querySelector('[data-key="lang:de"]').getAttribute('aria-pressed'))) === 'true', 'choosing a language filters the videos and is shown as pressed');
    await p.click('[data-key="f:status:all"]');
    await p.click('[data-key="lang:de"]');
    await p.click('#f-query');
    await p.type('rhine');
    await sleep(600);
    last = (await requests()).filter((r) => r.path === '/api/modules/languages').at(-1);
    ok(last?.query.query === 'rhine' && (await p.eval(() => document.querySelectorAll('[data-videos] .vrow').length)) === 1, 'search is debounced, sent and narrows the videos');
    await p.eval(() => { const i = document.getElementById('f-query'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(600);
    await p.select('#f-person', 'demo-owner');
    last = (await requests()).filter((r) => r.path === '/api/modules/languages').at(-1);
    ok(last?.query.person === 'demo-owner', 'person filter is offered for more than one person and sent');
    await p.select('#f-person', '');
    await p.select('#f-device', 'demo-living');
    last = (await requests()).filter((r) => r.path === '/api/modules/languages').at(-1);
    ok(last?.query.device === 'demo-living', 'device filter is sent');
    await p.select('#f-device', '');
    await p.click('[data-key="f:days:90"]');
    await p.click('[data-key="page:next"]');
    last = (await requests()).filter((r) => r.path === '/api/modules/languages').at(-1);
    ok(last?.query.page === '2' && last.query.days === '90' && /Page 2 of/.test(await p.eval(() => document.querySelector('.pager__at')?.textContent || '')), 'paging asks for the next 20 videos');
    ok(await p.eval(() => location.hash.includes('days=90') && location.hash.includes('page=2')), 'filters live in the URL, so reload and back work');
    await p.click('[data-key="f:days:7"]');
    await p.shot('mock-desktop');

    console.log('One decision for every version');
    await requests();
    await p.click('[data-key="act:demoNachr17"]');
    ok(await p.waitFor(() => !!document.querySelector('#dlg[open] [data-assessment]')), 'Review opens the video’s inspector');
    let req = await requests();
    let evReq = req.filter((r) => r.path === '/api/modules/languages/evidence');
    ok(evReq.length === 1 && evReq[0].query.device === nachr.versions[0].deviceId && evReq[0].query.metadata === nachr.versions[0].metadataId, 'it opens on the newest version and reads only that version’s evidence');
    ok(/Applies to all 17 recorded versions in this scope/.test(await p.eval(() => document.querySelector('#dlg [data-scope]')?.textContent || '')) && /last 7 days, all devices/.test(await p.eval(() => document.querySelector('#dlg [data-scope]').textContent)), 'the scope is said in one line: all 17 recorded versions in this scope');
    ok(/Playback on Living room TV counts as foreground \(owner correction/.test(await p.eval(() => document.querySelector('#dlg [data-context-override]')?.textContent || '')), 'a context correction on the device is noted quietly');
    const pick = nachr.versions[5];
    const pickKey = `${pick.deviceId}:${pick.metadataId}`;
    await p.select('#f-version', pickKey);
    await p.waitFor((m) => document.querySelector('#dlg [data-version]')?.dataset.version.endsWith(m) && !!document.querySelector('#dlg [data-assessment]'), pick.metadataId);
    req = await requests();
    evReq = req.filter((r) => r.path === '/api/modules/languages/evidence');
    ok(evReq.at(-1)?.query.metadata === pick.metadataId && /6 of 17/.test(await p.eval(() => document.getElementById('ins-ver').textContent)), 'choosing another version loads that version’s evidence and audit');
    await p.select('#f-lang', 'de');
    await p.click('#f-note');
    await p.type('Evening news in German, every version.');
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok' && /all 17 recorded versions/.test(document.querySelector('#dlg [data-alert]').textContent)), 'one save confirms all 17 versions');
    req = await requests();
    const bulk = req.filter((r) => r.path === '/api/modules/languages/assessment/bulk');
    const expectBody = { videoId: 'demoNachr17', targets: nachr.versions.map((v) => ({ deviceId: v.deviceId, metadataId: v.metadataId, baseRevision: v.revision })), action: 'manual', lang: 'de', note: 'Evening news in German, every version.' };
    ok(bulk.length === 1 && JSON.stringify(bulk[0].body) === JSON.stringify(expectBody), 'it is one atomic request listing every version with its expected revision');
    ok(!req.some((r) => r.path === '/api/modules/languages/assessment'), 'no per-version requests are sent for a whole-video decision');
    ok((await p.eval(() => document.getElementById('f-version')?.value)) === pickKey, 'the selected version stays selected after saving');
    const nachrAfter = (await inPage('/api/modules/languages', { days: 7, device: '', person: '', language: 'all', status: 'all', query: 'demoNachr17', page: 1, group: 'video' })).videos[0];
    ok(nachrAfter.versions.every((v) => v.assessment.source === 'manual' && v.assessment.lang === 'de') && !nachrAfter.needsReview, 'all 17 versions now carry the decision; the video needs no review');
    ok(await p.waitFor(() => !document.querySelector('[data-row="demoNachr17"] .flag-review') && /Classified/.test(document.querySelector('#dlg [data-audit]')?.textContent || '')), 'the list and the selected version’s audit show it');

    console.log('A stale version refuses the whole decision');
    const bumped = nachrAfter.versions[3];
    await fetch(`${BASE}/__mock/bump`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: bumped.deviceId, metadataId: bumped.metadataId }) });
    await p.select('#f-lang', 'en');
    await p.click('#f-note');
    await p.type('Actually English.');
    await requests();
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'review' && /Nothing was saved/.test(document.querySelector('#dlg [data-alert]').textContent) && !!document.querySelector('#dlg [data-key="ins:refresh"]')), 'a stale revision (409) says nothing was saved and offers a refresh');
    const nachrStale = (await inPage('/api/modules/languages', { days: 7, device: '', person: '', language: 'all', status: 'all', query: 'demoNachr17', page: 1, group: 'video' })).videos[0];
    ok(nachrStale.versions.filter((v) => v.metadataId !== bumped.metadataId).every((v) => v.assessment.lang === 'de' && v.revision === nachrAfter.versions.find((x) => x.metadataId === v.metadataId).revision), 'no version changed: the request was all or nothing');
    await p.click('#dlg [data-key="ins:refresh"]');
    await p.waitFor(() => !document.querySelector('#dlg [data-alert]') && !!document.querySelector('#dlg [data-assessment]'));
    ok((await p.eval(() => document.getElementById('f-note')?.value)) === 'Actually English.', 'your note survives the refresh');
    await requests();
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok'), 'after refreshing, the same decision saves');
    req = await requests();
    ok(req.find((r) => r.path === '/api/modules/languages/assessment/bulk')?.body.targets.find((t) => t.metadataId === bumped.metadataId)?.baseRevision === nachrStale.versions.find((v) => v.metadataId === bumped.metadataId).revision, 'and it carries the refreshed revision of the changed version');
    await p.shot('mock-inspector');
    await p.key('Escape', 27);
    ok(await p.eval(() => !document.getElementById('dlg').open && document.activeElement?.dataset.key === 'act:demoNachr17'), 'Esc closes the inspector and returns focus to the row');

    console.log('A dub: the selected version only');
    await p.click('[data-key="act:demoStalker11"]');
    await p.waitFor(() => !!document.querySelector('#dlg[open] [data-assessment]'));
    ok(await p.eval(() => { const c = document.querySelector('#dlg [data-conflict]'); return c?.dataset.conflict === 'assessment' && /don’t agree on the audio: .*English on Laptop/.test(c.textContent) && /German on Living room TV/.test(c.textContent); }), 'versions that disagree are flagged before an all-versions decision');
    const stalkerG = groups.find((g) => g.videoId === 'demoStalker11');
    await p.click('#dlg [data-key="ins:target:one"]');
    ok(/Applies only to the selected version/.test(await p.eval(() => document.querySelector('#dlg [data-scope]').textContent)) && !(await p.eval(() => document.querySelector('#dlg [data-conflict]'))), 'Selected version only says so and drops the warning');
    await requests();
    await p.select('#f-lang', 'en');
    await p.click('#dlg [data-key="ins:save"]');
    await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok');
    req = await requests();
    const one = req.find((r) => r.path === '/api/modules/languages/assessment');
    ok(one && !req.some((r) => r.path === '/api/modules/languages/assessment/bulk') && one.body.deviceId === stalkerG.versions[0].deviceId && one.body.metadataId === stalkerG.versions[0].metadataId && one.body.action === 'manual' && one.body.lang === 'en', 'it sends one per-version request for the selected version');
    const stalkerAfter = (await inPage('/api/modules/languages', { days: 7, device: '', person: '', language: 'all', status: 'all', query: 'demoStalker11', page: 1, group: 'video' })).videos[0];
    ok(stalkerAfter.versions.find((v) => v.metadataId === stalkerG.versions[1].metadataId).assessment.lang === 'de', 'the other version keeps its own language');
    await p.key('Escape', 27);
    // One language for both: the interpretations agree now, but the collector's recorded audio
    // still differs, and the warning says it is the collector's.
    await p.click('[data-key="act:demoStalker11"]');
    await p.waitFor(() => !!document.querySelector('#dlg[open] [data-assessment]'));
    await p.select('#f-lang', 'de');
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => {
      const c = document.querySelector('#dlg [data-conflict]');
      return document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok' && c?.dataset.conflict === 'recorded'
        && /^The collector recorded different audio for these versions:/.test(c.textContent) && /English on Laptop/.test(c.textContent) && /German on Living room TV/.test(c.textContent);
    }), 'after one language for both, the collector’s different recorded audio is still named, as the collector’s');
    await p.key('Escape', 27);
    // The collector's unknown ("other") beside known English is no possible dub.
    await p.eval(() => { const i = document.getElementById('f-query'); i.value = 'demoWeekly05'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.waitFor(() => document.querySelectorAll('[data-videos] .vrow').length === 1 && !!document.querySelector('[data-row="demoWeekly05"]'));
    const weeklyG = groups.find((g) => g.videoId === 'demoWeekly05');
    await p.click('[data-key="act:demoWeekly05"]');
    await p.waitFor(() => !!document.querySelector('#dlg[open] [data-assessment]'));
    ok(weeklyG.versions.filter((v) => v.recorded.lang === 'other').length === 2 && weeklyG.versions.filter((v) => v.recorded.lang === 'en').length === 3
      && await p.eval(() => !document.querySelector('#dlg [data-conflict]')), 'versions the collector recorded as unknown (“other”) beside known English raise no dub warning');
    await p.key('Escape', 27);
    await p.eval(() => { const i = document.getElementById('f-query'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.waitFor(() => document.querySelectorAll('[data-videos] .vrow').length > 1);

    console.log('Single-version videos and per-version actions');
    await requests();
    await p.click('[data-key="act:demoLathe0005"]');
    await p.waitFor(() => !!document.querySelector('#dlg[open] [data-assessment]'));
    const lathe = groups.find((g) => g.videoId === 'demoLathe0005');
    ok(!(await p.eval(() => document.getElementById('f-version') || document.querySelector('#dlg [data-key="ins:target:one"]'))) && /Applies to this video’s recorded version/.test(await p.eval(() => document.querySelector('#dlg [data-scope]').textContent)), 'a one-version video has no version picker or target choice');
    ok((await p.eval(() => document.getElementById('f-provider'))) === null, 'one provider: no analysis choice is shown');
    await p.click('#dlg [data-raw-details] > summary');
    const ev = await inPage('/api/modules/languages/evidence', { device: lathe.versions[0].deviceId, metadata: lathe.versions[0].metadataId });
    ok((await p.eval(() => document.querySelector('#dlg code[data-raw="exact"]')?.textContent)) === ev.evidenceText && await p.waitFor(() => /Matches/.test(document.querySelector('#dlg [data-digest]')?.textContent || '')), 'raw view is the exact saved text and its digest matches');
    await p.select('#f-lang', 'mul');
    await p.click('#f-note');
    await p.type('Two languages, half each.');
    await requests();
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok'), 'saving a classification confirms it');
    let post = (await requests()).find((r) => r.path === '/api/modules/languages/assessment/bulk');
    ok(JSON.stringify(post?.body) === JSON.stringify({ videoId: 'demoLathe0005', targets: [{ deviceId: lathe.versions[0].deviceId, metadataId: lathe.versions[0].metadataId, baseRevision: lathe.versions[0].revision }], action: 'manual', lang: 'mul', note: 'Two languages, half each.' }), 'the bulk body matches the contract exactly');
    ok(await p.waitFor(() => /Classified/.test(document.querySelector('#dlg [data-audit]')?.textContent || '') && document.querySelector('#dlg [data-key="ins:analyze"]').disabled), 'the audit shows it, and analysis is locked while it stands');
    await p.click('#dlg [data-key="ins:reset"]');
    ok(await p.waitFor(() => /Reset/.test(document.querySelector('#dlg [data-audit]')?.textContent || '') && !document.querySelector('#dlg [data-key="ins:analyze"]').disabled), 'reset is audited and unlocks analysis');
    ok(/collector, from the audio track/.test(await p.eval(() => document.querySelector('#dlg [data-assessment]').textContent)), 'reset restores the collector’s original interpretation');
    await requests();
    await p.click('#dlg [data-key="ins:analyze"]');
    await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok');
    const an = (await requests()).find((r) => r.path === '/api/modules/languages/assessment');
    ok(an?.body.action === 'analyze' && an.body.provider === 'saved-evidence' && an.body.metadataId === lathe.versions[0].metadataId, 'analysis runs on the selected version with the saved-evidence provider');
    await p.key('Escape', 27);

    console.log('Providers');
    await control({ external: true });
    await p.click('[data-key="f:days:30"]');
    await p.click('[data-key="f:days:7"]');
    await p.click('[data-key="act:demoTop100009"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    ok(await p.eval(() => document.getElementById('f-provider')?.options.length === 2), 'an advertised external API appears as a choice');
    await p.select('#f-provider', 'external');
    ok(/no media, no keys/.test(await p.eval(() => document.querySelector('#dlg [data-provider-note]').textContent)), 'the external choice says exactly what is sent');
    await p.key('Escape', 27);
    await control({ external: false });

    console.log('Failures, hostile text and compatibility');
    await control({ fail: 'list500' });
    await p.click('[data-key="f:days:30"]');
    ok(await p.waitFor(() => /Database is busy/.test(document.querySelector('.problem')?.textContent || '')), 'a server error shows its message and a retry');
    await control({ fail: null });
    await p.click('[data-key="retry"]');
    ok(await p.waitFor(() => !document.querySelector('.problem') && !!document.querySelector('[data-ledger]')), 'retry recovers');
    await control({ xss: true });
    await p.eval(() => { delete window.__langXss; });
    await p.click('[data-key="f:days:7"]');
    await p.click('[data-key="open:xssXss00001"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    await p.click('#dlg [data-raw-details] > summary');
    const injected = await p.eval(() => ({
      ran: window.__langXss,
      img: document.querySelectorAll('img[src="x"]').length,
      script: document.querySelectorAll('#main script, #dlg script').length,
      // Only the payload's own tags count; the UI's own <b> numbers are expected.
      markup: [...document.querySelectorAll('b, i')].filter((x) => /^(Bold channel|Old channel|text|markup|bold)$/.test(x.textContent.trim())).map((x) => x.outerHTML),
    }));
    ok(injected.ran === undefined && injected.img === 0 && injected.script === 0 && injected.markup.length === 0, `hostile titles, reasons, notes and evidence never run or render as markup ${JSON.stringify(injected)}`);
    ok(await p.eval(() => document.querySelector('[data-key="open:xssXss00001"]').textContent.includes('<img src=x') && document.querySelector('#dlg [data-description]').textContent.includes('<script>')), 'hostile text is shown literally');
    ok(await p.eval(() => !!document.querySelector('#dlg [data-history-more]')), 'a truncated history says older entries are kept');
    await p.key('Escape', 27);
    await p.click('[data-key="act:demoMarket25"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    ok(await p.eval(() => window.__langXss === undefined && [...document.querySelectorAll('#f-version option')].some((o) => o.textContent.includes('<img src=x')) && !document.querySelector('#dlg img')), 'an older version’s hostile title shows literally in the version picker');
    await p.key('Escape', 27);
    await control({ xss: false, ungrouped: true });
    await p.click('[data-key="f:days:30"]');
    const flat = await inPage('/api/modules/languages', { days: 30, device: '', person: '', language: 'all', status: 'all', query: '', page: 1 });
    ok(await p.waitFor((n) => document.querySelectorAll('[data-videos] .vrow').length === n && !document.querySelector('[data-videos] [data-version-count]'), flat.videos.length), 'a server without grouping still lists each version as its own row');
    await p.click('[data-videos] .vrow [data-action="open"]');
    ok(await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]')), 'and its inspector still opens');
    await p.key('Escape', 27);
    await control({ ungrouped: false, expire: true });
    await p.click('[data-key="f:days:7"]');
    ok(await p.waitFor(() => !!document.getElementById('owner-key')), 'an expired session returns to sign-in');
    ok(await signIn(), 'signing in again restores the view');

    console.log('Quick row languages');
    const quickGroup = async () => (await inPage('/api/modules/languages', { days: 7, group: 'video', query: 'demoWeekly05' })).videos[0];
    const quickBefore = await quickGroup();
    const originalEvidence = await inPage('/api/modules/languages/evidence', { device: quickBefore.versions[0].deviceId, metadata: quickBefore.versions[0].metadataId });
    ok(await p.eval(() => [...document.querySelectorAll('[data-row="demoWeekly05"] [data-action="quick-language"]')].map(b => b.textContent).join(' ') === '? DE EN BCS'), 'each row offers ?, DE, EN and BCS');
    const quickDone = () => p.waitFor(() => {
      const row = document.querySelector('[data-row="demoWeekly05"]');
      return row?.querySelector('.quick-language')?.getAttribute('aria-busy') === 'false'
        && row.querySelector('[data-quick-status]')?.textContent.startsWith('Saved');
    });
    for (const lang of ['und', 'de', 'en', 'bcs']) {
      const before = await quickGroup();
      await requests();
      await p.click(`[data-key="quick:demoWeekly05:${lang}"]`);
      ok(await quickDone(), `quick ${lang} saves without opening an inspector`);
      const writes = (await requests()).filter(r => r.method === 'POST');
      ok(writes.length === 1 && writes[0].path.endsWith('/assessment/bulk')
        && writes[0].body.lang === lang && writes[0].body.action === 'manual'
        && JSON.stringify(writes[0].body.targets) === JSON.stringify(before.versions.map(v => ({ deviceId: v.deviceId, metadataId: v.metadataId, baseRevision: v.revision }))),
      `quick ${lang} is one revision-checked decision for the row's five versions`);
      const after = await quickGroup();
      ok(after.versions.every(v => v.assessment.lang === lang && v.assessment.source === 'manual'
        && v.assessment.status === (lang === 'und' ? 'undetermined' : 'confirmed'))
        && await p.eval(code => !document.querySelector('#dlg').open
          && document.querySelector(`[data-key="quick:demoWeekly05:${code}"]`).getAttribute('aria-pressed') === 'true', lang),
      `quick ${lang} updates every version and highlights the saved choice`);
    }
    const evidenceAfter = await inPage('/api/modules/languages/evidence', { device: quickBefore.versions[0].deviceId, metadata: quickBefore.versions[0].metadataId });
    ok(evidenceAfter.evidenceText === originalEvidence.evidenceText
      && evidenceAfter.history.length === originalEvidence.history.length + 4
      && (await ledgerSeconds()) === g7.seconds, 'quick changes are audited, preserve exact evidence and leave total watch time unchanged');
    await p.eval(() => document.querySelector('[data-row="demoWeekly05"]').scrollIntoView({ block: 'center' }));
    await p.shot('mock-quick-languages');
    const beforeConflict = await quickGroup();
    await fetch(`${BASE}/__mock/bump`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(beforeConflict.versions[0]) });
    await p.click('[data-key="quick:demoWeekly05:en"]');
    ok(await p.waitFor(() => /Nothing was saved/.test(document.querySelector('[data-row="demoWeekly05"] [data-quick-status]')?.textContent || '')),
      'a quick stale revision reports failure inline');
    const conflicted = await quickGroup();
    ok(conflicted.versions.slice(1).every(v => v.assessment.lang === 'bcs'), 'a stale quick change cannot partially overwrite other versions');
    await p.click('[data-key="quick-refresh:demoWeekly05"]');
    await p.waitFor(() => !document.querySelector('[data-row="demoWeekly05"] [data-quick-status]'));
    await control({ saveDelay: 600 });
    await requests();
    await p.eval(() => {
      document.querySelector('[data-key="quick:demoWeekly05:de"]').click();
      document.querySelector('[data-key="quick:demoWeekly05:en"]').click();
    });
    ok(await p.eval(() => [...document.querySelectorAll('[data-row="demoWeekly05"] [data-action="quick-language"]')].every(b => b.disabled)), 'quick buttons disable while a save is pending');
    await quickDone();
    ok((await requests()).filter(r => r.method === 'POST').length === 1, 'rapid repeated clicks produce only one save');
    await control({ saveDelay: 0, fail: 'save500' });
    await p.click('[data-key="quick:demoWeekly05:en"]');
    ok(await p.waitFor(() => /Could not save classification/.test(document.querySelector('[data-row="demoWeekly05"] [data-quick-status]')?.textContent || ''))
      && (await quickGroup()).versions.every(v => v.assessment.lang === 'de'), 'failed saves show an inline error without changing the language');
    await control({ fail: null });
    await p.click('[data-key="quick-refresh:demoWeekly05"]');
    await p.waitFor(() => !document.querySelector('[data-row="demoWeekly05"] [data-quick-status]'));
    await p.click('[data-key="quick:demoWeekly05:und"]');
    await quickDone();
    await p.click('[data-key="f:status:review"]');
    await p.click('[data-key="quick:demoWeekly05:bcs"]');
    ok(await p.waitFor(() => !document.querySelector('[data-row="demoWeekly05"]'))
      && await p.eval(() => document.querySelector('[data-key="f:status:review"]').getAttribute('aria-pressed') === 'true'),
      'confirming from Needs review removes the resolved row and keeps the filter');
    await p.click('[data-key="f:status:all"]');

    console.log('Inspector Save & close');
    await p.click('[data-key="act:demoWeekly05"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    await requests();
    await p.click('[data-key="dlg:done"]');
    ok(await p.eval(() => !document.querySelector('#dlg').open)
      && !(await requests()).some(r => r.method === 'POST'), 'Close without edits makes no assessment');
    await p.click('[data-key="act:demoWeekly05"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    await p.select('#f-lang', 'de');
    ok(await p.eval(() => document.querySelector('[data-key="dlg:done"]').textContent === 'Save & close'), 'editing the language turns the footer into Save & close');
    await control({ fail: 'save500' });
    await p.click('[data-key="dlg:done"]');
    ok(await p.waitFor(() => document.querySelector('#dlg').open && document.querySelector('#dlg [data-alert]')?.dataset.alert === 'bad')
      && await p.eval(() => document.querySelector('#f-lang').value === 'de'), 'a failed footer save keeps the inspector open with the edited language');
    await control({ fail: null });
    await p.click('[data-key="dlg:done"]');
    ok(await p.waitFor(() => !document.querySelector('#dlg').open)
      && (await quickGroup()).versions.every(v => v.assessment.lang === 'de'), 'Save & close persists German for every version before closing');
    await p.click('[data-key="act:demoWeekly05"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    const footerVersion = await p.eval(() => document.querySelector('#f-version').value);
    await p.click('[data-key="ins:target:one"]');
    await p.select('#f-lang', 'en');
    await p.click('[data-key="dlg:done"]');
    await p.waitFor(() => !document.querySelector('#dlg').open);
    ok((await quickGroup()).versions.every(v => v.assessment.lang === (`${v.deviceId}:${v.metadataId}` === footerVersion ? 'en' : 'de')),
      'Save & close respects Selected version only');

    console.log('Phone width with long real-world text');
    // The production overflow: a long channel name in a review row could not wrap (nowrap) and
    // pushed the page 5 px wide at 390 px. Same sequence as the production check: review filter,
    // open and close the first inspector, then 390 × 844 at scale 1 and two animation frames.
    const overflowAt390 = async () => {
      await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      return p.eval(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(
        [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
          .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).trim().replace(/\s+/g, '.')} “${e.textContent.trim().slice(0, 40)}” right ${Math.round(e.getBoundingClientRect().right)}`),
      )))));
    };
    await p.size(1440, 900);
    await p.click('[data-key="f:days:7"]');
    ok(await p.waitFor(() => (document.querySelector('[data-row="demoNeonSign24"] .meta')?.textContent || '').includes('Northfield Workshop Restoration and Repair Notes')), 'fixture: a video with a long multi-word channel name is listed');
    await p.click('[data-videos] .vrow [data-action="open"]');
    await p.waitFor(() => !!document.querySelector('#dlg[open] [data-assessment]'));
    await p.key('Escape', 27);
    let over = await overflowAt390();
    ok(over.length === 0, `390 px after the inspector: nothing wider than the viewport ${over.length ? JSON.stringify(over) : ''}`);
    // Fully visible = the whole value, inside its row (not just inside the viewport), on more than one line.
    const contained = (rowSel, text) => p.eval((sel, t) => {
      const row = document.querySelector(sel);
      const s = row && [...row.querySelectorAll('.meta > span')].find((x) => x.textContent.startsWith(t));
      if (!s) return 'missing';
      const r = s.getBoundingClientRect(); const body = row.querySelector('.vrow__body').getBoundingClientRect();
      const cs = getComputedStyle(s); const lh = cs.lineHeight.endsWith('px') ? parseFloat(cs.lineHeight) : parseFloat(cs.lineHeight) * parseFloat(cs.fontSize);
      return { full: s.textContent.startsWith(t), inside: r.left >= body.left - 0.5 && r.right <= body.right + 0.5, lines: Math.round(r.height / lh) };
    }, rowSel, text);
    const neon = await contained('[data-row="demoNeonSign24"]', 'Northfield Workshop Restoration and Repair Notes');
    ok(neon.full && neon.inside && neon.lines >= 2, `the long channel name wraps inside its row and stays fully visible ${JSON.stringify(neon)}`);
    await control({ long: true });
    await p.size(1440, 900);
    await p.click('[data-key="f:days:30"]');
    await p.click('[data-key="f:days:7"]');
    await p.waitFor(() => !!document.querySelector('[data-row="longLong001"]'));
    over = await overflowAt390();
    ok(over.length === 0, `390 px with an unbroken 60-character channel and a long device label: nothing overflows ${over.length ? JSON.stringify(over) : ''}`);
    const token = await contained('[data-row="longLong001"]', 'Restoration_and_repair_notes_from_a_small_workshop_in_the_alps');
    const label = await contained('[data-row="longLong001"]', 'Laptop in the guest apartment upstairs (Chrome profile two)');
    ok(token.full && token.inside && token.lines >= 2 && label.full && label.inside, `the unbroken channel token and long device label stay whole and inside the row ${JSON.stringify({ token, label })}`);
    await p.eval(() => document.querySelector('[data-row="longLong001"]').scrollIntoView({ block: 'start' }));
    await p.shot('mock-phone-long-rows');
    await p.eval(() => document.querySelector('[data-key="open:longLong001"]').click());
    await p.waitFor(() => !!document.querySelector('#dlg[open] [data-assessment]'));
    ok(await p.eval(() => { const d = document.getElementById('dlg'); const m = d.querySelector('.ins__meta'); return d.scrollWidth <= d.clientWidth + 1 && m.textContent.includes('Restoration_and_repair_notes_from_a_small_workshop_in_the_alps') && m.getBoundingClientRect().right <= d.getBoundingClientRect().right; }), 'the inspector at 390 px wraps the same long values instead of scrolling sideways');
    await p.shot('mock-phone-long-inspector');
    await p.key('Escape', 27);
    await control({ long: false });

    console.log('Phone and demo');
    await p.size(390, 844, true);
    await p.go(`${MODULE}`);
    await p.waitFor(() => !!document.querySelector('[data-ledger]'));
    ok(await p.eval(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no horizontal scrolling');
    ok(await p.eval(() => { const h = [...document.querySelectorAll('[data-heading]')].find((x) => x.offsetParent); return !!h && h.getBoundingClientRect().top < document.getElementById('f-device').getBoundingClientRect().top; }), 'phone: heading comes before the filters');
    await p.click('[data-key="act:demoNachr17"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    ok(await p.eval(() => { const d = document.getElementById('dlg'); return d.scrollWidth <= d.clientWidth + 1; }), 'phone: the video inspector, with its version picker, fits the width');
    await p.shot('mock-phone-inspector');
    await p.key('Escape', 27);
    await p.size(1440, 900);
    await requests();
    await p.go(`${MODULE}?demo=1`);
    await p.waitFor(() => !!document.querySelector('[data-ledger]'));
    ok(await p.eval(() => !document.getElementById('demo').hidden && /Demo data/.test(document.querySelector('[data-ledger]').textContent)), 'demo mode is labelled on every view');
    ok((await requests()).length === 0, 'demo mode makes no API requests');
    await p.shot('demo-desktop');
  } else {
    console.log(`Live: ${BASE}`);
    await p.go(MODULE);
    ok(await signIn(), 'signs in with the owner key and loads Languages');
    const api30 = await inPage('/api/modules/languages', { days: 30, device: '', person: '', language: 'all', status: 'all', query: '', page: 1, group: 'video' });
    await p.click('[data-key="f:days:30"]');
    await p.waitFor((s) => Number(document.querySelector('[data-ledger]')?.dataset.seconds) === s, api30.seconds);
    ok((await ledgerSeconds()) === api30.seconds && api30.seconds > 0, `ledger matches the server (${api30.seconds} s)`);
    ok(await p.eval((ids) => JSON.stringify([...document.querySelectorAll('[data-videos] .vrow')].map((r) => r.dataset.row)) === JSON.stringify(ids), api30.videos.map((g) => g.id)), `rows are the server’s video groups, in its order (${api30.count} videos)`);
    ok(Array.isArray(api30.providers) && api30.providers.some((x) => x.id === 'saved-evidence'), 'server advertises saved-evidence analysis');
    // A two-version fictional video (Desk check fixtures): one decision, one atomic request.
    const derby = (await inPage('/api/modules/languages', { days: 30, device: '', person: '', language: 'all', status: 'all', query: 'fxDeskDerby', page: 1, group: 'video' })).videos.find((g) => g.videoId === 'fxDeskDerby');
    ok(derby?.versionCount === 2 && derby.seconds === derby.versions.reduce((s, v) => s + v.seconds, 0), 'the server groups the two versions of the fictional Derby video, with summed time');
    await p.click('#f-query');
    await p.type('fxDeskDerby');
    await p.waitFor(() => !!document.querySelector('[data-row="fxDeskDerby"]'));
    ok(await p.eval(() => document.querySelectorAll('[data-row="fxDeskDerby"]').length === 1 && /2 recorded versions/.test(document.querySelector('[data-row="fxDeskDerby"] .meta').textContent)), 'it is one row naming its two versions');
    await p.click('[data-key="act:fxDeskDerby"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    await p.select('#f-lang', 'en');
    await p.click('#f-note');
    await p.type('Check: English commentary in both versions.');
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok' && /all 2 recorded versions/.test(document.querySelector('#dlg [data-alert]').textContent)), 'one save confirms both versions on the real server');
    let after = (await inPage('/api/modules/languages', { days: 30, device: '', person: '', language: 'all', status: 'all', query: 'fxDeskDerby', page: 1, group: 'video' })).videos[0];
    ok(after.versions.every((v) => v.assessment.source === 'manual' && v.assessment.lang === 'en' && v.revision > 0) && !after.needsReview, 'the server stores the decision on both versions');
    // Another tab resets one version: the next whole-video decision must be refused as a whole.
    const other = after.versions[1];
    await p.eval(async (body) => fetch('/api/modules/languages/assessment', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { deviceId: other.deviceId, metadataId: other.metadataId, baseRevision: other.revision, action: 'reset', note: 'check: changed in another tab' });
    await p.select('#f-lang', 'de');
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'review'), 'a stale version is refused by the server (409)');
    const stale = (await inPage('/api/modules/languages', { days: 30, device: '', person: '', language: 'all', status: 'all', query: 'fxDeskDerby', page: 1, group: 'video' })).videos[0];
    ok(stale.versions.find((v) => v.metadataId === after.versions[0].metadataId).assessment.lang === 'en', 'nothing was saved: the other version is unchanged');
    await p.click('#dlg [data-key="ins:refresh"]');
    await p.waitFor(() => !document.querySelector('#dlg [data-alert]') && !!document.querySelector('#dlg [data-assessment]'));
    await p.click('#dlg [data-key="ins:reset"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok' && /Reset all 2/.test(document.querySelector('#dlg [data-alert]').textContent)), 'after refreshing, both versions reset together');
    after = (await inPage('/api/modules/languages', { days: 30, device: '', person: '', language: 'all', status: 'all', query: 'fxDeskDerby', page: 1, group: 'video' })).videos[0];
    ok(after.versions.every((v) => v.assessment.source !== 'manual'), 'the server restored both versions’ original interpretation');
    await p.key('Escape', 27);
    // The cross-device dub: the selected version alone.
    await p.eval(() => { const i = document.getElementById('f-query'); i.value = 'fxStalk0011'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.waitFor(() => !!document.querySelector('[data-row="fxStalk0011"]'));
    const stalk = (await inPage('/api/modules/languages', { days: 30, device: '', person: '', language: 'all', status: 'all', query: 'fxStalk0011', page: 1, group: 'video' })).videos.find((g) => g.videoId === 'fxStalk0011');
    ok(stalk?.versionCount === 2 && stalk.devices.length === 2, 'the dub on the TV and the original on the laptop are one video with two versions');
    await p.click('[data-key="act:fxStalk0011"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    const tv = stalk.versions.find((v) => v.deviceLabel === 'Living room TV') || stalk.versions[0];
    await p.select('#f-version', `${tv.deviceId}:${tv.metadataId}`);
    await p.waitFor((m) => document.querySelector('#dlg [data-version]')?.dataset.version.endsWith(m) && !!document.querySelector('#dlg [data-assessment]'), tv.metadataId);
    await p.click('#dlg [data-key="ins:target:one"]');
    const evTv = await inPage('/api/modules/languages/evidence', { device: tv.deviceId, metadata: tv.metadataId });
    if (evTv.evidenceText) {
      await p.click('#dlg [data-raw-details] > summary');
      ok((await p.eval(() => document.querySelector('#dlg code[data-raw="exact"]')?.textContent)) === evTv.evidenceText && sha256(evTv.evidenceText) === evTv.evidenceId, 'raw view is the server’s exact text and its SHA-256 is the evidence ID');
    }
    await p.select('#f-lang', 'de');
    await p.click('#f-note');
    await p.type('Check: German dub heard on the TV.');
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok'), 'the selected version alone saves on the real server');
    const final = await inPage('/api/modules/languages/evidence', { device: tv.deviceId, metadata: tv.metadataId });
    ok(final.assessment.source === 'manual' && final.assessment.lang === 'de' && final.history[0].note === 'Check: German dub heard on the TV.', 'the server stores it with its note');
    ok(await p.eval(() => document.querySelector('#dlg [data-key="ins:analyze"]').disabled), 'analysis is locked after a manual classification');
    const laptop = (await inPage('/api/modules/languages', { days: 30, device: '', person: '', language: 'all', status: 'all', query: 'fxStalk0011', page: 1, group: 'video' })).videos[0].versions.find((v) => v.metadataId !== tv.metadataId);
    ok(!laptop || laptop.assessment.lang !== 'de' || laptop.assessment.source !== 'manual', 'the laptop’s version keeps its own language');
    await p.shot('live-inspector');
    await p.key('Escape', 27);
    // Quick controls use the real server's audited bulk endpoint too.
    await p.eval(() => { const i = document.getElementById('f-query'); i.value = 'fxDeskDerby'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.waitFor(() => !!document.querySelector('[data-row="fxDeskDerby"]'));
    for (const lang of ['bcs', 'und']) {
      await p.click(`[data-key="quick:fxDeskDerby:${lang}"]`);
      ok(await p.waitFor(() => document.querySelector('[data-row="fxDeskDerby"] .quick-language')?.getAttribute('aria-busy') === 'false'
        && document.querySelector('[data-row="fxDeskDerby"] [data-quick-status]')?.textContent.startsWith('Saved')), `live quick ${lang} finishes inline`);
      const changed = (await inPage('/api/modules/languages', { days: 30, group: 'video', query: 'fxDeskDerby' })).videos[0];
      ok(changed.versions.every(v => v.assessment.lang === lang && v.assessment.source === 'manual'),
        `live quick ${lang} saves both versions through the real API`);
    }
    await p.click('[data-key="act:fxDeskDerby"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    await p.select('#f-lang', 'de');
    await p.click('[data-key="dlg:done"]');
    ok(await p.waitFor(() => !document.querySelector('#dlg').open)
      && (await inPage('/api/modules/languages', { days: 30, group: 'video', query: 'fxDeskDerby' })).videos[0].versions.every(v => v.assessment.lang === 'de'),
      'live Save & close persists the selected language before closing');
    await p.shot('live-desktop');
  }

  console.log('Searchable occasional languages');
  const video = LIVE ? 'fxDeskDerby' : 'demoWeekly05';
  await p.go(`${MODULE}#days=30&query=${video}`);
  await p.waitFor((id) => !!document.querySelector(`[data-key="other:${id}"]`), video);
  const group = async () => (await inPage('/api/modules/languages', { days: 30, group: 'video', query: video })).videos[0];
  const beforeOther = await group();
  const originalTotal = await ledgerSeconds();
  for (const [search, lang] of [['Russian', 'ru'], ['Japanese', 'ja']]) {
    await p.click(`[data-key="other:${video}"]`);
    await p.waitFor(() => !!document.querySelector('.language-picker[open]'));
    await p.click('#language-search'); await p.type(search);
    ok(await p.eval((code) => document.querySelectorAll('[data-picker-code]').length === 1 && document.querySelector('[data-picker-code]').dataset.pickerCode === code, lang), `${search} is found by name`);
    await p.click(`[data-picker-code="${lang}"]`);
    await p.waitFor((id) => document.querySelector(`[data-row="${id}"] .quick-language`)?.getAttribute('aria-busy') === 'false'
      && document.querySelector(`[data-row="${id}"] [data-quick-status]`)?.textContent.startsWith('Saved'), video);
    ok((await group()).versions.every((v) => v.assessment.lang === lang), `${search} saves every scoped version through the audited bulk flow`);
  }
  ok((await ledgerSeconds()) === originalTotal && (await group()).versions.every((v) => v.revision === beforeOther.versions.find((old) => old.metadataId === v.metadataId && old.deviceId === v.deviceId).revision + 2), 'occasional languages preserve totals and add exactly two audit revisions');
  await p.click(`[data-key="other:${video}"]`);
  await p.click('#language-search'); await p.type('ja');
  ok(await p.eval(() => !!document.querySelector('[data-picker-code="ja"]')), 'language codes are searchable too');
  await p.size(390, 844, true);
  ok(await p.eval(() => { const d = document.querySelector('.language-picker'); return d.scrollWidth <= d.clientWidth && d.getBoundingClientRect().right <= innerWidth; }), 'searchable picker fits the phone');
  await p.shot(`${LIVE ? 'live' : 'mock'}-language-picker`);
  await p.key('Escape', 27);
  ok(await p.eval((id) => document.activeElement?.dataset.key === `other:${id}`, video), 'Escape closes the picker and restores row focus');

  console.log('Comparison arithmetic');
  const { rateStory, shareStory, dayGap, percentText, rangeText } = await import(path.join(DIR, 'comparison.js'));
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  {
    const s = rateStory(47760 / 60 / 5, 30132 / 60 / 2);
    ok(s.state === 'lead' && s.leader === 1 && s.rates[0] === 159.2 && s.rates[1] === 251.1 && s.delta === 91.9 && s.base === 159.2 && near(s.percent, (91.9 / 159.2) * 100),
      'the difference is the gap between the two displayed one-decimal rates, relative to the lower one');
    const first = rateStory(10, 4);
    ok(first.state === 'lead' && first.leader === 0 && first.delta === 6 && near(first.percent, 150), 'the first group can be the higher one; neither group is assumed to be the baseline');
    const zero = rateStory(0, 22.5);
    ok(zero.state === 'lead' && zero.leader === 1 && zero.delta === 22.5 && zero.percent === null, 'a zero lower rate gives an absolute difference and no percentage');
    ok(rateStory(0.1, 0.3).delta === 0.2 && rateStory(0, 0).state === 'none' && rateStory(null, 5).state === 'incomplete' && rateStory(5, undefined).state === 'incomplete',
      'differences carry no floating-point noise; no playback and missing groups are their own states');
    ok(rateStory(80, 80).state === 'same' && rateStory(80, 80).exact === true && rateStory(80.01, 80.04).state === 'same' && rateStory(80.01, 80.04).exact === false,
      'rates that print identically are reported as the same, exactly or approximately');
    const trace = rateStory(0.04, 12);
    ok(trace.state === 'lead' && trace.leader === 1 && trace.delta === 12 && trace.percent === null && trace.trace === true && zero.trace === false && s.trace === false
      && rateStory(12, 0.04).trace === true && rateStory(12, 0).trace === false, 'a lower rate that only prints as 0.0 is marked as a trace, never as none');
    ok(rateStory(0.04, 0).state === 'same' && rateStory(0.04, 0).exact === false && rateStory(0.02, 0.04).state === 'same', 'a trace against zero is about the same, not no playback');
    const share = shareStory(95.52, 50.22);
    ok(share.state === 'lead' && share.leader === 0 && share.points === 45.3 && shareStory(50.22, 95.52).leader === 1 && shareStory(30, 30.2).points === 0.2,
      'share differences are percentage points between the two printed shares, with their own higher group');
    ok(shareStory(null, 40).state === 'incomplete' && shareStory(40, undefined).state === 'incomplete' && shareStory(40, 40).state === 'same' && shareStory(40, 40).exact === true
      && shareStory(40.01, 40.04).exact === false && shareStory(0, 0).state === 'same', 'a share without a denominator gives no difference; equal shares are their own state');
    ok(rateStory(47760 / 60 / 5, 30132 / 60 / 2).leader === 1 && shareStory(47760 / 50000 * 100, 30132 / 60000 * 100).leader === 0, 'the daily-rate leader and the share leader are derived independently and can differ');
    const g = dayGap(5, 2);
    ok(g.missing === 3 && g.shorter === 1 && g.longest === 5 && !g.equal && dayGap(2, 5).shorter === 0 && dayGap(7, 7).equal && dayGap(7, 7).shorter === null && dayGap(4, 0).missing === 4 && dayGap(4, 0).shorter === 1,
      'the shorter group and the number of days it needs to match are derived from calendar days');
    ok(percentText(57.726) === '+57.7%' && percentText(150) === '+150%' && percentText(1300) === '14× as much' && percentText(null) === '',
      'relative differences print as a signed percentage, then as a multiple');
    ok(rangeText({ start: '2026-11-07', end: '2026-11-11' }) === '7–11 Nov 2026' && rangeText({ start: '2026-10-28', end: '2026-11-03' }) === '28 Oct – 3 Nov 2026'
      && rangeText({ start: '2025-12-20', end: '2026-01-05' }) === '20 Dec 2025 – 5 Jan 2026' && rangeText({ start: '2026-11-13', end: '2026-11-13' }) === '13 Nov 2026' && rangeText({ start: '', end: '' }) === 'Incomplete period',
      'saved periods read as compact inclusive date ranges');
  }
  // The rendered lead must agree with the API response it was built from.
  const leadMatches = (result) => {
    const s = rateStory(result.groups[0].minutesPerDay, result.groups[1].minutesPerDay);
    const gap = dayGap(result.groups[0].calendarDays, result.groups[1].calendarDays);
    return p.eval((s, gap) => {
      const hero = document.querySelector('.cmp-hero'), cover = document.querySelector('.cmp-cover');
      const rates = [...document.querySelectorAll('[data-group-result]')].map((r) => r.dataset.rate);
      return hero?.dataset.story === s.state && hero.dataset.leader === String(s.leader ?? '') && hero.dataset.delta === String(s.delta ?? '')
        && (!s.rates || rates.join() === s.rates.join()) && (!cover || (cover.dataset.missing === String(gap.missing) && cover.dataset.equal === String(gap.equal)));
    }, s, gap);
  };
  const settled = () => p.waitFor(() => document.querySelector('[data-compare-results]')?.getAttribute('aria-busy') === 'false' && !document.querySelector('[data-compare="reload"]').disabled);
  const openEditor = async () => {
    if (await p.eval(() => document.querySelector('[data-key="compare:edit"]')?.getAttribute('aria-expanded') === 'false')) await p.click('[data-key="compare:edit"]');
  };

  console.log('Saved period comparison');
  const compareApi = (body) => p.eval(async (body) => {
    const r = await fetch('/api/modules/languages/comparison', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: r.status, data: await r.json() };
  }, body);
  const initial = (await compareApi()).data;
  await compareApi({ baseRevision: initial.config.baseRevision, groups: [{ label: 'Using it', ranges: [] }, { label: 'Not using it', ranges: [] }] });
  await p.size(1440, 1000);
  await p.click('[data-key="view:compare"]');
  await p.waitFor(() => !!document.querySelector('[data-compare="save"]'));
  ok(await p.eval(() => document.querySelector('#f-days').parentElement.hidden && location.hash.includes('view=compare')), 'comparison has its own date ranges and a bookmarkable view');
  await settled();
  ok(await p.eval(() => document.querySelector('.cmp-hero')?.dataset.story === 'incomplete' && !!document.querySelector('.compare__empty') && !document.querySelector('.cmp-cover')
    && document.querySelector('[data-key="compare:edit"]').getAttribute('aria-expanded') === 'true' && !!document.querySelector('#group-0') && document.querySelector('[data-compare="save"]').hidden),
    'with no saved periods the editor is open, nothing is compared, and there is nothing to save yet');
  const dates = Array.from({ length: 9 }, (_, n) => new Date(Date.parse(initial.today + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10));
  async function field(key, value) {
    await p.eval((key, value) => { const el = document.querySelector(`[data-key="${key}"]`); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, key, value);
  }
  let addFocus = true;
  for (const [i, start, end] of [[0, dates[2], dates[0]], [0, dates[2], dates[0]], [0, dates[8], dates[8]], [1, dates[6], dates[3]]]) {
    await p.click(`[data-key="compare:add:${i}"]`);
    const j = await p.eval((i) => document.querySelectorAll(`input[data-group="${i}"][data-compare-field="start"]`).length - 1, i);
    addFocus &&= await p.eval((key) => document.activeElement?.dataset.key === key, `compare:${i}:${j}:start`);
    await field(`compare:${i}:${j}:start`, start); await field(`compare:${i}:${j}:end`, end);
  }
  ok(addFocus, 'adding a period moves focus to its new From date');
  ok(await p.eval(() => !document.querySelector('[data-compare="save"]').hidden && document.querySelector('.compare__actions [role="status"]').textContent === 'Unsaved changes'
    && document.querySelector('[data-compare="reload"]').textContent === 'Discard edits'), 'editing dates reveals Save & compare and marks the draft as unsaved');
  await p.click('[data-compare="save"]');
  await p.waitFor(() => document.querySelector('[data-compare="save"]')?.textContent === 'Save & compare' && !!document.querySelector('.compare__table')
    && document.querySelector('[data-compare-results]')?.getAttribute('aria-busy') === 'false');
  let result = (await compareApi()).data;
  ok(await p.eval(() => !document.querySelector('.compare input') && document.querySelector('[data-key="compare:edit"]').getAttribute('aria-expanded') === 'false'
    && document.querySelector('[data-compare="save"]').hidden && document.querySelectorAll('.compare__group')[0].querySelectorAll('.cmp-periods li').length === 3
    && document.querySelector('.compare__setup, .cmp-setup').getBoundingClientRect().bottom < document.querySelector('.cmp-headline').getBoundingClientRect().top),
    'after saving, the editor folds into a summary of the saved periods above the result');
  ok(await p.eval(() => document.activeElement?.dataset.key === 'compare:edit'), 'after saving, focus moves from the vanished Save button to the Edit toggle');
  ok(await leadMatches(result) && await p.eval(() => /averaged|recorded/.test(document.querySelector('.cmp-headline').textContent)
    && document.querySelectorAll('[data-group-result]').length === 2), 'the lead sentence, both rates and the day gap match the saved comparison response');
  ok(await p.eval((groups) => groups.every((g, i) => {
    const row = document.querySelector(`[data-cover="${i}"]`);
    return row && Number(row.dataset.days) === g.calendarDays && Number(row.dataset.active) === g.activeDays
      && row.querySelectorAll('.cmp-day:not(.cmp-day--need)').length === g.calendarDays && row.querySelector('[role="img"]').getAttribute('aria-label').includes(`${g.calendarDays} selected calendar day`);
  }), result.groups), 'each group shows one cell per unique selected calendar day, with a text equivalent and its days with playback');
  ok(await p.eval((groups) => {
    const langs = new Set(groups.flatMap((g) => g.languages.map((l) => l.lang)));
    const rows = [...document.querySelectorAll('.cmp-row[data-lang]')];
    return rows.length === langs.size && rows.every((r) => langs.has(r.dataset.lang) && r.querySelectorAll('.cmp-row__bar').length === 2);
  }, result.groups), 'every recorded language gets one row with a bar for each group');
  ok(result.groups[0].calendarDays === 4 && result.groups[1].calendarDays === 4 && result.config.groups[0].ranges.length === 3, 'multiple ranges persist, with duplicate days counted only once');
  ok(result.groups[0].includesToday && await p.eval(() => document.querySelector('[data-cover="0"]').dataset.today === 'true' && document.querySelectorAll('[data-cover="0"] .cmp-day--today').length === 1
    && !document.querySelector('[data-cover="1"] .cmp-day--today') && document.querySelector('[data-group-result="0"]').textContent.includes('today partial')
    && document.querySelector('.cmp-cover').textContent.includes('today, not over yet')), 'today is identified as partial');
  ok(result.groups.every((g) => Math.abs(g.minutesPerDay - g.seconds / 60 / g.calendarDays) < 1e-8
    && Math.abs(g.languages.reduce((n, l) => n + l.seconds, 0) - g.seconds) < 1e-6), 'daily averages and language totals reconcile for both groups');
  const allLanguageGroups = structuredClone(result.groups);
  ok(await p.eval(() => [...document.querySelectorAll('.compare__group')].every((g) => {
    const period = g.querySelector('[data-compare="add"]');
    return period?.parentElement === g.querySelector('[data-compare="add-language"]')?.parentElement;
  })), 'each period group places Add language beside Add period');
  await p.click('[data-key="compare:add-language:1"]');
  ok(await p.eval((available) => JSON.stringify([...document.querySelectorAll('[data-picker-code]')].map((b) => b.dataset.pickerCode).sort()) === JSON.stringify(available.slice().sort()), result.availableLanguages),
    'comparison suggestions are exactly the languages recorded across the saved periods');
  await p.click('#language-search'); await p.type('eo');
  ok(await p.eval(() => !document.querySelector('[data-picker-code]') && document.querySelector('.language-picker__results').textContent.includes('No matching recorded language')),
    'search cannot introduce an unrecorded language code into comparison suggestions');
  await p.key('Escape', 27);
  for (const [name, lang] of [['German', 'de'], ['Japanese', 'ja'], ['German', 'de']]) {
    await p.click('[data-key="compare:add-language"]');
    await p.click('#language-search'); await p.type(name);
    await p.click(`[data-picker-code="${lang}"]`);
    await p.waitFor((l) => !!document.querySelector(`[data-key="compare:language:${l}"]`), lang);
  }
  ok(await p.eval(() => document.querySelectorAll('[data-compare="remove-language"]').length === 2
    && document.querySelector('.compare__actions [role="status"]').textContent === 'Unsaved changes'), 'search adds a shared language set to the draft without duplicates or immediate saves');
  await p.click('[data-compare="remove-language"][data-lang="ja"]');
  ok(await p.eval(() => !document.querySelector('[data-key="compare:language:ja"]')), 'a chosen language can be removed');
  await p.click('[data-key="compare:add-language"]');
  await p.click('#language-search'); await p.type('Japanese');
  await p.click('[data-picker-code="ja"]');
  await p.click('[data-compare="save"]');
  await p.waitFor(() => !!document.querySelector('[data-combined]') && !document.querySelector('[data-compare="save"]').disabled);
  result = (await compareApi()).data;
  ok(JSON.stringify(result.config.selectedLanguages) === JSON.stringify(['de', 'ja'])
    && result.groups.every((g, i) => Math.abs(g.seconds - allLanguageGroups[i].languages.filter((l) => ['de', 'ja'].includes(l.lang)).reduce((n, l) => n + l.seconds, 0)) < 1e-6
      && g.allSeconds === allLanguageGroups[i].seconds && g.calendarDays === allLanguageGroups[i].calendarDays),
    'saved German + Japanese totals combine only chosen languages in both groups, preserving calendar days and all-language share denominators');
  ok(result.availableLanguages.includes('en') && !result.availableLanguages.includes('eo'),
    'narrowing to chosen languages still offers other recorded languages, not the full catalog');
  ok(await leadMatches(result) && await p.eval(() => document.querySelector('.cmp-kicker').textContent.includes('German + Japanese combined')
    && [...document.querySelectorAll('.cmp-row[data-lang]')].map((r) => r.dataset.lang).sort().join() === 'de,ja'), 'results lead with the combined selection, then only its individual languages');
  await p.shot(`${LIVE ? 'live' : 'mock'}-comparison-desktop`);
  await p.go(`${MODULE}#days=30&query=${video}&view=compare`);
  await p.waitFor(() => !!document.querySelector('.compare__table'));
  ok(await p.eval(() => !document.querySelector('.compare input') && document.querySelectorAll('.cmp-periods li').length === 4
    && [...document.querySelectorAll('.compare__group')].every((g) => !!g.querySelector('[data-compare="add"]') && !!g.querySelector('[data-compare="add-language"]'))),
    'a fresh page load opens on the result with saved periods summarized and both add controls in each group');
  await openEditor();
  ok(await p.eval(() => document.querySelectorAll('[data-compare-field="start"]').length === 4 && document.activeElement?.dataset.key === 'compare:edit'), 'saved ranges are restored after a fresh page load');
  ok(await p.eval(() => !!document.querySelector('[data-key="compare:language:de"]') && !!document.querySelector('[data-key="compare:language:ja"]') && !!document.querySelector('[data-combined]')), 'the shared language set and combined results survive a fresh page load');
  await field('compare:1:0:start', dates[0]); await field('compare:1:0:end', dates[0]);
  await p.click('[data-compare="save"]');
  ok(await p.waitFor(() => document.querySelector('.compare [role="alert"]')?.textContent.includes('both groups'))
    && (await compareApi()).data.config.baseRevision === result.config.baseRevision, 'cross-group overlap is rejected without replacing saved periods');
  await p.click('[data-compare="reload"]');
  await p.waitFor((end) => document.querySelector('[data-key="compare:1:0:end"]')?.value === end, dates[3]);
  await settled();
  ok(await p.eval(() => document.activeElement?.dataset.key === 'compare:reload' && document.activeElement.textContent === 'Refresh' && !!document.querySelector('#group-0')), 'discarding edits keeps the editor open and focus on the same control');
  const fresh = (await compareApi()).data;
  await compareApi({ ...fresh.config, groups: fresh.config.groups.map((g, i) => ({ ...g, label: i ? g.label : 'Changed elsewhere' })) });
  await field('compare:name:0', 'My unsaved label');
  await p.click('[data-compare="save"]');
  ok(await p.waitFor(() => document.querySelector('.compare [role="alert"]')?.textContent.includes('another browser'))
    && await p.eval(() => document.querySelector('#group-0').value === 'My unsaved label'), 'concurrent saves are refused and your draft survives');
  await p.click('[data-compare="reload"]');
  await p.waitFor(() => document.querySelector('#group-0')?.value === 'Changed elsewhere');
  const device = await p.eval(() => document.querySelector('#f-device option[value]:not([value=""])').value);
  await field('compare:name:0', 'Draft kept across scopes');
  await p.select('#f-device', device);
  await p.waitFor(() => !!document.querySelector('.compare__totals') && !document.querySelector('.compare [role="alert"]'));
  ok(await p.eval(() => document.querySelector('#group-0').value === 'Draft kept across scopes'), 'changing device keeps unsaved period edits');
  await p.size(390, 844, true);
  ok(await p.eval(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.compare input')].every((e) => e.getBoundingClientRect().right <= innerWidth)), 'comparison editor fits 390 px; only its labelled table scrolls');
  await p.shot(`${LIVE ? 'live' : 'mock'}-comparison-phone`);
  await p.click('[data-key="view:overview"]');
  await p.waitFor((id) => !!document.querySelector(`[data-row="${id}"]`), video);
  ok(await p.eval((id) => document.querySelector('#f-query').value === id && document.querySelector('[data-key="f:days:30"]').getAttribute('aria-pressed') === 'true', video), 'returning to Overview retains its search and period');
  await p.click('[data-key="view:compare"]');
  await p.waitFor(() => !!document.querySelector('[data-combined]') && !document.querySelector('[data-compare="save"]').disabled);
  await p.click('[data-compare="all-languages"]');
  await p.click('[data-compare="save"]');
  await p.waitFor(() => !document.querySelector('[data-combined]') && document.querySelector('[data-compare-results]')?.getAttribute('aria-busy') === 'false' && !document.querySelector('[data-compare="save"]').disabled);
  const restored = (await compareApi()).data;
  ok(restored.config.selectedLanguages.length === 0 && restored.groups.every((g) => g.seconds === g.allSeconds)
    && await p.eval(() => !document.querySelector('[data-combined]')), 'Use all languages restores the complete comparison');

  if (!LIVE) {
    console.log('Comparison states');
    const L = (lang, seconds, days, all) => ({ lang, seconds, minutesPerDay: days ? seconds / 60 / days : null, share: all ? seconds / all : null });
    const grp = ({ days, active = days, today = false, langs, all }) => {
      const seconds = langs.reduce((n, [, s]) => n + s, 0); all ??= seconds;
      const fg = Math.round(seconds * 0.7), bg = Math.round(seconds * 0.25);
      return { calendarDays: days, activeDays: active, includesToday: today, seconds, allSeconds: all, share: all ? seconds / all : null, minutesPerDay: days ? seconds / 60 / days : null,
        foregroundSeconds: fg, backgroundSeconds: bg, unspecifiedSeconds: seconds - fg - bg, reviewSeconds: Math.round(seconds * 0.04), languages: langs.map(([l, s]) => L(l, s, days, all)) };
    };
    const R = (start, end) => ({ start, end });
    const state = async (labels, ranges, selected, groups) => {
      const comparison = { config: { baseRevision: 99, selectedLanguages: selected, groups: labels.map((label, i) => ({ label, ranges: ranges[i] })) }, groups,
        availableLanguages: ['de', 'en', 'fr', 'ja', 'sr', 'und'], timezone: 'Europe/Zurich', today: '2026-11-13', asOf: Date.parse('2026-11-13T14:02:00Z') };
      await p.eval((comparison) => fetch('/__mock', { method: 'POST', body: JSON.stringify({ comparison }) }).then((r) => r.ok), comparison);
      await p.click('[data-compare="reload"]');
      await p.waitFor((label) => document.querySelector('[data-compare-results]')?.getAttribute('aria-busy') === 'false' && document.querySelector('[data-group-result="0"] .cmp-duel__name')?.textContent === label, labels[0]);
    };
    const hero = () => p.eval(() => { const h = document.querySelector('.cmp-hero'); return { ...h.dataset, share: h.querySelector('.cmp-share')?.textContent.replace(/\s+/g, ' ').trim() ?? null, headline: h.querySelector('.cmp-headline').textContent, sub: h.querySelector('.cmp-sub').textContent, pct: h.querySelector('.cmp-pct')?.textContent ?? null, extra: [...h.querySelectorAll('.cmp-duel__extra')].map((e) => e.closest('[data-group-result]').dataset.groupResult + e.dataset.delta) }; });
    const fits = () => p.eval(() => document.documentElement.scrollWidth <= innerWidth);

    await p.size(1440, 1000);
    // Production shape: the first group is the plain one, the second is shorter and includes today.
    await state(['FREE', 'SLN'], [[R('2026-11-07', '2026-11-11')], [R('2026-11-12', '2026-11-13')]], ['de'],
      [grp({ days: 5, langs: [['de', 47760]], all: 61000 }), grp({ days: 2, today: true, langs: [['de', 30132]], all: 33500 })]);
    let h = await hero();
    ok(h.story === 'lead' && h.leader === '1' && h.delta === '91.9' && h.headline === 'SLN averaged 91.9 more minutes of German a day than FREE.'
      && h.pct === '+57.7%' && h.sub.includes('relative to FREE') && h.sub.includes('251.1 vs 159.2 min per calendar day') && h.extra.join() === '1+91.9 min / day',
      'unequal periods: the lead names the higher group, its per-day difference, the percentage and both rates');
    ok(await p.eval(() => {
      const cover = document.querySelector('.cmp-cover'), free = cover.querySelector('[data-cover="0"]'), sln = cover.querySelector('[data-cover="1"]');
      return cover.dataset.missing === '3' && cover.dataset.equal === 'false' && cover.querySelector('.cmp-h').textContent === 'SLN is 3 days shorter and needs 3 more days to match FREE’s 5.'
        && free.querySelectorAll('.cmp-day').length === 5 && !free.querySelector('.cmp-day--need, .cmp-day--today')
        && sln.querySelectorAll('.cmp-day:not(.cmp-day--need)').length === 2 && sln.querySelectorAll('.cmp-day--need').length === 3 && sln.querySelectorAll('.cmp-day--today').length === 1
        && sln.querySelector('[role="img"]').getAttribute('aria-label') === '2 selected calendar days, including today, which is not over yet; 3 more days needed to match the other group'
        && sln.textContent.includes('3 short') && free.textContent.includes('playback recorded on 5');
    }), 'unequal periods: the shorter group shows exactly how many more days it needs, and today as unfinished');
    ok(await p.eval(() => !document.querySelector('.cmp-row') && !!document.querySelector('[data-combined]') && document.querySelector('.cmp-fine').textContent.includes('Share of all watch time')),
      'one selected language is told once, in the lead, with its share of all watch time');
    ok(await p.eval(() => { const [a, b] = [...document.querySelectorAll('.cmp-duel__row')].map((r) => getComputedStyle(r.querySelector('.cmp-duel__bar')).backgroundColor); return a !== b && !/rgba?\(0, 0, 0, 0\)/.test(a); }),
      'the two groups are drawn in two distinct identity colours');
    ok(h.shareStory === 'lead' && h.shareLeader === '1' && h.sharePoints === '11.6' && h.share === 'Share of all watch time FREE 78.3% · SLN 89.9% · SLN is higher by 11.6 percentage points.'
      && h.sub.includes('relative to FREE’s daily average') && await p.eval(() => document.querySelector('.cmp-fine').textContent.includes('Share differenceSLN higher by 11.6 percentage points')),
      'the combined share difference is given in percentage points, apart from the relative daily-rate percentage');
    const contrast = () => p.eval(() => {
      const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      const page = getComputedStyle(document.body).backgroundColor, css = (el) => getComputedStyle(el);
      const pct = document.querySelector('.cmp-pct');
      return Math.min(...[...document.querySelectorAll('.cmp-headline .cmp-name, .cmp-cover .cmp-h .cmp-name')].map((n) => ratio(css(n).color, page)), ratio(css(pct).color, css(pct).backgroundColor)) >= 4.5
        && [...document.querySelectorAll('.cmp-duel__bar')].every((b) => ratio(css(b).backgroundColor, page) >= 3);
    });
    await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const lightContrast = await contrast();
    await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    const darkContrast = await contrast();
    await p.send('Emulation.setEmulatedMedia', { features: [] });
    ok(lightContrast && darkContrast, 'group-coloured text meets 4.5:1 and bars 3:1 against the page in light and dark');
    await p.shot('mock-comparison-unequal-desktop');
    await p.size(390, 844, true);
    ok(await fits() && await p.eval(() => [...document.querySelectorAll('.compare__group')].every((g) => {
      const a = g.querySelector('[data-compare="add"]').getBoundingClientRect(), b = g.querySelector('[data-compare="add-language"]').getBoundingClientRect();
      return a.width > 0 && b.width > 0 && b.right <= innerWidth && a.height >= 24 && b.height >= 24;
    }) && document.querySelector('.cmp-headline').getBoundingClientRect().top < 1400), 'unequal periods fit 390 px with both add controls in each group and the lead near the top');
    await p.shot('mock-comparison-unequal-phone');
    await p.size(1440, 1000);

    await state(['Using it', 'Not using it'], [[R('2026-10-01', '2026-10-14'), R('2026-11-01', '2026-11-07')], [R('2026-07-01', '2026-07-05'), R('2026-08-01', '2026-08-20'), R('2026-09-01', '2026-09-30'), R('2026-10-15', '2026-10-31')]], ['de', 'ja'],
      [grp({ days: 21, active: 18, langs: [['de', 151200], ['ja', 20000]], all: 220000 }), grp({ days: 72, active: 51, langs: [['de', 302400], ['ja', 90000]], all: 700000 })]);
    h = await hero();
    ok(h.story === 'lead' && h.leader === '0' && h.delta === '45.1' && h.headline === 'Using it averaged 45.1 more minutes of German and Japanese a day than Not using it.' && h.extra.join() === '0+45.1 min / day',
      'the first group can lead: the same sentence names it instead');
    ok(await p.eval(() => {
      const de = document.querySelector('.cmp-row[data-lang="de"]'), ja = document.querySelector('.cmp-row[data-lang="ja"]'), cover = document.querySelector('.cmp-cover');
      return de.dataset.leader === '0' && de.dataset.delta === '50' && ja.dataset.leader === '1' && ja.dataset.delta === '4.9' && ja.querySelector('.cmp-row__lead').textContent.startsWith('Not using it')
        && cover.dataset.missing === '51' && !cover.querySelector('.cmp-day:not(.cmp-legend *)') && cover.querySelectorAll('.cmp-span').length === 2
        && cover.querySelector('[data-cover="0"] .cmp-span__need') && !cover.querySelector('[data-cover="1"] .cmp-span__need')
        && document.querySelector('[data-cover="0"]').textContent.includes('playback recorded on 18') && document.querySelectorAll('.compare__group')[1].textContent.includes('+ 1 more period');
    }), 'a language can run against the combined result; long periods become proportional bars and active days stay separate from calendar days');

    await state(['Before', 'After'], [[R('2026-11-01', '2026-11-04')], [R('2026-11-05', '2026-11-08')]], ['ja'],
      [grp({ days: 4, active: 0, langs: [['ja', 0]], all: 20000 }), grp({ days: 4, active: 2, langs: [['ja', 5400]], all: 26000 })]);
    h = await hero();
    ok(h.story === 'lead' && h.leader === '1' && h.delta === '22.5' && h.percent === '' && h.pct === null && h.sub.includes('Before recorded none, so there is no percentage to give') && !/%/.test(h.headline),
      'zero baseline: an absolute difference and no invented percentage');
    ok(h.trace === 'false' && await p.eval(() => !document.querySelector('[data-group-result="0"] .cmp-duel__bar') && !!document.querySelector('[data-group-result="1"] .cmp-duel__bar')
      && document.querySelector('[data-group-result="0"] .cmp-duel__n').textContent === '0.0 min / day'), 'a true zero rate draws no bar at all');
    ok(await p.eval(() => document.querySelector('.cmp-cover').dataset.equal === 'true' && !document.querySelector('.cmp-cover .cmp-day--need') && document.querySelector('.cmp-cover .cmp-h').textContent === 'Equal length: both groups cover 4 calendar days.'
      && document.querySelector('[data-cover="0"]').dataset.active === '0' && document.querySelector('[data-cover="1"]').textContent.includes('playback recorded on 2')), 'equal lengths are stated, with days that had playback shown separately');

    await state(['Week A', 'Week B'], [[R('2026-10-26', '2026-11-01')], [R('2026-11-02', '2026-11-08')]], [],
      [grp({ days: 7, active: 6, langs: [['de', 25200], ['en', 8400]] }), grp({ days: 7, active: 7, langs: [['de', 25200], ['en', 8400]] })]);
    h = await hero();
    ok(h.story === 'same' && h.leader === '' && h.delta === '' && h.headline === 'Week A and Week B averaged exactly the same amount of listening a day.' && h.extra.length === 0 && h.pct === null
      && await p.eval(() => [...document.querySelectorAll('.cmp-row')].every((r) => r.dataset.story === 'same' && r.querySelector('.cmp-row__even').textContent === 'No difference')),
      'no change: equal rates are reported as equal, with no winner');

    // 10 seconds over 4 days prints as 0.0 min/day but is not "none".
    await state(['Before', 'After'], [[R('2026-11-01', '2026-11-04')], [R('2026-11-05', '2026-11-08')]], ['ja'],
      [grp({ days: 4, active: 1, langs: [['ja', 10]], all: 20000 }), grp({ days: 4, active: 2, langs: [['ja', 5400]], all: 26000 })]);
    h = await hero();
    ok(h.story === 'lead' && h.delta === '22.5' && h.percent === '' && h.trace === 'true' && h.pct === null && !/none/.test(h.sub) && h.sub.includes('Before averaged under 0.1 min a day, too little for a meaningful percentage')
      && h.sub.includes('22.5 vs <0.1 min per calendar day'), 'a trace baseline is described as under 0.1 min a day, not as none, and still gets no percentage');
    ok(await p.eval(() => { const bar = document.querySelector('[data-group-result="0"] .cmp-duel__bar'); return !!bar && bar.getBoundingClientRect().width > 0 && bar.getBoundingClientRect().width <= 3
      && document.querySelector('[data-group-result="0"] .cmp-duel__n').textContent === '<0.1 min / day' && document.querySelector('[data-group-result="0"]').dataset.rate === '0'; }),
      'a trace rate prints as <0.1 and keeps a thin marker, unlike a true zero');

    // FREE holds the larger share of its watch time while SLN averages more minutes a day.
    await state(['FREE', 'SLN'], [[R('2026-11-07', '2026-11-11')], [R('2026-11-12', '2026-11-13')]], ['de'],
      [grp({ days: 5, langs: [['de', 47760]], all: 50000 }), grp({ days: 2, today: true, langs: [['de', 30132]], all: 60000 })]);
    h = await hero();
    ok(h.leader === '1' && h.delta === '91.9' && h.headline.startsWith('SLN averaged') && h.shareStory === 'lead' && h.shareLeader === '0' && h.sharePoints === '45.3'
      && h.share === 'Share of all watch time FREE 95.5% · SLN 50.2% · FREE is higher by 45.3 percentage points.'
      && await p.eval(() => document.querySelector('.cmp-fine').textContent.includes('Share differenceFREE higher by 45.3 percentage points')),
      'opposing directions: SLN leads minutes a day while FREE is named as holding the larger share');

    await state(['FREE', 'SLN'], [[R('2026-11-07', '2026-11-11')], [R('2026-11-12', '2026-11-13')]], [],
      [grp({ days: 5, langs: [['de', 30000], ['en', 30000], ['fr', 1263], ['sr', 12], ['ja', 0]] }), grp({ days: 2, langs: [['de', 14400], ['en', 33600], ['fr', 509], ['sr', 600], ['ja', 0]] })]);
    h = await hero();
    ok(h.share === null && h.shareStory === '' && await p.eval(() => {
      const row = (l) => document.querySelector(`.cmp-row[data-lang="${l}"]`), d = (l) => row(l).dataset, bars = (l) => [...row(l).querySelectorAll('.cmp-row__track')].map((t) => t.children.length).join();
      const share = (l) => row(l).querySelector('.cmp-row__share')?.textContent.replace(/\s+/g, ' ').trim();
      return d('de').leader === '1' && d('de').delta === '20' && d('de').shareLeader === '0' && d('de').sharePoints === '19.7' && row('de').querySelector('.cmp-row__lead').textContent.startsWith('SLN')
        && share('de') === 'share +19.7 pts higher in · FREE' && row('de').querySelector('.cmp-row__pct').textContent === '+20.0% daily'
        && d('en').leader === '1' && d('en').shareLeader === '1' && share('en') === 'share +19.4 pts higher in · SLN'
        && d('fr').story === 'same' && row('fr').querySelector('.cmp-row__even').textContent === 'About the same' && d('fr').shareLeader === '0' && d('fr').sharePoints === '1.1'
        && d('sr').trace === 'true' && row('sr').querySelector('.cmp-row__pct').textContent === 'the other under 0.1 min / day' && row('sr').querySelector('.cmp-row__n').textContent.startsWith('<0.1') && bars('sr') === '1,1'
        && d('ja').story === 'none' && d('ja').shareStory === 'incomplete' && !row('ja').querySelector('.cmp-row__share') && bars('ja') === '0,0';
    }), 'per language: share points name their own higher group, unequal rates that print alike are about the same, a trace is not none, and zero draws no bar');
    await p.shot('mock-comparison-shares-desktop');
    await p.size(390, 844, true);
    ok(await fits() && await p.eval(() => [...document.querySelectorAll('.cmp-row__share')].every((e) => e.getBoundingClientRect().right <= innerWidth)), 'share differences fit 390 px');
    await p.shot('mock-comparison-shares-phone');
    await p.size(1440, 1000);

    await state(['Week A', 'Week B'], [[R('2026-10-26', '2026-11-01')], [R('2026-11-02', '2026-11-08')]], ['fr'],
      [grp({ days: 7, active: 0, langs: [['fr', 0]], all: 9000 }), grp({ days: 7, active: 0, langs: [['fr', 0]], all: 0 })]);
    h = await hero();
    ok(h.story === 'none' && h.headline === 'No French playback was recorded in either group.' && h.extra.length === 0
      && await p.eval(() => [...document.querySelectorAll('[data-group-result]')].every((r) => r.dataset.rate === '0')), 'no playback: said plainly, with both rates at zero');
    ok(h.sub === 'Both groups have selected days, but no French playback was recorded on them in this device/person scope. Other languages were recorded there.'
      && h.shareStory === 'incomplete' && h.sharePoints === '' && h.share.includes('Week B no watch time at all') && h.share.includes('No share difference to give')
      && await p.eval(() => !document.querySelector('.cmp-duel__bar') && document.querySelector('.cmp-fine').textContent.includes('Share difference—')),
      'no selected-language playback is scoped to those languages, with no bars and no invented share difference');

    await state(['Using it', 'Not using it'], [[R('2026-11-10', '2026-11-13')], []], [],
      [grp({ days: 4, today: true, langs: [['de', 14000], ['en', 3000]] }), grp({ days: 0, langs: [] })]);
    h = await hero();
    ok(h.story === 'incomplete' && h.headline === 'Not using it has no periods yet.' && await p.eval(() => !!document.querySelector('.compare__empty')
      && document.querySelector('[data-group-result="1"]').dataset.rate === '' && document.querySelector('[data-group-result="1"]').textContent.includes('no average')
      && document.querySelector('.cmp-cover').dataset.missing === '4' && document.querySelectorAll('[data-cover="1"] .cmp-day--need').length === 4
      && [...document.querySelectorAll('.cmp-row')].every((r) => r.dataset.story === 'incomplete')), 'an empty group is named, gets no average, and needs every day of the other group');

    const xssLabel = '<img src=x onerror="window.__cmpXss=1"> Weeks when Search Like a Native was switched on';
    await state([xssLabel, 'Everything_before_that_without_any_extension_installed_whatsoever_in_the_browser'], [[R('2026-11-12', '2026-11-13')], [R('2025-12-20', '2026-01-05'), R('2026-11-01', '2026-11-11')]], [],
      [grp({ days: 2, today: true, langs: [['de', 30132], ['en', 1800], ['sr', 960], ['ja', 608], ['fr', 500], ['bcs', 400], ['pt-BR', 300], ['zh-Hant', 200], ['mul', 900], ['zxx', 100], ['und', 60]] }),
        grp({ days: 28, active: 20, langs: [['de', 147760], ['en', 99100], ['sr', 22400], ['und', 11740], ['ja', 0], ['fr', 7000], ['bcs', 1400], ['pt-BR', 0], ['zh-Hant', 60], ['mul', 4000], ['zxx', 50]] })]);
    ok(await p.eval(() => window.__cmpXss === undefined && !document.querySelector('.compare img') && document.querySelectorAll('.cmp-row').length === 11
      && [...document.querySelectorAll('.cmp-row')].slice(-3).map((r) => r.dataset.lang).join() === 'und,mul,zxx' && document.querySelector('.cmp-cover').dataset.missing === '26' && document.querySelectorAll('[data-cover="0"] .cmp-day--need').length === 26
      && document.querySelector('.cmp-row[data-lang="ja"] .cmp-row__pct').textContent === 'the other recorded none' && document.querySelector('.cmp-row[data-lang="und"] .cmp-row__pct').textContent === '14× as much'),
      'many languages and hostile long labels render as text, one row per language, special codes last');
    ok(await fits(), 'many languages with long labels fit the desktop width');
    await p.size(390, 844, true);
    ok(await fits() && await p.eval(() => [...document.querySelectorAll('.cmp-row, .cmp-duel__row, .cmp-cover__row, .cmp-headline')].every((e) => e.getBoundingClientRect().right <= innerWidth + 0.5)),
      'many languages with long unbroken labels fit 390 px without sideways scrolling');
    await p.shot('mock-comparison-long-phone');
    await p.size(1440, 1000);
    await openEditor();
    await p.click('[data-key="compare:remove:0:0"]');
    ok(await p.eval(() => document.activeElement?.dataset.key === 'compare:add:0'), 'removing a group’s last period moves focus to its Add period');
    await p.eval(() => fetch('/__mock', { method: 'POST', body: JSON.stringify({ comparison: null }) }).then((r) => r.ok));
    await p.click('[data-compare="reload"]');
    await p.waitFor(() => document.querySelector('[data-compare-results]')?.getAttribute('aria-busy') === 'false' && !document.querySelector('[data-group-result="0"] .cmp-duel__name')?.textContent.includes('Search Like a Native'));
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
  process.exit(failures.length ? 1 : 0);
}
