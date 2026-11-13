// OwnTube backoffice · History desk: Watched and Searches (contract: contracts/history.md).
// Live data only: nothing here is sample data, and a failed request shows the server's error.
//
// Scope and snapshots. Period, device and person set every number; the text filter only narrows
// rows. Each view pages through a frozen server snapshot (Watched: generation + until, Searches:
// before + until). The pair is kept while the filter or page changes, and dropped when the scope
// changes, on Refresh, or when the server answers 410 (the list starts again at page 1).
import { ApiError, api } from './api.js';
import { versionKey, recordedVersions, findVersion, versionPickerHTML, savedEvidence, EvidenceDigests } from '/shared/recorded-versions.js';

/* ------------------------------------------------------------------ utilities */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : 0);
const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const plural = (n, one, many = `${one}s`) => `${num(n).toLocaleString('en')} ${num(n) === 1 ? one : many}`;
const DAYS = [7, 30, 90];
const PAGE_SIZE = 20;
const VIEWS = {
  watched: { path: '/history', tab: 'Watched' },
  searches: { path: '/history/searches', tab: 'Searches' },
};

function spentParts(sec) {
  const s = Math.round(num(sec));
  if (s === 0) return [['0', 'min']];
  if (s < 60) return [[String(s), 's']];
  const m = Math.round(s / 60);
  if (m < 60) return [[String(m), 'min']];
  const h = Math.floor(m / 60), r = m % 60;
  return r ? [[String(h), 'h'], [String(r), 'min']] : [[String(h), 'h']];
}
const spent = (sec) => spentParts(sec).map(([n, u]) => `${n} ${u}`).join(' ');
const spentHTML = (sec) => spentParts(sec).map(([n, u]) => `${n}<span class="u">${u}</span>`).join('');
function clock(sec) {
  const s = Math.max(0, Math.round(num(sec)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

// Every time is shown in the server's time zone and every day comes from the server's `date`;
// nothing is regrouped by the browser's zone.
const formats = new Map();
function format(options, timeZone) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  if (!formats.has(key)) {
    let f;
    try { f = new Intl.DateTimeFormat('en-GB', { ...options, timeZone }); } catch { f = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }); }
    formats.set(key, f);
  }
  return formats.get(key);
}
const clockTime = (ms, tz) => (has(ms) ? format({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, tz).format(Number(ms)) : '');
function dateIn(ms, tz) {
  const p = Object.fromEntries(format({ year: 'numeric', month: '2-digit', day: '2-digit' }, tz).formatToParts(Number(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const validDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const noon = (date) => Date.parse(`${date}T12:00:00Z`);
const shortDate = (date, year = false) => (validDate(date) ? format({ day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) }, 'UTC').format(noon(date)) : '');
const longDate = (date, year = false) => (validDate(date) ? format({ weekday: 'long', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) }, 'UTC').format(noon(date)).replace(',', '') : 'Date not recorded');
function dayTitle(date, today) {
  if (!validDate(date)) return 'Date not recorded';
  const diff = Math.round((noon(today) - noon(date)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return longDate(date, date.slice(0, 4) !== today.slice(0, 4));
}
function dateRange(first, last) {
  if (!validDate(first) || !validDate(last)) return '';
  if (first === last) return shortDate(first);
  if (first.slice(0, 7) === last.slice(0, 7)) return `${Number(first.slice(8))}–${shortDate(last)}`;
  const years = first.slice(0, 4) !== last.slice(0, 4);
  return `${shortDate(first, years)} – ${shortDate(last, years)}`;
}
const isoTime = (ms) => (has(ms) ? new Date(Number(ms)).toISOString() : '');

const displayNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; } })();
function langName(code) {
  if (!code) return '';
  try {
    const name = displayNames?.of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}
const names = (list) => (list.length <= 1 ? list.join('') : list.length === 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

const ICON = {
  search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.4 10.4L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

/* ------------------------------------------------------------------ state and routes */

// `data` is shown only while `dataScope` matches the current scope; `dataQ` is the filter text the
// data answers (it can differ from `q` while a newer request is on its way).
const blankView = () => ({ q: '', draft: null, page: 1, data: null, dataScope: '', dataQ: '', snap: null, loading: false, error: null, notice: null, ticket: 0 });
const state = {
  auth: 'checking', // checking | signedOut | signedIn
  login: { busy: false, error: '' },
  logout: { busy: false, error: '' },
  view: 'watched',
  scope: { days: 7, device: '', person: '' },
  views: { watched: blankView(), searches: blankView() },
  dialog: null,
};
const scopeKey = () => `${state.scope.days}|${state.scope.device}|${state.scope.person}`;

// Routes: #/history (Watched) and #/history/searches, each with ?days&device&person&q&page.
// Period, device and person are shared by both views; each view keeps its own filter and page.
function readRoute() {
  const raw = location.hash.replace(/^#/, '');
  if (raw && !raw.startsWith('/')) return null; // an in-page anchor, not a route
  const [path, search = ''] = raw.split('?');
  const p = new URLSearchParams(search);
  const days = Number(p.get('days'));
  return {
    view: path === VIEWS.searches.path ? 'searches' : 'watched',
    known: !raw || path === VIEWS.watched.path || path === VIEWS.searches.path,
    days: DAYS.includes(days) ? days : 7,
    device: (p.get('device') || '').slice(0, 200),
    person: (p.get('person') || '').slice(0, 200),
    q: (p.get('q') || '').slice(0, 200),
    page: Math.max(1, Math.floor(Number(p.get('page'))) || 1),
  };
}
function hashFor(name) {
  const v = state.views[name];
  const s = state.scope;
  const p = new URLSearchParams();
  if (s.days !== 7) p.set('days', String(s.days));
  if (s.device) p.set('device', s.device);
  if (s.person) p.set('person', s.person);
  if (v.q) p.set('q', v.q);
  if (v.page > 1) p.set('page', String(v.page));
  const qs = p.toString();
  return `#${VIEWS[name].path}${qs ? `?${qs}` : ''}`;
}
function writeHash() {
  const next = hashFor(state.view);
  if (location.hash !== next) history.replaceState(null, '', `${location.pathname}${location.search}${next}`);
}
function adoptRoute(r) {
  state.view = r.view;
  state.scope = { days: r.days, device: r.device, person: r.person };
  const v = state.views[r.view];
  v.q = r.q;
  v.draft = null;
  v.page = r.page;
}

/* ------------------------------------------------------------------ data */

const NOTICE_GONE = 'The saved list is no longer available, so this shows the current records from page 1.';

// A successful answer still has to look like the contract before it is shown as numbers.
function readable(name, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The server’s answer couldn’t be read.');
  if (!Array.isArray(data.rows) || !Array.isArray(data.daily)) throw new Error(`The server’s answer has no ${name === 'watched' ? 'entries' : 'searches'} list.`);
  return data;
}

async function load(name = state.view, { fresh = false, notice = null } = {}) {
  const v = state.views[name];
  const key = scopeKey();
  if (fresh || (v.snap && v.snap.scope !== key)) v.snap = null;
  v.notice = notice;
  if (name === state.view) writeHash();
  const mine = ++v.ticket;
  v.loading = true;
  render();
  const s = state.scope;
  const params = { days: s.days, device: s.device, person: s.person, query: v.q, page: v.page };
  const pair = v.snap;
  if (pair) Object.assign(params, name === 'watched' ? { generation: pair.generation, until: pair.until } : { before: pair.before, until: pair.until });
  try {
    const answer = await (name === 'watched' ? api.history(params) : api.searches(params));
    if (mine !== v.ticket) return;
    const data = readable(name, answer);
    v.data = data;
    v.dataScope = key;
    v.dataQ = params.query;
    v.error = null;
    if (!pair) {
      const first = name === 'watched' ? data?.generation : data?.before;
      v.snap = has(first) && has(data?.until)
        ? (name === 'watched' ? { scope: key, generation: Number(first), until: Number(data.until) } : { scope: key, before: Number(first), until: Number(data.until) })
        : null;
    }
    const page = num(data?.page);
    if (page && page !== v.page) { v.page = page; if (name === state.view) writeHash(); }
  } catch (error) {
    if (mine !== v.ticket) return;
    if (error instanceof ApiError && error.status === 401) { v.loading = false; signedOut('Your session ended. Sign in again.'); return; }
    if (error instanceof ApiError && error.status === 410 && pair) {
      // The snapshot behind this list is gone: start again from current records, and say so.
      v.snap = null;
      v.page = 1;
      v.loading = false;
      say(NOTICE_GONE);
      return load(name, { notice: NOTICE_GONE });
    }
    v.error = error?.message || 'History could not be loaded.';
  } finally {
    if (mine === v.ticket) { v.loading = false; render(); }
  }
}

function setScope(patch) {
  Object.assign(state.scope, patch);
  for (const v of Object.values(state.views)) v.page = 1;
  return load(state.view);
}

function signedOut(message = '') {
  state.auth = 'signedOut';
  state.login = { busy: false, error: message };
  state.logout = { busy: false, error: '' };
  for (const v of Object.values(state.views)) Object.assign(v, { data: null, dataScope: '', dataQ: '', snap: null, loading: false, error: null, notice: null, ticket: v.ticket + 1 });
  closeDialog();
  render();
  $('#owner-key')?.focus();
}

// Sign out only when the server confirms it (or the session is already gone); otherwise say so.
async function signOut() {
  if (state.logout.busy) return;
  state.logout = { busy: true, error: '' };
  render();
  try {
    await api.logout();
    signedOut();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) { signedOut(); return; }
    state.logout = { busy: false, error: error?.message || 'The server didn’t confirm it.' };
    render();
    say(`Signing out didn’t work. ${state.logout.error}`);
  }
}

async function boot() {
  const r = readRoute();
  if (r) adoptRoute(r);
  if (!r || !r.known) writeHash();
  render();
  try {
    await api.session();
    state.auth = 'signedIn';
    await load(state.view);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) signedOut();
    else { state.auth = 'signedIn'; state.views[state.view].error = error?.message || 'The server could not be reached.'; render(); }
  }
}

/* ------------------------------------------------------------------ render: frame */

function render() {
  preserve(() => {
    renderMastEnd();
    const main = $('#main');
    const v = state.views[state.view];
    main.setAttribute('aria-busy', String(state.auth === 'checking' || (v.loading && !v.data)));
    if (state.auth === 'checking') main.innerHTML = '<p class="boot">Checking your session…</p>';
    else if (state.auth === 'signedOut') main.innerHTML = loginHTML();
    else main.innerHTML = deskHTML();
  });
}

// Keep focus, caret and scroll across re-renders using stable data-key attributes.
function preserve(fn, focusKey) {
  const a = document.activeElement;
  const key = focusKey || a?.getAttribute?.('data-key');
  const sel = a && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  const y = window.scrollY;
  fn();
  window.scrollTo(0, y);
  if (key) {
    const el = $(`[data-key="${CSS.escape(key)}"]`);
    if (el && el !== document.activeElement && !el.disabled) {
      el.focus({ preventScroll: true });
      if (sel && !focusKey && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } }
    }
  }
}

function renderMastEnd() {
  $('#mast-end').innerHTML = `<a class="btn btn--sm btn--quiet" href="legacy/" title="The previous dashboard, with devices and pairing" data-key="mast:legacy">Legacy</a>${state.auth === 'signedIn'
    ? `<button type="button" class="btn btn--sm btn--quiet" data-action="logout" data-key="mast:logout" ${state.logout.busy ? 'disabled' : ''}>${state.logout.busy ? 'Signing out…' : 'Sign out'}</button>` : ''}`;
}

function loginHTML() {
  return `<div class="login">
    <h1 class="login__title" tabindex="-1">Sign in</h1>
    <p class="login__lede">History needs the owner session. Use the owner key from the server’s admin-token file.</p>
    <form data-form="login" novalidate>
      <label class="label" for="owner-key">Owner key</label>
      <input class="input" id="owner-key" type="password" autocomplete="current-password" spellcheck="false" required data-key="login:key">
      ${state.login.error ? `<p class="login__error" role="alert">${esc(state.login.error)}</p>` : ''}
      <div><button type="submit" class="btn btn--primary" ${state.login.busy ? 'disabled' : ''}>${state.login.busy ? 'Signing in…' : 'Sign in'}</button></div>
    </form>
  </div>`;
}

const LEDE = {
  watched: 'What played on your devices, newest first. Background playback is included and named.',
  searches: 'YouTube searches your devices recorded, newest first.',
};

function tabsHTML(prefix) {
  const tab = (name) => `<a class="htabs__tab" href="${esc(hashFor(name))}" ${state.view === name ? 'aria-current="page"' : ''} data-key="tab:${prefix}:${name}">${VIEWS[name].tab}</a>`;
  return `<nav class="htabs" aria-label="History views">${tab('watched')}${tab('searches')}</nav>`;
}

// The latest device and people lists either view has loaded (they are the same server lists).
const known = (field) => state.views[state.view].data?.[field] || state.views.watched.data?.[field] || state.views.searches.data?.[field] || [];

const KIND_GROUPS = [
  ['tv', 'TVs · playback only'],
  ['browser', 'Browsers · playback and searches'],
  ['mixed', 'TV and browser'],
  ['unknown', 'Source not identified yet'],
];
const kindOf = (x) => (KIND_GROUPS.some(([k]) => k === x?.kind) ? x.kind : 'unknown');

// Person and device narrow together: the server selects their intersection, so the device list
// shows only the chosen person's devices.
const belongs = (x, person) => !person || (person === 'unassigned' ? !x.personId : x.personId === person);

function deviceOptions(devices, people) {
  const s = state.scope;
  const many = people.length > 1 && !s.person;
  const opt = (x) => `<option value="${esc(x.id)}" ${s.device === x.id ? 'selected' : ''}>${esc(clean(x.label) || 'Device')}${many ? ` · ${esc(clean(x.person) || 'Unassigned')}` : ''}${x.revoked ? ' · revoked' : ''}</option>`;
  const mine = devices.filter((x) => belongs(x, s.person));
  const groups = KIND_GROUPS.map(([kind, label]) => {
    const list = mine.filter((x) => kindOf(x) === kind);
    return list.length ? `<optgroup label="${esc(label)}">${list.map(opt).join('')}</optgroup>` : '';
  }).join('');
  const missing = s.device && !mine.some((x) => x.id === s.device) ? `<option value="${esc(s.device)}" selected>Device not in the list</option>` : '';
  return groups + missing;
}

function personField(devices, people) {
  const s = state.scope;
  const unassigned = devices.some((x) => !x.personId);
  if (people.length < 2 && !unassigned && !s.person) return '';
  const opt = (value, label) => `<option value="${esc(value)}" ${s.person === value ? 'selected' : ''}>${esc(label)}</option>`;
  const missing = s.person && s.person !== 'unassigned' && !people.some((p) => p.id === s.person) ? opt(s.person, 'Person not in the list') : '';
  return `<div><label class="label" for="f-person">Person</label>
    <select class="select" id="f-person" data-action="person" data-key="f:person">${opt('', 'Everyone')}${people.map((p) => opt(p.id, p.name || 'Unnamed')).join('')}${unassigned ? opt('unassigned', 'Unassigned devices') : ''}${missing}</select></div>`;
}

const NOTES = {
  watched: `<p>History is a record, not a goal. It is here so you can act on what actually played.</p>
    <p><b>Watched</b> is wall-clock playback, background included. <b>On-tab</b> (browser) and <b>foreground</b> (TV) say what was in front, not who paid attention; <b>unspecified</b> means the collector didn’t record it.</p>
    <p>An <b>entry</b> is one recorded viewing of a video on one device and day. Metadata updates stay inside its evidence details. Older collectors saved samples per day instead, shown as <b>Recorded that day</b>. <b>Covered</b> is the share of the video that played at least once.</p>`,
  searches: `<p>A search is recorded when a YouTube results page opens in a browser with the collector; the same query again within 5 seconds counts once.</p>
    <p>OwnTube on Android TV records playback only. The small code beside a query is a language estimated from its text, not from anything spoken.</p>`,
};

function deskHTML() {
  const name = state.view;
  const v = state.views[name];
  const devices = known('devices');
  const people = known('people');
  const s = state.scope;
  const side = `<aside class="side" aria-label="Filters">
      <div class="side__inner">
        <div class="history__mhead">
          <h1 class="title" tabindex="-1" data-heading>History</h1>
          <p class="lede">${LEDE[name]}</p>
          ${tabsHTML('m')}
        </div>
        <div class="side__filters">
          <div><label class="label" for="f-q">Filter</label>
            <div class="search">${ICON.search}<input class="input" id="f-q" type="search" maxlength="200" autocomplete="off" spellcheck="false"
              placeholder="${name === 'searches' ? 'Query text' : 'Title, channel or video ID'}" value="${esc(v.draft ?? v.q)}" data-action="q" data-key="f:q:${name}"></div></div>
          <div class="side__pair">
            <div><label class="label" for="f-device">Device</label>
              <select class="select" id="f-device" data-action="device" data-key="f:device"><option value="">All devices</option>${deviceOptions(devices, people)}</select></div>
            ${personField(devices, people)}
          </div>
          <div class="side__period"><span class="label" id="f-days">Period</span>
            <div class="seg" role="group" aria-labelledby="f-days">${DAYS.map((n) => `<button type="button" aria-pressed="${s.days === n}" data-action="days" data-value="${n}" data-key="f:days:${n}">${n} days</button>`).join('')}</div></div>
        </div>
        <div class="side__note">${NOTES[name]}
          <p class="side__links"><a href="legacy/">Legacy dashboard · devices and pairing</a><a href="diagnostics.html">Diagnostics</a><a href="android-integration.html">Android TV setup guide</a></p>
        </div>
      </div>
    </aside>`;

  // Numbers are shown only under the scope they belong to: while another scope loads (or fails),
  // the previous scope's figures are not kept on screen under the new labels.
  const current = v.data && v.dataScope === scopeKey();
  let body;
  if (!current) body = v.error ? problemHTML(v.error) : `<p class="boot" data-loading>Loading ${esc(loadingText(devices, people))}…</p>`;
  else body = (v.error ? problemHTML(v.error) : '') + (v.notice ? `<p class="notice" role="status" data-notice><span>${esc(v.notice)}</span></p>` : '') + (name === 'watched' ? watchedHTML(v) : searchesHTML(v));
  const logout = state.logout.error
    ? `<div class="problem" role="alert" data-logout-error><p><b>Signing out didn’t work.</b> ${esc(state.logout.error)} You are still signed in.</p><button type="button" class="btn btn--sm" data-action="logout" data-key="logout:retry">Try again</button></div>` : '';

  return `<div class="ws">${side}
    <section class="content" aria-labelledby="h-title">
      <div class="history" data-view="${name}" aria-busy="${v.loading}">
        <div class="history__head">
          <h1 class="title" id="h-title" tabindex="-1" data-heading>History</h1>
          <p class="lede">${LEDE[name]}</p>
          ${tabsHTML('d')}
        </div>
        ${logout}${body}
      </div>
    </section>
  </div>`;
}

function loadingText(devices, people) {
  const s = state.scope;
  const device = s.device ? clean(devices.find((x) => x.id === s.device)?.label) || 'one device' : '';
  const person = s.person === 'unassigned' ? 'unassigned devices' : s.person ? `${clean(people.find((p) => p.id === s.person)?.name) || 'one person'}’s devices` : '';
  return `the last ${s.days} days on ${device || person || 'all devices'}`;
}

const problemHTML = (message) => `<div class="problem" role="alert"><p><b>History couldn’t be loaded.</b> ${esc(message)}</p><button type="button" class="btn btn--sm" data-action="retry" data-key="retry">Try again</button></div>`;

/* ------------------------------------------------------------------ render: shared pieces */

function inScope(d) {
  const s = state.scope;
  return (Array.isArray(d.devices) ? d.devices : []).filter((x) => (!s.device || x.id === s.device) && belongs(x, s.person));
}
// "Foreground" means on-tab only for a known browser; mixed and unknown scopes name both.
const frontWord = (kind) => (kind === 'browser' ? 'on-tab' : kind === 'tv' ? 'foreground' : 'on-tab / foreground');
function scopeFront(d) {
  const kinds = new Set(inScope(d).map(kindOf));
  return kinds.size === 1 ? frontWord([...kinds][0]) : frontWord('mixed');
}
function scopeNames(d) {
  const s = state.scope;
  const device = s.device ? (d.devices || []).find((x) => x.id === s.device)?.label || 'One device' : 'All devices';
  const person = s.person === 'unassigned' ? 'Unassigned devices' : s.person ? (d.people || []).find((p) => p.id === s.person)?.name || 'One person' : '';
  // The same scope inside a sentence: "on Living room TV", "on Guest’s devices", "on all devices".
  const phrase = s.device ? device : s.person === 'unassigned' ? 'unassigned devices' : s.person ? `${person}’s devices` : 'all devices';
  return { device, person, phrase };
}

function ledgerTop(d, name) {
  const tz = d.timezone;
  const dates = (Array.isArray(d.daily) ? d.daily : []).map((x) => x?.date).filter(validDate).sort();
  const first = dates[0] || (has(d.since) ? dateIn(d.since, tz) : '');
  const last = dates.at(-1) || (has(d.until) ? dateIn(d.until, tz) : '');
  const { device, person } = scopeNames(d);
  const until = has(d.until) ? Number(d.until) : null;
  const asOf = until == null ? '' : dateIn(until, tz) === dateIn(Date.now(), tz) ? clockTime(until, tz) : `${shortDate(dateIn(until, tz))}, ${clockTime(until, tz)}`;
  return `<div class="ledger__top">
      <h2 class="label ledger__scope" id="ledger-scope"><span>Last ${num(d.days) || state.scope.days} days</span>${dateRange(first, last) ? `<span>${esc(dateRange(first, last))}</span>` : ''}<span class="ledger__long">${esc(device)}</span>${person ? `<span class="ledger__long">${esc(person)}</span>` : ''}${asOf ? `<span data-as-of="${until}">As of ${esc(asOf)}</span>` : ''}</h2>
      <button type="button" class="ledger__refresh" data-action="refresh" data-key="refresh:${name}" aria-label="Refresh: load records received${asOf ? ` since ${esc(asOf)}` : ''}">Refresh</button>
    </div>`;
}

function statusHTML(v, d, one, many) {
  const count = num(d.count);
  const pages = Math.max(1, num(d.pages) || 1);
  const page = num(d.page) || v.page;
  const lead = v.dataQ
    ? `${num(d.filteredCount).toLocaleString('en')} of ${plural(count, one, many)} match <q>${esc(v.dataQ)}</q>`
    : plural(count, one, many);
  return `<p class="status" data-status data-count="${count}" data-filtered="${num(d.filteredCount)}">${lead}${pages > 1 ? ` · page ${page} of ${pages}` : ''}${v.loading ? ' · updating…' : ''}</p>`;
}

function pagerHTML(d, v) {
  const pages = Math.max(1, num(d.pages) || 1);
  const page = Math.min(pages, num(d.page) || v.page);
  if (pages <= 1) return '';
  return `<nav class="pager" aria-label="Pages">
      <button type="button" class="btn btn--sm" data-action="page" data-value="${page - 1}" data-key="page:prev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
      <span class="pager__at">Page ${page} of ${pages}</span>
      <button type="button" class="btn btn--sm" data-action="page" data-value="${page + 1}" data-key="page:next" ${page >= pages ? 'disabled' : ''}>Next</button>
    </nav>`;
}

// Group this page's rows by the server's date, in the server's order. Day headers carry the whole
// day's numbers from `daily`, so they stay true when a day continues on another page.
function daysHTML(d, v, { counted, total, row, list }) {
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const tz = d.timezone;
  const today = has(d.until) ? dateIn(d.until, tz) : dateIn(Date.now(), tz);
  const daily = new Map((Array.isArray(d.daily) ? d.daily : []).filter((x) => validDate(x?.date)).map((x) => [x.date, x]));
  const start = new Map();
  let acc = 0;
  for (const x of [...daily.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))) { start.set(x.date, acc); acc += counted(x); }
  const pageStart = (Math.max(1, num(d.page) || 1) - 1) * (num(d.pageSize) || PAGE_SIZE);
  const pageEnd = pageStart + rows.length;
  const groups = [];
  for (const r of rows) {
    const g = groups.at(-1);
    if (g && g.date === r.date) g.rows.push(r);
    else groups.push({ date: r.date, rows: [r] });
  }
  return groups.map((g, i) => {
    const info = daily.get(g.date);
    const title = dayTitle(g.date, today);
    const extras = [];
    if (info && v.dataQ) extras.push(total.match(info));
    if (info && start.has(g.date) && g.rows.length < counted(info)) {
      const s0 = start.get(g.date);
      if (s0 < pageStart) extras.push('continued from the previous page');
      if (s0 + counted(info) > pageEnd) extras.push('continues on the next page');
    }
    const id = `day-${i}-${esc(g.date)}`;
    return `<section class="day" aria-labelledby="${id}" data-date="${esc(g.date)}">
        <div class="day__head">
          <h2 class="day__title" id="${id}">${esc(title)}</h2>
          ${title === 'Today' || title === 'Yesterday' ? `<span class="day__date">${esc(shortDate(g.date))}</span>` : ''}
          ${extras.length ? `<span class="day__shown">${extras.map(esc).join(' · ')}</span>` : ''}
          ${info ? `<span class="day__total" ${total.attr(info)}>${esc(total.text(info))}</span>` : ''}
        </div>
        <ol class="${list}">${g.rows.map((r) => row(r, d)).join('')}</ol>
      </section>`;
  }).join('');
}

/* ------------------------------------------------------------------ render: Watched */

function ctxLine(fg, bg, un, kind) {
  const parts = [[fg, frontWord(kind)], [bg, 'background'], [un, 'unspecified']].filter(([s]) => num(s) > 0);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0][1] === 'unspecified' ? 'context not recorded' : `all ${parts[0][1]}`;
  return parts.map(([s, w]) => `${spent(s)} ${w}`).join(' · ');
}

// Coverage is the union of what played within this entry; replays add watched time, not coverage.
function coverageHTML(r) {
  const pct = has(r.coveragePercent) ? Math.max(0, Math.min(100, Number(r.coveragePercent))) : null;
  const secs = has(r.coveredSeconds) ? Number(r.coveredSeconds) : null;
  if (pct == null && secs == null) return '<span class="nr">coverage not recorded</span>';
  const atLeast = r.coverageComplete === false ? 'at least ' : '';
  if (pct == null) return `${atLeast}<b>${esc(spent(secs))}</b> covered`;
  const shown = pct > 0 && pct < 1 ? '<1' : String(Math.floor(pct));
  return `${atLeast}<b>${shown}%</b> covered`;
}

const realVideoId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
function artHTML(r) {
  const img = realVideoId(r.videoId)
    ? `<img src="https://i.ytimg.com/vi/${esc(r.videoId)}/mqdefault.jpg" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-thumb>` : '';
  const badge = has(r.durationSeconds) && num(r.durationSeconds) > 0
    ? `<span class="art__badge">${r.isShort ? 'SHORT · ' : ''}${clock(r.durationSeconds)}</span>`
    : r.isShort ? '<span class="art__badge">SHORT</span>' : '';
  const pct = has(r.coveragePercent) ? Math.max(0, Math.min(100, Number(r.coveragePercent))) : null;
  const bar = pct == null ? '' : `<span class="art__cov${r.coverageComplete === false ? ' art__cov--partial' : ''}" aria-hidden="true"><span style="width:${pct}%"></span></span>`;
  return `<span class="art"><span class="art__id">${esc(r.videoId || '')}</span>${img}${badge}${bar}</span>`;
}

// First and last recorded playback as one range. Rows are sorted by the latest recording, so the
// range's end follows the list order; neither end is a reconstructed session start or end.
function timeCell(r, tz) {
  if (r.rowKind === 'legacy-day') return '<span class="hrow__day">Recorded <span class="hrow__daypart">that day</span></span>';
  const a = clockTime(r.firstWatched, tz);
  const b = clockTime(r.lastWatched, tz);
  if (!a && !b) return '<span class="hrow__day">Time not recorded</span>';
  if (a && b && a !== b) {
    return `<span class="vh">Recorded </span><time datetime="${isoTime(r.firstWatched)}">${a}</time><span aria-hidden="true">–</span><span class="vh"> to </span><time datetime="${isoTime(r.lastWatched)}">${b}</time>`;
  }
  return `<span class="vh">Recorded at </span><time datetime="${isoTime(a ? r.firstWatched : r.lastWatched)}">${a || b}</time>`;
}

// Saved names sometimes carry stray outer spaces; show them without, as text.
const clean = (s) => (typeof s === 'string' ? s.trim() : '');

function watchedRow(r, d) {
  const id = String(r.id ?? `${r.deviceId}|${r.metadataId}|${r.date}`);
  const title = clean(r.title) || `Untitled · ${r.videoId || 'no video ID'}`;
  const ctx = ctxLine(r.foregroundSeconds, r.backgroundSeconds, r.unspecifiedSeconds, r.deviceKind);
  return `<li class="hrow${r.rowKind === 'legacy-day' ? ' hrow--legacy' : ''}" data-row="${esc(id)}" data-kind="${esc(r.rowKind || '')}" data-s="${num(r.seconds)}" data-fg="${num(r.foregroundSeconds)}" data-bg="${num(r.backgroundSeconds)}" data-un="${num(r.unspecifiedSeconds)}">
      <p class="hrow__time">${timeCell(r, d.timezone)}</p>
      <div class="hrow__media">${artHTML(r)}</div>
      <div class="hrow__body">
        <h3 class="hrow__title"><button type="button" data-action="evidence" data-id="${esc(id)}" data-key="title:${esc(id)}">${esc(title)}</button></h3>
        <p class="meta">${clean(r.channel) ? `<span>${esc(clean(r.channel))}</span>` : ''}<span>${esc(clean(r.deviceLabel) || 'Device')}</span></p>
      </div>
      <div class="hrow__side">
        <p class="hrow__numbers">
          <span><b>${esc(spent(r.seconds))}</b> watched</span>
          ${ctx ? `<span class="hrow__ctx" data-ctx>${esc(ctx)}</span>` : ''}
          <span data-cov>${coverageHTML(r)}</span>
        </p>
        <div class="hrow__actions"><button type="button" class="btn btn--sm btn--quiet" data-action="evidence" data-id="${esc(id)}" data-key="ev:${esc(id)}">Evidence<span class="vh"> for ${esc(title)}</span></button></div>
      </div>
    </li>`;
}

function watchedHTML(v) {
  const d = v.data;
  const total = num(d.seconds);
  const front = scopeFront(d);
  const people = Array.isArray(d.people) ? d.people : [];
  const split = [[d.foregroundSeconds, front], [d.backgroundSeconds, 'background'], [d.unspecifiedSeconds, 'unspecified']].filter(([s]) => num(s) > 0);
  const days = num(d.days) || state.scope.days;
  const ledger = `<section class="ledger" aria-labelledby="ledger-scope" data-ledger data-seconds="${total}" data-videos="${num(d.videoCount)}" data-per-day="${num(d.perCalendarDaySeconds)}" data-days="${days}">
      ${ledgerTop(d, 'watched')}
      <dl class="figs">
        <div class="fig"><dt>Watched</dt><dd class="fig__n">${spentHTML(total)}</dd></div>
        <div class="fig"><dt>Distinct videos</dt><dd class="fig__n">${num(d.videoCount).toLocaleString('en')}</dd></div>
        <div class="fig"><dt>Per calendar day</dt><dd class="fig__n">${spentHTML(d.perCalendarDaySeconds)}</dd><dd class="fig__div">÷ ${plural(days, 'calendar day')}</dd></div>
      </dl>
      ${total ? `<p class="split" data-split data-fg="${num(d.foregroundSeconds)}" data-bg="${num(d.backgroundSeconds)}" data-un="${num(d.unspecifiedSeconds)}"><span class="split__lead">Of that</span>${split.map(([s, w]) => `<span><b>${esc(spent(s))}</b> ${esc(w)}</span>`).join('')}</p>` : ''}
      <p class="note">Period, device${people.length > 1 || state.scope.person ? ' and person' : ''} set these numbers; the filter only narrows the list. Background playback counts in every total. Calendar days follow the server’s time zone${d.timezone ? ` (${esc(d.timezone)})` : ''}, counting today and days without recorded playback.</p>
    </section>`;

  const rows = Array.isArray(d.rows) ? d.rows : [];
  const count = num(d.count);
  let list;
  if (!count) {
    list = `<div class="empty" data-empty="none"><p class="empty__title">No recorded playback in the last ${days} days on ${esc(scopeNames(d).phrase)}.</p>
      <p class="empty__hint">An empty period means nothing was recorded, not proof that nothing was watched.${days < 90 ? ' A longer period may have some.' : ''}</p></div>`;
  } else if (!rows.length && v.dataQ) {
    list = `<div class="empty" data-empty="filter"><p class="empty__title">Nothing in this period matches <q>${esc(v.dataQ)}</q>.</p>
      <p class="empty__hint">The filter looks at titles, channels and video IDs. <button type="button" class="link-btn" data-action="clear-q" data-key="clear-q">Clear the filter</button></p></div>`;
  } else if (!rows.length) {
    list = '<div class="empty"><p class="empty__title">No entries on this page.</p></div>';
  } else {
    list = `<div class="days" data-days-list>${daysHTML(d, v, {
      counted: (x) => num(v.dataQ ? x.filteredCount : x.rowCount),
      total: {
        text: (x) => `${spent(x.seconds)} watched`,
        attr: (x) => `data-day-seconds="${num(x.seconds)}" title="Recorded playback that day in this scope, background included"`,
        match: (x) => `${num(x.filteredCount).toLocaleString('en')} of ${plural(x.rowCount, 'entry', 'entries')} match`,
      },
      row: watchedRow,
      list: 'hrows',
    })}</div>${pagerHTML(d, v)}`;
  }
  return ledger + (count ? statusHTML(v, d, 'recorded entry', 'recorded entries') : '') + list;
}

/* ------------------------------------------------------------------ render: Searches */

function sourceNote(d) {
  const list = inScope(d);
  const label = (x) => x.label || 'a device';
  const group = (xs) => (xs.length > 3 ? `${xs.length} devices` : names(xs.map(label)));
  const rec = list.filter((x) => x.searchCapability === 'recorded');
  const tv = list.filter((x) => x.searchCapability === 'not-recorded');
  const other = list.filter((x) => x.searchCapability !== 'recorded' && x.searchCapability !== 'not-recorded');
  const parts = [];
  if (rec.length) parts.push(`Searches come from ${group(rec)}, recorded when a YouTube results page opens in the browser.`);
  if (tv.length) parts.push(`${group(tv)} ${tv.length === 1 ? 'records' : 'record'} playback only.`);
  if (other.length) parts.push(`No search capture has been seen from ${group(other)}, so this can’t say whether ${other.length === 1 ? 'it records' : 'they record'} searches.`);
  return parts.join(' ');
}

function searchLang(r) {
  const code = typeof r.lang === 'string' ? r.lang.trim() : '';
  if (!code || ['und', 'other', 'unknown', 'zxx', 'mul'].includes(code.toLowerCase())) return '';
  const name = langName(code);
  return `<span class="srow__lang" title="Language estimated from the query text">${esc(code)}<span class="vh">, query language estimated as ${esc(name)}</span></span>`;
}

function searchRow(r, d) {
  return `<li class="srow" data-search="${esc(r.id)}">
      <time class="srow__time" datetime="${isoTime(r.t)}">${esc(clockTime(r.t, d.timezone) || '—')}</time>
      <p class="srow__query"><svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.4 10.4L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span class="srow__text">${esc(r.query)}</span>${searchLang(r)}</p>
      <p class="srow__source">${esc(clean(r.deviceLabel) || 'Device')}</p>
    </li>`;
}

function searchesHTML(v) {
  const d = v.data;
  const cap = d.searchCapability;
  const tvOnly = cap === 'not-recorded';
  const count = num(d.count);
  const days = num(d.days) || state.scope.days;
  const people = Array.isArray(d.people) ? d.people : [];
  const ledger = `<section class="ledger" aria-labelledby="ledger-scope" data-search-ledger data-count="${tvOnly ? '' : count}" data-capability="${esc(cap || '')}">
      ${ledgerTop(d, 'searches')}
      <dl class="figs"><div class="fig${tvOnly ? ' fig--none' : ''}"><dt>Searches</dt><dd class="fig__n">${tvOnly ? '—' : count.toLocaleString('en')}</dd>${tvOnly ? '<dd class="fig__div">not recorded on TVs</dd>' : ''}</div></dl>
      <p class="note" data-source-note>${esc(sourceNote(d))} Period, device${people.length > 1 || state.scope.person ? ' and person' : ''} set the count; the filter only narrows the list. Days follow the server’s time zone${d.timezone ? ` (${esc(d.timezone)})` : ''}.</p>
    </section>`;

  const rows = Array.isArray(d.rows) ? d.rows : [];
  const s = state.scope;
  const { device, person, phrase } = scopeNames(d);
  let list;
  if (tvOnly) {
    const who = s.device ? `${device} doesn’t` : s.person === 'unassigned' ? 'The unassigned devices don’t' : s.person ? `${person}’s devices don’t` : 'None of these devices';
    list = `<div class="empty" data-empty="not-recorded"><p class="empty__title">${esc(who)} record searches.</p>
      <p class="empty__hint">OwnTube on Android TV records playback only; searches come from browsers.${s.device || s.person ? ' <button type="button" class="link-btn" data-action="all-devices" data-key="all-devices">Show all devices</button>' : ''}</p></div>`;
  } else if (!count) {
    list = `<div class="empty" data-empty="none"><p class="empty__title">No searches recorded in the last ${days} days${s.device || s.person ? ` on ${esc(phrase)}` : ''}.</p>
      <p class="empty__hint">${cap === 'unknown' ? 'No search capture has been seen in this scope, so this can’t say whether it records searches.' : days < 90 ? 'A longer period may have some.' : 'Searches appear here once a browser records some.'}</p></div>`;
  } else if (!rows.length && v.dataQ) {
    list = `<div class="empty" data-empty="filter"><p class="empty__title">No searches in this period match <q>${esc(v.dataQ)}</q>.</p>
      <p class="empty__hint"><button type="button" class="link-btn" data-action="clear-q" data-key="clear-q">Clear the filter</button></p></div>`;
  } else if (!rows.length) {
    list = '<div class="empty"><p class="empty__title">No searches on this page.</p></div>';
  } else {
    list = `<div class="days" data-days-list>${daysHTML(d, v, {
      counted: (x) => num(v.dataQ ? x.filteredCount : x.count),
      total: {
        text: (x) => plural(x.count, 'search', 'searches'),
        attr: (x) => `data-day-count="${num(x.count)}"`,
        match: (x) => `${num(x.filteredCount).toLocaleString('en')} of ${num(x.count).toLocaleString('en')} match`,
      },
      row: searchRow,
      list: 'srows',
    })}</div>${pagerHTML(d, v)}`;
  }
  return ledger + (count && !tvOnly ? statusHTML(v, d, 'search', 'searches') : '') + list;
}

/* ------------------------------------------------------------------ evidence inspector */

const SIGNAL_WORDS = {
  'audio-track': 'the selected audio track', 'asr-caption': 'auto-generated captions', 'native-text': 'the browser’s text detector',
  'caption-heuristic': 'the caption languages', 'description-heuristic': 'the description (heuristic)', 'manual-caption': 'manual captions',
  'title-heuristic': 'the title (heuristic)', 'android-player': 'the TV player', unknown: 'no usable signal',
};
const langLabel = (code) => {
  if (code === 'und') return '<span class="mono">und</span> <span class="why">“undetermined”, as YouTube reported it</span>';
  const name = langName(code);
  return name && name !== code ? `${esc(name)} <span class="mono">(${esc(code)})</span>` : `<span class="mono">${esc(code)}</span>`;
};
const notRecorded = (why) => `<span class="nr">Not recorded</span>${why ? ` <span class="why">· ${why}</span>` : ''}`;
const facts = (rows) => `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

function rowById(id) {
  const rows = state.views.watched.data?.rows;
  return Array.isArray(rows) ? rows.find((r) => String(r.id ?? `${r.deviceId}|${r.metadataId}|${r.date}`) === id) : null;
}

async function openEvidence(id, opener) {
  const d = state.views.watched.data;
  const row = rowById(id);
  if (!row) return;
  state.dialog = {
    row, selected: versionKey(recordedVersions(row)[0]), request: 0,
    tz: d.timezone, days: num(d.days) || state.scope.days, data: null, loading: true, error: null,
    raw: 'exact', rawOpen: false, openerKey: opener?.getAttribute?.('data-key') || null,
  };
  renderDialog();
  const dlg = $('#dlg');
  if (!dlg.open) dlg.showModal();
  $('#dlg [data-key="dlg:close"]')?.focus();
  await fetchEvidence();
}

async function fetchEvidence() {
  const dl = state.dialog;
  if (!dl) return;
  const version = findVersion(dl.row, dl.selected);
  const request = ++dl.request;
  dl.data = null;
  dl.loading = true;
  dl.error = null;
  renderDialog();
  try {
    const data = await api.evidence(version.deviceId, version.metadataId);
    if (state.dialog !== dl || request !== dl.request) return;
    dl.data = data && typeof data === 'object' ? data : {};
  } catch (error) {
    if (state.dialog !== dl || request !== dl.request) return;
    if (error instanceof ApiError && error.status === 401) { signedOut('Your session ended. Sign in again.'); return; }
    dl.error = error?.message || 'The evidence could not be loaded.';
  } finally {
    if (state.dialog === dl && request === dl.request) { dl.loading = false; renderDialog(); }
  }
}

function closeDialog() {
  const dlg = $('#dlg');
  if (dlg?.open) dlg.close();
}

function renderDialog() {
  const dlg = $('#dlg');
  if (!state.dialog) return;
  // The live region may be parked inside the open dialog (see say); keep it across re-renders.
  const sr = document.getElementById('sr');
  preserve(() => {
    dlg.innerHTML = inspectorHTML();
    if (sr && !sr.isConnected) dlg.appendChild(sr);
  });
}

function languagesHref(r, days) {
  const p = new URLSearchParams();
  if (days !== 7 && DAYS.includes(days)) p.set('days', String(days));
  if (r.deviceId) p.set('device', r.deviceId);
  if (r.videoId) p.set('query', r.videoId);
  if (r.metadataId) p.set('metadata', r.metadataId);
  return `modules/languages/#${p}`;
}

function contextHTML(r, tz) {
  const legacy = r.rowKind === 'legacy-day';
  const kind = kindOf({ kind: r.deviceKind });
  const front = frontWord(kind);
  const first = clockTime(r.firstWatched, tz);
  const last = clockTime(r.lastWatched, tz);
  const recorded = !first && !last ? notRecorded()
    : legacy
      ? `First sample <span class="mono">${esc(first || '—')}</span>, latest <span class="mono">${esc(last || '—')}</span> <span class="why">samples an older collector saved, not a session</span>`
      : `<span class="mono">${esc(first)}${last && last !== first ? `–${esc(last)}` : ''}</span> <span class="why">first and last recorded playback, not when a session started or ended</span>`;
  const partial = r.coverageComplete === false && (has(r.coveragePercent) || has(r.coveredSeconds));
  const covered = `${coverageHTML(r)}${has(r.durationSeconds) && num(r.durationSeconds) > 0 ? ` <span class="why">of ${clock(r.durationSeconds)}</span>` : ''}${partial ? ' <span class="why">· some samples have no ranges, so more may have played</span>' : ''}`;
  const device = clean(r.deviceLabel) || 'this device';
  const scope = legacy
    ? `This entry is everything an older collector recorded for this video on ${esc(device)} on ${esc(longDate(r.date))}. It saved samples without a visit identity, so this is one day’s record, not separate plays.`
    : `This entry is one recorded viewing of this video on ${esc(device)}, ${esc(longDate(r.date))}.`;
  const meaning = kind === 'browser' ? 'On-tab means the YouTube tab was visible' : kind === 'tv' ? 'Foreground means the player was the app in front' : 'On-tab (browser) or foreground (TV) means the video was in front';
  return `<section class="ev__section" aria-labelledby="ev-ctx">
      <h3 class="label" id="ev-ctx">Playback context · this entry</h3>
      ${facts([
        [esc(front[0].toUpperCase() + front.slice(1)), `<span class="mono" data-ev-fg="${num(r.foregroundSeconds)}">${esc(spent(r.foregroundSeconds))}</span>`],
        ['Background', `<span class="mono" data-ev-bg="${num(r.backgroundSeconds)}">${esc(spent(r.backgroundSeconds))}</span>`],
        ['Unspecified', `<span class="mono" data-ev-un="${num(r.unspecifiedSeconds)}">${esc(spent(r.unspecifiedSeconds))}</span>${num(r.unspecifiedSeconds) ? ' <span class="why">the collector didn’t record context</span>' : ''}`],
        ['Total', `<span class="mono" data-ev-total="${num(r.seconds)}">${esc(spent(r.seconds))}</span> <span class="why">background included</span>`],
        ['Recorded', `<span data-ev-recorded>${recorded}</span>`],
        ['Covered', `<span data-ev-covered>${covered}</span>`],
      ])}
      <p class="ev__note" data-ev-scope>${scope} ${recordedVersions(r).length > 1 ? `It combines all ${recordedVersions(r).length} saved versions. ` : ''}${meaning}; neither proves attention. Covered counts each part of the video once across versions; replays add watched time only.</p>
      ${r.contextOverride?.context === 'foreground' ? `<p class="ev__note" data-context-correction>Foreground by owner correction for this device. ${esc(r.contextOverride.reason)} Original collector records are retained.</p>` : ''}
    </section>`;
}

function inspectorHTML() {
  const dl = state.dialog;
  const r = dl.row;
  const version = findVersion(r, dl.selected);
  const versions = recordedVersions(r);
  const tz = dl.tz;
  const data = dl.data;
  const { evidence: ev, text } = savedEvidence(data);
  const android = ev?.collector === 'owntube-source-v1';
  const recordTitle = clean(version.title);
  const heading = clean(r.title) || clean(ev?.title) || clean(data?.title) || `Untitled · ${r.videoId || ''}`;
  const legacy = r.rowKind === 'legacy-day';
  const when = legacy ? `${longDate(r.date)} · recorded that day` : `${longDate(r.date)}${clockTime(r.firstWatched, tz) ? ` · ${clockTime(r.firstWatched, tz)}` : ''}`;

  const head = `<div class="dialog__head">
      <h2 id="dlg-title"><span class="label dialog__kicker" aria-hidden="true">Evidence · this entry</span><span class="vh">Evidence for </span><span data-ev-heading>${esc(heading)}</span></h2>
      <button type="button" class="icon-btn" data-action="close" data-key="dlg:close" aria-label="Close evidence">${ICON.close}</button>
    </div>`;
  const foot = `<div class="dialog__foot"><span class="why">Saved evidence · not a fresh YouTube lookup</span><button type="button" class="btn btn--sm" data-action="close" data-key="dlg:done">Done</button></div>`;
  const meta = `<p class="ev__meta">${clean(r.channel) ? `<span>${esc(clean(r.channel))}</span>` : ''}<span class="mono">${esc(r.videoId || '')}</span><span>${esc(clean(r.deviceLabel) || 'Device')}</span><span>${esc(when)}</span></p>`;
  const context = contextHTML(r, tz);
  const picker = versions.length > 1 ? `<section class="ev__section" aria-labelledby="ev-versions">
      <h3 class="label" id="ev-versions">Saved versions · ${versions.length}</h3>
      ${versionPickerHTML(r, dl.selected, (v, i) => `${i === 0 ? 'Newest · ' : ''}${clockTime(v.lastWatched, tz)} · ${v.title || v.videoId} · ${String(v.metadataId).slice(0, 12)}`, { key: 'dlg:version' })}
      <p class="ev__note" data-version-scope data-metadata="${esc(version.metadataId)}">${esc(spent(version.seconds))} watched with this version. The playback totals above include every version; evidence below belongs only to this selection.</p>
    </section>` : '';

  if (!data) {
    const inner = dl.error
      ? `<div class="problem" role="alert"><p><b>The evidence couldn’t be loaded.</b> ${esc(dl.error)}</p><button type="button" class="btn btn--sm" data-action="evidence-retry" data-key="dlg:retry">Try again</button></div>`
      : '<p class="boot" style="padding:24px 0">Loading the saved evidence…</p>';
    return `${head}<div class="dialog__body">${meta}${context}${picker}${inner}</div>${foot}`;
  }

  const collectorLine = !ev && !text ? ''
    : android ? 'Snapshot from OwnTube on Android TV (<span class="mono">owntube-source-v1</span>): values as SmartTube exposed them, not untouched YouTube responses.'
      : ev ? `Snapshot from the browser collector (schema ${esc(ev.schemaVersion ?? '?')}, <span class="mono">${esc(ev.algorithmVersion || 'no algorithm version')}</span>).`
        : 'The saved snapshot isn’t valid JSON; its exact text is below.';

  const rec = data.recorded && typeof data.recorded === 'object' ? data.recorded : (version.recorded || {});
  const usable = typeof rec.lang === 'string' && rec.lang && rec.lang !== 'other';
  const estimate = `<section class="ev__section" aria-labelledby="ev-est">
      <h3 class="label" id="ev-est">Language estimate · the collector’s, derived</h3>
      <p class="ev__lead" data-ev-estimate>${usable
        ? `${langLabel(rec.lang)}${rec.conf ? ` · ${esc(rec.conf)} confidence` : ''}${rec.source ? ` · from ${esc(SIGNAL_WORDS[rec.source] || rec.source)}` : ''}`
        : android || rec.source === 'android-player' ? notRecorded('OwnTube on Android TV doesn’t run language analysis') : notRecorded()}</p>
      <p class="ev__note">The collector’s estimate of the spoken language, made from the source values below; it is not itself a source value. Review and corrections live in <a href="${esc(languagesHref(version, dl.days))}" data-key="dlg:languages">Languages</a>, which keeps its own record and never changes History.</p>
    </section>`;

  let body = '';
  if (!ev && !text) {
    body = `<div class="ev__missing" data-ev-missing><p><b>No source snapshot was saved with this version</b>, for example because an older collector recorded it. Title, channel and video ID come from the viewing record; nothing else is inferred.</p></div>`;
  } else if (!ev) {
    body = '<div class="ev__missing" data-ev-invalid><p><b>The saved snapshot isn’t valid JSON.</b> Its exact text is below, as stored.</p></div>';
  } else {
    const descAvailable = !(android && ev.descriptionAvailable === false);
    const description = descAvailable && typeof ev.description === 'string' && ev.description
      ? `<div class="ev__text" tabindex="0" role="region" aria-label="Saved description" data-ev-description>${esc(ev.description)}</div>
         <p class="ev__note">${ev.descriptionSource && ev.descriptionSource !== 'none' ? `Source <span class="mono">${esc(ev.descriptionSource)}</span> · ` : ''}${ev.description.length.toLocaleString('en')} characters saved${ev.descriptionTruncated ? ' · <b>cut by the collector at 10,000 characters</b>' : ''}</p>`
      : `<p class="ev__lead">${notRecorded(android && ev.descriptionAvailable === false ? 'the TV app didn’t expose a description' : 'no description was saved')}</p>`;
    const audio = (value, why) => (value ? langLabel(value) : notRecorded(why));
    const selected = android
      ? (ev.selectedAudioLanguage ? `${langLabel(ev.selectedAudioLanguage)} <span class="why">decoder label${ev.selectedAudioLanguageSource ? ` (${esc(ev.selectedAudioLanguageSource)})` : ''}, not spoken-language detection</span>` : notRecorded())
      : audio(ev.selectedAudioLanguage, 'YouTube reported no selected audio language');
    const deflt = android
      ? notRecorded(ev.defaultAudioLanguageStatus === 'not-exposed-by-MediaFormat' ? 'the TV app doesn’t expose it (MediaFormat)' : '')
      : audio(ev.defaultAudioLanguage, 'YouTube reported no default audio');
    const kindWord = (c) => (c?.kind === 'asr' ? 'auto-generated' : c?.kind === 'manual' ? 'manual' : 'kind not recorded');
    const captions = !Array.isArray(ev.captions) ? notRecorded()
      : ev.captions.length
        ? `<ul class="ev__tracks">${ev.captions.map((c) => `<li>${c?.language ? langLabel(c.language) : notRecorded()} · ${kindWord(c)}${c?.name ? ` <span class="why">“${esc(c.name)}”</span>` : ''}</li>`).join('')}</ul>`
        : '<span class="why">No caption tracks listed</span>';
    const omitted = android && ev.captionTranslationOptionsOmitted ? `<p class="ev__note">${esc(ev.captionTranslationOptionsOmitted)} translation options were counted and left out.</p>` : '';
    const mapping = android && ev.metadata?.mappingError
      ? `<p class="ev__warn" data-ev-mapping>A metadata getter failed (<span class="mono">${esc(ev.metadata.mappingError)}</span>); the partial values were kept.</p>` : '';
    const sources = `<section class="ev__section" aria-labelledby="ev-src">
        <h3 class="label" id="ev-src">Source values · as saved</h3>
        ${facts([
          ['Saved title', ev.title ? `${esc(ev.title)}${android && ev.titleSource ? ` <span class="why mono">${esc(ev.titleSource)}</span>` : ''}` : notRecorded()],
          ['Selected audio', selected],
          ['Default audio', deflt],
          ['Caption tracks', captions + omitted],
        ])}
        ${mapping}
        <h4 class="ev__sub">Description</h4>
        ${description}
        <p class="ev__note">Caption tracks are what YouTube listed; caption text was not saved, so there is no transcript.</p>
      </section>`;
    const t = ev.text && typeof ev.text === 'object' ? ev.text : null;
    const pct = (c) => (typeof c === 'number' ? `${Math.round(c * 100)}%` : esc(c));
    const detector = t
      ? `<section class="ev__section" aria-labelledby="ev-det">
          <h3 class="label" id="ev-det">Text detector · estimate from text</h3>
          ${facts([
            ['Estimate', t.language && t.language !== 'other' ? `${langLabel(t.language)}${t.confidence != null ? ` <span class="mono">${pct(t.confidence)}</span>` : ''}` : notRecorded(t.language === 'other' ? 'no language stood out' : '')],
            ['Engine', t.engine ? `<span class="mono">${esc(t.engine)}</span>` : notRecorded()],
            ['Input', t.input ? esc(t.input) : notRecorded()],
            ['Status', t.status ? `<span class="mono">${esc(t.status)}</span>` : notRecorded()],
            ['Algorithm', ev.algorithmVersion ? `<span class="mono">${esc(ev.algorithmVersion)}</span>` : notRecorded()],
            ['Candidates', Array.isArray(t.candidates) && t.candidates.length ? `<span class="mono">${t.candidates.map((c) => `${esc(c?.language)} ${pct(c?.confidence)}`).join(' · ')}</span>` : '<span class="why">None returned</span>'],
          ])}
          <p class="ev__note">A detector reads written text. The language of a description is not the spoken language.</p>
        </section>`
      : `<section class="ev__section" aria-labelledby="ev-det"><h3 class="label" id="ev-det">Text detector</h3><p class="ev__lead">${notRecorded(android ? 'not run on OwnTube TV' : '')}</p></section>`;
    body = sources + detector;
  }

  let raw = '';
  if (ev || text) {
    const formatted = ev ? JSON.stringify(ev, null, 2) : '';
    const mode = text ? dl.raw : 'formatted';
    const id = typeof data.evidenceId === 'string' ? data.evidenceId : '';
    raw = `<details class="ev__raw" ${dl.rawOpen ? 'open' : ''} data-raw-details>
        <summary>Raw source snapshot</summary>
        ${facts([
          ['Evidence ID', id ? `<code class="ev__id" data-evidence-id>${esc(id)}</code> <button type="button" class="link-btn" data-action="copy" data-text="${esc(id)}" data-key="dlg:copy">Copy</button>` : notRecorded()],
          ['Digest', text && id ? `<span data-digest>${digestText(id, text)}</span>` : notRecorded(text ? 'no evidence ID' : 'the exact text wasn’t returned, so it can’t be checked')],
          ['Size', text ? `<span class="mono">${new TextEncoder().encode(text).length.toLocaleString('en')} bytes</span>` : notRecorded('only the parsed snapshot was returned')],
        ])}
        ${text && ev ? `<div class="seg ev__mode" role="group" aria-label="Snapshot text">
            <button type="button" aria-pressed="${mode === 'exact'}" data-action="raw" data-value="exact" data-key="raw:exact">Exact text</button>
            <button type="button" aria-pressed="${mode === 'formatted'}" data-action="raw" data-value="formatted" data-key="raw:formatted">Formatted</button>
          </div>` : ''}
        <pre class="ev__rawtext" tabindex="0" aria-label="${mode === 'exact' ? 'Exact saved snapshot text' : 'Snapshot re-encoded for reading'}"><code data-raw="${mode}">${esc(mode === 'exact' ? text : formatted)}</code></pre>
        <p class="ev__note">${mode === 'exact'
          ? 'Exactly as saved. The evidence ID names the SHA-256 of this text.'
          : 'Re-encoded for reading, so not byte-identical: numbers can print slightly differently. Only the exact text is covered by the digest.'} Each recorded version keeps its own saved snapshot.</p>
      </details>`;
    if (text && id) checkDigest(text, id);
  }

  return `${head}<div class="dialog__body">${meta}
      ${ev?.title && recordTitle && ev.title !== recordTitle ? `<p class="ev__note" style="margin:-6px 0 12px">The viewing record’s title is “${esc(recordTitle)}”.</p>` : ''}
      <p class="notice ev__notice" data-ev-collector><span><strong>Saved evidence, not a fresh YouTube lookup.</strong> ${collectorLine}</span></p>
      ${context}${picker}${estimate}${body}${raw}
    </div>${foot}`;
}

// Re-hash the exact saved text in this browser and compare it with the stored evidence ID. A
// mismatch is shown as it is: the text is never rewritten to fit the ID.
const digests = new EvidenceDigests();
const digestText = (id, text) => ({
  match: '<span class="ev__ok">Matches</span> <span class="why">SHA-256 of the exact text, recomputed in this browser</span>',
  mismatch: '<span class="ev__bad">Does not match</span> <span class="why">the saved text differs from what this ID names; it is shown exactly as stored</span>',
  unavailable: notRecorded('can’t be checked here (needs a secure context)'),
})[digests.get(id, text)] || '<span class="why">Checking…</span>';
async function checkDigest(text, id) {
  await digests.check(id, text);
  // Only an inspector still showing this exact snapshot receives the result.
  const dl = state.dialog;
  const el = $('#dlg [data-digest]');
  if (el && dl?.data?.evidenceId === id && dl.data.evidenceText === text) el.innerHTML = digestText(id, text);
}

/* ------------------------------------------------------------------ announcements */

let liveRegionTimer = null;
function say(text) {
  const sr = document.getElementById('sr');
  if (!sr) return;
  const host = $('#dlg')?.open ? $('#dlg') : document.body;
  if (sr.parentElement !== host) host.appendChild(sr);
  sr.textContent = '';
  clearTimeout(liveRegionTimer);
  liveRegionTimer = setTimeout(() => { sr.textContent = text; }, 40);
}

// After a load, announce the result; a notice from that load (such as a restart after 410) comes first.
function announce(name, text) {
  const notice = state.views[name].notice;
  say(notice ? `${notice} ${text}` : text);
}

function summary(name) {
  const d = state.views[name].data;
  if (!d) return '';
  if (name === 'searches' && d.searchCapability === 'not-recorded') return 'Searches are not recorded in this scope.';
  const one = name === 'watched' ? 'recorded entry' : 'search';
  const many = name === 'watched' ? 'recorded entries' : 'searches';
  return state.views[name].dataQ ? `${num(d.filteredCount).toLocaleString('en')} of ${plural(d.count, one, many)} match.` : `${plural(d.count, one, many)}.`;
}

/* ------------------------------------------------------------------ events */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const name = state.view;
  const v = state.views[name];
  switch (el.dataset.action) {
    case 'skip': e.preventDefault(); $('#main').focus(); break;
    case 'days': if (Number(el.dataset.value) !== state.scope.days) setScope({ days: Number(el.dataset.value) || 7 }).then(() => announce(name, summary(name))); break;
    case 'page':
      v.page = Math.max(1, Number(el.dataset.value) || 1);
      load(name).then(() => {
        if (state.view !== name || !v.data) return;
        // At the first or last page the pressed button is disabled; keep focus in the pager.
        const active = document.activeElement;
        if (!active || active === document.body || active.disabled) ($('[data-key="page:prev"]:not([disabled])') || $('[data-key="page:next"]:not([disabled])'))?.focus({ preventScroll: true });
        $('[data-status]')?.scrollIntoView({ block: 'start' });
        announce(name, `Page ${num(v.data.page) || v.page} of ${Math.max(1, num(v.data.pages))}.`);
      });
      break;
    case 'refresh': v.page = 1; load(name, { fresh: true }).then(() => announce(name, `Updated. ${summary(name)}`)); break;
    case 'retry': load(name); break;
    case 'clear-q':
      v.q = ''; v.draft = null; v.page = 1;
      load(name).then(() => { $('#f-q')?.focus(); announce(name, summary(name)); });
      break;
    case 'all-devices': setScope({ device: '', person: '' }).then(() => announce(name, summary(name))); break;
    case 'evidence': openEvidence(el.dataset.id, el); break;
    case 'evidence-retry': fetchEvidence(); break;
    case 'close': closeDialog(); break;
    case 'raw': if (state.dialog) { state.dialog.raw = el.dataset.value; state.dialog.rawOpen = true; renderDialog(); } break;
    case 'copy': {
      const text = el.dataset.text || '';
      const done = navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
      done.then(() => say('Evidence ID copied.'), () => say('Copying isn’t available here; select the ID instead.'));
      break;
    }
    case 'logout': signOut(); break;
    default: break;
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  const name = state.view;
  if (t.dataset.action === 'version' && state.dialog) {
    state.dialog.selected = t.value;
    state.dialog.raw = 'exact';
    state.dialog.rawOpen = false;
    fetchEvidence();
  } else if (t.dataset.action === 'device') setScope({ device: t.value }).then(() => announce(name, summary(name)));
  else if (t.dataset.action === 'person') {
    // A device that belongs to someone else can't be in the new person's scope; clear it.
    const device = known('devices').find((x) => x.id === state.scope.device);
    const patch = { person: t.value };
    if (state.scope.device && (!device || !belongs(device, t.value))) patch.device = '';
    setScope(patch).then(() => announce(name, summary(name)));
  }
});

let queryTimer = null;
function applyQuery(name) {
  clearTimeout(queryTimer);
  const v = state.views[name];
  if (v.draft === null) return;
  const next = v.draft.slice(0, 200);
  v.draft = null;
  if (next === v.q) return;
  v.q = next;
  v.page = 1;
  load(name).then(() => { if (state.view === name) announce(name, summary(name)); });
}
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.action !== 'q') return;
  const name = state.view;
  state.views[name].draft = t.value;
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => applyQuery(name), 350);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target?.dataset?.action === 'q') { e.preventDefault(); applyQuery(state.view); }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.dataset.form !== 'login') return;
  e.preventDefault();
  const key = $('#owner-key').value;
  if (!key.trim()) { state.login.error = 'Enter the owner key.'; render(); $('#owner-key')?.focus(); return; }
  state.login = { busy: true, error: '' };
  render();
  try {
    await api.login(key);
    state.auth = 'signedIn';
    state.login = { busy: false, error: '' };
    await load(state.view);
    $$('[data-heading]').find((h) => h.offsetParent)?.focus();
  } catch (error) {
    state.login = { busy: false, error: error?.status === 401 ? 'That key wasn’t accepted.' : error?.message || 'Signing in didn’t work.' };
    render();
    $('#owner-key')?.focus();
  }
});

document.addEventListener('toggle', (e) => { if (e.target.matches?.('[data-raw-details]') && state.dialog) state.dialog.rawOpen = e.target.open; }, true);
document.addEventListener('error', (e) => { if (e.target.matches?.('img[data-thumb]')) e.target.remove(); }, true);

const dlg = $('#dlg');
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
dlg.addEventListener('close', () => {
  const key = state.dialog?.openerKey;
  state.dialog = null;
  const sr = document.getElementById('sr');
  if (sr && sr.parentElement !== document.body) document.body.appendChild(sr);
  if (key) $(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
});

window.addEventListener('hashchange', () => {
  const r = readRoute();
  if (!r) return;
  const before = { view: state.view, scope: scopeKey(), q: state.views[r.view].q, page: state.views[r.view].page };
  adoptRoute(r);
  if (!r.known) writeHash();
  if (state.auth !== 'signedIn') { render(); return; }
  const v = state.views[r.view];
  const switched = before.view !== r.view;
  if (switched || before.scope !== scopeKey() || before.q !== v.q || before.page !== v.page || !v.data) {
    load(r.view).then(() => { if (switched && state.view === r.view) announce(r.view, `${VIEWS[r.view].tab}. ${summary(r.view)}`); });
  } else {
    render();
  }
});

boot();
