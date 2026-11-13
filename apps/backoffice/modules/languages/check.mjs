#!/usr/bin/env node
// Behaviour check for the Languages module. Zero dependencies (Node 22+).
//
//   node apps/backoffice/modules/languages/check.mjs
//       Mock mode: an in-process mock of contracts/languages.md on an ephemeral loopback port
//       (auth, recorded requests, injected failures) serving this folder, driven through the real
//       api.js adapter in an isolated headless Chromium.
//   node apps/backoffice/modules/languages/check.mjs --live http://127.0.0.1:3211 --token-file <admin-token>
//       Live mode: the same UI against a real LOCAL server seeded with tests/seed-dev.mjs.
//       Refuses non-loopback URLs. Performs real assessment actions (they are audited).
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
setTimeout(() => { console.error('check timed out'); process.exit(2); }, 180_000).unref();

if (LIVE && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(LIVE).hostname)) {
  console.error('Live mode only runs against a loopback server.');
  process.exit(2);
}

/* ------------------------------------------------------------------ mock contract server */

async function startMock() {
  const { createDemoApi } = await import(path.join(DIR, 'demo.js'));
  const api = await createDemoApi({ external: true });
  const KEY = 'correct horse battery';
  const mock = { fail: null, expire: false, external: false, xss: false, long: false, requests: [] };
  // Worst case for phone wrapping: an unbroken 60-character channel token and a long device label.
  const longRow = () => ({
    deviceId: 'demo-laptop', deviceLabel: 'Laptop in the guest apartment upstairs (Chrome profile two)', metadataId: 'mock-long', videoId: 'longLong001',
    title: 'Restoration notes', channel: 'Restoration_and_repair_notes_from_a_small_workshop_in_the_alps', seconds: 120,
    foregroundSeconds: 100, backgroundSeconds: 20, unspecifiedSeconds: 0, lastWatched: Date.now() - 120000, evidenceId: null,
    recorded: { lang: 'en', source: 'collector-source-name-that-is-unusually-long-and-unbroken', conf: 'medium' },
    assessment: { lang: 'en', status: 'estimated', source: 'collector:collector-source-name-that-is-unusually-long-and-unbroken', confidence: 'medium', reason: 'Original collector estimate.' },
    revision: 0, needsReview: true,
  });
  const xssText = JSON.stringify({ schemaVersion: 1, algorithmVersion: 'language-v2', title: '<img src=x onerror="window.__langXss=4">', description: '</pre><script>window.__langXss=5</script> & <b>text</b>', descriptionSource: 'videoDetails.shortDescription', descriptionTruncated: false, selectedAudioLanguage: '', defaultAudioLanguage: '', captions: [] });
  const xssRow = () => ({
    deviceId: 'demo-laptop', deviceLabel: 'Laptop', metadataId: 'mock-xss', videoId: 'xssXss00001', title: '<img src=x onerror="window.__langXss=1"> Hostile title',
    channel: '<b>Bold channel</b>', seconds: 60, foregroundSeconds: 60, backgroundSeconds: 0, unspecifiedSeconds: 0, lastWatched: Date.now() - 60000,
    evidenceId: sha256(xssText), recorded: { lang: '', source: '<script>window.__langXss=2</script>', conf: '' },
    assessment: { lang: 'und', status: 'undetermined', source: 'collector', confidence: 'unavailable', reason: '<img src=x onerror="window.__langXss=3">' }, revision: 0, needsReview: true,
  });
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : null); } catch { resolve(s); } }); });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const body = req.method === 'POST' ? await readBody(req) : null;
    if (url.pathname === '/__mock') { Object.assign(mock, body || {}); return send(res, 200, { ok: true }); }
    if (url.pathname === '/__mock/requests') { const r = mock.requests; mock.requests = []; return send(res, 200, r); }
    if (url.pathname === '/__mock/bump') { // another tab changed the record
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
        if (url.pathname === '/api/modules/languages') {
          if (mock.fail === 'list500') return send(res, 500, { error: 'Database is busy.' });
          const data = await api.languages(Object.fromEntries(url.searchParams));
          if (!mock.external) data.providers = data.providers.filter((p) => p.id !== 'external');
          if (mock.xss) data.videos.unshift(xssRow());
          if (mock.long) data.videos.unshift(longRow());
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
      } catch (error) {
        return send(res, error.status || 500, { error: error.message });
      }
      return send(res, 404, { error: 'Not found' });
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
    ok(first.length >= 1 && JSON.stringify(first.at(-1).query) === JSON.stringify({ days: '7', device: '', person: '', language: 'all', status: 'all', query: '', page: '1' }), 'first request carries the contract’s default parameters');
    ok(await p.eval(() => document.getElementById('demo').hidden && !/Demo data|Sample data/.test(document.body.textContent)), 'live mode shows no demo or sample labels');

    console.log('Scope and filters');
    const api7 = await inPage('/api/modules/languages', { days: 7, device: '', person: '', language: 'all', status: 'all', query: '', page: 1 });
    ok((await ledgerSeconds()) === api7.seconds, 'ledger shows the response’s scope total');
    ok(await p.eval((d) => { const c = document.querySelector('[data-context]'); return !c || Number(c.dataset.fg) + Number(c.dataset.bg) + Number(c.dataset.un) === d; }, api7.seconds), 'context split covers the whole total');
    ok(await p.eval(() => document.querySelectorAll('[data-languages] .lang').length > 0 && !!document.querySelector('.lang--und') && /Not one spoken language/.test(document.querySelector('[data-languages]').textContent)), 'mixed, no speech and unknown are listed apart from spoken languages');
    await p.click('[data-key="f:status:review"]');
    let last = (await requests()).filter((r) => r.path === '/api/modules/languages').at(-1);
    ok(last?.query.status === 'review' && last.query.page === '1', 'status filter is sent to the server');
    ok((await ledgerSeconds()) === api7.seconds, 'status filter never changes the scope numbers');
    await p.click('[data-key="lang:de"]');
    last = (await requests()).filter((r) => r.path === '/api/modules/languages').at(-1);
    ok(last?.query.language === 'de' && (await p.eval(() => document.querySelector('[data-key="lang:de"]').getAttribute('aria-pressed'))) === 'true', 'choosing a language filters the rows and is shown as pressed');
    await p.click('[data-key="f:status:all"]');
    await p.click('[data-key="lang:de"]');
    await p.click('#f-query');
    await p.type('rhine');
    await sleep(600);
    last = (await requests()).filter((r) => r.path === '/api/modules/languages').at(-1);
    ok(last?.query.query === 'rhine' && (await p.eval(() => document.querySelectorAll('[data-videos] .vrow').length)) === 1, 'search is debounced, sent and narrows rows');
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
    ok(last?.query.page === '2' && last.query.days === '90' && /Page 2 of/.test(await p.eval(() => document.querySelector('.pager__at')?.textContent || '')), 'paging asks for the next 20 rows');
    ok(await p.eval(() => location.hash.includes('days=90') && location.hash.includes('page=2')), 'filters live in the URL, so reload and back work');
    await p.click('[data-key="f:days:7"]');
    await p.shot('mock-desktop');

    console.log('Inspector, corrections and audit');
    await requests();
    const rowKey = await p.eval(() => document.querySelector('[data-videos] .vrow [data-action="open"]').dataset.key);
    const [, device, metadata] = rowKey.split(':');
    await p.click(`[data-key="${rowKey}"]`);
    ok(await p.waitFor(() => !!document.querySelector('#dlg[open] [data-assessment]')), 'Review/Inspect opens the inspector');
    const evReq = (await requests()).find((r) => r.path === '/api/modules/languages/evidence');
    ok(evReq?.query.device === device && evReq.query.metadata === metadata, 'evidence is requested for exactly this device and version');
    const ev = await inPage('/api/modules/languages/evidence', { device, metadata });
    ok(/This recorded version on/.test(await p.eval(() => document.querySelector('#dlg .notice--scope').textContent)), 'the inspector states the correction scope (this version, this device)');
    ok((await p.eval(() => document.getElementById('f-provider'))) === null, 'one provider: no analysis choice is shown');
    if (ev.evidenceText) {
      await p.click('#dlg [data-raw-details] > summary');
      ok((await p.eval(() => document.querySelector('#dlg code[data-raw="exact"]')?.textContent)) === ev.evidenceText, 'raw view shows the exact saved text');
      ok(await p.waitFor(() => /Matches/.test(document.querySelector('#dlg [data-digest]')?.textContent || '')), 'digest of the exact text matches the evidence ID');
    }
    const rev0 = ev.revision;
    await p.select('#f-lang', 'mul');
    await p.click('#f-note');
    await p.type('Two languages, half each.');
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok'), 'saving a classification confirms it');
    const post = (await requests()).find((r) => r.path === '/api/modules/languages/assessment');
    ok(JSON.stringify(post?.body) === JSON.stringify({ deviceId: device, metadataId: metadata, baseRevision: rev0, action: 'manual', lang: 'mul', note: 'Two languages, half each.' }), 'manual body matches the contract exactly');
    ok(await p.waitFor(() => /Classified/.test(document.querySelector('#dlg [data-audit]')?.textContent || '')), 'the audit history shows the classification');
    ok(await p.eval(() => document.querySelector('#dlg [data-key="ins:analyze"]').disabled), 'analysis is locked while a manual classification stands');
    await p.click('#dlg [data-key="ins:reset"]');
    ok(await p.waitFor(() => /Reset/.test(document.querySelector('#dlg [data-audit]')?.textContent || '') && !document.querySelector('#dlg [data-key="ins:analyze"]').disabled), 'reset is audited and unlocks analysis');
    await requests();
    await p.click('#dlg [data-key="ins:analyze"]');
    await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok');
    const an = (await requests()).find((r) => r.path === '/api/modules/languages/assessment');
    ok(an?.body.action === 'analyze' && an.body.provider === 'saved-evidence', 'analyze sends the saved-evidence provider');
    await fetch(`${BASE}/__mock/bump`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: device, metadataId: metadata }) });
    await p.select('#f-lang', 'de');
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'review' && !!document.querySelector('#dlg [data-key="ins:refresh"]')), 'a stale revision (409) asks you to refresh');
    await p.click('#dlg [data-key="ins:refresh"]');
    const fresh = await inPage('/api/modules/languages/evidence', { device, metadata });
    ok(await p.waitFor((r) => Number(document.querySelector('#dlg [data-assessment]')?.dataset.revision) === r, fresh.revision), 'refresh loads the latest revision');
    await p.select('#f-lang', 'de');
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok'), 'after refreshing, the classification saves');
    await p.shot('mock-inspector');
    await p.key('Escape', 27);
    ok(await p.eval((k) => !document.getElementById('dlg').open && document.activeElement?.dataset.key === k, rowKey), 'Esc closes the inspector and returns focus to the row');

    console.log('Providers');
    await control({ external: true });
    await p.click('[data-key="f:days:30"]');
    await p.click('[data-key="f:days:7"]');
    const openKey = await p.eval(() => document.querySelector('[data-videos] .vrow--review [data-action="open"]')?.dataset.key);
    await p.click(`[data-key="${openKey}"]`);
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    ok(await p.eval(() => document.getElementById('f-provider')?.options.length === 2), 'an advertised external API appears as a choice');
    await p.select('#f-provider', 'external');
    ok(/no media, no keys/.test(await p.eval(() => document.querySelector('#dlg [data-provider-note]').textContent)), 'the external choice says exactly what is sent');
    await requests();
    if (!(await p.eval(() => document.querySelector('#dlg [data-key="ins:analyze"]').disabled))) {
      await p.click('#dlg [data-key="ins:analyze"]');
      await p.waitFor(() => !!document.querySelector('#dlg [data-alert]'));
      ok((await requests()).find((r) => r.path === '/api/modules/languages/assessment')?.body.provider === 'external', 'analyze sends the chosen provider');
    }
    await p.key('Escape', 27);
    await control({ external: false });

    console.log('Failures and hostile text');
    await control({ fail: 'list500' });
    await p.click('[data-key="f:days:30"]');
    ok(await p.waitFor(() => /Database is busy/.test(document.querySelector('.problem')?.textContent || '')), 'a server error shows its message and a retry');
    await control({ fail: null });
    await p.click('[data-key="retry"]');
    ok(await p.waitFor(() => !document.querySelector('.problem') && !!document.querySelector('[data-ledger]')), 'retry recovers');
    await control({ xss: true });
    await p.eval(() => { delete window.__langXss; });
    await p.click('[data-key="f:days:7"]');
    await p.click('[data-key="open:demo-laptop:mock-xss"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    await p.click('#dlg [data-raw-details] > summary');
    const injected = await p.eval(() => ({
      ran: window.__langXss,
      img: document.querySelectorAll('img[src="x"]').length,
      script: document.querySelectorAll('#main script, #dlg script').length,
      // Only the payload's own tags count; the UI's own <b> numbers are expected.
      markup: [...document.querySelectorAll('b, i')].filter((x) => /^(Bold channel|text|markup)$/.test(x.textContent.trim())).map((x) => x.outerHTML),
    }));
    ok(injected.ran === undefined && injected.img === 0 && injected.script === 0 && injected.markup.length === 0, `hostile titles, reasons, notes and evidence never run or render as markup ${JSON.stringify(injected)}`);
    ok(await p.eval(() => document.querySelector('[data-key="open:demo-laptop:mock-xss"]').textContent.includes('<img src=x') && document.querySelector('#dlg [data-description]').textContent.includes('<script>')), 'hostile text is shown literally');
    ok(await p.eval(() => !!document.querySelector('#dlg [data-history-more]')), 'a truncated history says older entries are kept');
    await p.key('Escape', 27);
    await control({ xss: false, expire: true });
    await p.click('[data-key="f:days:30"]');
    ok(await p.waitFor(() => !!document.getElementById('owner-key')), 'an expired session returns to sign-in');
    ok(await signIn(), 'signing in again restores the view');

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
    await p.click('[data-key="f:status:review"]');
    ok(await p.waitFor(() => [...document.querySelectorAll('[data-videos] .meta')].some((m) => m.textContent.includes('Northfield Workshop Restoration and Repair Notes'))), 'fixture: a review row with a long multi-word channel name is listed');
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
    const neon = await contained('[data-row="demo-laptop:m-neon"]', 'Northfield Workshop Restoration and Repair Notes');
    ok(neon.full && neon.inside && neon.lines >= 2, `the long channel name wraps inside its row and stays fully visible ${JSON.stringify(neon)}`);
    await control({ long: true });
    await p.size(1440, 900);
    await p.click('[data-key="f:status:all"]');
    await p.click('[data-key="f:status:review"]');
    await p.waitFor(() => !!document.querySelector('[data-row="demo-laptop:mock-long"]'));
    over = await overflowAt390();
    ok(over.length === 0, `390 px with an unbroken 60-character channel and a long device label: nothing overflows ${over.length ? JSON.stringify(over) : ''}`);
    const token = await contained('[data-row="demo-laptop:mock-long"]', 'Restoration_and_repair_notes_from_a_small_workshop_in_the_alps');
    const label = await contained('[data-row="demo-laptop:mock-long"]', 'Laptop in the guest apartment upstairs (Chrome profile two)');
    ok(token.full && token.inside && token.lines >= 2 && label.full && label.inside, `the unbroken channel token and long device label stay whole and inside the row ${JSON.stringify({ token, label })}`);
    await p.eval(() => document.querySelector('[data-row="demo-laptop:mock-long"]').scrollIntoView({ block: 'start' }));
    await p.shot('mock-phone-long-rows');
    await p.eval(() => document.querySelector('[data-key="open:demo-laptop:mock-long"]').click());
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
    await p.click('[data-videos] .vrow [data-action="open"]');
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    ok(await p.eval(() => { const d = document.getElementById('dlg'); return d.scrollWidth <= d.clientWidth + 1; }), 'phone: inspector fits the width');
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
    const api7 = await inPage('/api/modules/languages', { days: 7, device: '', person: '', language: 'all', status: 'all', query: '', page: 1 });
    ok((await ledgerSeconds()) === api7.seconds && api7.seconds > 0, `ledger matches the server (${api7.seconds} s)`);
    ok(await p.eval((n) => document.querySelectorAll('[data-videos] .vrow').length === n, api7.videos.length), 'rows match the server page');
    const providers = await p.eval(() => true) && api7.providers;
    ok(Array.isArray(providers) && providers.some((x) => x.id === 'saved-evidence'), 'server advertises saved-evidence analysis');
    const row = api7.videos.find((v) => v.videoId === 'fxStalk0011' && v.deviceLabel === 'Living room TV') || api7.videos.find((v) => v.evidenceId);
    await p.click(`[data-key="open:${row.deviceId}:${row.metadataId}"]`);
    await p.waitFor(() => !!document.querySelector('#dlg [data-assessment]'));
    const ev = await inPage('/api/modules/languages/evidence', { device: row.deviceId, metadata: row.metadataId });
    if (ev.evidenceText) {
      await p.click('#dlg [data-raw-details] > summary');
      ok((await p.eval(() => document.querySelector('#dlg code[data-raw="exact"]')?.textContent)) === ev.evidenceText && sha256(ev.evidenceText) === ev.evidenceId, 'raw view is the server’s exact text and its SHA-256 is the evidence ID');
    }
    if (ev.assessment?.source === 'manual') { await p.click('#dlg [data-key="ins:reset"]'); await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok'); }
    await p.click('#dlg [data-key="ins:analyze"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok'), 'saved-evidence analysis runs on the real server');
    const after = await inPage('/api/modules/languages/evidence', { device: row.deviceId, metadata: row.metadataId });
    ok(after.revision === ev.revision + (ev.assessment?.source === 'manual' ? 2 : 1) && after.history[0]?.action === 'analyze', `analysis is appended to the audit (revision ${after.revision}, ${after.assessment.lang}/${after.assessment.status})`);
    // Another tab changes the record: the UI must refuse to overwrite and offer a refresh.
    await p.eval(async (body) => fetch('/api/modules/languages/assessment', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { deviceId: row.deviceId, metadataId: row.metadataId, baseRevision: after.revision, action: 'reset', note: 'check: changed in another tab' });
    await p.select('#f-lang', 'de');
    await p.click('#f-note');
    await p.type('Check: German dub heard on the TV.');
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'review'), 'a stale revision is refused by the server (409)');
    await p.click('#dlg [data-key="ins:refresh"]');
    await p.waitFor(() => !document.querySelector('#dlg [data-alert]'));
    ok((await p.eval(() => document.getElementById('f-note')?.value)) === 'Check: German dub heard on the TV.', 'your note survives the refresh after a 409');
    await p.select('#f-lang', 'de');
    await p.click('#dlg [data-key="ins:save"]');
    ok(await p.waitFor(() => document.querySelector('#dlg [data-alert]')?.dataset.alert === 'ok'), 'after refreshing, the manual classification saves');
    const final = await inPage('/api/modules/languages/evidence', { device: row.deviceId, metadata: row.metadataId });
    ok(final.assessment.source === 'manual' && final.assessment.lang === 'de' && final.history[0].note === 'Check: German dub heard on the TV.', 'server stores the manual classification with its note');
    ok(await p.eval(() => document.querySelector('#dlg [data-key="ins:analyze"]').disabled), 'analysis is locked after a manual classification');
    const other = await inPage('/api/modules/languages', { days: 30, device: '', person: '', language: 'all', status: 'all', query: 'fxStalk0011', page: 1 });
    const laptop = other.videos.find((v) => v.deviceLabel === 'Laptop');
    ok(!laptop || laptop.assessment.source !== 'manual', 'the same video on another device keeps its own language');
    await p.shot('live-inspector');
    await p.key('Escape', 27);
    await p.shot('live-desktop');
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
