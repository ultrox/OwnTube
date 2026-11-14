import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openOutbox, readSetting, writeSetting, configure, append, status } from '../src/outbox.js';
import { createPairer, serverOrigin } from '../src/device-pairing.js';

async function fresh() {
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('youtube-observer'); req.onsuccess = resolve; req.onerror = reject;
  });
  return openOutbox();
}
const server = 'https://observer.example';
const pending = () => ({ state: 'pending', code: 'ABCD-EFGH', expiresAt: Date.now() + 600000 });
const approved = { state: 'approved', deviceId: 'new-browser', label: 'Chrome', person: 'Wife' };
const response = data => ({ ok: true, json: async () => data });

test('lost start response, concurrent clicks and worker restart retain one private secret', async () => {
  let db = await fresh(), lost = true, state = pending(), auth;
  const request = async (url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    const saved = await readSetting(db, 'pairing');
    assert.equal(options.headers.Authorization, `Bearer ${saved.secret}`);
    assert.match(saved.secret, /^[a-f0-9]{64}$/);
    auth ||= options.headers.Authorization;
    assert.equal(auth, options.headers.Authorization);
    if (lost) { lost = false; throw Error('Lost response'); }
    return response(state);
  };
  let pairing = createPairer(db, request);
  await assert.rejects(pairing.start(server), /Lost response/);
  const results = await Promise.all([pairing.start(server), pairing.start(server)]);
  assert.equal(results[0].code, 'ABCD-EFGH');
  assert.ok(!JSON.stringify(results).includes(auth.slice(7)), 'private key never appears in code UI');
  db.close(); db = await openOutbox(); pairing = createPairer(db, request);
  state = approved;
  assert.equal((await pairing.poll()).state, 'connected');
  assert.equal((await readSetting(db, 'config')).token, auth.slice(7));
  assert.equal(await readSetting(db, 'pairing'), null);
  db.close();
});

test('expired code can be replaced; rejected approvals and offline polls do not configure', async () => {
  const db = await fresh();
  let state = pending(), fail = false;
  const p = createPairer(db, async () => { if (fail) throw Error('offline'); return response(state); });
  await p.start(server);
  const first = (await readSetting(db, 'pairing')).secret;
  fail = true; await assert.rejects(p.poll(), /offline/);
  assert.equal((await readSetting(db, 'pairing')).secret, first);
  assert.equal(await readSetting(db, 'config'), undefined);
  fail = false; state = { state: 'expired' }; assert.equal((await p.poll()).state, 'expired');
  state = pending(); await p.start(server);
  assert.notEqual((await readSetting(db, 'pairing')).secret, first);
  db.close();
});

test('pairing never replaces an existing or concurrently configured browser or its queued data', async () => {
  const db = await fresh();
  let approve = false;
  const existing = { server, deviceId: 'existing', token: 'existing-secret' };
  const p = createPairer(db, async () => {
    if (approve) { await configure(db, existing); return response(approved); }
    return response(pending());
  });
  await p.start(server); approve = true;
  await assert.rejects(p.poll(), /connected elsewhere/);
  assert.deepEqual(await readSetting(db, 'config'), existing);
  await append(db, [{ eventId: 'saved', kind: 'search', t: Date.now(), query: 'hello' }]);
  assert.equal((await p.start(server)).state, 'connected');
  assert.equal((await status(db)).count, 1);
  assert.deepEqual(await readSetting(db, 'config'), existing);
  db.close();
});

test('pending pairing cannot silently change servers and origin validation rejects paths and credentials', async () => {
  const db = await fresh(), p = createPairer(db, async () => response(pending()));
  await p.start(server);
  await assert.rejects(p.start('https://different.example'), /Finish the current connection/);
  for (const url of ['https://a:b@example.com', 'https://example.com/path', 'https://example.com/?key=secret', 'http://example.com']) {
    assert.throws(() => serverOrigin(url));
  }
  assert.equal(serverOrigin('http://127.0.0.1:13213'), 'http://127.0.0.1:13213');
  db.close();
});
