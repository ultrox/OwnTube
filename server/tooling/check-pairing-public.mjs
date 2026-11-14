// Read-only release verification. Only owner login/logout create session writes.
// node server/tooling/check-pairing-public.mjs ORIGIN OWNER_KEY_FILE OUTPUT_DIRECTORY
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { launch } from '../tests/support/browser.mjs';

const [origin, keyFile, output] = process.argv.slice(2);
if (!origin || !keyFile || !output) throw Error('Supply origin, owner-key file and output directory');
const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, 'apps/backoffice/dist');
await fs.mkdir(output, { recursive: true });
const get = route => execFileSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '30', origin + route]);
const html = get('/connect/').toString();
assert.equal(html, await fs.readFile(path.join(dist, 'connect/index.html'), 'utf8'));
const assets = [];
for (const [, file] of html.matchAll(/(?:src|href)="([^"]+\.(?:css|js))"/g)) {
  const bytes = get(`/connect/${file}`);
  assert.deepEqual(bytes, await fs.readFile(path.join(dist, 'connect', file)));
  assert.ok(file.includes(createHash('sha256').update(bytes).digest('hex').slice(0, 16)));
  assets.push(file);
}
const downloads = {};
for (const file of ['youtube-observer-0.2.1.zip', 'youtube-observer-0.3.0.zip', 'youtube-observer-latest.zip']) {
  const bytes = get(`/${file}`);
  assert.deepEqual(bytes, await fs.readFile(path.join(dist, file)));
  downloads[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const browser = await launch({ extensionPath: path.join(root, 'apps/chrome-extension/dist'), profileRoot: output });
const errors = [];
try {
  const page = await browser.newPage();
  page.s.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails.text));
  await page.goto(origin + '/connect/');
  await page.waitFor('#login:not([hidden])');
  await page.type('#owner-key', (await fs.readFile(keyFile, 'utf8')).trim());
  await page.realClick('#login button');
  await page.waitFor('#approve:not([hidden])');
  const people = await page.eval(() => document.querySelector('#person').options.length - 2);
  assert.ok(people > 0);
  await page.waitFor('#devices:not([hidden])');
  const devices = await page.eval(() => fetch('/api/pairing').then(r => r.json()).then(d => d.devices));
  assert.deepEqual(
    await page.eval(() => [...document.querySelectorAll('[data-device-id]')].map(b => b.dataset.deviceId).sort()),
    devices.map(d => d.id).sort());
  for (const theme of ['light', 'dark']) {
    await page.s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    for (const width of [1280, 390]) {
      await page.setSize(width, 1000);
      await page.eval(() => window.scrollTo(0, 0));
      assert.equal(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot(path.join(output, `approval-${theme}-${width}.png`));
      await page.eval(() => document.querySelector('#devices').scrollIntoView());
      assert.equal(await page.eval(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot(path.join(output, `devices-${theme}-${width}.png`));
    }
  }
  for (const route of ['/#/history', '/modules/languages/']) {
    await page.goto(origin + route);
    await page.waitFor('a[href="/connect/"]', 'Connect device');
  }
  assert.equal(await page.eval(() => fetch('/api/logout', { method: 'POST' }).then(r => r.ok)), true);
  assert.deepEqual(errors, []);
  const report = { origin, assets, downloads, people, connectedDevices: devices.length, errors, productionDevicesCreated: 0, productionDevicesDeleted: 0 };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
