// Live adapter for the History desk: same-origin requests with the owner session cookie.
// Contract: contracts/history.md. Every method resolves with the parsed JSON body or rejects
// with ApiError {status, message, body}; status 0 means the server could not be reached.

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// A successful answer must be a JSON object or array; an empty or unreadable body is an error
// rather than "no data". Only sign-in and sign-out may answer with an empty body.
async function request(method, path, body, { emptyOk = false } = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(30000);
  let res;
  try {
    res = await fetch(path, init);
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError';
    throw new ApiError(0, timedOut ? 'The server took too long to answer.' : 'The server could not be reached.');
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    throw new ApiError(0, 'The server’s answer was cut off.');
  }
  let data = null;
  let parsed = false;
  if (text) {
    try { data = JSON.parse(text); parsed = true; } catch { data = null; }
  }
  if (!res.ok) {
    const message = data && typeof data.error === 'string' && data.error.trim() ? data.error : `Request failed (${res.status}).`;
    throw new ApiError(res.status, message, data);
  }
  if (!text && emptyOk) return null;
  if (!parsed || data === null || typeof data !== 'object') {
    throw new ApiError(res.status, text ? 'The server’s answer couldn’t be read.' : 'The server sent an empty answer.');
  }
  return data;
}

// Empty strings are sent (they mean "all"); undefined and null are left out, so the paging pair
// (generation/until or before/until) is only sent when both halves are known.
const query = (params) => new URLSearchParams(
  Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]),
).toString();

export const api = {
  session: () => request('GET', '/api/session'),
  login: (token) => request('POST', '/api/login', { token }, { emptyOk: true }),
  logout: () => request('POST', '/api/logout', {}, { emptyOk: true }),
  // {days, device, person, query, page, generation?, until?}
  history: (params) => request('GET', `/api/history?${query(params)}`),
  // {days, device, person, query, page, before?, until?}
  searches: (params) => request('GET', `/api/history/searches?${query(params)}`),
  evidence: (device, metadata) => request('GET', `/api/history/evidence?${query({ device, metadata })}`),
};
