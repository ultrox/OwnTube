import { readSetting, writeSetting, configure } from './outbox.js';

export function serverOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw Error('Use an HTTPS server origin, or local HTTP.');
  }
  return url.origin;
}

// One operation at a time in this worker; all durable state lives in IndexedDB.
// Persist the secret BEFORE requesting a code so retrying a lost response is safe.
export function createPairer(db, request = fetch) {
  let work = Promise.resolve();
  const serial = (fn) => { const next = work.then(fn); work = next.catch(() => {}); return next; };
  const visible = (p) => p ? ({ state: 'pending', server: p.server, code: p.code, expiresAt: p.expiresAt }) : ({ state: 'idle' });
  async function api(p, action) {
    const response = await request(`${p.server}/api/pairing/${action}`, {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${p.secret}` }, signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Error(data?.error || `Connection failed (${response.status}). Try again.`);
    if (!data || !['pending', 'approved', 'expired'].includes(data.state)) throw Error('Could not read the pairing response.');
    return data;
  }
  async function apply(p, data) {
    if (data.state === 'approved') {
      if (typeof data.deviceId !== 'string' || !data.deviceId || typeof data.label !== 'string') throw Error('Invalid connection response.');
      await configure(db, { server: p.server, deviceId: data.deviceId, token: p.secret, label: data.label, person: data.person }, { onlyIfUnpaired: true });
      await writeSetting(db, 'pairing', null);
      return { state: 'connected', label: data.label, person: data.person, server: p.server };
    }
    if (data.state === 'expired') { await writeSetting(db, 'pairing', null); return { state: 'expired' }; }
    if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(data.code) || !Number.isFinite(data.expiresAt)) throw Error('Invalid pairing code response.');
    p = { ...p, code: data.code, expiresAt: data.expiresAt };
    await writeSetting(db, 'pairing', p);
    return visible(p);
  }
  async function poll() {
    const config = await readSetting(db, 'config');
    if (config) return { state: 'connected', label: config.label || 'This browser', person: config.person || '', server: config.server };
    const p = await readSetting(db, 'pairing');
    if (!p) return { state: 'idle' };
    return apply(p, await api(p, p.code ? 'status' : 'start'));
  }
  return {
    poll: () => serial(poll),
    start: (value) => serial(async () => {
      const server = serverOrigin(value);
      if (await readSetting(db, 'config')) return poll();
      let p = await readSetting(db, 'pairing');
      if (p && p.server !== server) throw Error('Finish the current connection before changing servers.');
      if (p?.code) {
        const result = await poll();
        if (result.state !== 'expired') return result;
        p = null;
      }
      if (!p) {
        const secret = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
        p = { server, secret };
        await writeSetting(db, 'pairing', p);
      }
      return apply(p, await api(p, 'start'));
    }),
  };
}
