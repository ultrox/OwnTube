// OwnTube backoffice · Languages module (contract: contracts/languages.md).
// Live by default. `?demo` loads an in-memory sample adapter instead, behind a permanent demo strip;
// demo mode makes no /api requests and live mode never contains sample data.
import { ApiError, liveApi } from './api.js';
import { versionKey, findVersion, versionPickerHTML, savedEvidence, EvidenceDigests } from '/shared/recorded-versions.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
let api = liveApi;

/* ------------------------------------------------------------------ utilities */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
const PAGE_SIZE = 20;
const DAYS = [7, 30, 90];
const STATUSES = [['all', 'All'], ['review', 'Needs review'], ['confirmed', 'Confirmed'], ['estimated', 'Estimated']];
const SPECIAL = { und: 'Unknown', mul: 'Mixed languages', zxx: 'No speech' };
const COMMON = ['de', 'en', 'sr', 'hr', 'bs', 'fr', 'it', 'es', 'pt', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'hi', 'ja', 'ko', 'zh'];
const LANG_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const displayNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; } })();

function langName(code) {
  if (!code) return 'Unknown';
  if (SPECIAL[code]) return SPECIAL[code];
  try {
    const name = displayNames?.of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

function spentParts(sec) {
  const s = Math.round(Number(sec) || 0);
  if (s === 0) return [['0', 'min']];
  if (s < 60) return [[String(s), 's']];
  const m = Math.round(s / 60);
  if (m < 60) return [[String(m), 'min']];
  const h = Math.floor(m / 60), r = m % 60;
  return r ? [[String(h), 'h'], [String(r), 'min']] : [[String(h), 'h']];
}
const spent = (sec) => spentParts(sec).map(([n, u]) => `${n} ${u}`).join(' ');
const spentHTML = (sec) => spentParts(sec).map(([n, u]) => `${n}<span class="u">${u}</span>`).join('');
const toMs = (t) => (typeof t === 'number' ? t : t ? Date.parse(t) : NaN);

function ago(t) {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return '';
  const d = Date.now() - ms;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.round(d / 60000)} min ago`;
  if (d < 86400000) return `${Math.round(d / 3600000)} h ago`;
  const days = Math.round(d / 86400000);
  return days === 1 ? 'yesterday' : days < 31 ? `${days} days ago` : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
}
function when(t, timeZone) {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
  }
}
function day(t, timeZone) {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
  }
}
function span(since, until, timeZone) {
  const a = toMs(since), b = toMs(until);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  let f;
  try { f = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }); } catch { f = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }); }
  return `${f.format(a)} – ${f.format(b)}`;
}
// Confidence is a word (high, medium, low, unavailable; "human" for your own classification) or,
// for detector scores, a number between 0 and 1. Shown as recorded, never upgraded.
const CONF_WORD = { human: 'human (your classification)' };
const confText = (c) => (c == null || c === '' ? '' : typeof c === 'number' ? `${Math.round(c * 100)}%` : CONF_WORD[c] || String(c));

const ICON = {
  mark: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.9 7.6v8.8l6.8-4.4z" fill="currentColor"/></svg>',
  search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.4 10.4L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  confirmed: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  estimated: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.4 2"/></svg>',
  undetermined: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1M8 11.2v.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
const STATUS_WORD = { confirmed: 'Confirmed', estimated: 'Estimated', undetermined: 'Undetermined' };
const statusHTML = (s) => `<span class="status status--${esc(s || 'undetermined')}">${ICON[s] || ICON.undetermined}${esc(STATUS_WORD[s] || s || 'Undetermined')}</span>`;
const notRecorded = (why) => `<span class="nr">Not recorded</span>${why ? ` <span class="why">· ${why}</span>` : ''}`;

/* ------------------------------------------------------------------ state */

const state = {
  auth: 'checking', // checking | signedOut | signedIn
  login: { busy: false, error: '' },
  filters: readFilters(),
  data: null,
  loading: false,
  error: null,
  dialog: null,
};
let generation = 0;
let linkedMetadata = new URLSearchParams(location.hash.replace(/^#/, '')).get('metadata');

function readFilters() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const days = Number(h.get('days'));
  const status = h.get('status');
  return {
    days: DAYS.includes(days) ? days : 7,
    device: h.get('device') || '',
    person: h.get('person') || '',
    language: h.get('language') || 'all',
    status: STATUSES.some(([v]) => v === status) ? status : 'all',
    query: (h.get('query') || '').slice(0, 200),
    page: Math.max(1, Number(h.get('page')) || 1),
  };
}
function writeFilters() {
  const f = state.filters;
  const h = new URLSearchParams();
  if (f.days !== 7) h.set('days', f.days);
  for (const k of ['device', 'person', 'query']) if (f[k]) h.set(k, f[k]);
  if (f.language !== 'all') h.set('language', f.language);
  if (f.status !== 'all') h.set('status', f.status);
  if (f.page > 1) h.set('page', f.page);
  if (linkedMetadata) h.set('metadata', linkedMetadata);
  const next = h.toString();
  if (location.hash.replace(/^#/, '') !== next) history.replaceState(null, '', `${location.pathname}${location.search}${next ? `#${next}` : ''}`);
}

/* ------------------------------------------------------------------ data */

async function load({ keepPage = false } = {}) {
  if (!keepPage) state.filters.page = Math.max(1, state.filters.page);
  writeFilters();
  const mine = ++generation;
  state.loading = true;
  render();
  try {
    const f = state.filters;
    const data = await api.languages({ days: f.days, device: f.device, person: f.person, language: f.language, status: f.status, query: f.query, page: f.page, group: 'video' });
    if (mine !== generation) return;
    state.data = readable(data);
    state.error = null;
    if (Number(data?.page) && Number(data.page) !== f.page) { f.page = Number(data.page); writeFilters(); }
  } catch (error) {
    if (mine !== generation) return;
    if (error instanceof ApiError && error.status === 401) return signedOut();
    state.error = error.message || 'Languages could not be loaded.';
  } finally {
    if (mine === generation) {
      state.loading = false;
      render();
      if (!state.error && linkedMetadata) {
        const group = state.data?.videos.find((g) => g.versions.some((v) => v.metadataId === linkedMetadata));
        if (group) {
          const version = group.versions.find((v) => v.metadataId === linkedMetadata);
          linkedMetadata = null;
          writeFilters();
          openInspector(String(group.id), null, versionKey(version));
        }
      }
    }
  }
}

// One row is one video with every recorded version of it in the period/device/person scope. A
// server that ignores group=video returns version rows; each is then shown as a one-version group.
function asGroup(x) {
  if (Array.isArray(x?.versions) && x.versions.length) return x;
  return {
    id: `${x.deviceId}:${x.metadataId}`, videoId: x.videoId, title: x.title, channel: x.channel,
    seconds: x.seconds, foregroundSeconds: x.foregroundSeconds, backgroundSeconds: x.backgroundSeconds, unspecifiedSeconds: x.unspecifiedSeconds,
    lastWatched: x.lastWatched, deviceLabel: x.deviceLabel, devices: [{ id: x.deviceId, label: x.deviceLabel, contextOverride: x.contextOverride || null }],
    versionCount: 1, matchedVersionCount: 1, versions: [x], assessment: x.assessment, recorded: x.recorded, needsReview: x.needsReview,
  };
}
// A successful answer must still look like the contract before it is shown as numbers.
function readable(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.videos)) throw new ApiError(200, 'The server’s answer couldn’t be read.');
  return { ...data, videos: data.videos.map(asGroup) };
}

function signedOut(message = '') {
  state.auth = 'signedOut';
  state.data = null;
  state.login = { busy: false, error: message };
  closeDialog();
  render();
  $('#owner-key')?.focus();
}

async function boot() {
  if (DEMO) {
    const { createDemoApi } = await import('./demo.js');
    api = await createDemoApi({ external: params.has('external') });
  }
  renderChrome();
  try {
    await api.session();
    state.auth = 'signedIn';
    await load({ keepPage: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) signedOut();
    else { state.auth = 'signedIn'; state.error = error.message; render(); }
  }
}

/* ------------------------------------------------------------------ chrome */

function renderChrome() {
  const strip = $('#demo');
  strip.hidden = !DEMO;
  if (DEMO) {
    strip.innerHTML = `<span class="demo__tag">Demo</span><span class="demo__msg"><b>Sample data in this browser.</b> Nothing here comes from or goes to the server. Corrections reset on reload.</span>`;
  }
  // Demo runs inside the design preview, so its navigation mirrors the preview. Live, the module
  // sits beside the History desk at the backoffice root; the old dashboard lives at /legacy/.
  $('#nav').innerHTML = DEMO
    ? `<a class="nav__link" href="../../#/curation">Curation</a><a class="nav__link" href="../../#/history">History</a><a class="nav__link" href="./?demo=1" aria-current="page">Languages</a>`
    : `<a class="nav__link" href="../../#/history" data-nav="history">History</a><a class="nav__link" href="./" aria-current="page" data-nav="languages">Languages</a>`;
  renderMastEnd();
}
function renderMastEnd() {
  if (DEMO) { $('#mast-end').innerHTML = ''; return; }
  $('#mast-end').innerHTML = `<a class="btn btn--sm btn--quiet" href="../../legacy/" title="The previous dashboard, with devices and pairing" data-key="mast:legacy">Legacy</a>${state.auth === 'signedIn'
    ? '<button type="button" class="btn btn--sm btn--quiet" data-action="logout" data-key="mast:logout">Sign out</button>' : ''}`;
}

/* ------------------------------------------------------------------ render */

function render() {
  preserve(() => {
    renderMastEnd();
    const main = $('#main');
    main.setAttribute('aria-busy', String(state.auth === 'checking' || (state.loading && !state.data)));
    if (state.auth === 'checking') main.innerHTML = '<p class="boot">Checking your session…</p>';
    else if (state.auth === 'signedOut') main.innerHTML = loginHTML();
    else main.innerHTML = workspaceHTML();
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
      if (sel && !focusKey && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not text */ } }
    }
  }
}

function loginHTML() {
  return `<div class="login">
    <h1 class="login__title" tabindex="-1">Sign in</h1>
    <p class="login__lede">Languages needs the owner session. Use the owner key from the server’s admin-token file.</p>
    <form data-form="login" novalidate>
      <label class="label" for="owner-key">Owner key</label>
      <input class="input" id="owner-key" type="password" autocomplete="current-password" spellcheck="false" required data-key="login:key">
      ${state.login.error ? `<p class="login__error" role="alert">${esc(state.login.error)}</p>` : ''}
      <div><button type="submit" class="btn btn--primary" ${state.login.busy ? 'disabled' : ''}>${state.login.busy ? 'Signing in…' : 'Sign in'}</button></div>
    </form>
  </div>`;
}

const deviceById = (id) => state.data?.devices?.find((d) => d.id === id);
// Browsers report tab visibility (on-tab), the TV app reports the app in front (foreground). The
// contract doesn't say which kind a device is yet, so unknown or mixed scopes name both.
const frontWord = (deviceId) => {
  const kind = deviceById(deviceId)?.kind;
  return kind === 'browser' ? 'on-tab' : kind === 'tv' ? 'foreground' : 'on-tab/foreground';
};
const ctxParts = (fg, bg, un, deviceId) => [[fg, frontWord(deviceId)], [bg, 'background'], [un, 'unspecified']].filter(([s]) => Number(s) > 0);
function ctxSentence(fg, bg, un, deviceId) {
  const parts = ctxParts(fg, bg, un, deviceId);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0][1] === 'unspecified' ? 'context not recorded' : `all ${parts[0][1]}`;
  return parts.map(([s, w]) => `${spent(s)} ${w}`).join(' · ');
}

function workspaceHTML() {
  const d = state.data;
  const f = state.filters;
  const people = d?.people || [];
  const devices = d?.devices || [];
  const deviceOptions = () => {
    const opt = (x) => `<option value="${esc(x.id)}" ${f.device === x.id ? 'selected' : ''}>${esc(x.label)}</option>`;
    if (people.length > 1) {
      const groups = people.map((p) => {
        const ds = devices.filter((x) => x.personId === p.id);
        return ds.length ? `<optgroup label="${esc(p.name)}">${ds.map(opt).join('')}</optgroup>` : '';
      }).join('');
      const loose = devices.filter((x) => !people.some((p) => p.id === x.personId));
      return groups + (loose.length ? `<optgroup label="Unassigned">${loose.map(opt).join('')}</optgroup>` : '');
    }
    return devices.map(opt).join('');
  };
  // On phones the heading comes before the filters; this copy is shown only there.
  const side = `<aside class="side" aria-label="Scope">
      <div class="side__head"><h1 class="title" tabindex="-1" data-heading>Languages</h1>
        <p class="lede">Watch time by the language of the audio that actually played.</p></div>
      <div class="side__filters">
        <div><label class="label" for="f-device">Device</label>
          <select class="select" id="f-device" data-action="device" data-key="f:device"><option value="">All devices</option>${deviceOptions()}</select></div>
        ${people.length > 1 ? `<div><label class="label" for="f-person">Person</label>
          <select class="select" id="f-person" data-action="person" data-key="f:person"><option value="">Everyone</option>${people.map((p) => `<option value="${esc(p.id)}" ${f.person === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>` : ''}
        <div><span class="label" id="f-days">Period</span>
          <div class="seg" role="group" aria-labelledby="f-days">${DAYS.map((n) => `<button type="button" aria-pressed="${f.days === n}" data-action="days" data-value="${n}" data-key="f:days:${n}">${n} days</button>`).join('')}</div></div>
      </div>
      <div class="side__note">
        <p><b>Language</b> means the audio that actually played: the selected audio track, not the title’s or captions’ language.</p>
        <p><b>Mixed</b> and <b>no speech</b> are their own answers, separate from <b>unknown</b>.</p>
        <p>One row is one video. A decision covers all its recorded versions in this scope; for a dub, apply it to the selected version only.</p>
      </div>
    </aside>`;

  let body;
  if (state.error && !d) body = problemHTML(state.error);
  else if (!d) body = '<p class="boot">Loading languages…</p>';
  else body = (state.error ? problemHTML(state.error) : '') + ledgerHTML(d) + languagesHTML(d) + videosHTML(d);

  return `<div class="ws">${side}
    <section class="content"><div class="page">
      <div class="page__head"><h1 class="title" id="title" tabindex="-1" data-heading>Languages</h1>
        <p class="lede">Watch time by the language of the audio that actually played, background included.</p></div>
      ${body}
    </div></section>
  </div>`;
}

const problemHTML = (message) => `<div class="problem" role="alert"><p><b>Languages couldn’t be loaded.</b> ${esc(message)}</p><button type="button" class="btn btn--sm" data-action="retry" data-key="retry">Try again</button></div>`;

// The current scope inside a sentence: "last 30 days, all devices".
function scopePhrase() {
  const f = state.filters;
  const d = state.data || {};
  const dev = f.device ? deviceById(f.device)?.label || 'one device' : 'all devices';
  const person = f.person ? `, ${d.people?.find((p) => p.id === f.person)?.name || 'one person'}` : '';
  return `last ${d.days || f.days} days, ${dev}${person}`;
}

function scopeText(d) {
  const f = state.filters;
  const dev = f.device ? deviceById(f.device)?.label || 'One device' : 'All devices';
  const person = f.person ? d.people?.find((p) => p.id === f.person)?.name || 'One person' : (d.people?.length > 1 ? 'Everyone' : '');
  return [`Last ${d.days || f.days} days`, span(d.since, d.until, d.timezone), dev, person].filter(Boolean);
}

function ledgerHTML(d) {
  const ctx = ctxParts(d.foregroundSeconds, d.backgroundSeconds, d.unspecifiedSeconds, state.filters.device);
  // Every row is confirmed, estimated or undetermined, so the rest of the scope is undetermined.
  const undetermined = (Number(d.seconds) || 0) - (Number(d.confirmedSeconds) || 0) - (Number(d.estimatedSeconds) || 0);
  return `<section class="ledger" aria-labelledby="ledger-scope" data-ledger data-seconds="${Number(d.seconds) || 0}" data-review="${Number(d.reviewSeconds) || 0}" data-videos="${Number(d.videoCount) || 0}">
      <h2 class="label ledger__scope" id="ledger-scope">${scopeText(d).map((s) => `<span>${esc(s)}</span>`).join('')}${DEMO ? '<span class="ledger__demo">Demo data</span>' : ''}</h2>
      <dl class="figs">
        <div class="fig"><dt>Watched</dt><dd class="fig__n">${spentHTML(d.seconds)}</dd></div>
        <div class="fig"><dt>Distinct videos</dt><dd class="fig__n">${(Number(d.videoCount) || 0).toLocaleString('en')}</dd></div>
        <div class="fig fig--review"><dt>Needs review</dt><dd class="fig__n">${spentHTML(d.reviewSeconds)}</dd></div>
      </dl>
      <p class="sentence" data-decision><span class="sentence__lead">By decision</span><span><b>${esc(spent(d.confirmedSeconds))}</b> confirmed by you</span><span><b>${esc(spent(d.estimatedSeconds))}</b> estimated</span>${undetermined > 0 ? `<span><b>${esc(spent(undetermined))}</b> undetermined</span>` : ''}</p>
      ${ctx.length ? `<p class="sentence" data-context data-fg="${Number(d.foregroundSeconds) || 0}" data-bg="${Number(d.backgroundSeconds) || 0}" data-un="${Number(d.unspecifiedSeconds) || 0}"><span class="sentence__lead">By context</span>${ctx.map(([s, w]) => `<span><b>${esc(spent(s))}</b> ${esc(w)}</span>`).join('')}</p>` : ''}
      <p class="note">Period, device${d.people?.length > 1 ? ' and person' : ''} set these numbers; language, status and search only narrow the videos below. Days follow the server’s time zone${d.timezone ? ` (${esc(d.timezone)})` : ''}. Background playback counts. Confirmed means you classified it; everything else is an estimate.</p>
    </section>`;
}

function languagesHTML(d) {
  const total = Number(d.seconds) || 0;
  const list = (d.languages || []).slice().sort((a, b) => (Number(b.seconds) || 0) - (Number(a.seconds) || 0));
  const spoken = list.filter((l) => !SPECIAL[l.lang]);
  const other = ['mul', 'zxx', 'und'].map((c) => list.find((l) => l.lang === c)).filter(Boolean);
  const row = (l) => {
    const share = total ? Math.round(((Number(l.seconds) || 0) / total) * 100) : 0;
    const pressed = state.filters.language === l.lang;
    const name = langName(l.lang);
    return `<button type="button" class="lang lang--${esc(SPECIAL[l.lang] ? l.lang : 'spoken')}" aria-pressed="${pressed}" data-action="language" data-lang="${esc(l.lang)}" data-key="lang:${esc(l.lang)}"
        aria-label="${esc(`${name} (${l.lang}): ${spent(l.seconds)}, ${share}% of watch time, ${plural(Number(l.videoCount) || 0, 'video')}. ${pressed ? 'Showing only these videos.' : 'Show only these videos.'}`)}">
        <span class="lang__name">${esc(name)}<code>${esc(l.lang)}</code>${l.lang === 'und' ? '<span class="lang__review">needs a decision</span>' : ''}</span>
        <span class="lang__bar" aria-hidden="true"><span style="width:${Math.min(100, share)}%"></span></span>
        <span class="lang__time">${esc(spent(l.seconds))}</span>
        <span class="lang__share">${share}%</span>
        <span class="lang__videos">${esc(plural(Number(l.videoCount) || 0, 'video'))}</span>
      </button>`;
  };
  const content = !list.length
    ? '<div class="empty"><p class="empty__title">No playback in this period.</p><p class="empty__hint">Try a longer period or another device.</p></div>'
    : `${spoken.map(row).join('')}${other.length ? `<p class="label langs__sub">Not one spoken language</p>${other.map(row).join('')}` : ''}`;
  return `<section class="section" aria-labelledby="langs-h">
      <div class="section__head"><h2 class="section__title" id="langs-h">Languages</h2><span class="section__aside">Share of watch time · select one to filter the videos</span></div>
      <div class="langs" role="group" aria-labelledby="langs-h" data-languages>${content}</div>
    </section>`;
}

function videosHTML(d) {
  const f = state.filters;
  const narrowed = f.language !== 'all' || f.status !== 'all' || !!f.query;
  const codes = (d.languages || []).map((l) => l.lang);
  if (f.language !== 'all' && !codes.includes(f.language)) codes.push(f.language);
  const rows = d.videos || [];
  const pages = Math.max(1, Number(d.pages) || 1);
  const page = Number(d.page) || f.page;
  const count = Number(d.count) || 0;
  let list;
  if (!rows.length) {
    list = narrowed
      ? `<div class="empty"><p class="empty__title">No videos match.</p><p class="empty__hint"><button type="button" class="link-btn" data-action="clear" data-key="clear">Clear language, status and search</button></p></div>`
      : '<div class="empty"><p class="empty__title">Nothing played in this period.</p></div>';
  } else {
    list = `<ol class="vrows" data-videos>${rows.map(videoRow).join('')}</ol>`;
  }
  return `<section class="section" aria-labelledby="videos-h">
      <div class="section__head"><h2 class="section__title" id="videos-h">Videos</h2><span class="section__aside">One row per video, with all its recorded versions in this scope</span></div>
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Status">${STATUSES.map(([v, label]) => `<button type="button" aria-pressed="${f.status === v}" data-action="status" data-value="${v}" data-key="f:status:${v}">${label}</button>`).join('')}</div>
        <label class="vh" for="f-language">Language</label>
        <select class="select" id="f-language" data-action="language-select" data-key="f:language"><option value="all">All languages</option>${codes.map((c) => `<option value="${esc(c)}" ${f.language === c ? 'selected' : ''}>${esc(langName(c))} (${esc(c)})</option>`).join('')}</select>
        <div class="search">${ICON.search}<label class="vh" for="f-query">Search videos</label><input class="input" id="f-query" type="search" maxlength="200" autocomplete="off" spellcheck="false" placeholder="Title, channel or video ID" value="${esc(f.query)}" data-action="query" data-key="f:query"></div>
      </div>
      <p class="count" data-count="${count}">${esc(plural(count, 'video'))}${narrowed ? ' match' : ''}${state.loading ? ' · updating…' : ''}</p>
      ${list}
      ${pages > 1 ? `<nav class="pager" aria-label="Pages">
        <button type="button" class="btn btn--sm" data-action="page" data-value="${page - 1}" data-key="page:prev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
        <span class="pager__at">Page ${page} of ${pages}</span>
        <button type="button" class="btn btn--sm" data-action="page" data-value="${page + 1}" data-key="page:next" ${page >= pages ? 'disabled' : ''}>Next</button>
      </nav>` : ''}
    </section>`;
}

const realVideoId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
function thumbHTML(videoId) {
  const img = realVideoId(videoId) && !DEMO
    ? `<img src="https://i.ytimg.com/vi/${esc(videoId)}/mqdefault.jpg" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-thumb>`
    : '';
  return `<span class="thumb"><span class="thumb__id">${esc(videoId || '')}</span>${img}</span>`;
}

// What the collector itself recorded (a source value), shown beside the current interpretation.
function recordedText(r) {
  const src = r?.source ? ` · ${esc(r.source)}` : '';
  if (!r || !r.lang) return `Collector: <span class="nr">language not recorded</span>${src}`;
  return `Collector: ${esc(r.lang)}${src}${r.conf ? ` · ${esc(confText(r.conf))}` : ''}`;
}

/* ------------------------------------------------------------------ video groups */

const groupDevices = (g) => (Array.isArray(g.devices) && g.devices.length ? g.devices : [{ id: '', label: g.deviceLabel }]).map((d) => d.label || 'Device');
const versionsText = (n) => (n === 1 ? '1 recorded version' : `${n} recorded versions`);

// Assessed languages across a group's versions, longest-watched first, with status counts.
function groupLangs(g) {
  const m = new Map();
  for (const v of g.versions || []) {
    const lang = v.assessment?.lang || 'und';
    const status = v.assessment?.status || 'undetermined';
    const e = m.get(lang) || { lang, versions: 0, seconds: 0, statuses: {}, devices: new Set() };
    e.versions += 1;
    e.seconds += Number(v.seconds) || 0;
    e.statuses[status] = (e.statuses[status] || 0) + 1;
    e.devices.add(v.deviceLabel || 'a device');
    m.set(lang, e);
  }
  return [...m.values()].sort((a, b) => b.seconds - a.seconds || b.versions - a.versions);
}
const STATUS_ORDER = ['confirmed', 'estimated', 'undetermined'];
const statusesText = (counts) => STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${STATUS_WORD[s].toLowerCase()}`).join(' · ');
// A known audio language as the server reads one (server/src/languages.rs `language`): a lowercased,
// bounded BCP-47-shaped code. The collector's "other", empty and malformed values are unknown, like
// "und", and return null.
function knownLang(value) {
  const v = String(value ?? '').trim().toLowerCase();
  const parts = v.split('-');
  const primary = parts[0];
  if (v.length > 35 || primary === 'other' || primary === 'und' || !/^[a-z]{2,3}$/.test(primary)
    || parts.slice(1).some((p) => !/^[a-z0-9]{1,8}$/.test(p))
    || (['mul', 'zxx'].includes(primary) && parts.length !== 1)) return null;
  return v;
}
// Versions that name different known audio languages: a possible dub. Read from the current
// interpretations, else from the collector's recorded values; unknown never counts, so a version
// recorded as unknown beside a known one is no conflict. Each language comes with its devices.
function disagreement(g) {
  for (const [from, pick] of [['assessment', (v) => v.assessment?.lang], ['recorded', (v) => v.recorded?.lang]]) {
    const m = new Map();
    for (const v of g.versions || []) {
      const lang = knownLang(pick(v));
      if (!lang) continue;
      if (!m.has(lang)) m.set(lang, new Set());
      m.get(lang).add(v.deviceLabel || 'a device');
    }
    if (m.size > 1) return { from, langs: [...m].map(([lang, devices]) => ({ lang, devices: [...devices] })) };
  }
  return null;
}

// Where an interpretation comes from, in a few quiet words.
const SOURCE_WORDS = {
  'selected-audio-metadata': 'from the selected audio track', manual: 'your classification', 'external-api:audio': 'analysis of the audio',
  'saved-evidence': 'no selected audio language saved', 'collector:audio-track': 'collector, from the audio track', 'collector:asr-caption': 'collector, from auto-generated captions',
  'collector:native-text': 'collector, from text', 'collector:description-heuristic': 'collector, from the description', 'collector:title-heuristic': 'collector, from the title',
  'collector:android-player': 'no audio language saved',
};
function sourceWords(source) {
  if (!source) return '';
  if (SOURCE_WORDS[source]) return SOURCE_WORDS[source];
  if (source.startsWith('external-api:')) return `analysis of ${source.slice(13)}`;
  if (source.startsWith('collector:')) return 'collector estimate';
  return source;
}

// The row's language: the shared one, or "Mixed" with quiet counts when versions differ.
function groupLangHTML(g) {
  const langs = groupLangs(g);
  if (langs.length > 1) {
    return `<span class="assess__lang" data-mixed>Mixed</span><span class="why">versions differ: ${langs.map((l) => `${esc(langName(l.lang))} ×${l.versions}`).join(' · ')}</span>`;
  }
  const lang = langs[0]?.lang || g.assessment?.lang || 'und';
  const counts = langs[0]?.statuses || {};
  const statuses = Object.keys(counts).length > 1
    ? `<span class="status status--estimated" data-statuses>${esc(statusesText(counts))}</span>`
    : statusHTML(Object.keys(counts)[0] || g.assessment?.status);
  const sources = new Set((g.versions || []).map((v) => v.assessment?.source || ''));
  const from = sources.size > 1 ? 'sources vary' : sourceWords([...sources][0]);
  return `<span class="assess__lang">${esc(langName(lang))}<code>${esc(lang)}</code></span>${statuses}${from ? `<span class="recorded" data-source>${esc(from)}</span>` : ''}`;
}

function videoRow(g) {
  const id = String(g.id ?? g.videoId);
  const title = g.title || `Untitled · ${g.videoId || 'no video ID'}`;
  const n = Number(g.versionCount) || g.versions?.length || 1;
  const matched = Number(g.matchedVersionCount) || 0;
  const f = state.filters;
  const narrowed = f.language !== 'all' || f.status !== 'all' || !!f.query;
  const devices = groupDevices(g);
  const ctx = ctxSentence(g.foregroundSeconds, g.backgroundSeconds, g.unspecifiedSeconds, devices.length === 1 ? g.devices?.[0]?.id : null);
  return `<li class="vrow ${g.needsReview ? 'vrow--review' : ''}" data-row="${esc(id)}" data-versions="${n}" data-seconds="${Number(g.seconds) || 0}">
      <div class="vrow__media">${thumbHTML(g.videoId)}</div>
      <div class="vrow__body">
        <h3 class="vrow__title"><button type="button" data-action="open" data-id="${esc(id)}" data-key="open:${esc(id)}">${esc(title)}</button></h3>
        <p class="meta">${g.channel ? `<span>${esc(g.channel)}</span>` : ''}<span>${esc(devices.length > 3 ? `${devices.length} devices` : devices.join(', '))}</span>${g.lastWatched ? `<span>last played ${esc(ago(g.lastWatched))}</span>` : ''}${n > 1 ? `<span data-version-count>${n} recorded versions</span>` : ''}</p>
        <p class="assess">${groupLangHTML(g)}${g.needsReview ? '<span class="flag-review">Needs review</span>' : ''}${narrowed && n > 1 && matched && matched < n ? `<span class="why" data-matched>${matched} of ${n} versions match</span>` : ''}</p>
      </div>
      <div class="vrow__side">
        <p class="nums"><span><b>${esc(spent(g.seconds))}</b> watched</span>${ctx ? `<span class="nums__ctx">${esc(ctx)}</span>` : ''}</p>
        <button type="button" class="btn btn--sm ${g.needsReview ? 'btn--review' : ''}" data-action="open" data-id="${esc(id)}" data-key="act:${esc(id)}">${g.needsReview ? 'Review' : 'Inspect'}<span class="vh"> ${esc(title)}</span></button>
      </div>
    </li>`;
}

/* ------------------------------------------------------------------ inspector */

const providerList = () => {
  const list = Array.isArray(state.data?.providers) && state.data.providers.length ? state.data.providers : [{ id: 'saved-evidence', label: 'Saved audio metadata' }];
  return list.filter((p) => p && p.id);
};

// The inspector holds one video group. Its classification applies to every version in the group
// by default; evidence, audit and analysis belong to the selected version (newest first).
async function openInspector(id, opener, selected) {
  const group = state.data?.videos?.find((g) => String(g.id) === id);
  if (!group) return;
  state.dialog = {
    id, group, selected: selected || versionKey(group.versions[0]), target: 'all', request: 0,
    data: null, loading: true, error: null, alert: null, busy: false,
    raw: 'exact', rawOpen: false, openerKey: opener?.getAttribute?.('data-key') || null,
    form: { lang: null, other: '', note: '', provider: providerList()[0].id },
  };
  renderDialog();
  const dlg = $('#dlg');
  if (!dlg.open) dlg.showModal();
  await loadVersion();
}

const selectedVersion = (d) => findVersion(d.group, d.selected);

// The language a new decision starts from: an existing manual choice, else the most-watched known
// language, so one click never records "unknown" over a language some version already names.
function defaultLang(g) {
  const manual = (g.versions || []).find((v) => v.assessment?.source === 'manual');
  if (manual?.assessment?.lang) return manual.assessment.lang;
  return groupLangs(g).find((l) => l.lang !== 'und')?.lang || 'und';
}

// Evidence, audit and revision of the selected version. An answer for a version that is no longer
// selected (or a closed inspector) is dropped.
async function loadVersion() {
  const d = state.dialog;
  if (!d) return;
  const v = selectedVersion(d);
  const key = versionKey(v);
  const request = ++d.request;
  d.data = null;
  d.loading = true;
  d.error = null;
  renderDialog();
  try {
    const data = await api.evidence(v.deviceId, v.metadataId);
    if (state.dialog !== d || d.selected !== key || d.request !== request) return;
    d.data = data;
    if (d.form.lang == null) d.form.lang = defaultLang(d.group);
  } catch (error) {
    if (state.dialog !== d || d.selected !== key || d.request !== request) return;
    if (error instanceof ApiError && error.status === 401) { signedOut(); return; }
    d.error = error.message;
  } finally {
    if (state.dialog === d && d.selected === key && d.request === request) { d.loading = false; renderDialog(); }
  }
}

// After a decision (or a conflict) re-read the list and this video's group, keeping the same
// selected version while it is still part of the group.
async function refreshGroup() {
  const d = state.dialog;
  if (!d) return;
  await load({ keepPage: true });
  if (state.dialog !== d) return;
  let group = state.data?.videos?.find((g) => String(g.id) === d.id);
  if (!group) {
    // Filtered out of the list now (for example no longer "Needs review"): read the group alone.
    try {
      const f = state.filters;
      const one = readable(await api.languages({ days: f.days, device: f.device, person: f.person, language: 'all', status: 'all', query: d.group.videoId, page: 1, group: 'video' }));
      group = one.videos.find((g) => String(g.id) === d.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { signedOut(); return; }
    }
  }
  if (state.dialog !== d) return;
  if (group) {
    d.group = group;
    if (!group.versions.some((v) => versionKey(v) === d.selected)) d.selected = versionKey(group.versions[0]);
  }
  // The selected version's details are re-read rather than shown stale beside the new summary.
  d.data = null;
  await loadVersion();
}

function closeDialog() {
  const dlg = $('#dlg');
  if (dlg?.open) dlg.close();
}

function inspectorHTML() {
  const d = state.dialog;
  const g = d.group;
  const n = g.versions.length;
  const v = selectedVersion(d);
  const tz = state.data?.timezone;
  const title = g.title || `Untitled · ${g.videoId || ''}`;
  const devices = groupDevices(g);
  const head = `<div class="dialog__head">
      <h2 id="dlg-title"><span class="label" style="display:block;margin-bottom:6px" aria-hidden="true">Language · this video</span><span class="vh">Language for </span>${esc(title)}</h2>
      <button type="button" class="icon-btn" data-action="close" data-key="dlg:close" aria-label="Close">${ICON.close}</button>
    </div>`;
  const foot = `<div class="dialog__foot"><span class="why">${DEMO ? 'Demo data · nothing is saved to a server' : 'Saved evidence · not a fresh YouTube lookup'}</span><button type="button" class="btn btn--sm" data-action="close" data-key="dlg:done">Done</button></div>`;
  const meta = `<p class="ins__meta">${g.channel ? `<span>${esc(g.channel)}</span>` : ''}<span class="mono">${esc(g.videoId || '')}</span><span>${esc(devices.join(', '))}</span><span data-version-count>${esc(versionsText(n))}</span><span>${esc(spent(g.seconds))} watched</span></p>`;

  // What a decision here changes, in one sentence.
  const all = d.target === 'all' || n === 1;
  const scope = all
    ? `<p class="notice notice--scope" data-scope="all"><strong>${n === 1 ? 'Applies to this video’s recorded version in this scope' : `Applies to all ${n} recorded versions in this scope`}</strong> (${esc(scopePhrase())}). Versions recorded later start from their own evidence.</p>`
    : `<p class="notice notice--scope" data-scope="one"><strong>Applies only to the selected version</strong> (${esc(v.deviceLabel || 'device')}, last played ${esc(when(v.lastWatched, tz))}). The other ${n - 1} keep their own.</p>`;
  const differ = n > 1 && all ? disagreement(g) : null;
  const conflict = differ
    ? `<p class="alert" data-conflict="${differ.from}">${differ.from === 'recorded' ? 'The collector recorded different audio for these versions' : 'These versions don’t agree on the audio'}: ${esc(differ.langs.map((l) => `${langName(l.lang)} on ${l.devices.join(' and ')}`).join('; '))}. If one of them is a dub, apply your answer to the selected version only.</p>` : '';
  const overrides = (g.devices || []).filter((x) => x?.contextOverride);
  const override = overrides.length
    ? `<p class="ev__note" data-context-override>${overrides.map((x) => `Playback on ${esc(x.label || 'this device')} counts as ${esc(x.contextOverride.context || 'foreground')} (owner correction${x.contextOverride.created ? `, ${esc(day(x.contextOverride.created, tz))}` : ''})${x.contextOverride.reason ? `: ${esc(x.contextOverride.reason)}` : '.'}`).join(' ')}</p>` : '';

  const langs = groupLangs(g);
  const a = v.assessment || {};
  const summary = n === 1
    ? `<p class="ins__big">${esc(langName(a.lang))}<code>${esc(a.lang || 'und')}</code></p>
       <p>${statusHTML(a.status)}${a.confidence != null && a.confidence !== '' ? ` <span class="why">· confidence ${esc(confText(a.confidence))}</span>` : ''}${a.source ? ` <span class="why">· ${esc(sourceWords(a.source))}</span>` : ''}</p>`
    : `<p class="ins__big">${langs.length > 1 ? 'Mixed <span class="why">versions differ</span>' : `${esc(langName(langs[0]?.lang))}<code>${esc(langs[0]?.lang || 'und')}</code>`}</p>
       <ul class="ins__langs" data-langs>${langs.map((l) => `<li><span>${esc(langName(l.lang))} <span class="mono">(${esc(l.lang)})</span></span><span class="why">${esc(statusesText(l.statuses))} · ${esc(l.versions === 1 ? '1 version' : `${l.versions} versions`)} · ${esc(spent(l.seconds))}</span></li>`).join('')}</ul>`;
  const now = `<section class="ins__section" aria-labelledby="ins-now">
      <h3 class="label" id="ins-now">Current interpretation · this video</h3>
      <div class="ins__now" data-group-assessment>
        ${summary}
        <p class="why" data-group-review>${g.needsReview ? (n === 1 ? 'Needs review.' : 'At least one version needs review.') : 'Nothing here needs review.'}</p>
      </div>
      ${formHTML(g, d)}
      ${d.alert ? alertHTML(d.alert) : ''}
    </section>`;

  return `${head}<div class="dialog__body">${meta}${scope}${conflict}${override}${now}${versionHTML(d, v)}</div>${foot}`;
}

const ACTION_WORD = { manual: 'Classified', analyze: 'Analyzed', reset: 'Reset to collector', collector: 'Collector' };

function formHTML(g, d) {
  const n = g.versions.length;
  const lang = d.form.lang ?? defaultLang(g);
  const known = [...COMMON, 'mul', 'zxx', 'und'];
  // "__other" is the select's own value for a free code; any unlisted current code also opens it.
  const isOther = lang === '__other' || !known.includes(lang);
  const otherValue = lang === '__other' ? d.form.other : isOther ? lang : d.form.other;
  const option = (c) => `<option value="${esc(c)}" ${lang === c ? 'selected' : ''}>${esc(langName(c))} (${esc(c)})</option>`;
  const busy = d.busy || d.loading;
  const all = d.target === 'all' || n === 1;
  const manual = all ? g.versions.filter((x) => x.assessment?.source === 'manual').length : 0;
  const hint = !all ? 'Saved for the selected version only; the others keep theirs.'
    : n === 1 ? 'Saved as your decision; it stays until you reset.'
      : `One decision for every version; it stays until you reset.${manual ? ` It replaces your earlier classification on ${manual === 1 ? '1 version' : `${manual} versions`}.` : ''}`;
  return `<form class="ins__form" data-form="manual" novalidate>
      <div class="ins__row">
        <div><label class="label" for="f-lang">Spoken language</label>
          <select class="select" id="f-lang" data-action="form-lang" data-key="ins:lang">
            <optgroup label="Languages">${COMMON.map(option).join('')}</optgroup>
            <optgroup label="Not one spoken language">${['mul', 'zxx', 'und'].map(option).join('')}</optgroup>
            <option value="__other" ${isOther ? 'selected' : ''}>Other code…</option>
          </select></div>
        <div ${isOther ? '' : 'hidden'}><label class="label" for="f-other">Language code</label>
          <input class="input" id="f-other" maxlength="35" spellcheck="false" autocomplete="off" placeholder="e.g. pt-BR" value="${esc(otherValue)}" data-key="ins:other"></div>
      </div>
      <div><label class="label" for="f-note">Note · why (recommended)</label>
        <textarea class="input" id="f-note" rows="2" maxlength="500" placeholder="What you heard, e.g. German dub, original is English" data-key="ins:note">${esc(d.form.note)}</textarea></div>
      ${n > 1 ? `<div><span class="label" id="f-target">Apply to</span>
        <div class="seg ins__target" role="group" aria-labelledby="f-target">
          <button type="button" aria-pressed="${d.target === 'all'}" data-action="target" data-value="all" data-key="ins:target:all">All ${n} versions</button>
          <button type="button" aria-pressed="${d.target === 'one'}" data-action="target" data-value="one" data-key="ins:target:one">Selected version only</button>
        </div></div>` : ''}
      <div class="ins__actions">
        <button type="submit" class="btn btn--primary" data-key="ins:save" ${busy ? 'disabled' : ''}>${n === 1 ? 'Save classification' : all ? `Save for all ${n} versions` : 'Save for this version'}</button>
        <button type="button" class="btn btn--quiet" data-action="reset" data-key="ins:reset" ${busy ? 'disabled' : ''}>${n > 1 && all ? `Reset all ${n} to collector` : 'Reset to collector'}</button>
      </div>
      <p class="ev__note" data-form-hint>${esc(hint)}</p>
    </form>`;
}

// The selected recorded version: its own interpretation, analysis, audit and saved evidence.
function versionHTML(d, v) {
  const g = d.group;
  const n = g.versions.length;
  const tz = state.data?.timezone;
  const index = g.versions.indexOf(v);
  const label = (x, i) => `${i === 0 ? 'Newest · ' : ''}${when(x.lastWatched, tz)} · ${x.deviceLabel || 'device'} · ${langName(x.assessment?.lang)} (${x.assessment?.lang || 'und'}), ${(STATUS_WORD[x.assessment?.status] || x.assessment?.status || '').toLowerCase()}${x.title && x.title !== g.title ? ` · “${x.title}”` : ''}`;
  const picker = versionPickerHTML(g, d.selected, label);
  const facts = `<p class="why ins__vmeta" data-version-meta>${esc(v.deviceLabel || 'Device')} · last played ${esc(when(v.lastWatched, tz))} · ${esc(spent(v.seconds))} watched · <span class="mono" title="Recorded metadata version">version ${esc(String(v.metadataId || '').slice(0, 12))}</span>${v.title && v.title !== g.title ? ` · saved title “${esc(v.title)}”` : ''}</p>`;
  let inner;
  if (!d.data) {
    inner = d.error
      ? `<div class="problem" role="alert"><p>${esc(d.error)}</p><button type="button" class="btn btn--sm" data-action="ins-retry" data-key="dlg:retry">Try again</button></div>`
      : '<p class="boot" style="padding:16px 0">Loading this version’s saved evidence…</p>';
  } else {
    inner = versionNowHTML(d);
  }
  return `<section class="ins__section" aria-labelledby="ins-ver" data-version="${esc(versionKey(v))}">
      <h3 class="label" id="ins-ver">${n > 1 ? `Recorded version · ${index + 1} of ${n}, newest first` : 'Recorded version'}</h3>
      ${picker}${facts}${inner}
    </section>${d.data ? auditHTML(d.data) + evidenceHTML(d.data) : ''}`;
}

function versionNowHTML(d) {
  const data = d.data;
  const a = data.assessment || {};
  // A manual classification (source "manual", including a manual "und") locks out automatic analysis.
  const manualLock = a.source === 'manual' || a.status === 'confirmed';
  const providers = providerList();
  const provider = providers.find((p) => p.id === d.form.provider) || providers[0];
  const external = provider.id !== 'saved-evidence';
  const busy = d.busy || d.loading;
  return `<div class="ins__now ins__now--version" data-assessment data-revision="${Number(data.revision) || 0}">
      <p><b class="ins__vlang">${esc(langName(a.lang))}</b> <code>${esc(a.lang || 'und')}</code> ${statusHTML(a.status)}${a.confidence != null && a.confidence !== '' ? ` <span class="why">· confidence ${esc(confText(a.confidence))}</span>` : ''}${a.source && a.source !== 'manual' ? ` <span class="why">· ${esc(sourceWords(a.source))}</span>` : ''}</p>
      ${a.reason ? `<p class="why">${esc(a.reason)}${a.source ? ` <span class="mono">${esc(a.source)}</span>` : ''} · revision ${Number(data.revision) || 0}</p>` : ''}
      <p class="recorded">${recordedText(data.recorded)}</p>
    </div>
    <div class="ins__form" role="group" aria-labelledby="ins-auto">
      <span class="label" id="ins-auto">Automatic · this version</span>
      <div class="ins__actions">
        ${providers.length > 1 ? `<label class="vh" for="f-provider">Analysis source</label><select class="select" id="f-provider" style="width:auto" data-action="form-provider" data-key="ins:provider">${providers.map((p) => `<option value="${esc(p.id)}" ${p.id === provider.id ? 'selected' : ''}>${esc(p.label || p.id)}</option>`).join('')}</select>` : ''}
        <button type="button" class="btn" data-action="analyze" data-key="ins:analyze" ${busy || manualLock ? 'disabled' : ''}>${external ? 'Analyze with the API' : 'Analyze saved evidence'}</button>
      </div>
      <p class="ev__note" data-provider-note>${external
        ? `Sends this version’s saved evidence (no media, no keys) to ${esc(provider.label || 'the configured analysis API')}. The answer is an estimate and needs review unless it is based on the audio.`
        : 'Uses the selected-audio language label saved with this version. If none was saved, the answer stays unknown; default audio, titles and caption lists don’t count. Nothing is listened to or transcribed. The result is an estimate.'}
        ${manualLock ? ' Disabled while your classification stands.' : ''}</p>
    </div>`;
}

function auditHTML(data) {
  const hist = Array.isArray(data.history) ? data.history : [];
  return `<section class="ins__section" aria-labelledby="ins-audit">
      <h3 class="label" id="ins-audit">History of this version · newest first</h3>
      ${hist.length ? `<ol class="audit" data-audit>${hist.map((h) => `<li>
          <span class="audit__rev">r${esc(h.revision)}</span>
          <span class="audit__what"><b>${esc(ACTION_WORD[h.action] || h.action || 'Change')}</b> · ${esc(langName(h.lang))} <span class="mono">(${esc(h.lang || 'und')})</span> · ${esc(STATUS_WORD[h.status] || h.status || '')}</span>
          <span class="audit__meta">${esc(when(h.createdAt, state.data?.timezone))}${h.source ? ` · ${esc(h.source)}` : ''}${h.confidence != null && h.confidence !== '' ? ` · ${esc(confText(h.confidence))}` : ''}${h.reason ? ` · ${esc(h.reason)}` : ''}</span>
          ${h.note ? `<span class="audit__note">“${esc(h.note)}”</span>` : ''}
        </li>`).join('')}</ol>` : '<p class="why">No changes yet: the interpretation above is this version’s starting estimate.</p>'}
      ${data.historyHasMore ? `<p class="ev__note" data-history-more>Showing the latest ${esc(data.historyLimit || hist.length)} entries. Older entries are kept on the server.</p>` : ''}
      <p class="ev__note">Every action is appended; nothing is overwritten. Reset restores the collector’s original interpretation and is recorded too.</p>
    </section>`;
}

function alertHTML(al) {
  return `<div class="alert ${al.kind === 'ok' ? 'alert--ok' : al.kind === 'bad' ? 'alert--bad' : ''}" role="${al.kind === 'ok' ? 'status' : 'alert'}" tabindex="-1" data-key="ins:alert" data-alert="${esc(al.kind)}">
      <p>${esc(al.text)}</p>
      ${al.refresh ? '<button type="button" class="btn btn--sm" data-action="ins-refresh" data-key="ins:refresh">Refresh this video</button>' : ''}
    </div>`;
}

/* Saved evidence: source values, the detector's estimate and the exact saved text. */
function evidenceHTML(data) {
  const { evidence: ev, text } = savedEvidence(data);
  if (!ev && !text) {
    return `<section class="ins__section" aria-labelledby="ins-ev"><h3 class="label" id="ins-ev">Saved evidence</h3>
      <p>${notRecorded('no source snapshot was saved with this version')}</p></section>`;
  }
  const android = ev?.collector === 'owntube-source-v1';
  const facts = (rows) => `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const lang = (c) => (c === 'und' ? '<span class="mono">und</span> <span class="why">“undetermined”, as reported</span>' : `${esc(langName(c))} <span class="mono">(${esc(c)})</span>`);
  let sources = '';
  if (ev) {
    const descAvailable = !(android && ev.descriptionAvailable === false);
    const desc = descAvailable && ev.description
      ? `<div class="ev__text" tabindex="0" role="region" aria-label="Saved description" data-description>${esc(ev.description)}</div>
         <p class="ev__note">${ev.descriptionSource && ev.descriptionSource !== 'none' ? `Source <span class="mono">${esc(ev.descriptionSource)}</span> · ` : ''}${String(ev.description).length.toLocaleString('en')} characters saved${ev.descriptionTruncated ? ' · <b>cut by the collector at 10,000 characters</b>' : ''}</p>`
      : `<p>${notRecorded(android && ev.descriptionAvailable === false ? 'the TV app didn’t expose a description' : 'no description was saved')}</p>`;
    const selected = android
      ? (ev.selectedAudioLanguage ? `${lang(ev.selectedAudioLanguage)} <span class="why">decoder label${ev.selectedAudioLanguageSource ? ` (${esc(ev.selectedAudioLanguageSource)})` : ''}, not spoken-language detection</span>` : notRecorded())
      : (ev.selectedAudioLanguage ? lang(ev.selectedAudioLanguage) : notRecorded('no selected audio language was reported'));
    const deflt = android
      ? notRecorded(ev.defaultAudioLanguageStatus === 'not-exposed-by-MediaFormat' ? 'the TV app doesn’t expose it' : '')
      : (ev.defaultAudioLanguage ? lang(ev.defaultAudioLanguage) : notRecorded('no default audio was reported'));
    const kind = (c) => (c.kind === 'asr' ? 'auto-generated' : c.kind === 'manual' ? 'manual' : 'kind not recorded');
    const captions = !Array.isArray(ev.captions) ? notRecorded()
      : ev.captions.length ? `<ul class="ev__tracks">${ev.captions.map((c) => `<li>${c.language ? lang(c.language) : notRecorded()} · ${kind(c)}</li>`).join('')}</ul>` : '<span class="why">No caption tracks listed</span>';
    const t = ev.text;
    sources = `${facts([
        ['Saved title', ev.title ? esc(ev.title) : notRecorded()],
        ['Selected audio', selected],
        ['Default audio', deflt],
        ['Caption tracks', captions + (android && ev.captionTranslationOptionsOmitted ? ` <span class="why">${esc(ev.captionTranslationOptionsOmitted)} translation options counted, not listed</span>` : '')],
        ['Text detector', t ? `${t.language ? lang(t.language) : notRecorded()}${t.confidence != null ? ` <span class="mono">${esc(confText(t.confidence))}</span>` : ''} <span class="why">· ${esc(t.engine || 'engine not recorded')} · ${esc(t.status || 'status not recorded')} · input ${esc(t.input || '—')}</span>` : notRecorded(android ? 'language analysis is not run on OwnTube TV' : '')],
        ['Algorithm', ev.algorithmVersion ? `<span class="mono">${esc(ev.algorithmVersion)}</span>` : notRecorded()],
      ])}
      ${android && ev.metadata?.mappingError ? `<p class="alert">A metadata getter failed (<span class="mono">${esc(ev.metadata.mappingError)}</span>); partial values were kept.</p>` : ''}
      <h4 class="ev__sub">Description</h4>${desc}
      <p class="ev__note">Caption tracks are what YouTube listed; caption text was not saved, so there is no transcript. A text detector reads written text, which is not the audio that played.</p>`;
  }
  let raw = '';
  if (text || ev) {
    const d = state.dialog;
    const formatted = ev ? JSON.stringify(ev, null, 2) : '';
    const mode = text ? d.raw : 'formatted';
    raw = `<details class="raw" ${d.rawOpen ? 'open' : ''} data-raw-details>
        <summary>Raw source snapshot</summary>
        ${facts([
          ['Evidence ID', data.evidenceId ? `<code class="raw__id" data-evidence-id>${esc(data.evidenceId)}</code>` : notRecorded()],
          ['Digest', text && data.evidenceId ? `<span data-digest>${digestText(data.evidenceId, text)}</span>` : notRecorded(text ? 'no evidence ID' : 'exact text not returned')],
          ['Exact text', text ? `<span class="mono">${new TextEncoder().encode(text).length.toLocaleString('en')} bytes</span>` : notRecorded('only the parsed snapshot was returned')],
        ])}
        ${text && ev ? `<div class="seg" role="group" aria-label="Snapshot text" style="margin-top:12px">
          <button type="button" aria-pressed="${mode === 'exact'}" data-action="raw" data-value="exact" data-key="raw:exact">Exact text</button>
          <button type="button" aria-pressed="${mode === 'formatted'}" data-action="raw" data-value="formatted" data-key="raw:formatted">Formatted</button></div>` : ''}
        <pre class="raw__text" tabindex="0" aria-label="${mode === 'exact' ? 'Exact saved snapshot text' : 'Snapshot re-encoded for reading'}"><code data-raw="${mode}">${esc(mode === 'exact' ? text : formatted)}</code></pre>
        <p class="ev__note">${mode === 'exact' ? 'Exactly as saved; the evidence ID is the SHA-256 of this text.' : 'Re-encoded for reading; not byte-identical to what was saved.'}</p>
      </details>`;
    if (text && data.evidenceId) checkDigest(text, data.evidenceId);
  }
  return `<section class="ins__section" aria-labelledby="ins-ev">
      <h3 class="label" id="ins-ev">Saved evidence · this version</h3>
      ${sources}${raw}
    </section>`;
}

// Re-hash the exact saved text in this browser. Results are kept per ID and exact text, and are only
// written into an inspector still showing that same snapshot (versions can be switched meanwhile).
const digests = new EvidenceDigests();
const digestText = (id, text) => ({
  match: '<span class="ok">Matches</span> <span class="why">SHA-256 recomputed in this browser</span>',
  mismatch: '<span class="bad">Does not match</span> <span class="why">the saved text differs from what this ID names; it is shown exactly as stored</span>',
  unavailable: notRecorded('can’t be checked here (needs a secure context)'),
})[digests.get(id, text)] || '<span class="why">Checking…</span>';
async function checkDigest(text, id) {
  await digests.check(id, text);
  const d = state.dialog;
  const el = $('#dlg [data-digest]');
  if (el && d?.data?.evidenceId === id && d.data.evidenceText === text) el.innerHTML = digestText(id, text);
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

/* ------------------------------------------------------------------ actions */

function readLang() {
  const sel = $('#f-lang');
  if (!sel) return null;
  if (sel.value !== '__other') return sel.value;
  return ($('#f-other')?.value || '').trim();
}

// Classify or reset every version of the video at once (one atomic request carrying each
// version's expected revision), or only the selected version. Analysis is always that version's.
async function assess(action) {
  const d = state.dialog;
  if (!d?.data || d.busy) return;
  const g = d.group;
  const n = g.versions.length;
  const v = selectedVersion(d);
  const bulk = action !== 'analyze' && (d.target === 'all' || n === 1);
  const note = ($('#f-note')?.value || '').trim();
  d.form.note = note;
  let lang = null;
  if (action === 'manual') {
    lang = readLang();
    if (!lang || !(LANG_CODE.test(lang) || SPECIAL[lang])) {
      d.alert = { kind: 'bad', text: 'Enter a language code such as de, en or pt-BR, or choose mixed, no speech or unknown.' };
      renderDialog();
      $('#f-other')?.focus();
      return;
    }
    d.form.lang = lang;
  }
  d.busy = true;
  d.alert = null;
  renderDialog();
  try {
    let text;
    if (bulk) {
      const body = { videoId: g.videoId, targets: g.versions.map((x) => ({ deviceId: x.deviceId, metadataId: x.metadataId, baseRevision: Number(x.revision) || 0 })), action };
      if (lang) body.lang = lang;
      if (note) body.note = note;
      const res = await api.assessBulk(body);
      if (state.dialog !== d) return;
      const count = Number(res?.updated) || body.targets.length;
      const what = n === 1 ? 'this video' : `all ${count} recorded versions`;
      text = action === 'manual'
        ? `Saved for ${what}: ${langName(lang)} (${lang}), ${lang === 'und' ? 'undetermined' : 'confirmed'}.`
        : `Reset ${what} to the collector’s original interpretation.`;
    } else {
      const body = { deviceId: v.deviceId, metadataId: v.metadataId, baseRevision: Number(d.data.revision) || 0, action };
      if (lang) body.lang = lang;
      if (note && action !== 'analyze') body.note = note;
      if (action === 'analyze') {
        const providers = providerList();
        body.provider = (providers.find((p) => p.id === d.form.provider) || providers[0]).id;
      }
      const res = await api.assess(body);
      if (state.dialog !== d) return;
      const a = res?.assessment || {};
      const words = { manual: 'Saved for the selected version', analyze: 'Analysis of the selected version finished', reset: 'Reset the selected version to the collector’s original interpretation' };
      text = `${words[action]}: ${langName(a.lang)} (${a.lang || 'und'}), ${STATUS_WORD[a.status] || a.status || 'updated'}. Revision ${res?.revision ?? ''}.`;
    }
    d.alert = { kind: 'ok', text };
    if (action !== 'analyze') d.form.note = '';
    d.busy = false;
    await refreshGroup();
    say(text);
    $('#dlg [data-key="ins:alert"]')?.focus();
  } catch (error) {
    if (state.dialog !== d) return;
    d.busy = false;
    if (error instanceof ApiError && error.status === 401) { signedOut('Your session ended. Sign in again.'); return; }
    if (error instanceof ApiError && error.status === 409) {
      d.alert = { kind: 'review', refresh: true, text: bulk
        ? `Nothing was saved: ${error.message} Refresh this video, check it, then decide again.`
        : `${error.message} This version may have changed since you opened it. Refresh it, check the latest interpretation, then decide again.` };
    } else {
      d.alert = { kind: 'bad', text: error.message || 'That didn’t work.' };
    }
    renderDialog();
    $('#dlg [data-key="ins:alert"]')?.focus();
  }
}

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

/* ------------------------------------------------------------------ events */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  const f = state.filters;
  switch (a) {
    case 'days': f.days = Number(el.dataset.value) || 7; f.page = 1; load(); break;
    case 'status': f.status = el.dataset.value; f.page = 1; load(); break;
    case 'language': f.language = f.language === el.dataset.lang ? 'all' : el.dataset.lang; f.page = 1; load(); break;
    case 'page': f.page = Math.max(1, Number(el.dataset.value) || 1); load({ keepPage: true }).then(() => $('#videos-h')?.scrollIntoView({ block: 'start' })); break;
    case 'clear': f.language = 'all'; f.status = 'all'; f.query = ''; f.page = 1; load(); break;
    case 'retry': load({ keepPage: true }); break;
    case 'open': openInspector(el.dataset.id, el); break;
    case 'close': closeDialog(); break;
    case 'analyze': assess('analyze'); break;
    case 'reset': assess('reset'); break;
    case 'ins-refresh': if (state.dialog) { state.dialog.alert = null; refreshGroup(); } break;
    case 'ins-retry': loadVersion(); break;
    case 'target': if (state.dialog) { state.dialog.target = el.dataset.value === 'one' ? 'one' : 'all'; state.dialog.form.note = $('#f-note')?.value ?? state.dialog.form.note; renderDialog(); } break;
    case 'raw': if (state.dialog) { state.dialog.raw = el.dataset.value; state.dialog.rawOpen = true; renderDialog(); } break;
    case 'logout': api.logout().catch(() => {}).finally(() => signedOut()); break;
    default: break;
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  const f = state.filters;
  if (t.dataset.action === 'device') { f.device = t.value; f.page = 1; load(); }
  else if (t.dataset.action === 'person') { f.person = t.value; f.page = 1; load(); }
  else if (t.dataset.action === 'language-select') { f.language = t.value; f.page = 1; load(); }
  else if (t.dataset.action === 'version' && state.dialog) {
    // Another recorded version: its own evidence and audit; the decision form keeps its values.
    const d = state.dialog;
    d.form.note = $('#f-note')?.value ?? d.form.note;
    d.selected = t.value;
    d.data = null;
    d.raw = 'exact';
    d.rawOpen = false;
    loadVersion();
  } else if (t.dataset.action === 'form-lang' && state.dialog) {
    state.dialog.form.lang = t.value;
    state.dialog.form.note = $('#f-note')?.value || '';
    renderDialog();
    if (t.value === '__other') $('#f-other')?.focus();
  } else if (t.dataset.action === 'form-provider' && state.dialog) {
    state.dialog.form.provider = t.value;
    state.dialog.form.note = $('#f-note')?.value || '';
    renderDialog();
  }
});

let queryTimer = null;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.action === 'query') {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => { state.filters.query = t.value.slice(0, 200); state.filters.page = 1; load(); }, 300);
  } else if (t.id === 'f-other' && state.dialog) {
    state.dialog.form.other = t.value;
  } else if (t.id === 'f-note' && state.dialog) {
    state.dialog.form.note = t.value;
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.dataset.form === 'login') {
    e.preventDefault();
    const key = $('#owner-key').value;
    if (!key.trim()) { state.login.error = 'Enter the owner key.'; render(); $('#owner-key')?.focus(); return; }
    state.login = { busy: true, error: '' };
    render();
    try {
      await api.login(key);
      state.auth = 'signedIn';
      state.login = { busy: false, error: '' };
      await load({ keepPage: true });
      $$('[data-heading]').find((h) => h.offsetParent)?.focus();
    } catch (error) {
      state.login = { busy: false, error: error.status === 401 ? 'That key wasn’t accepted.' : error.message };
      render();
      $('#owner-key')?.focus();
    }
  } else if (form.dataset.form === 'manual') {
    e.preventDefault();
    assess('manual');
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
  const next = readFilters();
  if (JSON.stringify(next) !== JSON.stringify(state.filters)) { state.filters = next; if (state.auth === 'signedIn') load({ keepPage: true }); }
});

boot();
