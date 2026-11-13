// Tiny zero-dependency browser driver: launches Chromium with the extension loaded and talks to it
// over the DevTools protocol (Node's built-in fetch + WebSocket).
//
// Chromium: $CHROME_BIN, else the newest "Chrome for Testing" in the Playwright cache, else Helium.
// (Google Chrome 137+ ignores --load-extension, so it can't be used.)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : process.platform === 'win32' ? 'AppData/Local/ms-playwright' : '.cache/ms-playwright');
  const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const b of builds) {
    for (const relative of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe',
    ]) {
      const p = path.join(cache, b, relative);
      if (fs.existsSync(p)) return p;
    }
  }
  const helium = '/Applications/Helium.app/Contents/MacOS/Helium';
  if (fs.existsSync(helium)) return helium;
  throw new Error('No Chromium found: set CHROME_BIN');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 5000, interval = 50, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${message} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

/** One DevTools target (page or service worker). */
class Session {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  static async connect(url) {
    const s = new Session();
    s.#ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => { s.#ws.close(); rej(new Error('DevTools connection timed out')); }, 5000);
      s.#ws.onopen = () => { clearTimeout(timer); res(); };
      s.#ws.onerror = () => { clearTimeout(timer); rej(new Error('DevTools connection failed')); };
    });
    s.#ws.onclose = () => {
      for (const { rej } of s.#pending.values()) rej(new Error('DevTools connection closed'));
      s.#pending.clear();
    };
    s.#ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && s.#pending.has(msg.id)) {
        const { res, rej } = s.#pending.get(msg.id);
        s.#pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) s.#listeners.get(msg.method)?.forEach((f) => f(msg.params));
    };
    return s;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`DevTools timed out: ${method}`));
      }, 15000);
      const res = (value) => { clearTimeout(timer); resolve(value); };
      const rej = (error) => { clearTimeout(timer); reject(error); };
      this.#pending.set(id, { res, rej });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#pending.delete(id);
        rej(error);
      }
    });
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(fn);
  }

  /** Run `fn(...args)` in the target and return its (awaited, JSON) result. */
  async eval(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  close() {
    this.#ws.close();
  }
}

/** A page with a few DOM helpers. Dialogs (alert/confirm/prompt) are accepted automatically. */
export class Page {
  constructor(session) {
    this.s = session;
    this.dialogs = [];
    this.promptAnswer = undefined;
    session.on('Page.javascriptDialogOpening', (p) => {
      this.dialogs.push(p);
      void session.send('Page.handleJavaScriptDialog', { accept: true, promptText: this.promptAnswer ?? p.defaultPrompt ?? '' });
    });
  }
  eval(fn, ...args) {
    return this.s.eval(fn, ...args);
  }
  async goto(url) {
    const result = await this.s.send('Page.navigate', { url });
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText} (${url})`);
    await waitFor(() => this.eval((expected) => location.href === expected && document.readyState === 'complete', url), { message: `load ${url}` });
  }
  async foreground() { await this.s.send('Page.bringToFront'); }
  async close() { await this.s.send('Page.close'); }
  async setSize(width, height) {
    await this.s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }
  /** Wait for a selector (optionally containing text) and return how many match. */
  waitFor(selector, text) {
    return waitFor(
      () => this.eval((sel, txt) => [...document.querySelectorAll(sel)].filter((e) => !txt || e.textContent.includes(txt)).length, selector, text),
      { message: `${selector}${text ? ` with "${text}"` : ''}` },
    );
  }
  count(selector, text) {
    return this.eval((sel, txt) => [...document.querySelectorAll(sel)].filter((e) => !txt || e.textContent.includes(txt)).length, selector, text);
  }
  text(selector) {
    return this.eval((sel) => document.querySelector(sel)?.textContent ?? null, selector);
  }
  attr(selector, name) {
    return this.eval((sel, n) => document.querySelector(sel)?.getAttribute(n) ?? null, selector, name);
  }
  /** Click the first element matching `selector` (and containing `text`, if given). */
  async click(selector, text) {
    await this.waitFor(selector, text);
    await this.eval(
      (sel, txt) => [...document.querySelectorAll(sel)].find((e) => !txt || e.textContent.includes(txt)).click(),
      selector,
      text,
    );
  }
  /** A trusted mouse click at the element's centre (needed for things like file choosers). */
  async realClick(selector, text) {
    await this.waitFor(selector, text);
    const [x, y] = await this.eval(
      (sel, txt) => {
        const el = [...document.querySelectorAll(sel)].find((e) => !txt || e.textContent.includes(txt));
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      },
      selector,
      text,
    );
    for (const type of ['mousePressed', 'mouseReleased'])
      await this.s.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  /** Fire mouseenter/mouseover like a real pointer arriving. */
  async hover(selector) {
    await this.waitFor(selector);
    await this.eval((sel) => {
      const el = document.querySelector(sel);
      for (const type of ['mouseover', 'mouseenter']) el.dispatchEvent(new MouseEvent(type, { bubbles: type === 'mouseover' }));
    }, selector);
  }
  async type(selector, value) {
    await this.waitFor(selector);
    await this.eval((sel, v) => {
      const el = document.querySelector(sel);
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, selector, value);
  }
  async screenshot(file) {
    const { data } = await this.s.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
}

/**
 * Launch Chromium with our extension + fixtures. Hosts ending in `.test` resolve to a local
 * server that answers every request with a small page, so rule tests need no network.
 */
export async function launch({ extensionPath, fixtures = [], extra = [], browser = findChrome(), profileRoot = os.tmpdir() } = {}) {
  if (!extensionPath) throw new Error('extensionPath is required');
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
  const extensionName = manifest.name;
  const server = http.createServer((_q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Connection': 'close' });
    res.end('<!doctype html><title>test</title><h1>test page</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const webPort = server.address().port;

  const userDir = fs.mkdtempSync(path.join(profileRoot, 'extension-e2e-'));
  const exts = [extensionPath, ...fixtures, ...extra].map(p => path.resolve(p)).join(',');
  const proc = spawn(
    browser,
    [
      '--headless=new',
      // macOS: isolated profiles still consult the system keychain unless this is set.
      '--use-mock-keychain',
      '--password-store=basic',
      `--user-data-dir=${userDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--disable-background-networking',
      '--disable-component-extensions-with-background-pages',
      '--disable-client-side-phishing-detection',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--disable-extensions-except=${exts}`,
      `--load-extension=${exts}`,
      `--host-resolver-rules=MAP *.test 127.0.0.1`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const sessions = [];
  const stopOnExit = () => proc.kill();
  process.once('exit', stopOnExit);
  const close = async () => {
    sessions.forEach((s) => s.close());
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => proc.kill('SIGKILL'), 3000);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
        proc.kill();
      });
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(userDir, { recursive: true, force: true });
    process.off('exit', stopOnExit);
  };

  try {
  const portFile = path.join(userDir, 'DevToolsActivePort');
  const port = await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], { timeout: 15000, message: 'DevTools port' });
  const api = async (p, method = 'GET') => (await fetch(`http://127.0.0.1:${port}${p}`, { method, signal: AbortSignal.timeout(5000) })).json();

  // Chrome runs component extensions with a background.js too, so identify ours by its manifest name.
  const connectWorker = () => waitFor(
    async () => {
      const targets = (await api('/json/list')).filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
      for (const t of targets) {
        const s = await Session.connect(t.webSocketDebuggerUrl);
        if ((await s.eval(() => chrome.runtime.getManifest().name).catch(() => '')) === extensionName) return Object.assign(s, { url: t.url });
        s.close();
      }
      return null;
    },
    { timeout: 15000, interval: 200, message: 'extension service worker' },
  );
  let sw = await connectWorker();
  const extId = new URL(sw.url).host;
  sessions.push(sw);

  return {
    extId,
    get sw() { return sw; },
    webPort,
    /** `https://www.figma.test/x` -> `http://www.figma.test:<port>/x` (served locally). */
    web: (url) => url.replace(/^https?:\/\/([^/]+)/, `http://$1:${webPort}`),
    async newPage(url = 'about:blank') {
      const t = await api(`/json/new?${encodeURIComponent(url)}`, 'PUT');
      const s = await Session.connect(t.webSocketDebuggerUrl);
      sessions.push(s);
      await s.send('Page.enable');
      await s.send('Runtime.enable');
      const page = new Page(s);
      if (url !== 'about:blank') await waitFor(() => page.eval(() => document.readyState === 'complete'), { message: `load ${url}` });
      return page;
    },
    async stopWorker(page) {
      const versions = [];
      page.s.on('ServiceWorker.workerVersionUpdated', event => versions.push(...event.versions));
      await page.s.send('ServiceWorker.enable');
      const version = await waitFor(() => versions.find(v => v.scriptURL === sw.url && v.runningStatus === 'running'), { message: 'worker version' });
      sw.close(); // debugger connections otherwise keep service workers alive
      await page.s.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      await waitFor(() => versions.some(v => v.versionId === version.versionId && v.runningStatus === 'stopped'), { message: 'worker stopped' });
    },
    async reconnectWorker() {
      sw = await connectWorker();
      sessions.push(sw);
    },
    async openPopup() {
      await sw.eval(() => chrome.action.openPopup());
      const target = await waitFor(async () => (await api('/json/list')).find(t => t.type === 'page' && t.url === `chrome-extension://${extId}/${manifest.action.default_popup}`), { message: 'native action popup' });
      const s = await Session.connect(target.webSocketDebuggerUrl);
      sessions.push(s);
      await s.send('Page.enable');
      await s.send('Runtime.enable');
      return new Page(s);
    },
    async attachPage(url) {
      const target = await waitFor(async () => (await api('/json/list')).find(t => t.type === 'page' && t.url === url), { message: `page ${url}` });
      const s = await Session.connect(target.webSocketDebuggerUrl);
      sessions.push(s);
      await s.send('Page.enable');
      await s.send('Runtime.enable');
      return new Page(s);
    },
    /** Helpers that run inside the extension's service worker. */
    ext: (name) => sw.eval(async (n) => (await chrome.management.getAll()).find((e) => e.name === n), name),
    storage: (area, key) => sw.eval(async (a, k) => (await chrome.storage[a].get(k))[k], area, key),
    close,
  };
  } catch (error) {
    await close();
    throw error;
  }
}

/** A temp dir of N throwaway extensions. */
export function manyExtensions(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-many-'));
  return Array.from({ length: n }, (_, i) => {
    const d = path.join(dir, `ext${i}`);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: `Fixture ${i}`, version: '1.0' }));
    return d;
  });
}
