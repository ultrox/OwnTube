// Live adapter for the Languages module: same-origin requests with the owner session cookie.
// Contract: contracts/languages.md. Every method resolves with the parsed JSON body or rejects
// with ApiError {status, message, body}; status 0 means the server could not be reached.

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body) {
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
  // Longer than the server's 20 s analysis-provider deadline, so its own error (or commit) arrives.
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(30000);
  let res;
  try {
    res = await fetch(path, init);
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError';
    throw new ApiError(0, timedOut ? 'The server took too long to answer.' : 'The server could not be reached.');
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const message = data && typeof data.error === 'string' && data.error.trim() ? data.error : `Request failed (${res.status}).`;
    throw new ApiError(res.status, message, data);
  }
  return data;
}

const query = (params) => new URLSearchParams(Object.entries(params).map(([k, v]) => [k, v == null ? '' : String(v)])).toString();

export const liveApi = {
  mode: 'live',
  session: () => request('GET', '/api/session'),
  login: (token) => request('POST', '/api/login', { token }),
  logout: () => request('POST', '/api/logout', {}),
  // {days, device, person, language, status, query, page}
  languages: (params) => request('GET', `/api/modules/languages?${query(params)}`),
  evidence: (device, metadata) => request('GET', `/api/modules/languages/evidence?${query({ device, metadata })}`),
  // {deviceId, metadataId, baseRevision, action: 'manual'|'analyze'|'reset', lang?, note?, provider?}
  assess: (body) => request('POST', '/api/modules/languages/assessment', body),
};
