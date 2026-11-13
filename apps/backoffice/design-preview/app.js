/*
 * OwnTube backoffice — design preview behaviour.
 *
 * Vanilla JS, no build, no network except optional thumbnails for links you paste
 * (https://i.ytimg.com, referrer stripped, can be switched off in Preview settings).
 * State lives in localStorage under STORE_KEY. "Publishing" appends a revision there; no TV is
 * contacted. The model mirrors what the real backoffice would need: a draft curation document,
 * immutable numbered revisions, and a diff between the two.
 */
(() => {
  'use strict';

  const F = window.OwnTubeFixtures;
  const { MIN, HOUR, DAY } = F;
  const STORE_KEY = 'owntube.backoffice.preview.state.v1';
  const PREFS_KEY = 'owntube.backoffice.preview.prefs.v1';
  const SCHEMA = 2;

  /* ------------------------------------------------------------------ lists */

  const LISTS = {
    'suggested.videos': {
      slug: 'suggested-videos', group: 'suggested', kind: 'video', name: 'Videos', title: 'Suggested videos', ordered: true,
      lede: 'The first row on the TV home, in this order. A video you suggest is shown even when its channel is blocked.',
      empty: 'No suggested videos.', noun: 'video',
    },
    'suggested.channels': {
      slug: 'suggested-channels', group: 'suggested', kind: 'channel', name: 'Channels', title: 'Suggested channels', ordered: true,
      lede: 'A row of channels on the TV home, in this order.', empty: 'No suggested channels.', noun: 'channel',
    },
    'suggested.playlists': {
      slug: 'suggested-playlists', group: 'suggested', kind: 'playlist', name: 'Playlists', title: 'Suggested playlists', ordered: true,
      lede: 'A row of playlists on the TV home, in this order.', empty: 'No suggested playlists.', noun: 'playlist',
    },
    'blocked.videos': {
      slug: 'blocked-videos', group: 'blocked', kind: 'video', name: 'Videos', title: 'Blocked videos', ordered: false,
      lede: 'Never shown on the TV, in any row.', empty: 'No blocked videos.', noun: 'video',
    },
    'blocked.channels': {
      slug: 'blocked-channels', group: 'blocked', kind: 'channel', name: 'Channels', title: 'Blocked channels', ordered: false,
      lede: 'Nothing from these channels is shown on the TV, except videos you suggest one by one.', empty: 'No blocked channels.', noun: 'channel',
    },
  };
  const LIST_KEYS = Object.keys(LISTS);
  const KEY_BY_SLUG = Object.fromEntries(LIST_KEYS.map((k) => [LISTS[k].slug, k]));
  const suggestKey = (kind) => `suggested.${kind}s`;
  const blockKey = (kind) => `blocked.${kind}s`;

  /* ------------------------------------------------------------------ utilities */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const pad2 = (n) => String(n).padStart(2, '0');
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isSmall = () => matchMedia('(max-width: 859px)').matches;
  const isWide = () => matchMedia('(min-width: 1180px)').matches;
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const shortDayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
  const fullFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

  const LANGS = {
    de: ['DE', 'German'], en: ['EN', 'English'],
    'sr-Latn': ['SR', 'Serbian, Latin script'], 'sr-Cyrl': ['SR', 'Serbian, Cyrillic script'],
  };

  function parseDur(s) {
    if (!s) return null;
    return s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
  }
  function fmtDur(sec) {
    if (sec == null) return '';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }
  // Same rounding as the History ledger (`spentParts`), so a day total and the ledger never disagree.
  const fmtSpent = (sec) => spentParts(sec).map(([n, u]) => `${n} ${u}`).join(' ');
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);
  function ago(t, now = Date.now()) {
    const d = now - t;
    if (d < 45 * 1000) return 'just now';
    if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))} min ago`;
    const days = dayDiff(t, now);
    if (days === 0) return `${Math.round(d / HOUR)} h ago`;
    if (days === 1) return 'yesterday';
    if (days < 31) return `${days} days ago`;
    return `on ${shortDayFmt.format(t)}`;
  }
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

  /* ------------------------------------------------------------------ icons */

  const ICON = {
    plus: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    block: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.9 12.1l8.2-8.2" stroke="currentColor" stroke-width="1.6"/></svg>',
    up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.2M3.8 7.2L8 3l4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9.8M3.8 8.8L8 13l4.2-4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.4 10.4L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.2" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="12.8" cy="8" r="1.4" fill="currentColor"/></svg>',
    back: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    expand: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    list: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h8M2 7.5h8M2 11h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10.5 9.5v4.5l3.6-2.25z" fill="currentColor"/></svg>',
    mark: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.9 7.6v8.8l6.8-4.4z" fill="currentColor"/></svg>',
    external: '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  /* ------------------------------------------------------------------ storage */

  let storageOk = true;
  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      storageOk = false;
      return null;
    }
  }
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      storageOk = false;
    }
  }

  function seed() {
    const now = Date.now();
    const at = (offset) => now - offset;
    const catalog = { channels: {}, videos: {}, playlists: {} };
    for (const c of F.channels) catalog.channels[c.id] = { id: c.id, name: c.name, lang: c.lang, color: c.color, sample: true };
    for (const v of F.videos) {
      catalog.videos[v.id] = {
        id: v.id, title: v.title, channelId: v.ch, lang: v.lang, durationS: parseDur(v.dur),
        live: !!v.live, short: !!v.short, art: v.art, sample: true,
      };
    }
    for (const p of F.playlists) catalog.playlists[p.id] = { id: p.id, title: p.title, channelId: p.ch, count: p.count, cover: p.cover, sample: true };
    const entry = (e) => ({ id: e.id, note: e.note || '', at: at(e.ago) });
    const doc = (c) => ({
      suggested: { videos: c.suggested.videos.map(entry), channels: c.suggested.channels.map(entry), playlists: c.suggested.playlists.map(entry) },
      blocked: { videos: c.blocked.videos.map(entry), channels: c.blocked.channels.map(entry) },
    });
    return {
      schema: SCHEMA,
      seededAt: now,
      catalog,
      draft: doc(F.draft),
      revisions: F.revisions.map((r) => ({ n: r.n, at: at(r.ago), note: r.note, origin: 'sample', snapshot: doc(r.snapshot) })),
      feed: clone(F.feed),
      ...observations(now),
    };
  }

  // Devices, plays and searches, materialised relative to the seed time. A play keeps the evidence
  // snapshot saved with it and its own context split; total = foreground + background + unspecified.
  function observations(base) {
    const devices = F.devices.map((d) => ({ label: d.label, kind: d.kind }));
    const history = F.history.map((h, i) => {
      const dev = F.devices[h.d];
      const [fg, bg, un] = h.ctx || (dev.context ? [h.s, 0, 0] : [0, 0, h.s]);
      return {
        id: `h${i}`, at: base - h.m * MIN, videoId: h.v, device: dev.label, watchedS: h.s, coverage: h.cov,
        ctx: { fg, bg, un },
        evidenceKey: h.e || null,
        estimate: h.est ? { lang: h.est[0], conf: h.est[1], source: h.est[2] } : null,
      };
    });
    const searches = F.searches.map((s, i) => ({ id: `s${i}`, at: base - s.m * MIN, query: s.q, device: F.devices[s.d].label }));
    return { devices, history, searches };
  }

  function valid(s) {
    return s && s.schema === SCHEMA && s.catalog && s.draft && Array.isArray(s.revisions) && s.revisions.length > 0 && Array.isArray(s.feed)
      && Array.isArray(s.history) && Array.isArray(s.searches) && Array.isArray(s.devices) && s.devices.every((d) => d && d.kind);
  }

  // Schema 1 had TV-only plays and no searches. Keep the owner's draft and revisions; refresh the
  // sample observations from the same seed time so all times stay consistent.
  function migrate(s) {
    if (s && s.schema === 1 && s.catalog && s.draft && Array.isArray(s.revisions)) {
      Object.assign(s, observations(s.seededAt || Date.now()), { schema: SCHEMA });
    }
    return s;
  }

  let state = readJSON(STORE_KEY);
  const loadedSchema = state?.schema;
  state = migrate(state);
  if (!valid(state)) state = seed();
  const prefs = Object.assign({ remoteThumbs: true, theme: 'system' }, readJSON(PREFS_KEY) || {});
  const persist = () => writeJSON(STORE_KEY, state);
  const persistPrefs = () => writeJSON(PREFS_KEY, prefs);

  /* ------------------------------------------------------------------ view state */

  const ui = {
    view: 'curation',
    list: 'suggested.videos',
    pane: 'index',
    filter: {},
    sort: { 'blocked.videos': 'recent', 'blocked.channels': 'recent' },
    monitorMode: 'draft',
    showHidden: false,
    tvFocus: null,
    editing: null,
    add: { text: '', choice: 0 },
    history: { view: 'watched', q: '', sq: '', device: 'all', days: 7 },
    evidence: null, // { historyId, raw: 'exact' | 'formatted' }
    publishNote: '',
    confirmDiscard: false,
    confirmReset: false,
    item: null,
  };

  /* ------------------------------------------------------------------ model helpers */

  const cat = () => state.catalog;
  const published = () => state.revisions[state.revisions.length - 1];
  const listOf = (doc, key) => { const [g, k] = key.split('.'); return doc[g][k]; };
  const setListOf = (doc, key, arr) => { const [g, k] = key.split('.'); doc[g][k] = arr; };
  const has = (doc, key, id) => listOf(doc, key).some((e) => e.id === id);
  const entryOf = (doc, key, id) => listOf(doc, key).find((e) => e.id === id);

  function entity(kind, id) {
    const c = cat();
    return kind === 'video' ? c.videos[id] : kind === 'channel' ? c.channels[id] : c.playlists[id];
  }
  function titleOf(kind, id) {
    const e = entity(kind, id);
    if (kind === 'channel') return e?.name || e?.handle || (id.startsWith('@') ? id : `Channel ${id}`);
    if (kind === 'playlist') return e?.title || `Playlist ${id}`;
    return e?.title || `Video ${id}`;
  }
  const channelName = (id) => (id ? titleOf('channel', id) : null);

  /* Visibility of a feed video under a curation document. Specific beats general:
     a suggested video shows even if its channel is blocked; a blocked video hides even if
     its channel is suggested. Suggesting and blocking the same item is impossible by design. */
  function videoState(doc, id) {
    const v = cat().videos[id];
    const suggested = has(doc, 'suggested.videos', id);
    const blocked = has(doc, 'blocked.videos', id);
    const chBlocked = !!(v?.channelId && has(doc, 'blocked.channels', v.channelId));
    const chSuggested = !!(v?.channelId && has(doc, 'suggested.channels', v.channelId));
    let visible = true;
    let reason = null;
    if (blocked) { visible = false; reason = 'video'; }
    else if (chBlocked && !suggested) { visible = false; reason = 'channel'; }
    return { suggested, blocked, chBlocked, chSuggested, visible, reason, override: chBlocked && suggested };
  }

  /* How many slots in the sample feed a rule hides, and where a video appears. */
  function feedEffect(doc, kind, id) {
    let hidden = 0, appears = 0, shown = 0;
    for (const row of state.feed) {
      for (const vid of row.videoIds) {
        const v = cat().videos[vid];
        const match = kind === 'video' ? vid === id : v?.channelId === id;
        if (!match) continue;
        appears++;
        const st = videoState(doc, vid);
        if (st.visible) shown++;
        else if ((kind === 'video' && st.reason === 'video') || (kind === 'channel' && st.reason === 'channel')) hidden++;
      }
    }
    return { hidden, appears, shown };
  }
  const feedRowsOf = (videoId) => state.feed.filter((r) => r.videoIds.includes(videoId)).map((r) => r.title);

  /* ------------------------------------------------------------------ diff */

  // Indices of one longest increasing subsequence: items outside it are the ones that "moved".
  function lisKeep(seq) {
    const tails = [], tailIdx = [], prev = new Array(seq.length).fill(-1);
    seq.forEach((x, i) => {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < x) lo = mid + 1; else hi = mid; }
      tails[lo] = x; tailIdx[lo] = i; prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
    });
    const keep = new Set();
    for (let k = tailIdx[tails.length - 1]; k !== undefined && k >= 0; k = prev[k]) keep.add(k);
    return keep;
  }

  function diffList(key, pubArr, draftArr) {
    const pubIdx = new Map(pubArr.map((e, i) => [e.id, i]));
    const draftIdx = new Map(draftArr.map((e, i) => [e.id, i]));
    const out = [];
    const mk = (type, id, extra) => ({ key: `${key}|${type}|${id}`, list: key, type, id, ...extra });
    draftArr.forEach((e, i) => { if (!pubIdx.has(e.id)) out.push(mk('added', e.id, { to: i })); });
    pubArr.forEach((e, i) => { if (!draftIdx.has(e.id)) out.push(mk('removed', e.id, { from: i, entry: e })); });
    if (LISTS[key].ordered) {
      const common = draftArr.filter((e) => pubIdx.has(e.id)).map((e) => e.id);
      const keep = lisKeep(common.map((id) => pubIdx.get(id)));
      common.forEach((id, k) => { if (!keep.has(k)) out.push(mk('moved', id, { from: pubIdx.get(id), to: draftIdx.get(id) })); });
    }
    draftArr.forEach((e) => {
      if (!pubIdx.has(e.id)) return;
      const before = pubArr[pubIdx.get(e.id)].note || '';
      if (before !== (e.note || '')) out.push(mk('note', e.id, { before, after: e.note || '' }));
    });
    return out;
  }
  const diffAll = (draft, pub) => LIST_KEYS.flatMap((k) => diffList(k, listOf(pub, k), listOf(draft, k)));

  let D = null; // derived per render
  function derive() {
    const pub = published().snapshot;
    const changes = diffAll(state.draft, pub);
    const byRow = new Map();
    const countByList = {};
    for (const c of changes) {
      const k = `${c.list}|${c.id}`;
      if (!byRow.has(k)) byRow.set(k, []);
      byRow.get(k).push(c);
      countByList[c.list] = (countByList[c.list] || 0) + 1;
    }
    D = { pub, changes, byRow, countByList };
  }

  /* ------------------------------------------------------------------ mutations */

  const undoStack = [];

  // Insert an entry where the published revision had it (relative to its nearest surviving
  // predecessor), so re-adding something you just removed is a true no-op in the diff.
  function insertLikePublished(doc, key, entry, { front = false } = {}) {
    const arr = listOf(doc, key);
    if (arr.some((e) => e.id === entry.id)) return;
    const pubArr = listOf(published().snapshot, key);
    const pi = pubArr.findIndex((e) => e.id === entry.id);
    if (pi < 0) { if (front) arr.unshift(entry); else arr.push(entry); return; }
    const restored = clone(pubArr[pi]);
    for (let j = pi - 1; j >= 0; j--) {
      const k = arr.findIndex((e) => e.id === pubArr[j].id);
      if (k >= 0) { arr.splice(k + 1, 0, restored); return; }
    }
    arr.unshift(restored);
  }

  function commit(label, fn, { toastText, undoable = true, focus, announce } = {}) {
    const before = clone(state.draft);
    fn(state.draft);
    if (same(before, state.draft)) return false;
    if (undoable) {
      undoStack.push({ draft: before, label });
      if (undoStack.length > 60) undoStack.shift();
    }
    persist();
    render({ focus });
    if (toastText) toast(toastText, undoable ? { action: 'Undo', run: undoLast } : {});
    if (announce) say(announce);
    return true;
  }

  function undoLast() {
    const u = undoStack.pop();
    if (!u) { toast('Nothing to undo.'); return; }
    state.draft = u.draft;
    persist();
    render();
    toast(`Undone: ${u.label}.`);
  }

  function suggest(kind, id) {
    const key = suggestKey(kind);
    const wasBlocked = kind !== 'playlist' && has(state.draft, blockKey(kind), id);
    const title = titleOf(kind, id);
    return commit(`suggest ${kind}`, (d) => {
      if (kind !== 'playlist') setListOf(d, blockKey(kind), listOf(d, blockKey(kind)).filter((e) => e.id !== id));
      insertLikePublished(d, key, { id, note: '', at: Date.now() }, { front: true });
    }, { toastText: wasBlocked ? `Unblocked and suggested “${truncate(title, 60)}”.` : `Suggested “${truncate(title, 60)}”.` });
  }

  function block(kind, id) {
    const key = blockKey(kind);
    const wasSuggested = has(state.draft, suggestKey(kind), id);
    const title = titleOf(kind, id);
    let after = null;
    const ok = commit(`block ${kind}`, (d) => {
      setListOf(d, suggestKey(kind), listOf(d, suggestKey(kind)).filter((e) => e.id !== id));
      insertLikePublished(d, key, { id, note: '', at: Date.now() }, { front: true });
      after = feedEffect(d, kind, id);
    });
    if (ok) {
      const effect = after.hidden ? ` ${plural(after.hidden, 'item')} hidden in the sample feed.` : '';
      toast(`${wasSuggested ? 'Removed from suggested and blocked' : 'Blocked'} ${kind} “${truncate(title, 50)}”.${effect}`, { action: 'Undo', run: undoLast });
    }
    return ok;
  }

  function removeFrom(key, id) {
    const L = LISTS[key];
    const title = titleOf(L.kind, id);
    const verb = L.group === 'blocked' ? 'Unblocked' : 'Removed';
    return commit(L.group === 'blocked' ? `unblock ${L.kind}` : `remove ${L.kind}`, (d) => {
      setListOf(d, key, listOf(d, key).filter((e) => e.id !== id));
    }, { toastText: `${verb} “${truncate(title, 60)}”${L.group === 'blocked' ? '' : ` from ${L.title.toLowerCase()}`}.` });
  }

  function move(key, id, delta) {
    const arr = listOf(state.draft, key);
    const i = arr.findIndex((e) => e.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= arr.length) return false;
    return commit('move', (d) => {
      const a = listOf(d, key);
      const [x] = a.splice(i, 1);
      a.splice(j, 0, x);
    }, { announce: `Moved to position ${j + 1} of ${arr.length}.` });
  }

  function setNote(key, id, note) {
    const clean = note.replace(/\s+/g, ' ').trim();
    return commit('note edit', (d) => {
      const e = entryOf(d, key, id);
      if (e) e.note = clean;
    }, { toastText: clean ? 'Note saved in the draft.' : 'Note removed.' });
  }

  function applyRevert(d, c) {
    const arr = listOf(d, c.list);
    if (c.type === 'added') setListOf(d, c.list, arr.filter((e) => e.id !== c.id));
    else if (c.type === 'removed') insertLikePublished(d, c.list, clone(c.entry));
    else if (c.type === 'note') { const e = entryOf(d, c.list, c.id); if (e) e.note = c.before; }
    else if (c.type === 'moved') {
      const entry = arr.find((e) => e.id === c.id);
      setListOf(d, c.list, arr.filter((e) => e.id !== c.id));
      const a = listOf(d, c.list);
      const pubArr = listOf(published().snapshot, c.list);
      const pi = pubArr.findIndex((e) => e.id === c.id);
      for (let j = pi - 1; j >= 0; j--) {
        const k = a.findIndex((e) => e.id === pubArr[j].id);
        if (k >= 0) { a.splice(k + 1, 0, entry); return; }
      }
      a.unshift(entry);
    }
  }

  function revertChange(changeKey) {
    const c = D.changes.find((x) => x.key === changeKey);
    if (!c) return false;
    return commit('revert', (d) => applyRevert(d, c), { toastText: `Reverted: ${changeSummary(c)}.` });
  }

  function discardDraft() {
    const n = published().n;
    ui.confirmDiscard = false;
    return commit('discard draft', (d) => {
      const pub = clone(published().snapshot);
      d.suggested = pub.suggested;
      d.blocked = pub.blocked;
    }, { toastText: `Draft discarded. The draft matches revision ${n} again.` });
  }

  function restoreRevision(n) {
    const rev = state.revisions.find((r) => r.n === n);
    if (!rev) return false;
    return commit(`restore revision ${n}`, (d) => {
      const snap = clone(rev.snapshot);
      d.suggested = snap.suggested;
      d.blocked = snap.blocked;
    }, { toastText: `Draft now matches revision ${n}. Publish to make it current.` });
  }

  function publishDraft() {
    if (!D.changes.length) return;
    const n = published().n + 1;
    state.revisions.push({ n, at: Date.now(), note: ui.publishNote.trim(), origin: 'local', snapshot: clone(state.draft) });
    ui.publishNote = '';
    ui.confirmDiscard = false;
    undoStack.length = 0;
    persist();
    render({ focus: 'publish:done' });
    toast(`Revision ${n} saved in this browser (simulated). No TV was contacted.`);
  }

  function resetSample() {
    state = seed();
    undoStack.length = 0;
    ui.confirmReset = false;
    ui.filter = {};
    ui.editing = null;
    ui.add = { text: '', choice: 0 };
    ui.monitorMode = 'draft';
    persist();
    closeAllDialogs();
    render();
    toast('Sample data restored. Local edits and revisions were replaced.');
  }

  /* ------------------------------------------------------------------ change text */

  function changeSummary(c) {
    const L = LISTS[c.list];
    const t = `“${truncate(titleOf(L.kind, c.id), 48)}”`;
    if (c.type === 'added') return L.group === 'blocked' ? `blocked ${t}` : `suggested ${t}`;
    if (c.type === 'removed') return L.group === 'blocked' ? `unblocked ${t}` : `removed ${t} from suggested`;
    if (c.type === 'moved') return `${t} back to position ${c.from + 1}`;
    return `note on ${t}`;
  }

  /* Sign and tone describe the effect on the TV: teal appears, vermilion disappears. */
  function changeSign(c) {
    const L = LISTS[c.list];
    if (c.type === 'moved') return ['↕', 'move', 'Moved'];
    if (c.type === 'note') return ['✎', 'note', 'Note edited'];
    const appears = (L.group === 'suggested') === (c.type === 'added');
    return [c.type === 'added' ? '+' : '−', appears ? 'add' : 'remove', c.type === 'added' ? 'Added' : 'Removed'];
  }

  function changeLabel(c) {
    const L = LISTS[c.list];
    if (c.type === 'added') return L.group === 'blocked' ? 'Blocked in draft' : 'New in draft';
    if (c.type === 'removed') return L.group === 'blocked' ? 'Unblocked in draft' : 'Removed in draft';
    if (c.type === 'moved') return `Moved ${c.from + 1} → ${c.to + 1} in draft`;
    return 'Note edited in draft';
  }

  /* ------------------------------------------------------------------ artwork */

  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

  function drawArt(art) {
    const c = art.c;
    let s = '';
    switch (art.m) {
      case 'rails': {
        const [sky, snow, pine, rail] = c;
        s += `<rect width="160" height="90" fill="${sky}"/>`;
        s += `<path d="M0 44 L18 36 L30 41 L46 30 L62 40 L78 33 L96 42 L112 31 L130 39 L146 34 L160 38 V56 H0Z" fill="${pine}" opacity=".45"/>`;
        for (let x = -4, i = 0; x < 164; x += 9, i++) {
          const h = 7 + ((i * 7) % 5);
          s += `<path d="M${x} 54 L${x + 4.5} ${54 - h} L${x + 9} 54Z" fill="${pine}"/>`;
        }
        s += `<rect y="53" width="160" height="37" fill="${snow}"/>`;
        s += `<path d="M66 90 L78.5 53 L83.5 53 L100 90Z" fill="${rail}" opacity=".2"/>`;
        for (const y of [56, 60, 65, 71, 78, 87]) {
          const t = (y - 53) / 37;
          s += `<path d="M${(77 - 9 * t).toFixed(1)} ${y} H${(85 + 13 * t).toFixed(1)}" stroke="${rail}" stroke-width="${(0.6 + 1.7 * t).toFixed(2)}" opacity=".75"/>`;
        }
        s += `<path d="M79 53 L70 90 M83 53 L96 90" stroke="${rail}" stroke-width="1.3" fill="none"/>`;
        break;
      }
      case 'waves': {
        const [sky, w1, w2, sun] = c;
        const wave = (y, a, fill, op = 1) => `<path d="M0 ${y} Q20 ${y - a} 40 ${y} T80 ${y} T120 ${y} T160 ${y} V90 H0Z" fill="${fill}" opacity="${op}"/>`;
        s += `<rect width="160" height="90" fill="${sky}"/><circle cx="118" cy="30" r="11" fill="${sun}"/>`;
        s += wave(48, 4, w2) + wave(58, 4, w1) + wave(68, 3.5, w2, 0.9) + wave(79, 3, w1);
        for (const [y, w] of [[54, 16], [60, 11], [66, 7]]) s += `<path d="M${118 - w / 2} ${y} h${w}" stroke="${sun}" stroke-width="1.2" opacity=".55"/>`;
        break;
      }
      case 'peaks': {
        const [sky, rock, snow, sun] = c;
        s += `<rect width="160" height="90" fill="${sky}"/><circle cx="36" cy="26" r="9" fill="${sun}"/>`;
        s += `<path d="M0 70 L30 46 L52 60 L84 32 L112 56 L136 40 L160 54 V90 H0Z" fill="${rock}" opacity=".5"/>`;
        s += `<path d="M0 90 L44 40 L70 66 L100 28 L160 90Z" fill="${rock}"/>`;
        s += `<path d="M44 40 L37 49 L43 47 L47 51 L51 46Z M100 28 L90 41 L97 38 L102 43 L108 37Z" fill="${snow}"/>`;
        break;
      }
      case 'bench': {
        const [bg, w1, w2, steel] = c;
        s += `<rect width="160" height="90" fill="${bg}"/>`;
        for (let x = 10; x < 160; x += 12) for (let y = 10; y < 40; y += 12) s += `<circle cx="${x}" cy="${y}" r=".9" fill="${steel}" opacity=".35"/>`;
        s += `<rect y="64" width="160" height="6" fill="${w1}"/><rect y="70" width="160" height="20" fill="${w2}"/>`;
        s += `<rect x="18" y="38" width="26" height="26" fill="${steel}"/><rect x="18" y="56" width="98" height="8" fill="${steel}" opacity=".8"/>`;
        s += `<circle cx="52" cy="47" r="9" fill="${w1}"/><circle cx="52" cy="47" r="3" fill="${bg}"/>`;
        s += `<rect x="60" y="44" width="38" height="6" fill="${w1}"/><rect x="100" y="40" width="14" height="16" fill="${steel}"/>`;
        break;
      }
      case 'bowl': {
        const [table, bowl, food, steam] = c;
        s += `<rect width="160" height="90" fill="${table}"/><rect y="70" width="160" height="20" fill="${steam}" opacity=".12"/>`;
        s += `<path d="M34 54 A46 30 0 0 0 126 54Z" fill="${bowl}"/>`;
        s += `<ellipse cx="80" cy="54" rx="46" ry="10" fill="${bowl}"/><ellipse cx="80" cy="54" rx="41" ry="7.5" fill="${food}"/>`;
        s += `<path d="M66 40 q-5 -7 0 -14 q5 -7 0 -12 M80 38 q-5 -7 0 -14 q5 -7 0 -12 M94 40 q-5 -7 0 -14 q5 -7 0 -12" stroke="${steam}" stroke-width="1.8" fill="none" stroke-linecap="round" opacity=".8"/>`;
        break;
      }
      case 'rings': {
        const [bg, disc, groove, label] = c;
        s += `<rect width="160" height="90" fill="${bg}"/><circle cx="102" cy="45" r="40" fill="${disc}"/>`;
        for (const r of [35, 30, 25, 20]) s += `<circle cx="102" cy="45" r="${r}" fill="none" stroke="${groove}" stroke-width=".6"/>`;
        s += `<circle cx="102" cy="45" r="11" fill="${label}"/><circle cx="102" cy="45" r="1.6" fill="${bg}"/>`;
        s += `<path d="M152 9 L146 14 L124 38" stroke="${groove}" stroke-width="2.4" stroke-linecap="round" fill="none"/><circle cx="152" cy="9" r="4" fill="${groove}"/>`;
        s += `<path d="M20 70 V24 M26 70 V30 M32 70 V20" stroke="${label}" stroke-width="1.4" opacity=".55"/>`;
        break;
      }
      case 'grid': {
        const [facade, win, lit, shade] = c;
        s += `<rect width="160" height="90" fill="${facade}"/>`;
        for (let r = 0; r < 4; r++) {
          for (let k = 0; k < 7; k++) {
            const on = (r * 7 + k * 3 + c.length) % 6 === 0;
            s += `<rect x="${8 + k * 21}" y="${8 + r * 20}" width="13" height="12" fill="${on ? lit : win}"/>`;
          }
        }
        s += `<path d="M0 0 H74 L34 90 H0Z" fill="${shade}" opacity=".38"/>`;
        break;
      }
      case 'map': {
        const [sea, land, land2, border] = c;
        s += `<rect width="160" height="90" fill="${sea}"/>`;
        s += `<path d="M0 30 H160 M0 60 H160 M40 0 V90 M80 0 V90 M120 0 V90" stroke="#fff" stroke-width=".4" opacity=".25"/>`;
        s += `<path d="M0 18 C22 10 40 30 64 22 S108 6 160 20 V90 H0Z" fill="${land}"/>`;
        s += `<path d="M0 60 C26 50 52 66 80 56 S130 46 160 58 V90 H0Z" fill="${land2}"/>`;
        s += `<path d="M70 18 C76 36 66 52 84 70 S98 84 104 90" stroke="${border}" stroke-width="1.5" stroke-dasharray="3 2.2" fill="none"/>`;
        break;
      }
      case 'face': {
        const [bg, skin, dark, mark] = c;
        s += `<rect width="160" height="90" fill="${bg}"/>`;
        s += `<path d="M18 90 C22 68 86 68 90 90Z" fill="${dark}"/><circle cx="54" cy="44" r="22" fill="${skin}"/>`;
        s += `<path d="M32 40 C33 18 75 16 76 40 C70 29 40 29 32 40Z" fill="${dark}"/>`;
        s += `<circle cx="46" cy="42" r="2.6" fill="${dark}"/><circle cx="62" cy="42" r="2.6" fill="${dark}"/>`;
        s += `<path d="M40 34 L50 32 M58 32 L68 34" stroke="${dark}" stroke-width="2" stroke-linecap="round"/>`;
        s += `<ellipse cx="54" cy="55" rx="6" ry="7.5" fill="${dark}"/>`;
        s += `<circle cx="124" cy="36" r="17" fill="none" stroke="${mark}" stroke-width="4"/>`;
        s += `<path d="M98 80 L113 60" stroke="${mark}" stroke-width="6" stroke-linecap="round"/><path d="M106 53 L121 52 L116 66Z" fill="${mark}"/>`;
        break;
      }
      case 'type': {
        const [bg, fg, stroke] = c;
        const t = art.t || '!';
        const size = t.length <= 2 ? 56 : t.length === 3 ? 48 : t.length === 4 ? 42 : t.length <= 6 ? 34 : 28;
        s += `<rect width="160" height="90" fill="${bg}"/>`;
        s += `<path d="M-10 90 L60 0 H84 L14 90Z M90 90 L160 0 V30 L114 90Z" fill="${stroke}" opacity=".14"/>`;
        s += `<text x="80" y="${(45 + size * 0.36).toFixed(1)}" text-anchor="middle" font-family="Impact, Haettenschweiler, 'Arial Narrow Bold', 'Helvetica Neue', Arial, sans-serif" font-weight="900" font-size="${size}" fill="${fg}" stroke="${stroke}" stroke-width="3.2" stroke-linejoin="round" paint-order="stroke">${esc(t)}</text>`;
        break;
      }
      default:
        s += `<rect width="160" height="90" fill="#888"/>`;
    }
    return `<svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${s}</svg>`;
  }

  // Placeholder for anything without sample art: pasted links, deleted or private videos.
  function pendingArt(id, tv) {
    const bg = tv ? '#18232d' : '#dcdcd6', line = tv ? '#22303b' : '#cfcfc8', ink = tv ? '#93a3ae' : '#5b5e59';
    let s = `<rect width="160" height="90" fill="${bg}"/>`;
    for (let x = -90; x < 170; x += 9) s += `<path d="M${x} 90 L${x + 90} 0" stroke="${line}" stroke-width="1"/>`;
    s += `<rect x="30" y="35" width="100" height="22" fill="${bg}"/>`;
    s += `<text x="80" y="47.5" text-anchor="middle" font-family="'PT Mono', Menlo, monospace" font-size="9" fill="${ink}">${esc(truncate(id, 18))}</text>`;
    s += `<text x="80" y="55" text-anchor="middle" font-family="'PT Mono', Menlo, monospace" font-size="5.2" letter-spacing=".6" fill="${ink}">NOT LOOKED UP</text>`;
    return `<svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${s}</svg>`;
  }

  const realVideo = (v) => v && !v.sample && /^[A-Za-z0-9_-]{11}$/.test(v.id);

  function videoArt(id, { tv = false, badge = true, progress = null } = {}) {
    const v = cat().videos[id];
    let inner = v?.art ? drawArt(v.art) : pendingArt(id, tv);
    if (realVideo(v) && prefs.remoteThumbs) {
      inner += `<img src="https://i.ytimg.com/vi/${esc(id)}/mqdefault.jpg" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-thumb>`;
    }
    let extra = '';
    if (badge && v) {
      if (v.live) extra += '<span class="art__badge art__badge--live">LIVE</span>';
      else if (v.durationS != null) extra += `<span class="art__badge">${v.short ? 'SHORT · ' : ''}${fmtDur(v.durationS)}</span>`;
    }
    if (progress != null) extra += `<span class="hrow__progress"><span style="width:${Math.round(progress * 100)}%"></span></span>`;
    return `<span class="art">${inner}${extra}</span>`;
  }

  function initials(name) {
    const stop = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'und', 'im', 'am', 'kod', 'i', 'de', 'la']);
    const words = name.split(/\s+/).filter((w) => /^\p{L}/u.test(w) && !stop.has(w.toLowerCase()));
    if (!words.length) return name.replace(/^@/, '').slice(0, 2).toUpperCase();
    const first = words[0][0];
    const last = words.length > 1 ? words[words.length - 1][0] : (words[0][1] || '');
    return (first + last).toUpperCase();
  }
  function textOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.3 ? '#141414' : '#ffffff';
  }
  function avatar(id) {
    const ch = cat().channels[id];
    if (!ch || ch.pending) return `<span class="avatar avatar--pending" aria-hidden="true">${ch?.handle ? '@' : '?'}</span>`;
    return `<span class="avatar" aria-hidden="true" style="background:${ch.color};color:${textOn(ch.color)}">${esc(initials(ch.name))}</span>`;
  }
  function playlistArt(id, { tv = false } = {}) {
    const p = cat().playlists[id];
    const cover = p?.cover ? cat().videos[p.cover] : null;
    const inner = cover?.art ? drawArt(cover.art) : pendingArt(id, tv);
    const count = p?.count != null ? `<span class="art__count">${ICON.list}<span>${p.count}</span><span>videos</span></span>` : `<span class="art__count">${ICON.list}<span>?</span></span>`;
    return `<span class="art art--stack">${inner}${count}</span>`;
  }
  function media(kind, id, opts) {
    if (kind === 'video') return videoArt(id, opts);
    if (kind === 'channel') return avatar(id);
    return playlistArt(id, opts);
  }

  /* ------------------------------------------------------------------ routing */

  function applyRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    const [view, sub] = h.split('/');
    if (view === 'history') { ui.view = 'history'; ui.history.view = sub === 'searches' ? 'searches' : 'watched'; }
    else if (view === 'tv') ui.view = isWide() ? 'curation' : 'tv';
    else {
      ui.view = 'curation';
      if (sub && KEY_BY_SLUG[sub]) { ui.list = KEY_BY_SLUG[sub]; ui.pane = 'list'; } else ui.pane = 'index';
    }
    ui.editing = null;
  }
  const listHref = (key) => `#/curation/${LISTS[key].slug}`;

  /* ------------------------------------------------------------------ render: shell */

  function render({ focus } = {}) {
    derive();
    preserve(() => {
      document.body.dataset.view = ui.view;
      document.body.dataset.pane = ui.pane;
      renderProto();
      renderNav();
      renderStatus();
      const main = $('#main');
      main.classList.toggle('ws--history', ui.view === 'history');
      if (ui.view === 'history') {
        renderHistoryFilters();
        renderHistory();
        $('#col-monitor').hidden = true;
      } else {
        $('#col-monitor').hidden = false;
        renderIndex();
        renderList();
        renderMonitor();
      }
      renderDraftbar();
      if ($('#dlg-publish').open) renderPublish();
      if ($('#dlg-item').open) renderItem();
      if ($('#dlg-tv').open) renderTvDialog();
      if ($('#dlg-about').open) renderAbout();
      if ($('#dlg-evidence').open) renderEvidence();
    }, focus);
  }

  // Keep focus, caret and scroll positions across re-renders.
  function preserve(fn, focusKey) {
    const a = document.activeElement;
    const key = focusKey || a?.getAttribute?.('data-key');
    const sel = a && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    const scrolls = $$('[data-scroll-key]').map((el) => [el.dataset.scrollKey, el.scrollLeft, el.scrollTop]);
    fn();
    for (const [k, l, t] of scrolls) {
      const el = $(`[data-scroll-key="${CSS.escape(k)}"]`);
      if (el) { el.scrollLeft = l; el.scrollTop = t; }
    }
    if (key) {
      let el = $(`[data-key="${CSS.escape(key)}"]`);
      // The exact control can disappear (e.g. "Suggest" became a mark). Fall back to a sibling
      // control of the same row or panel, which shares the key prefix.
      if (!el || el.disabled) {
        const prefix = key.slice(0, key.lastIndexOf(':') + 1);
        if (prefix) el = $$(`[data-key^="${CSS.escape(prefix)}"]`).find((x) => !x.disabled) || null;
      }
      if (el && el !== document.activeElement) {
        el.focus({ preventScroll: true });
        if (sel && !focusKey && el.dataset.key === key && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } }
      }
    }
  }

  function renderProto() {
    const msg = $('#proto-msg');
    const actions = $('#proto-actions');
    if (ui.confirmReset) {
      msg.innerHTML = '<b>Reset the sample?</b> Your local edits and locally published revisions in this preview will be replaced.';
      actions.innerHTML = '<button type="button" class="proto__btn" data-action="reset-confirm" data-key="proto:reset-confirm">Reset</button><button type="button" class="proto__btn" data-action="reset-cancel">Keep my edits</button>';
      return;
    }
    const storageNote = storageOk ? '' : ' <b>Browser storage is unavailable: edits will be lost on reload.</b>';
    msg.innerHTML = `<span class="proto__long"><b>Local design prototype.</b> Sample data. Edits and “published” revisions stay in this browser. Nothing is sent to a TV or a server.</span><span class="proto__short"><b>Local prototype.</b> Sample data; nothing leaves this browser.</span>${storageNote}`;
    actions.innerHTML = '<button type="button" class="proto__btn" data-action="open-about" data-key="proto:about">Preview settings</button><button type="button" class="proto__btn" data-action="reset" data-key="proto:reset">Reset sample</button>';
  }

  function renderNav() {
    for (const a of $$('#nav [data-nav]')) {
      const v = a.dataset.nav;
      const current = v === ui.view || (v === 'curation' && ui.view === 'tv' && isWide());
      if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      if (v === 'curation') a.href = isSmall() ? '#/curation' : listHref(ui.list);
    }
  }

  function renderStatus() {
    const n = D.changes.length;
    const pub = published();
    const el = $('#mast-status');
    if (n) {
      el.innerHTML = `<span class="status status--draft"><span>Draft · <span class="mono">${n}</span> ${n === 1 ? 'change' : 'changes'}</span></span>
        <button type="button" class="btn btn--primary" data-action="open-publish" data-key="mast:publish">Review &amp; publish</button>`;
    } else {
      el.innerHTML = `<span class="status">Published <span class="mono">r${pub.n}</span><span class="status__time">· ${esc(ago(pub.at))}</span></span>
        <button type="button" class="btn btn--sm" data-action="open-publish" data-key="mast:revisions">Revisions</button>`;
    }
  }

  function renderDraftbar() {
    const n = D.changes.length;
    const bar = $('#draftbar');
    bar.hidden = !n;
    if (n) bar.innerHTML = `<span class="status status--draft">${plural(n, 'unpublished change')}</span><button type="button" class="btn btn--primary" data-action="open-publish" data-key="draftbar:publish">Review</button>`;
  }

  /* ------------------------------------------------------------------ render: index column */

  function renderIndex() {
    const col = $('#col-index');
    const group = (g, label, glyph) => {
      const keys = LIST_KEYS.filter((k) => LISTS[k].group === g);
      const items = keys.map((k) => {
        const L = LISTS[k];
        const count = listOf(state.draft, k).length;
        const ch = D.countByList[k] || 0;
        const current = ui.view === 'curation' && ui.list === k && (!isSmall() || ui.pane === 'list');
        return `<li><a class="lists__item ${ch ? 'lists__item--changed' : ''}" href="${listHref(k)}" ${current ? 'aria-current="page"' : ''} data-key="index:${k}" ${ch ? `title="${plural(ch, 'unpublished change')}"` : ''}>
          <span class="lists__name">${L.name}</span>
          <span class="lists__count"><span class="vh">, </span>${count}<span class="vh"> ${count === 1 ? 'item' : 'items'}${ch ? `, ${plural(ch, 'unpublished change')}` : ''}</span></span>
        </a></li>`;
      }).join('');
      return `<div class="lists__group"><h2 class="lists__heading lists__heading--${g === 'suggested' ? 'suggest' : 'block'} label">${glyph}${label}</h2><ul>${items}</ul></div>`;
    };
    col.innerHTML = `
      <section class="add" aria-labelledby="add-h">
        <div class="add__head"><h2 class="label" id="add-h">Add by link</h2><kbd aria-hidden="true" title="Shortcut">A</kbd></div>
        <label class="vh" for="add-input">YouTube link, video ID, channel ID or @handle</label>
        <input class="input" id="add-input" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
          placeholder="Paste a YouTube link" value="${esc(ui.add.text)}" data-key="add:input" aria-describedby="add-out">
        <div class="add__out" id="add-out">${addOutput()}</div>
      </section>
      <nav aria-label="Curation lists">
        ${group('suggested', 'Suggested', ICON.plus)}
        ${group('blocked', 'Blocked', ICON.block)}
      </nav>
      <div class="index__foot">
        <p>The TV applies the latest <em>published</em> revision. Everything here edits the draft until you publish.</p>
      </div>`;
  }

  /* Accepts watch, youtu.be, shorts, live, embed, channel, @handle, /c/, /user/ and playlist links, or bare IDs. */
  function parseLink(raw) {
    const s = raw.trim();
    if (!s) return { empty: true };
    const VID = /^[A-Za-z0-9_-]{11}$/;
    const CH = /^UC[A-Za-z0-9_-]{22}$/;
    const PL = /^(PL|UU|LL|FL|OL)[A-Za-z0-9_-]{10,}$/;
    const HANDLE = /^@[\p{L}\p{N}._-]{3,30}$/u;
    if (HANDLE.test(s)) return { candidates: [{ kind: 'channel', id: s.toLowerCase(), handle: s }] };
    if (CH.test(s)) return { candidates: [{ kind: 'channel', id: s }] };
    if (PL.test(s)) return { candidates: [{ kind: 'playlist', id: s }] };
    if (VID.test(s)) return { candidates: [{ kind: 'video', id: s }] };
    let url;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return { error: 'unknown' }; }
    const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    const decode = (p) => { try { return decodeURIComponent(p); } catch { return p; } };
    const parts = url.pathname.split('/').filter(Boolean).map(decode);
    const out = [];
    let mix = false;
    if (host === 'youtu.be') {
      if (VID.test(parts[0] || '')) out.push({ kind: 'video', id: parts[0] });
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = url.searchParams.get('v');
      const list = url.searchParams.get('list');
      if (parts[0] === 'watch' && v && VID.test(v)) out.push({ kind: 'video', id: v });
      if (['shorts', 'live', 'embed', 'v'].includes(parts[0]) && VID.test(parts[1] || '')) out.push({ kind: 'video', id: parts[1] });
      if (parts[0] === 'channel' && CH.test(parts[1] || '')) out.push({ kind: 'channel', id: parts[1] });
      if (parts[0] && HANDLE.test(parts[0])) out.push({ kind: 'channel', id: parts[0].toLowerCase(), handle: parts[0] });
      if ((parts[0] === 'c' || parts[0] === 'user') && /^[\p{L}\p{N}._-]{1,100}$/u.test(parts[1] || '')) out.push({ kind: 'channel', id: `${parts[0]}/${parts[1]}`, handle: `${parts[0]}/${parts[1]}` });
      if (list) {
        if (/^RD/.test(list)) mix = true;
        else if (/^[A-Za-z0-9_-]{10,}$/.test(list)) out.push({ kind: 'playlist', id: list });
      }
    } else {
      return { error: 'host' };
    }
    if (!out.length) return { error: mix ? 'mix' : 'unknown' };
    return { candidates: out, mix };
  }

  function whereIs(kind, id) {
    for (const key of [suggestKey(kind), kind === 'playlist' ? null : blockKey(kind)]) {
      if (!key) continue;
      const i = listOf(state.draft, key).findIndex((e) => e.id === id);
      if (i >= 0) return { key, index: i };
    }
    return null;
  }

  function addOutput() {
    const p = parseLink(ui.add.text);
    if (p.empty) return '<p class="add__hint">A video, channel or playlist link, a video ID, or an @handle. Suggest it or block it.</p>';
    if (p.error) {
      const msg = p.error === 'mix'
        ? 'That is a YouTube Mix. Mixes are generated per viewer, so they can’t be suggested. Use a video or playlist link.'
        : p.error === 'host' ? 'Only youtube.com and youtu.be links are recognised.' : 'That isn’t a YouTube video, channel or playlist link.';
      return `<p class="add__error">${ICON.block}<span>${msg}</span></p>`;
    }
    const cands = p.candidates;
    const choice = Math.min(ui.add.choice, cands.length - 1);
    const c = cands[choice];
    const kindLabel = { video: 'Video', channel: 'Channel', playlist: 'Playlist' };
    const choices = cands.length > 1
      ? `<fieldset class="add__choices" style="border:0;padding:0;margin:0"><legend class="vh">This link points to more than one thing</legend>${cands.map((x, i) => `
          <label><input type="radio" name="add-choice" value="${i}" ${i === choice ? 'checked' : ''} data-action="add-choice" data-key="add:choice:${i}"> ${kindLabel[x.kind]} <span class="mono">${esc(x.handle || x.id)}</span></label>`).join('')}</fieldset>`
      : `<p class="add__what"><span class="label">${kindLabel[c.kind]}</span><span class="mono">${esc(c.handle || c.id)}</span></p>`;
    const at = whereIs(c.kind, c.id);
    let known = '';
    if (at) {
      const L = LISTS[at.key];
      known = `<p class="add__known">Already in <a href="${listHref(at.key)}">${L.title.toLowerCase()}</a>${L.ordered ? `, position ${at.index + 1}` : ''}.</p>`;
    }
    const inSuggested = at?.key === suggestKey(c.kind);
    const inBlocked = at && at.key === blockKey(c.kind);
    const suggestBtn = `<button type="button" class="btn btn--sm btn--suggest" data-action="add-commit" data-verb="suggest" data-key="add:suggest" ${inSuggested ? 'disabled' : ''}>${ICON.plus}${inBlocked ? 'Unblock & suggest' : 'Suggest'}</button>`;
    const blockBtn = c.kind === 'playlist' ? '' : `<button type="button" class="btn btn--sm btn--block" data-action="add-commit" data-verb="block" data-key="add:block" ${inBlocked ? 'disabled' : ''}>${ICON.block}${inSuggested ? 'Block instead' : 'Block'}</button>`;
    const lookup = entity(c.kind, c.id)?.sample
      ? ''
      : '<p class="add__note">The real backoffice looks up the title and channel on the server. This preview keeps only the ID. New suggestions go first in their row.</p>';
    const playlistNote = c.kind === 'playlist' ? '<p class="add__note">Playlists can be suggested, not blocked.</p>' : '';
    return `<div class="add__found">${choices}${known}<div class="add__buttons">${suggestBtn}${blockBtn}</div>${playlistNote}${lookup}</div>`;
  }

  function addCommit(verb) {
    const p = parseLink(ui.add.text);
    if (!p.candidates) return;
    const c = p.candidates[Math.min(ui.add.choice, p.candidates.length - 1)];
    const C = cat();
    if (c.kind === 'video' && !C.videos[c.id]) C.videos[c.id] = { id: c.id, title: null, channelId: null, lang: null, durationS: null, pending: true, sample: false };
    if (c.kind === 'channel' && !C.channels[c.id]) C.channels[c.id] = { id: c.id, name: null, handle: c.handle || null, pending: true, sample: false };
    if (c.kind === 'playlist' && !C.playlists[c.id]) C.playlists[c.id] = { id: c.id, title: null, channelId: null, count: null, pending: true, sample: false };
    const target = verb === 'block' ? blockKey(c.kind) : suggestKey(c.kind);
    const ok = verb === 'block' ? block(c.kind, c.id) : suggest(c.kind, c.id);
    if (!ok) return;
    ui.add = { text: '', choice: 0 };
    if (!isSmall()) {
      ui.list = target;
      if (location.hash !== listHref(target)) history.replaceState(null, '', listHref(target));
      $('#col-list').scrollTop = 0;
    }
    render({ focus: 'add:input' });
  }

  function updateAddOutput() {
    const out = $('#add-out');
    if (out) out.innerHTML = addOutput();
  }

  /* ------------------------------------------------------------------ render: list column */

  function renderList() {
    const key = ui.list;
    const L = LISTS[key];
    const col = $('#col-list');
    const count = listOf(state.draft, key).length;
    const q = ui.filter[key] || '';
    const sort = L.ordered
      ? `<span class="label" title="Order on the TV">TV order</span>`
      : `<label class="vh" for="sort">Sort</label><select class="select" id="sort" data-action="sort" data-key="list:sort">
          <option value="recent" ${ui.sort[key] === 'recent' ? 'selected' : ''}>Recently blocked</option>
          <option value="name" ${ui.sort[key] === 'name' ? 'selected' : ''}>Name</option></select>`;
    col.innerHTML = `
      <div class="list">
        <a class="btn btn--quiet list__back" href="#/curation">${ICON.back}All lists</a>
        <h1 class="list__title" id="list-title" tabindex="-1" data-key="list:title">${L.title}</h1>
        <p class="list__lede">${L.lede}</p>
        <div class="toolbar">
          <div class="search">${ICON.search}
            <label class="vh" for="filter">Filter ${L.title.toLowerCase()}</label>
            <input class="input" id="filter" type="search" autocomplete="off" spellcheck="false" placeholder="Filter ${plural(count, L.noun)}"
              value="${esc(q)}" data-action="filter" data-key="list:filter">
          </div>
          <div class="toolbar__right">${sort}</div>
          ${L.ordered && q ? '<p class="toolbar__note">Reordering is paused while filtering.</p>' : ''}
        </div>
        <div id="rows">${rowsHTML()}</div>
      </div>`;
  }

  function matches(kind, id, entry, q) {
    if (!q) return true;
    const e = entity(kind, id);
    const hay = [titleOf(kind, id), id, entry?.note, e?.channelId ? channelName(e.channelId) : '', e?.handle].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }

  function rowsHTML() {
    const key = ui.list;
    const L = LISTS[key];
    const draftArr = listOf(state.draft, key);
    const q = (ui.filter[key] || '').trim();
    const removed = D.changes.filter((c) => c.list === key && c.type === 'removed');

    // Display order: draft order with removed ("ghost") rows placed where they were.
    let rows = draftArr.map((e, i) => ({ e, pos: i + 1, ghost: false }));
    if (L.ordered) {
      const pubArr = listOf(D.pub, key);
      for (const c of removed.slice().sort((a, b) => a.from - b.from)) {
        let at = 0;
        for (let j = c.from - 1; j >= 0; j--) {
          const k = rows.findIndex((r) => r.e.id === pubArr[j].id);
          if (k >= 0) { at = k + 1; break; }
        }
        rows.splice(at, 0, { e: c.entry, pos: null, ghost: true, change: c });
      }
    } else {
      rows = rows.concat(removed.map((c) => ({ e: c.entry, pos: null, ghost: true, change: c })));
      const by = ui.sort[key];
      rows.sort((a, b) => (by === 'name' ? collator.compare(titleOf(L.kind, a.e.id), titleOf(L.kind, b.e.id)) : b.e.at - a.e.at));
    }
    const total = rows.length;
    rows = rows.filter((r) => matches(L.kind, r.e.id, r.e, q));

    if (!total) {
      const hint = L.group === 'suggested'
        ? `Paste a ${L.noun} link in <b>Add by link</b> or suggest one from the TV preview.`
        : `Block a ${L.noun} from <b>Add by link</b>, the TV preview, or History.`;
      return `<div class="empty"><p class="empty__title">${L.empty}</p><p class="empty__hint">${hint}</p></div>`;
    }
    if (!rows.length) return `<p class="filter-empty">Nothing matches “${esc(q)}”. <button type="button" class="link-btn" data-action="clear-filter">Clear filter</button></p>`;

    const tag = L.ordered ? 'ol' : 'ul';
    const cls = ['rows', L.group === 'blocked' ? 'rows--blocked' : '', L.kind === 'channel' ? 'rows--channels' : '', L.ordered ? '' : 'rows--unordered'].join(' ');
    return `<${tag} class="${cls}" aria-labelledby="list-title">${rows.map((r) => rowHTML(key, r, draftArr.length, !!q)).join('')}</${tag}>`;
  }

  function rowHTML(key, r, len, filtering) {
    const L = LISTS[key];
    const { e, pos, ghost } = r;
    const kind = L.kind;
    const ent = entity(kind, e.id);
    const changes = ghost ? [r.change] : D.byRow.get(`${key}|${e.id}`) || [];
    const title = titleOf(kind, e.id);
    const lang = ent?.lang ? LANGS[ent.lang] : null;
    const rowKey = `row:${key}:${e.id}`;

    const meta = [];
    if (kind !== 'channel' && ent?.channelId) meta.push(`<span>${esc(channelName(ent.channelId))}</span>`);
    if (ent?.pending) meta.push('<span class="effect effect--wrap">Details not looked up in this preview</span>');
    if (lang) meta.push(`<span class="lang" title="${lang[1]}">${lang[0]}</span>`);
    if (kind === 'playlist' && ent?.count != null) meta.push(`<span>${plural(ent.count, 'video')}</span>`);
    // Blocked lists sort by recency, so the date earns its place; for suggestions it lives in the item dialog.
    if (L.group === 'blocked') meta.push(`<span>Blocked ${esc(ago(e.at))}</span>`);
    if (!ghost && L.group === 'blocked') {
      const fx = feedEffect(state.draft, kind, e.id);
      meta.push(fx.hidden ? `<span class="effect">Hides <strong>${fx.hidden}</strong> in sample feed</span>` : '<span class="effect">Not in sample feed</span>');
    }
    if (!ghost && key === 'suggested.channels') {
      const fx = feedEffect(state.draft, 'channel', e.id);
      if (fx.appears) meta.push(`<span class="effect">${plural(fx.shown, 'video')} in sample feed</span>`);
    }

    let override = '';
    if (!ghost && key === 'suggested.videos' && ent?.channelId && has(state.draft, 'blocked.channels', ent.channelId)) {
      override = `<p class="row__override">${ICON.plus}<span>Shown although ${esc(channelName(ent.channelId))} is blocked. Suggestions win.</span></p>`;
    }
    if (!ghost && key === 'blocked.channels') {
      const kept = listOf(state.draft, 'suggested.videos').filter((x) => cat().videos[x.id]?.channelId === e.id).length;
      if (kept) override = `<p class="row__override">${ICON.plus}<span>${plural(kept, 'suggested video')} from this channel still shown.</span></p>`;
    }

    const changeLine = changes.length
      ? `<p class="row__change">${changes.map((c) => `<span>${esc(changeLabel(c))}</span>`).join('')}
          <button type="button" class="link-btn" data-action="revert" data-change="${esc(changes[0].key)}" data-key="revert:${esc(changes[0].key)}">${changes.length > 1 ? 'Revert all' : 'Revert'}<span class="vh"> ${esc(title)}</span></button></p>`
      : '';

    const editing = !ghost && ui.editing === `${key}:${e.id}`;
    const note = editing
      ? `<div class="row__editor">
          <label class="vh" for="note-${esc(e.id)}">Note for ${esc(title)}</label>
          <textarea class="input" id="note-${esc(e.id)}" rows="2" maxlength="280" data-key="note:${key}:${esc(e.id)}" placeholder="Why it’s here. Only you see this.">${esc(e.note)}</textarea>
          <div class="row__editor-actions">
            <button type="button" class="btn btn--sm btn--primary" data-action="note-save" data-list="${key}" data-id="${esc(e.id)}">Save note</button>
            <button type="button" class="btn btn--sm btn--quiet" data-action="note-cancel">Cancel</button>
            <span class="hint">⌘↵ saves · Esc cancels</span>
          </div></div>`
      : e.note ? `<p class="row__note">${esc(e.note)}</p>` : '';

    let actions = '';
    if (!ghost) {
      const inline = [];
      if (L.ordered) {
        const lock = filtering ? 'disabled title="Clear the filter to reorder"' : '';
        inline.push(`<button type="button" class="icon-btn row__inline" data-action="move" data-list="${key}" data-id="${esc(e.id)}" data-delta="-1" data-key="${rowKey}:up" aria-label="Move up: ${esc(title)}" title="Move up (Alt ↑)" ${pos === 1 || filtering ? 'disabled' : ''} ${lock}>${ICON.up}</button>`);
        inline.push(`<button type="button" class="icon-btn row__inline" data-action="move" data-list="${key}" data-id="${esc(e.id)}" data-delta="1" data-key="${rowKey}:down" aria-label="Move down: ${esc(title)}" title="Move down (Alt ↓)" ${pos === len || filtering ? 'disabled' : ''} ${lock}>${ICON.down}</button>`);
      }
      inline.push(`<button type="button" class="btn btn--quiet row__inline" data-action="note-edit" data-list="${key}" data-id="${esc(e.id)}" data-key="${rowKey}:note" aria-label="${e.note ? 'Edit note' : 'Add note'}: ${esc(title)}">Note</button>`);
      inline.push(`<button type="button" class="btn btn--quiet row__inline" data-action="remove" data-list="${key}" data-id="${esc(e.id)}" data-key="${rowKey}:remove" aria-label="${L.group === 'blocked' ? 'Unblock' : 'Remove'}: ${esc(title)}">${L.group === 'blocked' ? 'Unblock' : 'Remove'}</button>`);
      inline.push(`<button type="button" class="icon-btn row__more" data-action="open-item" data-kind="${kind}" data-id="${esc(e.id)}" data-from="${key}" data-key="${rowKey}:more" aria-label="Actions for ${esc(title)}">${ICON.more}</button>`);
      actions = `<div class="row__actions">${inline.join('')}</div>`;
    }

    const classes = ['row', changes.length ? 'row--changed' : '', ghost ? 'row--ghost' : ''].join(' ');
    const extra = override + changeLine + note;
    return `<li class="${classes}" data-kind="${kind}" data-id="${esc(e.id)}" data-list="${key}">
      ${L.ordered ? `<span class="row__pos" aria-hidden="true">${pos ? pad2(pos) : '—'}</span>` : ''}
      <div class="row__media">${media(kind, e.id)}</div>
      <h3 class="row__title"><button type="button" data-action="open-item" data-kind="${kind}" data-id="${esc(e.id)}" data-from="${ghost ? '' : key}" data-key="${rowKey}:title" ${ent?.lang ? `lang="${esc(ent.lang)}"` : ''}>${L.ordered && pos ? `<span class="vh">${pos}. </span>` : ''}${esc(title)}</button></h3>
      <p class="meta row__meta">${meta.join('')}</p>
      ${actions}
      ${extra ? `<div class="row__extra">${extra}</div>` : ''}
    </li>`;
  }

  /* ------------------------------------------------------------------ render: monitor */

  function renderMonitor() {
    const col = $('#col-monitor');
    const pub = published();
    const draftSame = !D.changes.length;
    col.innerHTML = `
      <div class="monitor">
        <div class="monitor__head">
          <h2 class="monitor__title" id="monitor-h">On the TV</h2>
          <p class="monitor__sub">${ui.monitorMode === 'draft' ? (draftSame ? 'The draft matches what the TV shows now.' : 'The TV home as it will look after you publish.') : `The TV home with revision ${pub.n}, as published.`}</p>
        </div>
        <div class="monitor__controls">
          <div class="seg" role="group" aria-label="Version to preview">
            <button type="button" aria-pressed="${ui.monitorMode === 'draft'}" data-action="monitor-mode" data-mode="draft" data-key="mon:draft">Draft</button>
            <button type="button" aria-pressed="${ui.monitorMode === 'published'}" data-action="monitor-mode" data-mode="published" data-key="mon:pub">Published <span class="mono">r${pub.n}</span></button>
          </div>
          <label class="check"><input type="checkbox" data-action="toggle-hidden" data-key="mon:hidden" ${ui.showHidden ? 'checked' : ''}> Show hidden</label>
          <button type="button" class="btn btn--sm" data-action="open-tv" data-key="mon:expand">${ICON.expand}Full screen</button>
        </div>
        ${tvHTML({ prefix: 'tv' })}
        <div class="monitor__legend" aria-label="Legend">
          <p class="legend__row"><span class="legend__key legend__key--change" aria-hidden="true"></span><span>Changes when you publish</span></p>
          <p class="legend__row"><span class="legend__key legend__key--hidden" aria-hidden="true"></span><span>Hidden by a rule. Shown here with <i>Show hidden</i>, or while you point at the rule.</span></p>
        </div>
        <p class="monitor__foot">Home and Subscriptions are a fixed sample. The real preview would use the rows your TV last reported. Arrow keys move like the remote; Enter opens an item.</p>
      </div>`;
  }

  function tvModel() {
    const draftMode = ui.monitorMode === 'draft';
    const doc = draftMode ? state.draft : D.pub;
    const base = draftMode ? D.pub : null;
    const changedRow = (key, id) => draftMode && (D.byRow.get(`${key}|${id}`) || []).some((c) => c.type === 'added' || c.type === 'moved');
    const shelves = [];
    const curated = (key, title, kind) => {
      const items = listOf(doc, key).map((e) => ({ kind, id: e.id, changed: changedRow(key, e.id) }));
      if (draftMode) {
        for (const c of D.changes) if (c.list === key && c.type === 'removed') items.splice(Math.min(c.from, items.length), 0, { kind, id: c.id, hidden: true, flag: 'Removed in draft', changed: true });
      }
      shelves.push({ id: key, title, kind, items, curated: true });
    };
    curated('suggested.videos', 'Suggested', 'video');
    curated('suggested.playlists', 'Suggested playlists', 'playlist');
    curated('suggested.channels', 'Suggested channels', 'channel');
    for (const row of state.feed) {
      const items = row.videoIds.map((id) => {
        const st = videoState(doc, id);
        const was = base ? videoState(base, id) : null;
        return {
          kind: 'video', id,
          hidden: !st.visible,
          flag: st.visible ? null : st.reason === 'video' ? 'Hidden · video blocked' : 'Hidden · channel blocked',
          changed: !!was && was.visible !== st.visible,
        };
      });
      shelves.push({ id: `feed:${row.id}`, title: row.title, kind: 'video', items, sample: true });
    }
    return shelves;
  }

  function tvHTML({ prefix, large = false }) {
    const shelves = tvModel();
    const pub = published();
    const shown = (s) => s.items.filter((i) => !i.hidden).length;
    let firstKey = null;
    const keys = [];
    const body = shelves.map((s) => {
      const items = s.items.map((it) => {
        const k = `${prefix}:${s.id}:${it.id}`;
        keys.push({ k, hidden: it.hidden });
        if (!firstKey && !it.hidden) firstKey = k;
        return cardHTML(it, k);
      }).join('');
      const visible = shown(s);
      const meta = s.sample ? `${visible} of ${s.items.length} shown` : `${visible}`;
      const empty = !visible && !ui.showHidden && !s.items.some((i) => i.hidden && i.changed) ? `<li class="shelf__empty">Empty. The TV skips this row.</li>` : '';
      return `<section class="shelf" aria-label="${esc(s.title)}">
        <div class="shelf__head"><h3 class="shelf__title">${esc(s.title)}</h3><span class="shelf__meta">${meta}</span>${s.sample ? '<span class="shelf__tag">Sample feed</span>' : ''}</div>
        <ul class="shelf__items" data-scroll-key="${prefix}:shelf:${esc(s.id)}">${items}${empty}</ul>
      </section>`;
    }).join('');
    const wanted = `${prefix}:${ui.tvFocus}`;
    const focusKey = keys.some((x) => x.k === wanted && (!x.hidden || ui.showHidden)) ? wanted : firstKey;
    const html = `<div class="tv ${ui.showHidden ? 'tv--show-hidden' : ''} ${large ? 'tv--large' : ''}" data-prefix="${prefix}" role="region" aria-label="TV home preview (${ui.monitorMode === 'draft' ? 'draft' : `revision ${pub.n}`})">
      <div class="tv__bar">${ICON.mark}<span>OwnTube · Home</span><span class="tv__rev">${ui.monitorMode === 'draft' ? (D.changes.length ? `draft · ${plural(D.changes.length, 'change')}` : `r${pub.n}`) : `r${pub.n} · published`}</span></div>
      ${body}
    </div>`;
    // Roving tabindex: exactly one card is in the tab order.
    return focusKey ? html.replace(`data-key="${esc(focusKey)}" tabindex="-1"`, `data-key="${esc(focusKey)}" tabindex="0"`) : html;
  }

  function cardHTML(it, key) {
    const { kind, id } = it;
    const ent = entity(kind, id);
    const title = titleOf(kind, id);
    const cls = ['card', `card--${kind}`, it.hidden ? 'card--hidden' : '', it.changed ? 'card--changed' : ''].join(' ');
    const data = kind === 'video'
      ? `data-video="${esc(id)}" data-channel="${esc(ent?.channelId || '')}"`
      : kind === 'channel' ? `data-channel-tile="${esc(id)}"` : `data-playlist="${esc(id)}"`;
    let sub = '';
    if (kind === 'video') sub = ent?.channelId ? channelName(ent.channelId) : 'Not looked up';
    else if (kind === 'playlist') sub = ent?.channelId ? channelName(ent.channelId) : 'Playlist';
    const status = [it.flag, it.changed ? 'changes when you publish' : ''].filter(Boolean).join(', ');
    const label = `${title}${sub ? ` — ${sub}` : ''}${kind === 'video' && ent?.durationS ? `, ${fmtDur(ent.durationS)}` : ''}${status ? `. ${status}` : ''}`;
    const flag = it.flag ? `<span class="card__flag">${esc(it.flag)}</span>` : '';
    const mediaHTML = kind === 'channel' ? avatar(id) : kind === 'playlist' ? playlistArt(id, { tv: true }) : videoArt(id, { tv: true });
    return `<li class="${cls}" ${data}>
      <button type="button" class="card__hit" data-action="open-item" data-kind="${kind}" data-id="${esc(id)}" data-key="${esc(key)}" tabindex="-1" aria-label="${esc(label)}">
        ${flag}${mediaHTML}
        <span class="card__title" ${ent?.lang ? `lang="${esc(ent.lang)}"` : ''}>${esc(title)}</span>
        ${sub ? `<span class="card__meta">${esc(sub)}</span>` : ''}
      </button>
    </li>`;
  }

  function renderTvDialog() {
    const d = $('#dlg-tv');
    setDialogHTML(d, `<button type="button" class="btn btn--sm tvdialog__close" data-action="close-dialog" data-key="tvd:close">${ICON.close.replace('<svg', '<svg width="14" height="14"')}Close<span class="vh"> full-screen preview</span></button>${tvHTML({ prefix: 'tvL', large: true })}`);
  }

  /* Point at a rule in the list → light the cards it affects (and reveal hidden ones). */
  function lightCards(kind, id, list) {
    clearLight();
    const tv = $('#col-monitor .tv');
    if (!tv || !tv.offsetParent) return [];
    let sel;
    if (kind === 'video') sel = `.card[data-video="${CSS.escape(id)}"]`;
    else if (kind === 'playlist') sel = `.card[data-playlist="${CSS.escape(id)}"]`;
    else if (list === 'blocked.channels') sel = `.card--hidden[data-channel="${CSS.escape(id)}"]`;
    else sel = `.card[data-channel-tile="${CSS.escape(id)}"], .card[data-channel="${CSS.escape(id)}"]:not(.card--hidden)`;
    const cards = $$(sel, tv);
    cards.forEach((c) => c.classList.add('is-lit'));
    return cards;
  }
  function clearLight() { $$('.is-lit').forEach((el) => el.classList.remove('is-lit')); }
  function revealCard(card) {
    if (!card) return;
    const shelf = card.closest('.shelf__items');
    const col = $('#col-monitor');
    const behavior = reducedMotion() ? 'auto' : 'smooth';
    if (shelf) {
      const r = card.getBoundingClientRect(), sr = shelf.getBoundingClientRect();
      const l = r.left - sr.left + shelf.scrollLeft;
      if (r.left < sr.left || r.right > sr.right) shelf.scrollTo({ left: Math.max(0, l - 18), behavior });
    }
    if (col && col.scrollHeight > col.clientHeight) {
      const r = card.getBoundingClientRect(), cr = col.getBoundingClientRect();
      if (r.top < cr.top + 8 || r.bottom > cr.bottom - 8) col.scrollBy({ top: r.top - cr.top - cr.height / 3, behavior });
    }
  }

  /* ------------------------------------------------------------------ render: item dialog */

  function openItem(kind, id, from, opener) {
    ui.item = { kind, id, from: from || null, noteDraft: null };
    renderItem();
    openDialog($('#dlg-item'), opener);
  }

  function renderItem() {
    const d = $('#dlg-item');
    if (!ui.item) return;
    const { kind, id } = ui.item;
    const ent = entity(kind, id);
    const title = titleOf(kind, id);
    const doc = state.draft;
    const sKey = suggestKey(kind), bKey = kind === 'playlist' ? null : blockKey(kind);
    const sIdx = listOf(doc, sKey).findIndex((e) => e.id === id);
    const bIdx = bKey ? listOf(doc, bKey).findIndex((e) => e.id === id) : -1;
    const lang = ent?.lang ? LANGS[ent.lang] : null;

    // Status: what the TV will do with this item once the draft is published.
    let status = '', tone = '';
    if (kind === 'video') {
      const st = videoState(doc, id);
      if (st.suggested) { tone = 'suggest'; status = `<p><strong>Suggested</strong>, position ${sIdx + 1} of ${listOf(doc, sKey).length} in the first row.</p>${st.override ? `<p>Shown although its channel, ${esc(channelName(ent.channelId))}, is blocked. Suggestions win.</p>` : ''}`; }
      else if (st.blocked) { tone = 'block'; status = '<p><strong>Blocked.</strong> Never shown on the TV.</p>'; }
      else if (st.chBlocked) { tone = 'block'; status = `<p><strong>Hidden</strong> because its channel, ${esc(channelName(ent.channelId))}, is blocked.</p><p>Suggest this video to show it anyway.</p>`; }
      else status = '<p><strong>Not curated.</strong> Shown wherever the TV’s feed puts it.</p>';
    } else if (kind === 'channel') {
      const fx = feedEffect(doc, 'channel', id);
      if (sIdx >= 0) { tone = 'suggest'; status = `<p><strong>Suggested channel</strong>, position ${sIdx + 1} of ${listOf(doc, sKey).length}.</p>`; }
      else if (bIdx >= 0) { tone = 'block'; status = `<p><strong>Blocked channel.</strong> ${fx.hidden ? `Hides ${plural(fx.hidden, 'item')} in the sample feed.` : 'Nothing from it is in the sample feed.'}</p>`; }
      else status = `<p><strong>Not curated.</strong> ${fx.appears ? `${plural(fx.appears, 'video')} in the sample feed.` : ''}</p>`;
    } else {
      status = sIdx >= 0 ? `<p><strong>Suggested playlist</strong>, position ${sIdx + 1} of ${listOf(doc, sKey).length}.</p>` : '<p><strong>Not curated.</strong></p>';
      if (sIdx >= 0) tone = 'suggest';
    }

    // Facts
    const facts = [];
    if (kind !== 'channel' && ent?.channelId) facts.push(['Channel', `<button type="button" class="link-btn" data-action="open-item" data-kind="channel" data-id="${esc(ent.channelId)}">${esc(channelName(ent.channelId))}</button>`]);
    if (lang) facts.push(['Language', `${lang[1]} <span class="mono">(${esc(ent.lang)})</span>`]);
    if (kind === 'video' && ent?.live) facts.push(['Length', 'Live stream']);
    else if (kind === 'video' && ent?.durationS != null) facts.push(['Length', `<span class="mono">${fmtDur(ent.durationS)}</span>${ent.short ? ' · Short' : ''}`]);
    if (kind === 'playlist' && ent?.count != null) facts.push(['Videos', `<span class="mono">${ent.count}</span>`]);
    if (kind === 'video') {
      const rows = feedRowsOf(id);
      facts.push(['Sample feed', rows.length ? esc(rows.join(', ')) : 'Not in the sample feed']);
      const plays = state.history.filter((h) => h.videoId === id).sort((a, b) => b.at - a.at);
      if (plays.length) facts.push(['History', `Played ${plays.length === 1 ? 'once' : `${plays.length} times`}, last ${esc(ago(plays[0].at))} on ${esc(plays[0].device)}`]);
    }
    if (kind === 'channel') {
      const fx = feedEffect(doc, 'channel', id);
      facts.push(['Sample feed', fx.appears ? plural(fx.appears, 'video') : 'No videos in the sample feed']);
    }
    const held = sIdx >= 0 ? listOf(doc, sKey)[sIdx] : bIdx >= 0 ? listOf(doc, bKey)[bIdx] : null;
    if (held) facts.push([sIdx >= 0 ? 'Suggested' : 'Blocked', esc(ago(held.at))]);
    facts.push(['Source', ent?.sample ? 'Sample item (not on YouTube)' : 'Pasted link. Title and channel would be looked up by the server.']);

    // Actions
    // Keys stay stable when a button toggles (Suggest ⇄ Remove), so focus stays put.
    const acts = [];
    const btn = (action, label, cls, k, extra = '') => `<button type="button" class="btn btn--sm ${cls}" data-action="${action}" data-kind="${kind}" data-id="${esc(id)}" data-key="item:${k}" ${extra}>${label}</button>`;
    if (sIdx >= 0) acts.push(btn('unsuggest', 'Remove from suggested', '', 's'));
    else acts.push(btn('suggest', `${ICON.plus}${bIdx >= 0 ? 'Unblock &amp; suggest' : 'Suggest'}`, 'btn--suggest', 's'));
    if (kind !== 'playlist') {
      if (bIdx >= 0) acts.push(btn('unblock', `Unblock ${kind}`, '', 'b'));
      else acts.push(btn('block', `${ICON.block}Block ${kind}`, 'btn--block', 'b'));
    }
    if (kind === 'video' && ent?.channelId) {
      const cid = ent.channelId;
      const chBlocked = has(doc, 'blocked.channels', cid);
      acts.push(`<button type="button" class="btn btn--sm ${chBlocked ? '' : 'btn--block'}" data-action="${chBlocked ? 'unblock' : 'block'}" data-kind="channel" data-id="${esc(cid)}" data-key="item:channel">${chBlocked ? '' : ICON.block}${chBlocked ? 'Unblock' : 'Block'} channel<span class="vh"> ${esc(channelName(cid))}</span></button>`);
    }

    // Order + note, for whichever list currently holds the item.
    const holder = sIdx >= 0 ? sKey : bIdx >= 0 ? bKey : null;
    let order = '', noteBlock = '';
    if (holder) {
      const arr = listOf(doc, holder);
      const i = holder === sKey ? sIdx : bIdx;
      if (LISTS[holder].ordered) {
        order = `<div class="item__section"><span class="label">Order on the TV</span><div class="item__order">
          <button type="button" class="btn btn--sm" data-action="move" data-list="${holder}" data-id="${esc(id)}" data-delta="-1" data-key="item:up" ${i === 0 ? 'disabled' : ''}>${ICON.up.replace('<svg', '<svg width="14" height="14"')}Move up</button>
          <button type="button" class="btn btn--sm" data-action="move" data-list="${holder}" data-id="${esc(id)}" data-delta="1" data-key="item:down" ${i === arr.length - 1 ? 'disabled' : ''}>${ICON.down.replace('<svg', '<svg width="14" height="14"')}Move down</button>
          <span class="mono">${i + 1} / ${arr.length}</span></div></div>`;
      }
      const entry = arr[i];
      const val = ui.item.noteDraft ?? entry.note;
      noteBlock = `<div class="item__section"><label class="label" for="item-note">Note · only you see this</label>
        <textarea class="input" id="item-note" rows="2" maxlength="280" data-key="item:note" data-list="${holder}" placeholder="Why it’s ${holder.startsWith('blocked') ? 'blocked' : 'here'}">${esc(val)}</textarea>
        <div class="item__actions" style="margin-top:8px"><button type="button" class="btn btn--sm" data-action="item-note-save" data-list="${holder}" data-id="${esc(id)}" data-key="item:note-save">Save note</button></div></div>`;
    }

    let external = '';
    if (!ent?.sample) {
      const url = kind === 'video' ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
        : kind === 'playlist' ? `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`
          : id.startsWith('@') ? `https://www.youtube.com/${encodeURIComponent(id)}` : id.includes('/') ? `https://www.youtube.com/${id.split('/').map(encodeURIComponent).join('/')}` : `https://www.youtube.com/channel/${encodeURIComponent(id)}`;
      external = `<p class="item__external"><a href="${url}" target="_blank" rel="noopener noreferrer">Open on YouTube ${ICON.external}<span class="vh"> (opens a new tab)</span></a></p>`;
    }
    const kindWord = { video: 'Video', channel: 'Channel', playlist: 'Playlist' }[kind];
    const mediaBlock = kind === 'channel' ? avatar(id) : kind === 'playlist' ? playlistArt(id) : videoArt(id);
    setDialogHTML(d, `
      <div class="dialog__head">
        <h2 id="item-title"><span class="vh">${kindWord}: </span><span class="label" style="display:block;margin-bottom:6px" aria-hidden="true">${kindWord}</span><span ${ent?.lang ? `lang="${esc(ent.lang)}"` : ''}>${esc(title)}</span></h2>
        <button type="button" class="icon-btn dialog__close" data-action="close-dialog" data-key="item:close" aria-label="Close">${ICON.close}</button>
      </div>
      <div class="dialog__body">
        <div class="item__media">${mediaBlock}</div>
        <p class="item__ids"><span>ID ${esc(id)}</span>${ent?.sample ? '<span>sample</span>' : `<button type="button" data-action="copy" data-text="${esc(id)}">Copy ID</button>`}</p>
        <div class="item__status ${tone ? `item__status--${tone}` : ''}">${status}</div>
        <div class="item__section"><span class="label">Curate · changes go to the draft</span><div class="item__actions">${acts.join('')}</div></div>
        ${order}${noteBlock}
        <dl class="item__facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        ${external}
      </div>`);
    d.setAttribute('aria-labelledby', 'item-title');
  }

  /* ------------------------------------------------------------------ render: publish sheet */

  function renderPublish() {
    const d = $('#dlg-publish');
    const pub = published();
    const n = pub.n + 1;
    const changes = D.changes;
    const groups = LIST_KEYS.map((k) => [k, changes.filter((c) => c.list === k)]).filter(([, cs]) => cs.length);
    const changeRow = (c) => {
      const L = LISTS[c.list];
      const [sign, tone, word] = changeSign(c);
      const title = titleOf(L.kind, c.id);
      let detail = '';
      if (c.type === 'added') detail = L.ordered ? `${word} at position ${c.to + 1}` : (L.group === 'blocked' ? (() => { const fx = feedEffect(state.draft, L.kind, c.id); return fx.hidden ? `Hides ${fx.hidden} in sample feed` : 'Not in sample feed'; })() : word);
      if (c.type === 'removed') detail = L.group === 'blocked' ? 'Unblocked' : `Was at position ${c.from + 1}`;
      if (c.type === 'moved') detail = `Position ${c.from + 1} → ${c.to + 1}`;
      if (c.type === 'note') detail = c.after ? `Note: “${truncate(c.after, 70)}”` : 'Note removed';
      const ent = entity(L.kind, c.id);
      return `<li class="change">
        <span class="change__sign change__sign--${tone}" aria-hidden="true">${sign}</span>
        <span class="change__text"><span class="t" ${ent?.lang ? `lang="${esc(ent.lang)}"` : ''}>${esc(title)}</span><span class="d">${esc(detail)}</span></span>
        <button type="button" class="link-btn" data-action="revert" data-change="${esc(c.key)}" data-key="pub:revert:${esc(c.key)}">Revert<span class="vh"> ${esc(title)}</span></button>
      </li>`;
    };
    const changesHTML = changes.length ? `
      <section class="sheet__section" aria-labelledby="pub-changes">
        <h3 id="pub-changes">Changes since r${pub.n} <span class="mono">${changes.length}</span></h3>
        <div class="changes">${groups.map(([k, cs]) => `<div class="changes__group"><span class="label">${LISTS[k].title}</span><ul>${cs.map(changeRow).join('')}</ul></div>`).join('')}</div>
        <div class="publish-form">
          <label for="pub-note">Note for revision ${n} (optional)</label>
          <textarea class="input" id="pub-note" rows="2" maxlength="200" data-key="pub:note" placeholder="What changed, in your words">${esc(ui.publishNote)}</textarea>
          ${ui.confirmDiscard
            ? `<div class="confirm" role="group" aria-label="Confirm discard"><span>Discard ${plural(changes.length, 'change')}? The draft goes back to revision ${pub.n}. You can undo this.</span>
                <button type="button" class="btn btn--sm btn--block" data-action="discard-confirm" data-key="pub:discard-confirm">Discard</button>
                <button type="button" class="btn btn--sm btn--quiet" data-action="discard-cancel" data-key="pub:discard-cancel">Keep</button></div>`
            : `<div class="publish-form__buttons">
                <button type="button" class="btn btn--primary" data-action="publish" data-key="pub:publish">Publish revision ${n} locally</button>
                <button type="button" class="btn btn--danger btn--sm" data-action="discard" data-key="pub:discard">Discard changes</button></div>`}
        </div>
      </section>`
      : `<section class="sheet__section"><p class="uptodate" tabindex="-1" data-key="publish:done">Nothing to publish. The draft matches revision ${pub.n}.</p></section>`;

    const revs = state.revisions.slice().reverse();
    const revsHTML = revs.map((r, i) => {
      const prev = state.revisions[state.revisions.indexOf(r) - 1];
      const count = prev ? diffAll(r.snapshot, prev.snapshot).length : null;
      const current = i === 0;
      const matchesDraft = diffAll(state.draft, r.snapshot).length === 0;
      return `<li class="rev">
        <span class="rev__n">r${r.n}</span>
        <span class="rev__note ${r.note ? '' : 'rev__note--empty'}">${esc(r.note || 'No note')}</span>
        <span class="rev__meta">${current ? '<span class="live">current · </span>' : ''}${esc(fullFmt.format(r.at))} · ${r.origin === 'sample' ? 'sample' : 'this browser'}${count != null ? ` · ${plural(count, 'change')}` : ' · first in sample'}</span>
        <span class="rev__act">${matchesDraft ? '<span class="label">= draft</span>' : `<button type="button" class="btn btn--sm btn--quiet" data-action="restore" data-n="${r.n}" data-key="pub:restore:${r.n}"><span>Restore as draft<span class="vh"> (revision ${r.n})</span></span></button>`}</span>
      </li>`;
    }).join('');

    setDialogHTML(d, `
      <div class="sheet__head">
        <div style="flex:1"><span class="label">Publishing</span><h2 id="publish-title">${changes.length ? `Publish revision ${n}` : 'Revisions'}</h2></div>
        <button type="button" class="icon-btn" data-action="close-dialog" data-key="pub:close" aria-label="Close">${ICON.close}</button>
      </div>
      <div class="sheet__body">
        <p class="notice"><span><strong>Preview only.</strong> Publishing here saves a numbered revision in this browser. No TV or server is contacted, and nothing leaves this page.</span></p>
        ${changesHTML}
        <section class="sheet__section" aria-labelledby="pub-revs"><h3 id="pub-revs">Revisions</h3><ol class="revs">${revsHTML}</ol></section>
        <section class="sheet__section" aria-labelledby="pub-dev"><h3 id="pub-dev">TVs</h3>
          <p class="devices">This preview has no TVs. In the real backoffice, each paired OwnTube device reports the revision it last applied and when, so you can tell whether a change has arrived.</p>
        </section>
      </div>`);
  }

  /* ------------------------------------------------------------------ render: about */

  function renderAbout() {
    const d = $('#dlg-about');
    const theme = prefs.theme;
    setDialogHTML(d, `
      <div class="dialog__head"><h2 id="about-title">About this preview</h2>
        <button type="button" class="icon-btn dialog__close" data-action="close-dialog" data-key="about:close" aria-label="Close">${ICON.close}</button></div>
      <div class="dialog__body about">
        <p>A local design prototype of the OwnTube backoffice: curating what the TV shows, previewing the result, and publishing it as a numbered revision.</p>
        <p>Every channel, video, revision and history entry is sample data. Your edits are saved in this browser’s storage only. “Publishing” adds a revision there and contacts nothing.</p>
        <p>The only network requests are thumbnails for real YouTube links you paste, loaded from <span class="mono">i.ytimg.com</span> without a referrer. Turn them off below.</p>
        <div class="about__prefs">
          <div class="about__pref"><span class="label" id="pref-thumbs">Thumbnails for pasted links</span>
            <div class="seg" role="group" aria-labelledby="pref-thumbs">
              <button type="button" aria-pressed="${prefs.remoteThumbs}" data-action="pref-thumbs" data-value="on" data-key="about:thumbs-on">Load from YouTube</button>
              <button type="button" aria-pressed="${!prefs.remoteThumbs}" data-action="pref-thumbs" data-value="off" data-key="about:thumbs-off">Placeholders only</button>
            </div></div>
          <div class="about__pref"><span class="label" id="pref-theme">Appearance</span>
            <div class="seg" role="group" aria-labelledby="pref-theme">
              ${['system', 'light', 'dark'].map((t) => `<button type="button" aria-pressed="${theme === t}" data-action="pref-theme" data-value="${t}" data-key="about:theme-${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
            </div></div>
        </div>
        <span class="label" style="display:block;margin-top:22px">Keyboard</span>
        <dl class="shortcuts">
          <dt><kbd>A</kbd></dt><dd>Paste a link (Add by link)</dd>
          <dt><kbd>/</kbd></dt><dd>Filter the list, or search History</dd>
          <dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd>Switch between the five lists</dd>
          <dt><kbd>Alt</kbd> <kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Move a suggestion while its row has focus</dd>
          <dt><kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Move around the TV preview like a remote</dd>
          <dt><kbd>H</kbd></dt><dd>Show or hide what rules hide</dd>
          <dt><kbd>P</kbd></dt><dd>Review &amp; publish</dd>
          <dt><kbd>⌘</kbd> <kbd>Z</kbd></dt><dd>Undo the last change to the draft</dd>
          <dt><kbd>?</kbd></dt><dd>This panel</dd>
        </dl>
      </div>`);
  }

  /* ------------------------------------------------------------------ render: history */

  /* ---- Devices and sources. Only what each collector actually records. ---- */

  const deviceOf = (label) => state.devices.find((d) => d.label === label) || { label, kind: 'tv' };
  // Chrome reports tab visibility ("on-tab"); OwnTube on Android TV reports whether the player
  // activity is in front ("foreground"). Neither proves attention.
  const frontWord = (kind) => (kind === 'browser' ? 'on-tab' : 'foreground');
  const deviceText = (label) => (deviceOf(label).kind === 'browser' ? `${label} · Chrome` : label);
  const scopeFront = (dev) => (dev === 'all' ? 'on-tab or foreground' : frontWord(deviceOf(dev).kind));
  const scopeLabel = (dev) => (dev === 'all' ? 'All devices' : deviceText(dev));

  // A play without a recorded split (older records) is all "unspecified", never assumed foreground.
  const ctxOf = (h) => h.ctx || { fg: 0, bg: 0, un: h.watchedS };

  // One play's split, in words. Unknown context stays "unspecified"; it is never counted as foreground.
  function ctxLine(ctx, kind) {
    const parts = [[ctx.fg, frontWord(kind)], [ctx.bg, 'background'], [ctx.un, 'unspecified']].filter(([s]) => s > 0);
    if (parts.length === 1) return parts[0][1] === 'unspecified' ? 'context not recorded' : `all ${parts[0][1]}`;
    return parts.map(([s, w]) => `${fmtSpent(s)} ${w}`).join(' · ');
  }

  function historyTabs(prefix) {
    const tab = (id, label, href) => `<a class="htabs__tab" href="${href}" ${ui.history.view === id ? 'aria-current="page"' : ''} data-key="htab:${prefix}:${id}">${label}</a>`;
    return `<nav class="htabs" aria-label="History views">${tab('watched', 'Watched', '#/history')}${tab('searches', 'Searches', '#/history/searches')}</nav>`;
  }

  function renderHistoryFilters() {
    const col = $('#col-index');
    const v = ui.history.view;
    const opt = (d) => `<option value="${esc(d.label)}" ${ui.history.device === d.label ? 'selected' : ''}>${esc(d.label)}</option>`;
    const group = (kind, label) => {
      const ds = state.devices.filter((d) => d.kind === kind);
      return ds.length ? `<optgroup label="${label}">${ds.map(opt).join('')}</optgroup>` : '';
    };
    const note = v === 'searches'
      ? `<p>A search is recorded when a YouTube results page opens in Chrome; the same query again within 5 seconds counts once.</p>
         <p>OwnTube on Android TV records playback only, so TVs never show searches here.</p>`
      : `<p>History is a record, not a goal. It is here so you can act on what actually played.</p>
         <p><b>Watched</b> is wall-clock playback, background included. <b>On-tab</b> (Chrome) and <b>foreground</b> (TV) say what was in front, not who paid attention; <b>unspecified</b> means the collector didn’t record it. <b>Covered</b> is the share of a video that played at least once.</p>`;
    // On phones the heading and the view switch come before the filters; this copy is shown only there.
    col.innerHTML = `
      <div class="history__mhead">
        <h1 class="list__title" tabindex="-1" data-heading>History</h1>
        <p class="list__lede">${v === 'searches' ? 'YouTube searches from Chrome. Sample data.' : 'What played on your devices. Sample data.'}</p>
        ${historyTabs('m')}
      </div>
      <div class="history__filters">
        <div><label class="label" for="hq">Filter</label>
          <div class="search">${ICON.search}<input class="input" id="hq" type="search" autocomplete="off" spellcheck="false"
            placeholder="${v === 'searches' ? 'Query text' : 'Title or channel'}" value="${esc(v === 'searches' ? ui.history.sq : ui.history.q)}" data-action="history-q" data-key="history:q:${v}"></div></div>
        <div><label class="label" for="hdev">Device</label>
          <select class="select" id="hdev" data-action="history-device" data-key="history:device">
            <option value="all">All devices</option>
            ${group('tv', 'TVs · playback only')}
            ${group('browser', 'Chrome · playback and searches')}
          </select></div>
        <div><span class="label" id="hperiod">Period</span>
          <div class="seg" role="group" aria-labelledby="hperiod">
            ${HISTORY_DAYS.map((d) => `<button type="button" aria-pressed="${ui.history.days === d}" data-action="history-days" data-value="${d}" data-key="history:days:${d}">${d} days</button>`).join('')}
          </div></div>
      </div>
      <div class="history__note">${note}</div>`;
  }

  /* ---- History numbers. One definition feeds the ledger and every day total. ---- */

  const HISTORY_DAYS = [7, 30, 90];
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; } catch { return 'local time'; } })();

  // The last N calendar days in the browser's time zone, ending today (inclusive). Built from
  // local dates, so a DST day still counts as one day.
  function historyRange(days, now = Date.now()) {
    const d = new Date(now);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
    return { start, end: now, days };
  }

  // Search never reaches this function: period and TV decide the numbers, search only filters rows.
  // The average divides by every calendar day in the period, including today and empty days.
  function historySummary(plays, range) {
    const inRange = plays.filter((h) => h.at >= range.start && h.at <= range.end);
    const totalS = inRange.reduce((s, h) => s + h.watchedS, 0);
    const videos = new Set(inRange.map((h) => h.videoId)).size;
    const ctx = inRange.reduce((a, h) => ({ fg: a.fg + ctxOf(h).fg, bg: a.bg + ctxOf(h).bg, un: a.un + ctxOf(h).un }), { fg: 0, bg: 0, un: 0 });
    return { plays: inRange, totalS, videos, avgS: totalS / range.days, days: range.days, ctx };
  }

  // The server's dashboard lists the latest 20 searches while `searchCount` covers the whole scope.
  const SEARCH_LIST_LIMIT = 20;
  const inScope = (items, dev, range) => items.filter((x) => (dev === 'all' || x.device === dev) && x.at >= range.start && x.at <= range.end);
  function byDay(items) {
    const m = new Map();
    for (const x of items) {
      const k = startOfDay(x.at);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return m;
  }
  const dayTitle = (t, now = Date.now()) => { const dd = dayDiff(t, now); return dd === 0 ? 'Today' : dd === 1 ? 'Yesterday' : dayFmt.format(t).replace(',', ''); };
  const dayHead = (t, id, extra) => `<div class="day__head"><h2 class="day__title" id="${id}">${dayTitle(t)}</h2>${dayDiff(t, Date.now()) <= 1 ? `<span class="day__date">${shortDayFmt.format(t)}</span>` : ''}${extra}</div>`;

  function spentParts(sec) {
    const s = Math.round(sec);
    if (s === 0) return [['0', 'min']];
    if (s < 60) return [[String(s), 's']];
    const m = Math.round(s / 60);
    if (m < 60) return [[String(m), 'min']];
    const h = Math.floor(m / 60), r = m % 60;
    return r ? [[String(h), 'h'], [String(r), 'min']] : [[String(h), 'h']];
  }
  const spentHTML = (sec) => spentParts(sec).map(([n, u]) => `${n}<span class="u">${u}</span>`).join('');
  function fmtSpan(a, b) {
    const da = new Date(a), db = new Date(b);
    const sameMonth = da.getMonth() === db.getMonth() && da.getFullYear() === db.getFullYear();
    return sameMonth ? `${da.getDate()}–${shortDayFmt.format(db)}` : `${shortDayFmt.format(da)} – ${shortDayFmt.format(db)}`;
  }

  function renderHistory() {
    const v = ui.history.view;
    const lede = v === 'searches'
      ? 'YouTube searches recorded by the Chrome collector, newest first. Sample data in this preview.'
      : 'What played on your devices, OwnTube TVs and Chrome, newest first. Sample data in this preview; the real list comes from the server’s viewing records.';
    $('#col-list').innerHTML = `
      <div class="history" data-history-view="${v}">
        <div class="history__head">
          <h1 class="list__title" id="list-title" tabindex="-1" data-heading>History</h1>
          <p class="list__lede">${lede}</p>
          ${historyTabs('d')}
        </div>
        ${v === 'searches' ? searchesHTML() : watchedHTML()}
      </div>`;
  }

  const scopeLine = (range, dev, id) => `<h2 class="label ledger__scope" id="${id}"><span>Last ${range.days} days</span><span>${fmtSpan(range.start, range.end)}</span><span>${esc(scopeLabel(dev))}</span><span class="ledger__sample">Sample data</span></h2>`;

  function watchedHTML() {
    const dev = ui.history.device;
    const range = historyRange(ui.history.days);
    const sum = historySummary(inScope(state.history, dev, range), range);
    const q = ui.history.q.trim().toLowerCase();
    const matches = (h) => {
      if (!q) return true;
      const v = cat().videos[h.videoId];
      return [v?.title, v?.channelId ? channelName(v.channelId) : '', h.videoId].join(' ').toLowerCase().includes(q);
    };
    const rows = sum.plays.filter(matches).sort((a, b) => b.at - a.at);
    const scopeByDay = byDay(sum.plays);
    const groups = [...byDay(rows).entries()].map(([t, hs]) => {
      const all = scopeByDay.get(t);
      const total = all.reduce((s, h) => s + h.watchedS, 0);
      const shown = q && hs.length < all.length ? `<span class="day__shown">${hs.length} of ${all.length} plays shown</span>` : '';
      return `<section class="day" aria-labelledby="day-${t}">
        ${dayHead(t, `day-${t}`, `${shown}<span class="day__total" data-day-total-s="${total}" title="Wall-clock playback that day on the selected devices, background included">${fmtSpent(total)} watched</span>`)}
        <ol>${hs.map(historyRow).join('')}</ol>
      </section>`;
    }).join('');

    const parts = [[sum.ctx.fg, scopeFront(dev)], [sum.ctx.bg, 'background'], [sum.ctx.un, 'unspecified']].filter(([s]) => s > 0);
    const split = sum.totalS
      ? `<p class="ledger__split" data-ledger-split data-fg-s="${sum.ctx.fg}" data-bg-s="${sum.ctx.bg}" data-un-s="${sum.ctx.un}"><span class="ledger__split-lead">Of that</span>${parts.map(([s, w]) => `<span><b>${fmtSpent(s)}</b> ${w}</span>`).join('')}</p>`
      : '';
    const ledger = `<section class="ledger" aria-labelledby="ledger-scope" data-ledger data-total-s="${sum.totalS}" data-videos="${sum.videos}" data-avg-s="${Math.round(sum.avgS)}" data-days="${sum.days}" data-start="${new Date(range.start).toISOString()}">
        ${scopeLine(range, dev, 'ledger-scope')}
        <dl class="ledger__figures">
          <div class="fig"><dt>Watched</dt><dd class="fig__n">${spentHTML(sum.totalS)}</dd></div>
          <div class="fig"><dt>Distinct videos</dt><dd class="fig__n">${sum.videos}</dd></div>
          <div class="fig"><dt>Per calendar day</dt><dd class="fig__n">${spentHTML(sum.avgS)}</dd><dd class="fig__div">÷ ${range.days} calendar days</dd></div>
        </dl>
        ${split}
        <p class="ledger__note">Period and device set these numbers; the filter only narrows the list. Background playback counts in every total. Calendar days in ${esc(TZ)} (this browser), counting today and days without recorded playback.</p>
      </section>`;
    const empty = !sum.plays.length
      ? `<p class="filter-empty">No recorded playback in the last ${range.days} days on ${esc(scopeLabel(dev))}.</p>`
      : `<p class="filter-empty">Nothing matches “${esc(ui.history.q)}”. <button type="button" class="link-btn" data-action="clear-history">Clear filter</button></p>`;
    return ledger + (groups || empty);
  }

  function searchesHTML() {
    const dev = ui.history.device;
    const range = historyRange(ui.history.days);
    const tvOnly = dev !== 'all' && deviceOf(dev).kind === 'tv';
    const scoped = inScope(state.searches, dev, range).sort((a, b) => b.at - a.at);
    const listed = scoped.slice(0, SEARCH_LIST_LIMIT);
    const q = ui.history.sq.trim().toLowerCase();
    const rows = q ? listed.filter((s) => s.query.toLowerCase().includes(q)) : listed;
    const ledger = `<section class="ledger" aria-labelledby="sledger-scope" data-search-ledger data-count="${tvOnly ? '' : scoped.length}" data-listed="${listed.length}" data-shown="${rows.length}" data-days="${range.days}" data-start="${new Date(range.start).toISOString()}">
        ${scopeLine(range, dev, 'sledger-scope')}
        <dl class="ledger__figures">
          <div class="fig"><dt>Searches</dt><dd class="fig__n">${tvOnly ? '—' : scoped.length}</dd>${tvOnly ? '<dd class="fig__div">not recorded on TVs</dd>' : ''}</div>
        </dl>
        <p class="ledger__note">Recorded by the Chrome collector. OwnTube on Android TV records playback only. Period and device set the count; the filter only narrows the list.</p>
      </section>`;

    let body;
    if (tvOnly) {
      body = `<div class="empty"><p class="empty__title">${esc(dev)} doesn’t record searches.</p>
        <p class="empty__hint">OwnTube on Android TV captures playback only; searches come from Chrome. <button type="button" class="link-btn" data-action="history-all-devices">Show all devices</button></p></div>`;
    } else if (!scoped.length) {
      body = `<div class="empty"><p class="empty__title">No searches recorded in the last ${range.days} days.</p><p class="empty__hint">${range.days < 90 ? 'A longer period may have some.' : 'Searches appear once Chrome records some.'}</p></div>`;
    } else if (!rows.length) {
      body = `<p class="filter-empty">None of the ${listed.length} listed searches match “${esc(ui.history.sq)}”. <button type="button" class="link-btn" data-action="clear-history">Clear filter</button></p>`;
    } else {
      const scopeByDay = byDay(scoped);
      body = [...byDay(rows).entries()].map(([t, ss]) => {
        const all = scopeByDay.get(t).length;
        const shown = ss.length < all ? `<span class="day__shown">${ss.length} of ${all} listed</span>` : '';
        return `<section class="day" aria-labelledby="sday-${t}">
          ${dayHead(t, `sday-${t}`, `${shown}<span class="day__total" data-day-count="${all}">${plural(all, 'search', 'searches')}</span>`)}
          <ol class="srows">${ss.map(searchRow).join('')}</ol>
        </section>`;
      }).join('');
    }
    const status = q && rows.length ? `<p class="history__status" data-search-status>${rows.length} of the ${listed.length} listed searches match “${esc(ui.history.sq)}”.</p>` : '';
    const bound = !tvOnly && scoped.length > listed.length
      ? `<p class="history__bound" data-search-bound>Listing the latest ${listed.length} of ${scoped.length}. Older searches are counted above but not listed; the server currently returns the latest ${SEARCH_LIST_LIMIT}.</p>`
      : '';
    return ledger + status + body + bound;
  }

  function searchRow(s) {
    return `<li class="srow" data-search-id="${esc(s.id)}">
      <time class="srow__time" datetime="${new Date(s.at).toISOString()}">${timeFmt.format(s.at)}</time>
      <p class="srow__query">${ICON.search.replace('<svg', '<svg class="glyph"')}<span class="srow__text">${esc(s.query)}</span></p>
      <p class="srow__source">${esc(deviceText(s.device))}</p>
    </li>`;
  }

  function historyRow(h) {
    const v = cat().videos[h.videoId];
    const doc = state.draft;
    const st = videoState(doc, h.videoId);
    const pubSt = videoState(D.pub, h.videoId);
    const cid = v?.channelId;
    const title = titleOf('video', h.videoId);
    const marks = [];
    const pending = (now, then) => (now !== then ? ' <span class="mark--change">· in draft</span>' : '');
    if (st.suggested) marks.push(`<span class="mark mark--suggest">${ICON.plus}Suggested${pending(st.suggested, pubSt.suggested)}</span>`);
    if (st.blocked) marks.push(`<span class="mark mark--block">${ICON.block}Video blocked${pending(st.blocked, pubSt.blocked)}</span>`);
    else if (st.chBlocked) marks.push(`<span class="mark mark--block">${ICON.block}Channel blocked${pending(st.chBlocked, pubSt.chBlocked)}</span>`);
    else if (pubSt.chBlocked || pubSt.blocked) marks.push('<span class="mark mark--change">Unblocked in draft</span>');
    const actions = [];
    if (!st.suggested) actions.push(`<button type="button" class="btn btn--sm btn--quiet" data-action="suggest" data-kind="video" data-id="${esc(h.videoId)}" data-key="h:${h.id}:suggest">Suggest<span class="vh"> ${esc(title)}</span></button>`);
    if (cid) {
      actions.push(st.chBlocked
        ? `<button type="button" class="btn btn--sm btn--quiet" data-action="unblock" data-kind="channel" data-id="${esc(cid)}" data-key="h:${h.id}:ch">Unblock channel<span class="vh"> ${esc(channelName(cid))}</span></button>`
        : `<button type="button" class="btn btn--sm btn--quiet" data-action="block" data-kind="channel" data-id="${esc(cid)}" data-key="h:${h.id}:ch">Block channel<span class="vh"> ${esc(channelName(cid))}</span></button>`);
    }
    actions.push(`<button type="button" class="btn btn--sm btn--quiet" data-action="evidence" data-history-id="${esc(h.id)}" data-key="h:${h.id}:evidence">Evidence<span class="vh"> for ${esc(title)}</span></button>`);
    const kind = deviceOf(h.device).kind;
    return `<li class="hrow" data-kind="video" data-id="${esc(h.videoId)}" data-history-id="${esc(h.id)}" data-s="${h.watchedS}" data-fg="${ctxOf(h).fg}" data-bg="${ctxOf(h).bg}" data-un="${ctxOf(h).un}">
      <time class="hrow__time" datetime="${new Date(h.at).toISOString()}">${timeFmt.format(h.at)}</time>
      <div class="hrow__media">${videoArt(h.videoId, { progress: h.coverage })}</div>
      <div class="hrow__body">
        <h3 class="hrow__title"><button type="button" data-action="open-item" data-kind="video" data-id="${esc(h.videoId)}" data-key="h:${h.id}:title" ${v?.lang ? `lang="${esc(v.lang)}"` : ''}>${esc(title)}</button></h3>
        <p class="meta">${cid ? `<span>${esc(channelName(cid))}</span>` : ''}<span>${esc(deviceText(h.device))}</span></p>
        ${marks.length ? `<p class="hrow__marks">${marks.join('')}</p>` : ''}
      </div>
      <div class="hrow__side">
        <p class="hrow__numbers">
          <span><b>${fmtSpent(h.watchedS)}</b> watched</span>
          <span class="hrow__ctx" data-ctx-line>${esc(ctxLine(ctxOf(h), kind))}</span>
          <span><b>${Math.round(h.coverage * 100)}%</b> covered</span>
        </p>
        <div class="hrow__actions">${actions.join('')}</div>
      </div>
    </li>`;
  }

  /* ------------------------------------------------------------------ render: evidence */

  const SIGNAL_WORDS = {
    'audio-track': 'the selected audio track', 'asr-caption': 'auto-generated captions', 'native-text': 'Chrome’s text detector',
    'caption-heuristic': 'the caption languages', 'description-heuristic': 'the description (heuristic)',
    'manual-caption': 'manual captions', 'title-heuristic': 'the title (heuristic)', unknown: 'no usable signal',
  };
  const displayNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; } })();
  const langLabel = (code) => {
    if (code === 'und') return '<span class="mono">und</span> <span class="ev__why">“undetermined”, as YouTube reported it</span>';
    let name = '';
    try { name = displayNames?.of(code) || ''; } catch { name = ''; }
    return name && name !== code ? `${esc(name)} <span class="mono">(${esc(code)})</span>` : `<span class="mono">${esc(code)}</span>`;
  };
  const notRecorded = (why) => `<span class="nr">Not recorded</span>${why ? ` <span class="ev__why">· ${why}</span>` : ''}`;
  const facts = (rows) => `<dl class="item__facts ev__facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

  // Re-hash the exact saved text in this browser and compare with the stored evidence ID.
  const digests = new Map();
  async function checkDigest(snap) {
    if (digests.has(snap.id)) return;
    if (!globalThis.crypto?.subtle || !globalThis.TextEncoder) { digests.set(snap.id, 'unavailable'); return; }
    digests.set(snap.id, 'pending');
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snap.raw));
      const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      digests.set(snap.id, hex === snap.id ? 'match' : 'mismatch');
    } catch {
      digests.set(snap.id, 'unavailable');
    }
    const el = $('#dlg-evidence [data-digest-status]');
    if (el && el.dataset.digestFor === snap.id) el.innerHTML = digestText(snap.id);
  }
  const digestText = (id) => ({
    match: '<span class="ev__ok">Matches</span> <span class="ev__why">SHA-256 of the exact text, recomputed in this browser</span>',
    mismatch: '<span class="ev__bad">Does not match</span> <span class="ev__why">the text differs from what this ID names</span>',
    unavailable: notRecorded('can’t be checked here (needs a secure context)'),
  })[digests.get(id)] || '<span class="ev__why">Checking…</span>';

  function openEvidence(historyId, opener) {
    ui.evidence = { historyId, raw: 'exact', rawOpen: false };
    renderEvidence();
    openDialog($('#dlg-evidence'), opener);
  }

  function renderEvidence() {
    const d = $('#dlg-evidence');
    const h = ui.evidence && state.history.find((x) => x.id === ui.evidence.historyId);
    if (!h) return;
    const v = cat().videos[h.videoId];
    const kind = deviceOf(h.device).kind;
    const snap = h.evidenceKey ? F.evidence[h.evidenceKey] : null;
    let ev = null;
    if (snap) { try { ev = JSON.parse(snap.raw); } catch { ev = null; } }
    const android = ev?.collector === 'owntube-source-v1';
    const recordedTitle = titleOf('video', h.videoId);
    const heading = ev?.title || recordedTitle;
    const channel = v?.channelId ? channelName(v.channelId) : null;
    const front = frontWord(kind);

    const collectorLine = !snap ? 'No source snapshot was saved with this play.'
      : android ? 'Snapshot from OwnTube on Android TV (<span class="mono">owntube-source-v1</span>): values as SmartTube exposed them, not untouched YouTube responses.'
        : `Snapshot from the Chrome collector (schema ${esc(ev?.schemaVersion ?? '?')}, <span class="mono">${esc(ev?.algorithmVersion || 'no algorithm version')}</span>).`;

    const context = `<section class="ev__section" aria-labelledby="ev-ctx">
        <h3 class="label" id="ev-ctx">Playback context · this play</h3>
        ${facts([
          [front[0].toUpperCase() + front.slice(1), `<span class="mono" data-ev-fg="${ctxOf(h).fg}">${fmtSpent(ctxOf(h).fg)}</span>`],
          ['Background', `<span class="mono" data-ev-bg="${ctxOf(h).bg}">${fmtSpent(ctxOf(h).bg)}</span>`],
          ['Unspecified', ctxOf(h).un ? `<span class="mono" data-ev-un="${ctxOf(h).un}">${fmtSpent(ctxOf(h).un)}</span> <span class="ev__why">the collector didn’t record context</span>` : `<span class="mono" data-ev-un="0">${fmtSpent(0)}</span>`],
          ['Total', `<span class="mono">${fmtSpent(h.watchedS)}</span> <span class="ev__why">background included</span>`],
        ])}
        <p class="ev__note">One observation on ${esc(deviceText(h.device))}, ${esc(fullFmt.format(h.at))}. ${kind === 'browser' ? 'On-tab means the YouTube tab was visible' : 'Foreground means the player was the app in front'}; neither proves attention.</p>
      </section>`;

    const est = h.estimate;
    const estimate = `<section class="ev__section" aria-labelledby="ev-est">
        <h3 class="label" id="ev-est">Language estimate · derived</h3>
        <p class="ev__lead" data-ev-estimate>${est
          ? `${langLabel(est.lang)} · ${esc(est.conf)} confidence · from ${esc(SIGNAL_WORDS[est.source] || est.source)}`
          : android ? notRecorded('OwnTube on Android TV doesn’t run language analysis (<span class="mono">languageAnalysis: not-run</span>)') : notRecorded()}</p>
        <p class="ev__note">The collector’s estimate of the spoken language, made from the source values below. It is not itself a source value.</p>
      </section>`;

    let body = '';
    if (!snap) {
      body = `<div class="ev__missing" data-ev-missing><p><b>No source snapshot was saved with this play</b>, for example because an older collector recorded it. Title, channel and video ID come from the play record; nothing else is inferred.</p></div>`;
    } else if (!ev) {
      body = `<div class="ev__missing"><p><b>The saved snapshot isn’t valid JSON.</b> Its exact text is below.</p></div>`;
    } else {
      const descAvailable = !(android && ev.descriptionAvailable === false);
      const description = descAvailable && ev.description
        ? `<div class="ev__text" tabindex="0" role="region" aria-label="Saved description" data-ev-description>${esc(ev.description)}</div>
           <p class="ev__note">${ev.descriptionSource && ev.descriptionSource !== 'none' ? `Source <span class="mono">${esc(ev.descriptionSource)}</span> · ` : ''}${ev.description.length.toLocaleString('en')} characters saved${ev.descriptionTruncated ? ' · <b data-ev-truncated>cut by the collector at 10,000 characters</b>' : ''}</p>`
        : `<p class="ev__lead">${notRecorded(android && ev.descriptionAvailable === false ? 'the TV app didn’t expose a description' : 'no description was saved')}</p>`;

      const audio = (value, why) => (value ? langLabel(value) : notRecorded(why));
      const selected = android
        ? (ev.selectedAudioLanguage ? `${langLabel(ev.selectedAudioLanguage)} <span class="ev__why">decoder label (${esc(ev.selectedAudioLanguageSource || 'player')}), not spoken-language detection</span>` : notRecorded())
        : audio(ev.selectedAudioLanguage, 'YouTube reported no selected audio language');
      const fallbackDefault = ev.defaultAudioLanguageStatus === 'not-exposed-by-MediaFormat' ? 'the TV app doesn’t expose it (MediaFormat)' : '';
      const deflt = android ? notRecorded(fallbackDefault) : audio(ev.defaultAudioLanguage, 'YouTube reported no default audio');

      const kindWord = (c) => (c.kind === 'asr' ? 'auto-generated' : c.kind === 'manual' ? 'manual' : 'kind not recorded');
      const captions = !Array.isArray(ev.captions) ? notRecorded()
        : ev.captions.length
          ? `<ul class="ev__tracks">${ev.captions.map((c) => `<li>${c.language ? langLabel(c.language) : notRecorded()} · ${kindWord(c)}${c.name ? ` <span class="ev__why">“${esc(c.name)}”</span>` : ''}</li>`).join('')}</ul>`
          : '<span class="ev__why">No caption tracks listed</span>';
      const omitted = android && ev.captionTranslationOptionsOmitted ? `<p class="ev__note">${ev.captionTranslationOptionsOmitted} translation options were counted and left out.</p>` : '';
      const mapping = android && ev.metadata?.mappingError
        ? `<p class="ev__warn" data-ev-mapping>A metadata getter failed (<span class="mono">${esc(ev.metadata.mappingError)}</span>); the partial values were kept.</p>` : '';

      const sources = `<section class="ev__section" aria-labelledby="ev-src">
          <h3 class="label" id="ev-src">Source values · as saved</h3>
          ${facts([
            ['Saved title', ev.title ? `<span ${v?.lang ? `lang="${esc(v.lang)}"` : ''}>${esc(ev.title)}</span>${android && ev.titleSource ? ` <span class="ev__why mono">${esc(ev.titleSource)}</span>` : ''}` : notRecorded()],
            ['Selected audio', selected],
            ['Default audio', deflt],
            ['Caption tracks', captions + omitted],
          ])}
          ${mapping}
          <h4 class="ev__sub">Description</h4>
          ${description}
          <p class="ev__note">Caption tracks are what YouTube listed; caption text was not saved, so there is no transcript.</p>
        </section>`;

      const t = ev.text;
      const detector = t
        ? `<section class="ev__section" aria-labelledby="ev-det">
            <h3 class="label" id="ev-det">Text detector · estimate from text</h3>
            ${facts([
              ['Estimate', t.language ? `${langLabel(t.language)}${t.confidence != null ? ` <span class="mono">${Math.round(t.confidence * 100)}%</span>` : ''}` : notRecorded()],
              ['Engine', t.engine ? `<span class="mono">${esc(t.engine)}</span>` : notRecorded()],
              ['Input', t.input ? esc(t.input) : notRecorded()],
              ['Status', t.status ? `<span class="mono">${esc(t.status)}</span>` : notRecorded()],
              ['Algorithm', ev.algorithmVersion ? `<span class="mono">${esc(ev.algorithmVersion)}</span>` : notRecorded()],
              ['Candidates', Array.isArray(t.candidates) && t.candidates.length ? `<span class="mono">${t.candidates.map((c) => `${esc(c.language)} ${Math.round(c.confidence * 100)}%`).join(' · ')}</span>` : '<span class="ev__why">None returned</span>'],
            ])}
            <p class="ev__note">A detector reads written text. The language of a description is not the spoken language.</p>
          </section>`
        : `<section class="ev__section" aria-labelledby="ev-det">
            <h3 class="label" id="ev-det">Text detector</h3>
            <p class="ev__lead">${notRecorded(android ? 'not run on OwnTube TV' : '')}</p>
          </section>`;
      body = sources + detector;
    }

    let raw = '';
    if (snap) {
      const formatted = ev ? JSON.stringify(ev, null, 2) : snap.raw;
      const mode = ui.evidence.raw;
      raw = `<details class="ev__raw" ${ui.evidence.rawOpen ? 'open' : ''}>
          <summary>Raw source snapshot</summary>
          ${facts([
            ['Evidence ID', `<code class="ev__id" data-evidence-id>${esc(snap.id)}</code> <button type="button" class="link-btn" data-action="copy" data-text="${esc(snap.id)}">Copy</button>`],
            ['Digest', `<span data-digest-status data-digest-for="${esc(snap.id)}">${digestText(snap.id)}</span>`],
            ['Size', `<span class="mono">${new TextEncoder().encode(snap.raw).length.toLocaleString('en')} bytes</span>`],
          ])}
          <div class="seg ev__mode" role="group" aria-label="Snapshot text">
            <button type="button" aria-pressed="${mode === 'exact'}" data-action="raw-mode" data-value="exact" data-key="ev:raw-exact">Exact text</button>
            <button type="button" aria-pressed="${mode === 'formatted'}" data-action="raw-mode" data-value="formatted" data-key="ev:raw-formatted">Formatted</button>
          </div>
          <pre class="ev__rawtext" tabindex="0" aria-label="${mode === 'exact' ? 'Exact saved snapshot text' : 'Snapshot re-encoded for reading'}"><code data-raw="${mode}">${esc(mode === 'exact' ? snap.raw : formatted)}</code></pre>
          <p class="ev__note">The digest covers the exact text. “Formatted” re-encodes it for reading and is not byte-identical. Each play keeps the snapshot saved with it; earlier snapshots of a video stay stored, but there is no revision browser yet.</p>
        </details>`;
      checkDigest(snap);
    }

    setDialogHTML(d, `
      <div class="dialog__head">
        <h2 id="evidence-title"><span class="label" style="display:block;margin-bottom:6px" aria-hidden="true">Evidence · this play</span><span class="vh">Evidence for </span><span ${v?.lang ? `lang="${esc(v.lang)}"` : ''}>${esc(heading)}</span></h2>
        <button type="button" class="icon-btn dialog__close" data-action="close-dialog" data-key="ev:close" aria-label="Close evidence">${ICON.close}</button>
      </div>
      <div class="dialog__body">
        <p class="ev__meta">${channel ? `<span>${esc(channel)}</span>` : ''}<span class="mono">${esc(h.videoId)}</span><span>${esc(deviceText(h.device))}</span><span>${esc(fullFmt.format(h.at))}</span></p>
        ${ev?.title && ev.title !== recordedTitle ? `<p class="ev__note">The play record’s title is “${esc(recordedTitle)}”.</p>` : ''}
        <p class="notice ev__notice" data-ev-collector><span><strong>Saved evidence, not a fresh YouTube lookup.</strong> ${collectorLine}</span></p>
        ${context}${estimate}${body}${raw}
      </div>
      <div class="ev__foot"><span class="ev__why">Saved evidence · sample data</span><button type="button" class="btn btn--sm" data-action="close-dialog" data-key="ev:done">Done</button></div>`);
  }

  /* ------------------------------------------------------------------ dialogs */

  // Dialog contents are re-rendered wholesale; keep the live regions that may be parked inside.
  function setDialogHTML(d, html) {
    const parked = ['toasts', 'sr'].map((id) => document.getElementById(id)).filter((el) => el && d.contains(el));
    d.innerHTML = html;
    parked.forEach((el) => d.appendChild(el));
  }

  const openers = new WeakMap();
  function openDialog(d, opener) {
    openers.set(d, opener || document.activeElement);
    if (!d.open) d.showModal();
  }
  function closeAllDialogs() { $$('dialog[open]').forEach((d) => d.close()); }
  for (const d of $$('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    d.addEventListener('close', () => {
      if (d.id === 'dlg-item') ui.item = null;
      if (d.id === 'dlg-evidence') ui.evidence = null;
      if (d.id === 'dlg-publish') ui.confirmDiscard = false;
      placeLive();
      const o = openers.get(d);
      if (o && o.isConnected) o.focus({ preventScroll: true });
      else {
        const k = o?.getAttribute?.('data-key');
        const again = k && $(`[data-key="${CSS.escape(k)}"]`);
        if (again) again.focus({ preventScroll: true });
      }
    });
  }

  /* ------------------------------------------------------------------ toast */

  let toastTimer = null;
  let toastRun = null;
  // A modal dialog makes the rest of the page inert, so live regions and the Undo button must
  // live inside the top-most open dialog while one is open.
  function placeLive() {
    const host = $$('dialog[open]').pop() || document.body;
    for (const id of ['toasts', 'sr']) {
      const el = document.getElementById(id);
      if (el.parentElement !== host) host.appendChild(el);
    }
  }
  function toast(msg, { action, run } = {}) {
    placeLive();
    const box = $('#toasts');
    toastRun = run || null;
    box.innerHTML = `<div class="toast"><span class="toast__msg">${esc(msg)}</span>${action ? `<button type="button" class="toast__btn" data-action="toast-run">${esc(action)}</button>` : ''}<button type="button" class="toast__close" data-action="toast-close" aria-label="Dismiss">${ICON.close}</button></div>`;
    armToast(action ? 9000 : 5000);
  }
  function armToast(ms) {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      const t = $('#toasts .toast');
      if (t && (t.matches(':hover') || t.contains(document.activeElement))) { armToast(2000); return; }
      $('#toasts').innerHTML = '';
      toastRun = null;
    }, ms);
  }
  function say(msg) {
    placeLive();
    const sr = $('#sr');
    sr.textContent = '';
    setTimeout(() => { sr.textContent = msg; }, 30);
  }

  /* ------------------------------------------------------------------ events */

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const a = el.dataset.action;
    const { kind, id, list } = el.dataset;
    switch (a) {
      case 'open-item': {
        if (el.closest('.tv')) ui.tvFocus = el.dataset.key.split(':').slice(1).join(':');
        openItem(kind, id, el.dataset.from, el);
        break;
      }
      case 'suggest': suggest(kind, id); break;
      case 'unsuggest': removeFrom(suggestKey(kind), id); break;
      case 'block': block(kind, id); break;
      case 'unblock': removeFrom(blockKey(kind), id); break;
      case 'remove': {
        const rows = $$('#rows .row:not(.row--ghost)');
        const i = rows.findIndex((r) => r.dataset.id === id);
        const next = rows[i + 1] || rows[i - 1];
        const focus = next ? `row:${list}:${next.dataset.id}:remove` : 'list:title';
        if (removeFrom(list, id)) preserve(() => {}, focus);
        break;
      }
      case 'move': {
        const delta = Number(el.dataset.delta);
        if (move(list, id, delta)) {
          const inDialog = el.closest('dialog');
          const k = inDialog ? el.dataset.key : `row:${list}:${id}:${delta < 0 ? 'up' : 'down'}`;
          let target = $(`[data-key="${CSS.escape(k)}"]`);
          if (!inDialog && target?.disabled) target = $(`[data-key="${CSS.escape(`row:${list}:${id}:${delta < 0 ? 'down' : 'up'}`)}"]`);
          if (target && !target.disabled) target.focus({ preventScroll: false });
        }
        break;
      }
      case 'note-edit': ui.editing = `${list}:${id}`; renderList(); $(`[data-key="${CSS.escape(`note:${list}:${id}`)}"]`)?.focus(); break;
      case 'note-cancel': { const k = ui.editing; ui.editing = null; renderList(); if (k) $(`[data-key="${CSS.escape(`row:${k}:note`)}"]`)?.focus(); break; }
      case 'note-save': {
        const ta = $(`[data-key="${CSS.escape(`note:${list}:${id}`)}"]`);
        ui.editing = null;
        if (!setNote(list, id, ta ? ta.value : '')) renderList();
        $(`[data-key="${CSS.escape(`row:${list}:${id}:note`)}"]`)?.focus();
        break;
      }
      case 'item-note-save': {
        const ta = $('#item-note');
        if (ui.item) ui.item.noteDraft = null;
        if (!setNote(list, id, ta ? ta.value : '')) toast('Note unchanged.');
        break;
      }
      case 'revert': revertChange(el.dataset.change); break;
      case 'open-publish': renderPublish(); openDialog($('#dlg-publish'), el); break;
      case 'publish': publishDraft(); break;
      case 'discard': ui.confirmDiscard = true; renderPublish(); $('[data-key="pub:discard-confirm"]')?.focus(); break;
      case 'discard-cancel': ui.confirmDiscard = false; renderPublish(); $('[data-key="pub:discard"]')?.focus(); break;
      case 'discard-confirm': discardDraft(); $('[data-key="publish:done"]')?.focus(); break;
      case 'restore': restoreRevision(Number(el.dataset.n)); break;
      case 'close-dialog': el.closest('dialog')?.close(); break;
      case 'monitor-mode': ui.monitorMode = el.dataset.mode; render(); break;
      case 'open-tv': renderTvDialog(); openDialog($('#dlg-tv'), el); $('#dlg-tv .card__hit[tabindex="0"]')?.focus(); break;
      case 'open-about': renderAbout(); openDialog($('#dlg-about'), el); break;
      case 'reset': ui.confirmReset = true; renderProto(); $('[data-key="proto:reset-confirm"]')?.focus(); break;
      case 'reset-cancel': ui.confirmReset = false; renderProto(); $('[data-key="proto:reset"]')?.focus(); break;
      case 'reset-confirm': resetSample(); break;
      case 'add-commit': addCommit(el.dataset.verb); break;
      case 'clear-filter': ui.filter[ui.list] = ''; renderList(); $('#filter')?.focus(); break;
      case 'clear-history': ui.history[ui.history.view === 'searches' ? 'sq' : 'q'] = ''; render(); $('#hq')?.focus(); break;
      case 'history-all-devices': ui.history.device = 'all'; render(); $('#hdev')?.focus(); break;
      case 'evidence': openEvidence(el.dataset.historyId, el); break;
      case 'raw-mode': if (ui.evidence) { ui.evidence.raw = el.dataset.value === 'formatted' ? 'formatted' : 'exact'; ui.evidence.rawOpen = true; renderEvidence(); $(`[data-key="ev:raw-${ui.evidence.raw}"]`)?.focus(); } break;
      case 'history-days': ui.history.days = Number(el.dataset.value) || 7; render(); break;
      case 'toast-run': { const r = toastRun; $('#toasts').innerHTML = ''; toastRun = null; if (r) r(); break; }
      case 'toast-close': $('#toasts').innerHTML = ''; toastRun = null; break;
      case 'copy': {
        const text = el.dataset.text;
        (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast(`Copied ${text}.`), () => toast(`Copy failed. The ID is ${text}.`));
        break;
      }
      case 'pref-thumbs': prefs.remoteThumbs = el.dataset.value === 'on'; persistPrefs(); render(); break;
      case 'pref-theme': {
        prefs.theme = el.dataset.value;
        persistPrefs();
        if (prefs.theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = prefs.theme;
        renderAbout();
        $(`[data-key="about:theme-${prefs.theme}"]`)?.focus();
        break;
      }
      default: break;
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'add-input') { ui.add.text = t.value; ui.add.choice = 0; updateAddOutput(); return; }
    if (t.dataset.action === 'filter') { ui.filter[ui.list] = t.value; $('#rows').innerHTML = rowsHTML(); const note = $('.toolbar__note'); if (LISTS[ui.list].ordered && !!t.value !== !!note) preserve(renderList); return; }
    if (t.dataset.action === 'history-q') { ui.history[ui.history.view === 'searches' ? 'sq' : 'q'] = t.value; preserve(renderHistory); return; }
    if (t.id === 'pub-note') { ui.publishNote = t.value; return; }
    if (t.id === 'item-note' && ui.item) { ui.item.noteDraft = t.value; }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    const a = t.dataset.action;
    if (a === 'toggle-hidden') { ui.showHidden = t.checked; render(); }
    else if (a === 'sort') { ui.sort[ui.list] = t.value; renderList(); $('#sort')?.focus(); }
    else if (a === 'history-device') { ui.history.device = t.value; renderHistory(); }
    else if (a === 'add-choice') { ui.add.choice = Number(t.value); updateAddOutput(); $(`[data-key="add:choice:${t.value}"]`)?.focus(); }
  });

  // Pointing at a rule lights what it affects on the TV; pointing at a card lights its rule.
  let lightTimer = null;
  function lightFromRow(row) {
    if (!row || row.classList.contains('row--ghost')) return;
    const cards = lightCards(row.dataset.kind, row.dataset.id, row.dataset.list);
    clearTimeout(lightTimer);
    if (cards.length) lightTimer = setTimeout(() => revealCard(cards[0]), 140);
  }
  document.addEventListener('mouseover', (e) => {
    const row = e.target.closest('#rows .row');
    if (row) { if (!row.contains(e.relatedTarget)) lightFromRow(row); return; }
    const card = e.target.closest('#col-monitor .card');
    if (card && !card.contains(e.relatedTarget)) {
      $$('#rows .row.is-lit').forEach((r) => r.classList.remove('is-lit'));
      const { video, channel, channelTile, playlist } = card.dataset;
      for (const r of $$('#rows .row')) {
        const k = r.dataset.kind, i = r.dataset.id;
        if ((k === 'video' && i === video) || (k === 'channel' && (i === channel || i === channelTile)) || (k === 'playlist' && i === playlist)) r.classList.add('is-lit');
      }
    }
  });
  document.addEventListener('mouseout', (e) => {
    const row = e.target.closest('#rows .row');
    if (row && !row.contains(e.relatedTarget)) { clearTimeout(lightTimer); clearLight(); }
    const card = e.target.closest('#col-monitor .card');
    if (card && !card.contains(e.relatedTarget)) $$('#rows .row.is-lit').forEach((r) => r.classList.remove('is-lit'));
  });
  document.addEventListener('focusin', (e) => {
    const row = e.target.closest('#rows .row');
    if (row) lightFromRow(row);
    const hit = e.target.closest('.card__hit');
    if (hit) {
      ui.tvFocus = hit.dataset.key.split(':').slice(1).join(':');
      const tv = hit.closest('.tv');
      $$('.card__hit[tabindex="0"]', tv).forEach((h) => { if (h !== hit) h.tabIndex = -1; });
      hit.tabIndex = 0;
    }
  });
  document.addEventListener('focusout', (e) => {
    const row = e.target.closest('#rows .row');
    if (row && !row.contains(e.relatedTarget)) { clearTimeout(lightTimer); clearLight(); }
  });

  // Keep the raw-snapshot disclosure open across re-renders (e.g. after the digest check).
  document.addEventListener('toggle', (e) => { if (e.target.matches?.('.ev__raw') && ui.evidence) ui.evidence.rawOpen = e.target.open; }, true);

  // Broken or missing remote thumbnails fall back to the placeholder underneath.
  document.addEventListener('error', (e) => { if (e.target.matches?.('img[data-thumb]')) e.target.remove(); }, true);
  document.addEventListener('load', (e) => {
    const img = e.target;
    if (img.matches?.('img[data-thumb]') && img.naturalWidth === 120 && img.naturalHeight === 90) img.remove(); // YouTube's "no thumbnail" image
  }, true);

  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  document.addEventListener('keydown', (e) => {
    const t = e.target;

    // Note editors
    if (t.matches?.('textarea[data-key^="note:"]')) {
      const [, list, ...rest] = t.dataset.key.split(':');
      const id = rest.join(':');
      if (e.key === 'Escape') { e.preventDefault(); ui.editing = null; renderList(); $(`[data-key="${CSS.escape(`row:${list}:${id}:note`)}"]`)?.focus(); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ui.editing = null; if (!setNote(list, id, t.value)) renderList(); $(`[data-key="${CSS.escape(`row:${list}:${id}:note`)}"]`)?.focus(); return; }
      return;
    }
    if (t.id === 'add-input' && e.key === 'Enter') { e.preventDefault(); $('[data-key="add:suggest"]:not(:disabled), [data-key="add:block"]:not(:disabled)')?.focus(); return; }
    if (t.id === 'add-input' && e.key === 'Escape' && t.value) { e.preventDefault(); t.value = ''; ui.add.text = ''; updateAddOutput(); return; }

    // TV preview: arrows move like a remote.
    const hit = t.closest?.('.card__hit');
    if (hit && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const tv = hit.closest('.tv');
      const visible = (el) => el.offsetParent !== null;
      const shelves = $$('.shelf', tv).map((s) => $$('.card__hit', s).filter(visible)).filter((s) => s.length);
      const si = shelves.findIndex((s) => s.includes(hit));
      const ci = shelves[si].indexOf(hit);
      let target = null;
      if (e.key === 'ArrowRight') target = shelves[si][ci + 1];
      if (e.key === 'ArrowLeft') target = shelves[si][ci - 1];
      if (e.key === 'Home') target = shelves[si][0];
      if (e.key === 'End') target = shelves[si][shelves[si].length - 1];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const row = shelves[si + (e.key === 'ArrowDown' ? 1 : -1)];
        if (row) {
          const x = hit.getBoundingClientRect().left;
          target = row.reduce((best, c) => (Math.abs(c.getBoundingClientRect().left - x) < Math.abs(best.getBoundingClientRect().left - x) ? c : best), row[0]);
        }
      }
      if (target) {
        hit.tabIndex = -1;
        target.tabIndex = 0;
        target.focus({ preventScroll: true });
        target.closest('.card').scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
      return;
    }

    // Alt+↑/↓ reorders the focused suggestion.
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const row = t.closest?.('#rows .row:not(.row--ghost)');
      if (row && LISTS[row.dataset.list]?.ordered && !(ui.filter[row.dataset.list] || '').trim()) {
        e.preventDefault();
        const delta = e.key === 'ArrowUp' ? -1 : 1;
        const key = t.dataset.key;
        if (move(row.dataset.list, row.dataset.id, delta)) {
          const again = key && $(`[data-key="${CSS.escape(key)}"]`);
          (again && !again.disabled ? again : $(`[data-key="${CSS.escape(`row:${row.dataset.list}:${row.dataset.id}:title`)}"]`))?.focus();
        }
      }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing(t)) { e.preventDefault(); undoLast(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || typing(t) || $('dialog[open]')) return;

    const k = e.key;
    if (k === '/') {
      const f = ui.view === 'history' ? $('#hq') : $('#filter');
      if (f && f.offsetParent) { e.preventDefault(); f.focus(); f.select(); }
    } else if (k === 'a' || k === 'A') {
      if (ui.view === 'tv' || ui.view === 'history') return;
      if (isSmall() && ui.pane !== 'index') { location.hash = '#/curation'; setTimeout(() => $('#add-input')?.focus(), 0); }
      else { e.preventDefault(); $('#add-input')?.focus(); }
    } else if (k === 'p' || k === 'P') { e.preventDefault(); renderPublish(); openDialog($('#dlg-publish'), document.activeElement); }
    else if (k === 'h' || k === 'H') { if (ui.view !== 'history') { ui.showHidden = !ui.showHidden; render(); say(ui.showHidden ? 'Showing hidden items in the TV preview.' : 'Hidden items are hidden again.'); } }
    else if (k === '?') { renderAbout(); openDialog($('#dlg-about'), document.activeElement); }
    else if (/^[1-5]$/.test(k)) { location.hash = listHref(LIST_KEYS[Number(k) - 1]); }
  });

  window.addEventListener('hashchange', () => {
    const prevView = ui.view, prevList = ui.list, prevPane = ui.pane, prevHistory = ui.history.view;
    const fromTabs = document.activeElement?.closest?.('.htabs');
    applyRoute();
    render();
    if (ui.view === 'history' && prevView === 'history' && prevHistory !== ui.history.view) {
      // Switching Watched/Searches keeps focus on the switch and says what changed.
      if (fromTabs) $$(`[data-key$=":${ui.history.view}"].htabs__tab`).find((a) => a.offsetParent)?.focus({ preventScroll: true });
      say(ui.history.view === 'searches' ? 'Searches.' : 'Watched.');
      return;
    }
    if (prevView !== ui.view || prevList !== ui.list || prevPane !== ui.pane) {
      $('#col-list').scrollTop = 0;
      if (isSmall()) window.scrollTo(0, 0);
      // Keyboard users moving through the list index keep their place; everyone else lands on the heading.
      const fromIndex = document.activeElement?.closest?.('.col--index');
      if (ui.view === 'curation' && !(isSmall() && ui.pane === 'index')) {
        const L = LISTS[ui.list];
        say(`${L.title}, ${plural(listOf(state.draft, ui.list).length, L.noun)}.`);
        if (!fromIndex) $('#list-title')?.focus({ preventScroll: true });
      } else if (ui.view === 'history') {
        if (!fromIndex) $$('[data-heading]').find((h) => h.offsetParent)?.focus({ preventScroll: true });
      }
    }
  });

  for (const q of ['(max-width: 859px)', '(min-width: 1180px)']) {
    matchMedia(q).addEventListener('change', () => { applyRoute(); render(); });
  }

  // Another tab edited the preview: adopt its state instead of silently overwriting it later.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORE_KEY) return;
    const next = e.newValue ? JSON.parse(e.newValue) : null;
    if (!valid(next)) return;
    state = next;
    undoStack.length = 0;
    render();
    toast('Updated from another tab.');
  });

  /* ------------------------------------------------------------------ start */

  // Write back a fresh, migrated or reseeded state once, so other tabs and later loads see schema 2.
  if (loadedSchema !== SCHEMA || !valid(readJSON(STORE_KEY))) persist();
  applyRoute();
  render();
})();
