#!/usr/bin/env node
// Behaviour check for the backoffice design preview. Zero dependencies (Node 22+: fetch, WebSocket).
//
//   pnpm --dir apps/backoffice preview:design            # serves http://127.0.0.1:4187/
//   node apps/backoffice/design-preview/check.mjs [url]   # default url: http://127.0.0.1:4187/
//
// Launches an isolated headless Chromium ($CHROME_BIN, else Playwright's "Chrome for Testing", else
// Helium) with a throwaway profile, so it never touches anyone's preview state. Remote thumbnails
// are switched off, so the run makes no network requests beyond the preview server. Screenshots go
// to $OWNTUBE_CHECK_OUT or <os tmpdir>/owntube-design-preview-check, never into the repository.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv.find((a) => /^https?:\/\//.test(a)) || 'http://127.0.0.1:4187/';
const SHOTS = !process.argv.includes('--no-shots');
const OUT = process.env.OWNTUBE_CHECK_OUT || path.join(os.tmpdir(), 'owntube-design-preview-check');
const STATE = 'owntube.backoffice.preview.state.v1';
const PREFS = 'owntube.backoffice.preview.prefs.v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.error('check timed out'); process.exit(2); }, 150_000).unref();

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => b.split('-')[1] - a.split('-')[1]) : [];
  for (const b of builds) {
    for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
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
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) p.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') p.errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`);
      if (m.method === 'Page.loadEventFired') p.loads.splice(0).forEach((f) => f());
    };
    for (const d of ['Page.enable', 'Runtime.enable', 'Log.enable']) await p.send(d);
    return p;
  }
  send(method, params = {}) {
    const id = ++this.n;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async size(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    await this.send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  }
  async go(hash = '') {
    this.nav = (this.nav || 0) + 1; // a fresh query forces a real load; hash-only changes never fire "load"
    const loaded = new Promise((r) => this.loads.push(r));
    await this.send('Page.navigate', { url: `${BASE}?n=${this.nav}${hash}` });
    await Promise.race([loaded, sleep(8000)]);
    await sleep(200);
  }
  async eval(fn, ...args) {
    const r = await this.send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async click(sel) {
    const pt = await this.eval((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    }, sel);
    if (!pt) throw new Error(`missing ${sel}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1 });
    await sleep(150);
  }
  async hover(sel) {
    const pt = await this.eval((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && [r.x + r.width / 2, r.y + 20]; }, sel);
    if (!pt) throw new Error(`missing ${sel}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt[0], y: pt[1] });
    await sleep(350);
  }
  async key(key, { modifiers = 0, keyCode, text } = {}) {
    const base = { key, code: key.length === 1 ? undefined : key, modifiers, windowsVirtualKeyCode: keyCode };
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(80);
  }
  async type(text) { await this.send('Input.insertText', { text }); await sleep(80); }
  async setValue(sel, value) {
    await this.eval((s, v) => { const i = document.querySelector(s); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }, sel, value);
    await sleep(80);
  }
  async shot(name) {
    if (!SHOTS) return;
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  }
}

let passed = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) passed++; else failures.push(msg); console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`); };
const state = (p) => p.eval((k) => JSON.parse(localStorage.getItem(k)), STATE);
const count = (p, sel) => p.eval((s) => document.querySelectorAll(s).length, sel);
const focusKey = (p) => p.eval(() => document.activeElement?.dataset.key ?? null);

// Independent reading of the History rules: last N calendar days in the browser's zone, ending now.
const expectSummary = (p, days, device = 'all') => p.eval((k, n, dev) => {
  const s = JSON.parse(localStorage.getItem(k));
  const now = Date.now();
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (n - 1)).getTime();
  const plays = s.history.filter((h) => (dev === 'all' || h.device === dev) && h.at >= start && h.at <= now);
  const total = plays.reduce((a, h) => a + h.watchedS, 0);
  const activeDays = new Set(plays.map((h) => new Date(h.at).toDateString())).size;
  return { total, videos: new Set(plays.map((h) => h.videoId)).size, avg: Math.round(total / n), activeDays, start };
}, STATE, days, device);
const ledger = (p) => p.eval(() => {
  const l = document.querySelector('[data-ledger]');
  const s = document.querySelector('[data-ledger-split]');
  return l && {
    total: +l.dataset.totalS, videos: +l.dataset.videos, avg: +l.dataset.avgS, days: +l.dataset.days, start: Date.parse(l.dataset.start),
    fg: s ? +s.dataset.fgS : 0, bg: s ? +s.dataset.bgS : 0, un: s ? +s.dataset.unS : 0, split: s?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    text: l.textContent.replace(/\s+/g, ' ').trim(),
  };
});
// Searches in scope, read independently: same calendar-day window, device match, newest first.
const expectSearches = (p, days, device = 'all') => p.eval((k, n, dev) => {
  const s = JSON.parse(localStorage.getItem(k));
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (n - 1)).getTime();
  return s.searches.filter((x) => (dev === 'all' || x.device === dev) && x.at >= start && x.at <= Date.now()).sort((a, b) => b.at - a.at).map((x) => x.query);
}, STATE, days, device);
const searchLedger = (p) => p.eval(() => {
  const l = document.querySelector('[data-search-ledger]');
  return l && { count: l.dataset.count, listed: +l.dataset.listed, shown: +l.dataset.shown, figure: l.querySelector('.fig__n')?.textContent.trim() };
});
const selectDevice = async (p, value) => {
  await p.eval((v) => { const s = document.getElementById('hdev'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  await sleep(120);
};
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'owntube-preview-profile-'));
const chrome = spawn(findChrome(), ['--headless=new', '--use-mock-keychain', '--password-store=basic', `--user-data-dir=${profile}`,
  '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const portFile = path.join(profile, 'DevToolsActivePort');
for (let i = 0; i < 300 && !fs.existsSync(portFile); i++) await sleep(50);
const p = await Page.open(fs.readFileSync(portFile, 'utf8').split('\n')[0]);

try {
  await p.size(1440, 900);
  await p.go();
  await p.eval((s, pr) => { localStorage.removeItem(s); localStorage.setItem(pr, JSON.stringify({ remoteThumbs: false, theme: 'light' })); }, STATE, PREFS);
  await p.go('#/curation/suggested-videos');

  console.log('Seed and draft');
  const s0 = await state(p);
  ok(s0.revisions.length === 3 && s0.revisions.at(-1).n === 14, 'three sample revisions, r14 published');
  ok((await p.eval(() => document.querySelector('.status--draft')?.textContent.replace(/\s+/g, ' ').trim())) === 'Draft · 4 changes', 'header: 4 draft changes');
  ok((await count(p, '#rows .row--changed')) === 2, 'changed rows carry a change bar');
  await p.shot('desktop-curation');

  console.log('Languages module (shared files, demo mode)');
  ok((await p.eval(() => document.querySelector('#nav [data-nav="languages"]')?.getAttribute('href'))) === 'modules/languages/?demo=1', 'masthead links to the Languages module in explicit demo mode');
  ok((await p.eval(async () => Promise.all(['modules/languages/', 'modules/languages/languages.js', 'modules/languages/demo.js', 'modules/languages/languages.css'].map(async (u) => (await fetch(u)).status)))).every((s) => s === 200), 'the preview serves the real module files (no copies)');

  console.log('Publish sheet');
  await p.click('[data-key="mast:publish"]');
  ok((await count(p, '#dlg-publish .change')) === 4, 'sheet lists the 4 changes');
  await p.key('Escape', { keyCode: 27 });
  ok((await focusKey(p)) === 'mast:publish', 'Esc closes and returns focus to the opener');

  console.log('Item dialog: block from the TV, undo inside the dialog');
  await p.click('#col-monitor .card[data-video="smpVpixel0017"] .card__hit');
  const blocked0 = (await state(p)).draft.blocked.channels.length;
  await p.click('#dlg-item [data-key="item:channel"]');
  ok((await state(p)).draft.blocked.channels.length === blocked0 + 1, 'channel blocked from the dialog');
  ok(await p.eval(() => !!document.querySelector('#dlg-item #toasts .toast__btn')), 'Undo is reachable inside the modal');
  await p.click('#dlg-item .toast__btn');
  ok((await state(p)).draft.blocked.channels.length === blocked0, 'Undo restores the draft');
  await p.key('Escape', { keyCode: 27 });

  console.log('Add by link');
  await p.click('#add-input');
  await p.type('https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLsample0000000001');
  ok((await count(p, '#add-out input[type=radio]')) === 2, 'video+playlist link offers a choice');
  await p.click('[data-key="add:suggest"]');
  ok((await state(p)).draft.suggested.videos[0].id === 'jNQXAC9IVRw', 'new suggestion goes first in its row');
  ok((await p.eval(() => document.activeElement?.id)) === 'add-input', 'focus stays in the add field');
  for (const [input, sel, msg] of [
    ['not a link', '#add-out .add__error', 'nonsense is rejected'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ', '#add-out .add__what', 'a Mix list is ignored; the video is offered'],
    ['@SomeHandle', '#add-out .add__what', '@handle is read as a channel'],
  ]) {
    await p.setValue('#add-input', input);
    ok((await count(p, sel)) === 1, msg);
  }
  await p.setValue('#add-input', '');

  console.log('Ordering, notes, revert');
  await p.setValue('#filter', 'rail');
  ok(await p.eval(() => [...document.querySelectorAll('#rows [data-action="move"]')].every((b) => b.disabled)), 'reordering is locked while filtering');
  await p.setValue('#filter', '');
  const order0 = (await state(p)).draft.suggested.videos.map((e) => e.id).join();
  await p.click('[data-key="row:suggested.videos:smpVlathe0003:down"]');
  ok((await focusKey(p)) === 'row:suggested.videos:smpVlathe0003:down', 'focus follows a moved row');
  await p.key('ArrowUp', { modifiers: 1, keyCode: 38 });
  ok((await state(p)).draft.suggested.videos.map((e) => e.id).join() === order0, 'Alt+↑ moves it back');
  await p.click('[data-key="row:suggested.videos:smpVlathe0003:note"]');
  await p.type('Watch with the restoration playlist.');
  await p.key('Enter', { modifiers: 4, keyCode: 13 });
  ok((await state(p)).draft.suggested.videos.find((e) => e.id === 'smpVlathe0003').note === 'Watch with the restoration playlist.', '⌘↵ saves a note');
  await p.click('[data-key^="revert:suggested.videos|moved|smpVdjerdap02"]');
  ok((await count(p, '[data-key^="revert:suggested.videos|moved|smpVdjerdap02"]')) === 0, 'a single change can be reverted');

  console.log('Blocked channels');
  await p.go('#/curation/blocked-channels');
  await p.click('[data-key="row:blocked.channels:smpCtop10:remove"]');
  ok((await count(p, '.row--ghost[data-id="smpCtop10"]')) === 1, 'an unblock stays visible as a struck ghost row');
  await p.hover('#rows .row[data-id="smpCdrama"]');
  ok((await count(p, '#col-monitor .card.is-lit')) >= 2, 'pointing at a blocked channel reveals what it hides');

  console.log('Publish, restore, discard');
  await p.click('[data-key="mast:publish"]');
  await p.click('#pub-note');
  await p.type('Check publish');
  await p.click('[data-key="pub:publish"]');
  const s1 = await state(p);
  ok(s1.revisions.at(-1).n === 15 && s1.revisions.at(-1).origin === 'local' && s1.revisions.at(-1).note === 'Check publish', 'r15 saved locally with its note');
  ok((await focusKey(p)) === 'publish:done', 'focus moves to the outcome');
  await p.click('[data-key="pub:restore:14"]');
  ok((await count(p, '#dlg-publish .change')) > 0, 'restoring r14 becomes a draft');
  await p.click('[data-key="pub:discard"]');
  await p.click('[data-key="pub:discard-confirm"]');
  ok((await count(p, '#dlg-publish .change')) === 0, 'discard returns to the published revision');
  await p.key('Escape', { keyCode: 27 });

  console.log('TV preview keys');
  await p.click('[data-key="mon:expand"]');
  ok(await p.eval(() => {
    const a = document.querySelector('.tvdialog__close').getBoundingClientRect();
    const b = document.querySelector('#dlg-tv .tv__rev').getBoundingClientRect();
    return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
  }), 'full-screen Close does not cover the revision label');
  const k0 = await focusKey(p);
  await p.key('ArrowDown', { keyCode: 40 });
  const k1 = await focusKey(p);
  ok(k0 && k1 && k0 !== k1 && k1.startsWith('tvL:'), 'arrow keys move focus like a remote');
  await p.shot('desktop-tv-fullscreen');
  await p.key('Escape', { keyCode: 27 });

  console.log('History numbers');
  await p.eval((k) => localStorage.removeItem(k), STATE);
  await p.go('#/history');
  let e = await expectSummary(p, 7);
  let l = await ledger(p);
  ok(l && l.total === e.total && e.total > 0, `7 days: watched = sum of plays (${l?.total} s)`);
  ok(l.videos === e.videos && e.videos < (await state(p)).history.length, `7 days: distinct videos (${l.videos}) counts repeats once`);
  ok(l.days === 7 && l.avg === Math.round(e.total / 7), `7 days: average divides by 7 calendar days (${l.avg} s)`);
  ok(e.activeDays < 7 && l.avg !== Math.round(e.total / e.activeDays), `average does not divide by active days (${e.activeDays})`);
  ok(l.start === e.start, 'period starts at local midnight six days ago');
  ok(/Sample data/.test(l.text) && /÷ 7 calendar days/.test(l.text), 'ledger states sample data and its divisor');
  const todayTotal = await p.eval(() => +document.querySelector('[data-day-total-s]')?.dataset.dayTotalS);
  await p.setValue('#hq', 'rijaliti');
  const l2 = await ledger(p);
  ok(l2.total === l.total && l2.videos === l.videos && l2.avg === l.avg, 'search filters rows, never the totals');
  ok((await count(p, '.hrow')) === 2 && (await p.eval(() => +document.querySelector('[data-day-total-s]')?.dataset.dayTotalS)) === todayTotal, 'day totals keep their scope while searching');
  await p.setValue('#hq', '');
  await p.eval(() => { const s = document.getElementById('hdev'); s.value = 'Bedroom TV'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await sleep(100);
  e = await expectSummary(p, 7, 'Bedroom TV');
  l = await ledger(p);
  ok(l.total === e.total && l.videos === e.videos && l.avg === Math.round(e.total / 7), `TV filter scopes the numbers (Bedroom TV: ${l.total} s, ${l.videos} videos)`);
  await p.eval(() => { const s = document.getElementById('hdev'); s.value = 'all'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.click('[data-key="history:days:30"]');
  e = await expectSummary(p, 30);
  l = await ledger(p);
  ok(l.days === 30 && l.total === e.total && l.avg === Math.round(e.total / 30), '30 days: divisor is 30');

  // Boundary: a play 30 s after the 7-day window opens counts; one 30 s before it does not.
  const boundary = await p.eval((k) => {
    const s = JSON.parse(localStorage.getItem(k));
    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime();
    s.history.push({ id: 'tIn', at: start + 30_000, videoId: 'smpVnotiz020', device: 'Living room TV', watchedS: 600, coverage: 1 });
    s.history.push({ id: 'tOut', at: start - 30_000, videoId: 'smpVderby019', device: 'Living room TV', watchedS: 900, coverage: 1 });
    localStorage.setItem(k, JSON.stringify(s));
    return start;
  }, STATE);
  const base7 = await ledger(p); // 30-day view still showing the pre-injection render
  await p.go('#/history');
  l = await ledger(p);
  e = await expectSummary(p, 7);
  ok(l.start === boundary && l.total === e.total && l.videos === e.videos, `boundary: 7 days counts the play inside the window only (${l.total} s)`);
  ok(l.fg + l.bg + l.un === l.total, 'a play recorded without context counts as unspecified, not foreground');
  await p.click('[data-key="history:days:30"]');
  const l30 = await ledger(p);
  ok(l30.total === base7.total + 600 + 900 && l30.videos === base7.videos + 2, '30 days includes both boundary plays');
  ok(l30.un === base7.un + 600 + 900 && l30.fg === base7.fg, 'context-less plays land in unspecified only');

  console.log('Playback context');
  await p.eval((k) => localStorage.removeItem(k), STATE);
  await p.go('#/history');
  const rowsCtx = await p.eval(() => [...document.querySelectorAll('.hrow')].map((r) => ({ id: r.dataset.historyId, s: +r.dataset.s, fg: +r.dataset.fg, bg: +r.dataset.bg, un: +r.dataset.un, line: r.querySelector('[data-ctx-line]').textContent, device: r.querySelector('.meta').textContent })));
  ok(rowsCtx.length > 0 && rowsCtx.every((r) => r.fg + r.bg + r.un === r.s), `every row: watched = foreground + background + unspecified (${rowsCtx.length} rows)`);
  const rowFor = async (video, device) => p.eval((v, d) => {
    const r = [...document.querySelectorAll('.hrow')].find((x) => x.dataset.id === v && x.querySelector('.meta').textContent.includes(d));
    return r && r.querySelector('[data-ctx-line]').textContent;
  }, video, device);
  const mixedTv = await rowFor('smpVrhine0005', 'Living room TV');
  ok(/foreground/.test(mixedTv) && /background/.test(mixedTv) && !/on-tab/.test(mixedTv), `TV mixed play uses "foreground" (${mixedTv})`);
  const mixedChrome = await rowFor('smpVplane0011', 'Laptop');
  ok(/on-tab/.test(mixedChrome) && /background/.test(mixedChrome) && !/foreground/.test(mixedChrome), `Chrome mixed play uses "on-tab" (${mixedChrome})`);
  ok((await rowFor('smpVbrahms016', 'Laptop')) === 'all background', 'background-only play is shown as all background');
  ok((await rowFor('smpVfight033', 'Bedroom TV')) === 'context not recorded', 'missing context is shown as not recorded');
  ok(/unspecified/.test(await rowFor('smpVstalker07', 'Laptop')), 'partly unknown context is labelled unspecified');
  for (const [device, word] of [['all', 'on-tab or foreground'], ['Laptop', 'on-tab'], ['Living room TV', 'foreground'], ['Bedroom TV', null]]) {
    await selectDevice(p, device);
    for (const days of [7, 30]) {
      await p.click(`[data-key="history:days:${days}"]`);
      const lg = await ledger(p);
      const ex = await expectSummary(p, days, device);
      const ok1 = lg.total === ex.total && lg.fg + lg.bg + lg.un === lg.total;
      const ok2 = word === 'on-tab' ? lg.split.includes('on-tab') && !lg.split.includes('foreground')
        : word === 'foreground' ? lg.split.includes('foreground') && !lg.split.includes('on-tab')
          : word ? lg.split.includes(word)
            : !/foreground|on-tab/.test(lg.split) && /unspecified/.test(lg.split);
      ok(ok1 && ok2, `${device}, ${days} days: split adds up to watched and names the source (${lg.split})`);
    }
  }
  await selectDevice(p, 'all');
  await p.click('[data-key="history:days:7"]');
  await p.shot('desktop-history');

  console.log('Search history');
  ok(await p.eval(() => !!document.querySelector('.history__head .htabs__tab[href="#/history/searches"]')?.offsetParent), 'Searches tab is visible next to Watched');
  const watchedBefore = await ledger(p);
  await p.click('.history__head .htabs__tab[href="#/history/searches"]');
  ok((await p.eval(() => location.hash)) === '#/history/searches' && (await p.eval(() => document.querySelector('.history__head [aria-current="page"]')?.textContent)) === 'Searches', 'tab switches to Searches and marks it current');
  ok((await focusKey(p)) === 'htab:d:searches', 'focus stays on the view switch');
  for (const days of [7, 30, 90]) {
    await p.click(`[data-key="history:days:${days}"]`);
    const ex = await expectSearches(p, days);
    const sl = await searchLedger(p);
    const rows = await p.eval(() => [...document.querySelectorAll('.srow .srow__text')].map((x) => x.textContent));
    const listed = ex.slice(0, 20);
    ok(sl.count === String(ex.length) && sl.listed === listed.length && rows.join('\n') === listed.join('\n'), `${days} days: count ${ex.length} covers the scope; rows are the latest ${listed.length}, newest first`);
    const bound = await p.eval(() => document.querySelector('[data-search-bound]')?.textContent ?? '');
    ok(ex.length > 20 ? bound.includes(`latest 20 of ${ex.length}`) : bound === '', `${days} days: listing limit is ${ex.length > 20 ? 'stated' : 'not needed'}`);
  }
  ok(await p.eval(() => !document.querySelector('[data-ledger], .hrow') && !/watched|covered|on-tab|background/i.test(document.querySelector('.srows')?.textContent ?? '')), 'search rows carry no watch time, coverage or context');
  await p.click('[data-key="history:days:30"]');
  const before30 = await searchLedger(p);
  await p.setValue('#hq', 'plane');
  const filtered = await searchLedger(p);
  const exPlane = (await expectSearches(p, 30)).filter((q) => q.includes('plane'));
  ok(filtered.count === before30.count && filtered.shown === exPlane.length && filtered.shown < filtered.listed, `filter narrows rows (${filtered.shown}) but not the count (${filtered.count})`);
  ok(new RegExp(`^${exPlane.length} of the ${filtered.listed} listed searches match`).test(await p.eval(() => document.querySelector('[data-search-status]')?.textContent ?? '')), 'filtered row count is stated separately from the count');
  await p.setValue('#hq', 'zzzz');
  ok(/None of the \d+ listed searches match/.test(await p.eval(() => document.querySelector('.filter-empty')?.textContent ?? '')), 'no match has its own empty state');
  await p.setValue('#hq', '');
  const raw = await p.eval(() => [...document.querySelectorAll('.srow__text')].map((x) => x.textContent));
  ok(raw.includes('kids & cartoons < 20 min') && raw.includes('"slow tv" -compilation'), 'queries are shown as literal text');
  await selectDevice(p, 'Living room TV');
  const tv = await searchLedger(p);
  ok(tv.count === '' && tv.figure === '—' && (await count(p, '.srow')) === 0 && /doesn’t record searches/.test(await p.eval(() => document.querySelector('.empty__title')?.textContent ?? '')), 'a TV shows “not recorded”, not zero searches');
  await p.click('[data-action="history-all-devices"]');
  ok((await p.eval(() => document.getElementById('hdev').value)) === 'all', '“Show all devices” resets the device filter');
  await selectDevice(p, 'Laptop');
  ok((await searchLedger(p)).count === String((await expectSearches(p, 30, 'Laptop')).length), 'browser device scopes the count');
  await selectDevice(p, 'all');
  await p.click('[data-key="history:days:7"]');
  await p.shot('desktop-searches');
  await p.click('.history__head .htabs__tab[href="#/history"]');
  const watchedAfter = await ledger(p);
  ok(watchedAfter.total === watchedBefore.total && watchedAfter.videos === watchedBefore.videos && (await p.eval(() => document.getElementById('hq').value)) === '', 'watch numbers and their filter are untouched by Searches');

  console.log('Evidence');
  const fixtures = await p.eval(() => Object.entries(window.OwnTubeFixtures.evidence).map(([k, v]) => [k, v.id, v.raw]));
  ok(fixtures.length >= 10 && fixtures.every(([, id, text]) => sha256(text) === id), `every evidence ID is the SHA-256 of its exact text (${fixtures.length} snapshots)`);
  ok(fixtures.every(([, , text]) => { try { JSON.parse(text); return true; } catch { return false; } }), 'every snapshot is valid JSON');
  const playId = (video, device) => p.eval((k, v, d) => JSON.parse(localStorage.getItem(k)).history.find((h) => h.videoId === v && h.device === d)?.id, STATE, video, device);
  const openEv = async (video, device) => {
    const id = await playId(video, device);
    await p.click(`[data-key="h:${id}:evidence"]`);
    await sleep(150);
    return id;
  };
  const evText = (sel) => p.eval((s) => document.querySelector(`#dlg-evidence ${s}`)?.textContent.replace(/\s+/g, ' ').trim() ?? null, sel);

  const planeId = await openEv('smpVplane0011', 'Laptop');
  ok(await p.eval(() => document.getElementById('dlg-evidence').open), 'Evidence opens from the play row');
  ok(/Chrome collector/.test(await evText('[data-ev-collector]')) && /not a fresh YouTube lookup/.test(await evText('[data-ev-collector]')), 'says saved evidence, not a fresh lookup, and names the collector');
  ok(/English/.test(await evText('[data-ev-estimate]')) && /high confidence/.test(await evText('[data-ev-estimate]')), 'Chrome estimate shows language, confidence and signal');
  ok(await p.eval(() => document.querySelector('[data-ev-fg]').dataset.evFg === '520' && document.querySelector('[data-ev-bg]').dataset.evBg === '120'), 'context is this play’s own split');
  await p.click('#dlg-evidence .ev__raw > summary');
  const planeRaw = fixtures.find(([k]) => k === 'cPlaneV2');
  ok((await p.eval(() => document.querySelector('#dlg-evidence code[data-raw="exact"]')?.textContent)) === planeRaw[2], 'raw view is the exact saved text, byte for byte');
  ok((await evText('[data-evidence-id]')) === sha256(planeRaw[2]), 'shown evidence ID is the SHA-256 of that text');
  await sleep(200);
  ok(/Matches/.test(await evText('[data-digest-status]')), 'digest recomputed in the browser matches');
  await p.click('[data-key="ev:raw-formatted"]');
  ok((await p.eval(() => document.querySelector('#dlg-evidence code[data-raw="formatted"]')?.textContent)) === JSON.stringify(JSON.parse(planeRaw[2]), null, 2), 'formatted view is a labelled re-encoding');
  await p.key('Escape', { keyCode: 27 });
  ok(!(await p.eval(() => document.getElementById('dlg-evidence').open)) && (await focusKey(p)) === `h:${planeId}:evidence`, 'Esc closes and returns focus to the Evidence button');

  await openEv('smpVgotthard0', 'Living room TV');
  ok(/Not recorded/.test(await evText('[data-ev-estimate]')) && /not-run/.test(await evText('[data-ev-estimate]')), 'Android: no language estimate, and says analysis was not run');
  ok(/Default audio\s*Not recorded/.test(await p.eval(() => document.getElementById('dlg-evidence').textContent.replace(/\s+/g, ' '))), 'Android: default audio is “Not recorded”, never guessed');
  ok((await p.eval(() => document.querySelector('[data-ev-description]')?.textContent.length)) === 10000 && !!(await evText('[data-ev-truncated]')), 'truncated description: 10,000 characters and flagged');
  ok(/154 translation options/.test(await p.eval(() => document.getElementById('dlg-evidence').textContent)), 'omitted caption translation options are counted, not listed');
  ok(/no transcript/.test(await p.eval(() => document.getElementById('dlg-evidence').textContent)), 'caption tracks are not presented as a transcript');
  await p.key('Escape', { keyCode: 27 });

  await openEv('smpVeis000013', 'Living room TV');
  ok(/didn’t expose a description/.test(await p.eval(() => document.getElementById('dlg-evidence').textContent)) && !!(await evText('[data-ev-mapping]')), 'partial Android snapshot: missing description and failed getter are stated');
  await p.key('Escape', { keyCode: 27 });

  await openEv('smpVfight033', 'Bedroom TV');
  ok(!!(await evText('[data-ev-missing]')) && (await count(p, '#dlg-evidence .ev__raw')) === 0, 'play without a snapshot says so and shows no raw section');
  await p.key('Escape', { keyCode: 27 });

  await p.eval(() => { delete window.__ownTubeXss; });
  await openEv('smpVtop10023', 'Laptop');
  await p.click('#dlg-evidence .ev__raw > summary');
  await sleep(150);
  ok(await p.eval(() => window.__ownTubeXss === undefined && !document.querySelector('#dlg-evidence img[src="x"], #dlg-evidence script')), 'markup in saved text never runs');
  ok((await p.eval(() => document.querySelector('[data-ev-description]')?.textContent ?? '')).includes('<img src=x onerror="window.__ownTubeXss=1">'), 'markup in saved text is shown literally');
  await p.shot('desktop-evidence');
  await p.key('Escape', { keyCode: 27 });

  console.log('Stored state from before searches and evidence');
  await p.eval((k) => {
    const s = JSON.parse(localStorage.getItem(k));
    s.schema = 1;
    s.devices = ['Living room TV', 'Bedroom TV'];
    s.history = s.history.filter((h) => h.device !== 'Laptop').map(({ ctx, evidenceKey, estimate, ...h }) => h);
    delete s.searches;
    s.draft.suggested.videos = s.draft.suggested.videos.filter((e) => e.id !== 'smpVlathe0003'); // an owner edit to keep
    localStorage.setItem(k, JSON.stringify(s));
  }, STATE);
  await p.go('#/history/searches');
  const migrated = await state(p);
  ok(migrated.schema === 2 && migrated.searches.length > 0 && migrated.history.every((h) => h.ctx && 'evidenceKey' in h), 'schema 1 state migrates: searches, context and evidence added');
  ok(!migrated.draft.suggested.videos.some((e) => e.id === 'smpVlathe0003'), 'migration keeps the owner’s draft edits');
  ok((await count(p, '.srow')) > 0, 'migrated state renders searches');

  console.log('Phone');
  await p.size(390, 844, true);
  await p.eval((k) => localStorage.removeItem(k), STATE);
  await p.go('#/history');
  ok(await p.eval(() => document.querySelector('.history__mhead h1')?.getBoundingClientRect().top < document.querySelector('#hq').getBoundingClientRect().top), 'phone: History heading comes before the filters');
  ok(await p.eval(() => [...document.querySelectorAll('.hrow__actions .btn')].every((b) => b.getBoundingClientRect().right <= innerWidth)), 'phone: row actions stay on screen');
  ok(await p.eval(() => { const t = document.querySelector('.history__mhead .htabs'); return !!t?.offsetParent && t.getBoundingClientRect().top < document.getElementById('hq').getBoundingClientRect().top; }), 'phone: Watched/Searches switch sits above the filters');
  await p.shot('phone-history');
  const phoneEv = await playId('smpVgotthard0', 'Living room TV');
  await p.click(`[data-key="h:${phoneEv}:evidence"]`);
  await sleep(150);
  ok(await p.eval(() => { const d = document.getElementById('dlg-evidence'); return d.open && d.scrollWidth <= d.clientWidth + 1 && d.getBoundingClientRect().right <= innerWidth + 1; }), 'phone: evidence sheet fits the width');
  await p.shot('phone-evidence');
  await p.click('[data-key="ev:done"]');
  ok((await focusKey(p)) === `h:${phoneEv}:evidence`, 'phone: Done returns focus to the row');
  await p.go('#/history/searches');
  ok(await p.eval(() => document.documentElement.scrollWidth <= innerWidth && document.querySelectorAll('.srow').length > 0), 'phone: searches fit without horizontal scrolling');
  await p.shot('phone-searches');
  await p.go('#/curation/suggested-videos');
  await p.click('[data-key="row:suggested.videos:smpVzahnrad01:more"]');
  ok(await p.eval(() => document.getElementById('dlg-item').open), 'phone: ⋯ opens the item sheet');
  await p.shot('phone-item');
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.log(`  FAIL threw: ${err.message}`);
} finally {
  ok(p.errors.length === 0, `no console errors${p.errors.length ? `:\n${p.errors.join('\n')}` : ''}`);
  console.log(`\n${passed} passed, ${failures.length} failed${SHOTS ? ` · screenshots: ${OUT}` : ''}`);
  chrome.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}
