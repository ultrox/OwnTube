import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { launch, waitFor } from '../support/browser.mjs';

test('short-code setup → expiry → worker restart → owner approval → attributed upload', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-pairing-'));
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const bind = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${bind}`, admin = 'pairing-browser-test-owner';
  const server = spawn(path.resolve('target/debug/youtube-observer'), [], {
    env: { ...process.env, BIND: `127.0.0.1:${bind}`, DATA_DIR: folder, ADMIN_TOKEN: admin }, stdio: 'ignore',
  });
  let browser;
  try {
    await waitFor(() => fetch(`${origin}/health`).then(r => r.ok), { timeout: 10000 });
    browser = await launch({ extensionPath: path.resolve('../apps/chrome-extension/dist') });
    const popup = await browser.newPage(`chrome-extension://${browser.extId}/popup.html`);
    await popup.waitFor('#onboarding:not([hidden])');
    assert.equal(await popup.attr('#onboarding a', 'target'), '_blank');
    let setup = await browser.newPage(`chrome-extension://${browser.extId}/pairing.html`);
    await setup.waitFor('#connect:not([disabled])');
    await setup.type('#server', origin);
    await setup.realClick('#connect');
    await setup.waitFor('#waiting:not([hidden])');
    const expiredCode = await setup.text('#code');
    assert.match(expiredCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(await setup.eval(o => chrome.permissions.contains({ origins: [`${o}/*`] }), origin), true);
    const owner = await browser.newPage(`${origin}/connect/`);
    await owner.waitFor('#login:not([hidden])');
    await owner.type('#owner-key', admin);
    await owner.realClick('#login button');
    await owner.waitFor('#approve:not([hidden])');
    assert.equal(await owner.eval(() => document.querySelector('#owner-key').value), '');
    await owner.type('#code', expiredCode);
    await owner.type('#person-name', 'Test viewer');
    await owner.type('#label', 'Family laptop');
    execFileSync('python3', ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE pairing_requests SET expires=0"); db.commit()', path.join(folder, 'observer.sqlite3')]);
    await owner.realClick('#approve-button');
    await owner.waitFor('#error:not([hidden])', 'expired');
    await setup.eval(() => chrome.runtime.sendMessage({ tag: 'PairStatus' }));
    await setup.goto(`chrome-extension://${browser.extId}/pairing.html`);
    await setup.waitFor('#connect:not([disabled])');
    await setup.type('#server', origin);
    await setup.realClick('#connect');
    await setup.waitFor('#waiting:not([hidden])');
    const code = await setup.text('#code');
    assert.notEqual(code, expiredCode);
    await setup.close();
    await browser.stopWorker(popup);
    setup = await browser.newPage(`chrome-extension://${browser.extId}/pairing.html`);
    await setup.waitFor('#waiting:not([hidden])');
    assert.equal(await setup.text('#code'), code, 'same code after worker restart');
    await browser.reconnectWorker();
    await owner.type('#code', code.toLowerCase());
    fs.mkdirSync('artifacts', { recursive: true });
    for (const width of [1280, 390]) {
      await owner.setSize(width, 900);
      await owner.eval(() => window.scrollTo(0, 0));
      assert.equal(await owner.eval(() => document.documentElement.scrollWidth <= innerWidth), true);
      await owner.screenshot(`artifacts/pairing-owner-${width}.png`);
    }
    await owner.realClick('#approve-button');
    await owner.waitFor('#success:not([hidden])');
    await waitFor(() => setup.count('#connected:not([hidden])'), { timeout: 10000 });
    assert.equal(await setup.text('#saved-connection'), 'Family laptop · Test viewer');
    await setup.screenshot('artifacts/pairing-connected.png');
    const config = (await popup.eval(() => chrome.runtime.sendMessage({ tag: 'Status' }))).config;
    assert.ok(config.deviceId);
    assert.equal(config.token, undefined, 'status never exposes the private key');
    await owner.click('#another');
    await owner.waitFor('#person option', 'Test viewer');
    const person = await owner.eval(() => [...document.querySelectorAll('#person option')].find(p => p.textContent === 'Test viewer').value);
    // A real content script records playback, then the approved browser uploads it.
    const video = await browser.newPage();
    await video.s.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    video.s.on('Fetch.requestPaused', e => void video.s.send('Fetch.fulfillRequest', {
      requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      body: fs.readFileSync('tests/fixtures/youtube.html').toString('base64'),
    }));
    await video.goto('https://www.youtube.com/watch?v=abcdefghijk');
    await video.foreground();
    await waitFor(() => video.eval(() => document.querySelector('video').currentTime > 3), { timeout: 10000 });
    await video.eval(() => document.querySelector('video').pause());
    await waitFor(async () => (await popup.eval(() => chrome.runtime.sendMessage({ tag: 'Status' }))).count > 0);
    await popup.eval(() => chrome.runtime.sendMessage({ tag: 'Drain' }));
    const data = await owner.eval(p => fetch(`/api/dashboard?person=${p}`).then(r => r.json()), person);
    assert.ok(data.seconds > 0);
    assert.ok(data.devices.some(d => d.id === config.deviceId && d.person === 'Test viewer'));
    assert.equal((await popup.eval(() => chrome.runtime.sendMessage({ tag: 'Status' }))).count, 0);
    // Connected setup never starts a second device, and both dashboard headers link here.
    assert.equal((await setup.eval(o => chrome.runtime.sendMessage({ tag: 'PairStart', server: o }), origin)).pairing.state, 'connected');
    for (const route of ['/#/history', '/modules/languages/']) {
      await owner.goto(origin + route);
      await owner.waitFor('a[href="/connect/"]', 'Connect device');
    }
    await owner.goto(origin + '/connect/');
    await owner.waitFor('#devices:not([hidden])');
    await owner.waitFor(`[data-device-id="${config.deviceId}"]`);
    const exported = await owner.eval(() => fetch('/api/export').then(r => r.json()));
    assert.ok(exported.viewings.length > 0);
    // A failed deletion leaves the device and its action available for retry.
    const route = `${origin}/api/devices/${config.deviceId}/revoke`;
    await owner.s.send('Fetch.enable', { patterns: [{ urlPattern: route }] });
    owner.s.on('Fetch.requestPaused', e => void owner.s.send('Fetch.fulfillRequest', {
      requestId: e.requestId, responseCode: 503,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from('{"error":"Temporarily unavailable"}').toString('base64'),
    }));
    await owner.realClick(`[data-device-id="${config.deviceId}"]`);
    await owner.waitFor('#error:not([hidden])', 'Temporarily unavailable');
    assert.equal(await owner.count(`[data-device-id="${config.deviceId}"]:not([disabled])`), 1);
    await owner.s.send('Fetch.disable');
    await owner.realClick(`[data-device-id="${config.deviceId}"]`);
    await owner.waitFor('#device-notice', 'recorded history was kept');
    assert.equal(await owner.count('[data-device-id]'), 0);
    assert.equal(await owner.count('#devices-empty:not([hidden])'), 1);
    assert.deepEqual(await owner.eval(() => fetch('/api/export').then(r => r.json())), exported);
    const kept = await owner.eval(p => fetch(`/api/dashboard?person=${p}`).then(r => r.json()), person);
    assert.equal(kept.seconds, data.seconds);
    assert.equal(kept.devices.find(d => d.id === config.deviceId).revoked, true);
    await owner.goto(origin + '/connect/');
    await owner.waitFor('#devices-empty:not([hidden])');
    // The disconnected browser keeps its local queue but its credential no longer uploads.
    await video.foreground();
    const elapsed = await video.eval(() => document.querySelector('video').currentTime);
    await video.eval(() => document.querySelector('video').play());
    await waitFor(() => video.eval(t => document.querySelector('video').currentTime > t + 2, elapsed));
    await video.eval(() => document.querySelector('video').pause());
    await waitFor(async () => (await popup.eval(() => chrome.runtime.sendMessage({ tag: 'Status' }))).count > 0);
    await popup.eval(() => chrome.runtime.sendMessage({ tag: 'Drain' }));
    const disconnected = await popup.eval(() => chrome.runtime.sendMessage({ tag: 'Status' }));
    assert.equal(disconnected.sync.paused, true);
    assert.ok(disconnected.count > 0);
    assert.deepEqual(await owner.eval(() => fetch('/api/export').then(r => r.json())), exported);
  } finally {
    await browser?.close();
    const exit = once(server, 'exit'); server.kill('SIGINT'); await exit;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
