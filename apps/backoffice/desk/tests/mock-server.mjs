// In-process mock of contracts/history.md for the desk check. Fictional fixtures only, owner auth,
// recorded requests, and injected delays and failures. Serves the desk at "/" like production and
// stubs the pages it links to. Not shipped.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const KEY = 'correct horse battery';
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// Calendar helpers in an IANA zone, without libraries.
export function zone(tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const parts = (ms) => Object.fromEntries(dtf.formatToParts(ms).map((p) => [p.type, p.value]));
  const offset = (ms) => { const p = parts(ms); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000; };
  const date = (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
  const at = (day, hh, mm, ss = 0) => {
    const [y, mo, d] = day.split('-').map(Number);
    const guess = Date.UTC(y, mo - 1, d, hh, mm, ss);
    const first = guess - offset(guess);
    return guess - offset(first);
  };
  const addDays = (day, n) => { const [y, mo, d] = day.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10); };
  const label = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms).replace(',', ' ·');
  return { date, at, addDays, label };
}

const chrome = (title, description, extra = {}) => JSON.stringify({
  schemaVersion: 1, algorithmVersion: 'language-v2', title, description, descriptionSource: 'videoDetails.shortDescription', descriptionTruncated: false,
  selectedAudioLanguage: 'en', defaultAudioLanguage: 'en', captions: [{ language: 'en', kind: 'asr' }],
  text: { engine: 'chrome-language-detector', status: 'available', input: 'description', language: 'en', confidence: 0.93, candidates: [{ language: 'en', confidence: 0.93 }] },
  ...extra,
});
const android = (videoId, title, description, extra = {}) => JSON.stringify({
  schemaVersion: 1, collector: 'owntube-source-v1', videoId, languageAnalysis: 'not-run', defaultAudioLanguageStatus: 'not-exposed-by-MediaFormat',
  title, description, titleSource: 'MediaItemMetadata.getTitle', descriptionAvailable: true, descriptionTruncated: false,
  captions: [{ language: 'de', kind: 'asr' }], captionCount: 1, captionTranslationOptionsOmitted: 120,
  selectedAudioLanguage: 'de', selectedAudioLanguageSource: 'SimpleExoPlayer.getAudioFormat.language (player-normalized)', ...extra,
});

export function createFixtures(tz = 'Europe/Zurich') {
  const z = zone(tz);
  const today = z.date(Date.now());
  const day = (n) => z.addDays(today, -n);
  const people = [{ id: 'p-owner', name: 'Owner' }, { id: 'p-guest', name: 'Guest' }];
  const devices = [
    { id: 'd-living', label: 'Living room TV', personId: 'p-owner', person: 'Owner', kind: 'tv', searchCapability: 'not-recorded', revoked: false },
    { id: 'd-laptop', label: 'Laptop', personId: 'p-owner', person: 'Owner', kind: 'browser', searchCapability: 'recorded', revoked: false },
    { id: 'd-bedroom', label: 'Bedroom TV', personId: 'p-guest', person: 'Guest', kind: 'tv', searchCapability: 'not-recorded', revoked: false },
    { id: 'd-shared', label: 'Shared Chromebook in the hallway', personId: 'p-guest', person: 'Guest', kind: 'mixed', searchCapability: 'recorded', revoked: false },
    { id: 'd-tablet', label: 'Tablet in the guest apartment upstairs (unpaired profile two)', personId: null, person: '', kind: 'unknown', searchCapability: 'unknown', revoked: false },
    { id: 'd-oldphone', label: 'Old phone', personId: 'p-owner', person: 'Owner', kind: 'browser', searchCapability: 'recorded', revoked: true },
  ];
  const byId = Object.fromEntries(devices.map((d) => [d.id, d]));

  // Evidence: id → exact text. "mismatch" is stored under an ID that names different text.
  const evidence = {};
  const keep = (text, id = sha256(text)) => { evidence[id] = text; return id; };
  const ev = {
    chrome1: keep(chrome('How Tarkovsky films a room: the long take in Stalker', 'A close reading of one room in Stalker.\nThe camera barely moves for four minutes.')),
    chrome2: keep(chrome('One-minute dashi', 'Kombu, katsuobushi, one minute.', { selectedAudioLanguage: 'ja', defaultAudioLanguage: 'ja' })),
    chrome3: keep(chrome('Restoration_notes_without_any_spaces_in_the_title_whatsoever_for_wrapping_checks', 'Long names on purpose.')),
    chrome4a: keep(chrome('Derby notes: what changed after the red card', 'First upload.')),
    chrome4b: keep(chrome('Derby notes: what changed after the red card (revised)', 'Revised description after the uploader edited it.')),
    chrome5: keep(chrome('Sharpening a plane iron by hand', 'Flat back, consistent bevel, no burr.')),
    android1: keep(android('mockZahnrd1', 'Wie funktioniert eine Zahnradbahn? Rigi, Pilatus und die Technik dahinter', 'Wie Zahnradbahnen steile Strecken schaffen.', { metadata: { mappingError: 'getDescription: NullPointerException' } })),
    android2: keep(android('mockMidnit1', 'Night train to Belgrade, part 2', 'Overnight from Zürich.')),
    xss: keep(chrome('<img src=x onerror="window.__deskXss=4"> Hostile & title', '</pre><script>window.__deskXss=2</script> & <b>bold</b> <img src=x onerror="window.__deskXss=5">')),
    mismatch: keep(chrome('Zwei Sprachen, ein Tisch', 'Ein Gespräch, das zwischen Deutsch und Serbisch wechselt.'), sha256('a different text')),
    invalid: keep('{"schemaVersion":1,"title":"Cut off in the middle'),
  };

  const rows = [];
  const add = (spec) => {
    const [id, deviceId, n, first, last, videoId, title, channel, fg, bg, un, duration, covered, complete, evKey, extra = {}] = spec;
    const d = day(n);
    const [fh, fm] = first.split(':').map(Number);
    const [lh, lm] = last.split(':').map(Number);
    const dev = byId[deviceId];
    const pct = duration && covered != null ? Math.min(100, (covered / duration) * 100) : null;
    rows.push({
      id, deviceId, deviceLabel: dev.label, deviceKind: dev.kind, personId: dev.personId, person: dev.person,
      viewingId: extra.rowKind === 'legacy-day' ? null : extra.viewingId || `v-${id}`, metadataId: extra.metadataId || `m-${videoId}-${evKey || 'none'}`,
      videoId, title, channel, isShort: !!extra.isShort, durationSeconds: duration, evidenceId: evKey ? ev[evKey] : null,
      recorded: extra.recorded || (dev.kind === 'tv' ? { lang: '', source: 'android-player', conf: '' } : { lang: 'en', source: 'audio-track', conf: 'high' }),
      date: d, firstWatched: z.at(d, fh, fm), lastWatched: z.at(d, lh, lm, 30), seconds: fg + bg + un,
      foregroundSeconds: fg, backgroundSeconds: bg, unspecifiedSeconds: un,
      coveredSeconds: covered, coveragePercent: pct, coverageComplete: complete !== false, rowKind: extra.rowKind || 'viewing-version',
    });
  };
  // Today: every source kind, every coverage state, hostile and long text, both evidence failures.
  add(['w-t1', 'd-laptop', 0, '19:40', '20:05', 'mockLaptop1', 'How Tarkovsky films a room: the long take in Stalker', 'The Long Take', 1200, 300, 0, 1800, 1500, true, 'chrome1']);
  add(['w-t2', 'd-living', 0, '18:00', '18:50', 'mockZahnrd1', 'Wie funktioniert eine Zahnradbahn? Rigi, Pilatus und die Technik dahinter', 'Alpine Rail Archive', 3000, 0, 0, 3600, 3000, true, 'android1']);
  add(['w-t3', 'd-tablet', 0, '17:10', '17:30', 'mockTablet1', 'Four hours on the Rhine: Basel to Strasbourg, no narration', 'Slow Rivers', 0, 0, 1200, null, 900, true, null, { recorded: { lang: '', source: '', conf: '' } }]);
  add(['w-t4', 'd-laptop', 0, '16:00', '16:01', 'mockShort01', 'One-minute dashi', 'Kitchen Notes', 45, 0, 0, 58, 45, true, 'chrome2', { isShort: true }]);
  add(['w-t5', 'd-shared', 0, '15:00', '15:40', 'mockShared1', 'Zwei Sprachen, ein Tisch', 'Map Room', 1500, 900, 0, 2700, 1080, false, 'mismatch']);
  add(['w-t6', 'd-laptop', 0, '14:00', '14:03', 'mockHostil1', '<img src=x onerror="window.__deskXss=1"> Hostile & title', '<b>Bold channel</b>', 200, 0, 0, null, null, null, 'xss']);
  add(['w-t7', 'd-living', 0, '00:20', '00:35', 'mockMidnit1', 'Night train to Belgrade, part 2', 'Rail Nights', 900, 0, 0, 5400, 1800, true, 'android2', { viewingId: 'v-midnight', metadataId: 'm-midnight' }]);
  add(['w-t8', 'd-bedroom', 0, '12:00', '12:30', 'mockInvald1', 'Rijaliti: ko je ispao sinoć? Sve što ste propustili', 'Rijaliti danas', 0, 0, 1800, 1900, 1800, true, 'invalid']);
  add(['w-t9', 'd-laptop', 0, '11:00', '11:05', 'mockLongNm1', 'Restoration_notes_without_any_spaces_in_the_title_whatsoever_for_wrapping_checks', 'Restoration_and_repair_notes_from_a_small_workshop_in_the_alps', 300, 0, 0, 300, 300, true, 'chrome3']);
  add(['w-t10', 'd-tablet', 0, '10:00', '10:20', 'mockTablet2', 'Unboxing 47 mystery boxes from an auction', 'Unboxing Loop', 1200, 0, 0, 2642, 6, true, null]);
  // Yesterday: the first half of the midnight viewing and a metadata change mid-viewing.
  add(['w-y1', 'd-living', 1, '23:40', '23:59', 'mockMidnit1', 'Night train to Belgrade, part 2', 'Rail Nights', 1140, 0, 0, 5400, 1140, true, 'android2', { viewingId: 'v-midnight', metadataId: 'm-midnight' }]);
  add(['w-y2', 'd-laptop', 1, '20:10', '20:25', 'mockMetaChg', 'Derby notes: what changed after the red card (revised)', 'Derby Notes', 900, 0, 0, 1500, 900, true, 'chrome4b', { viewingId: 'v-meta', metadataId: 'm-meta-b' }]);
  add(['w-y3', 'd-laptop', 1, '20:00', '20:10', 'mockMetaChg', 'Derby notes: what changed after the red card', 'Derby Notes', 600, 0, 0, 1500, 600, true, 'chrome4a', { viewingId: 'v-meta', metadataId: 'm-meta-a' }]);
  const fill = [
    ['Gotthard-Bergstrecke im Winter: Führerstandsmitfahrt', 'Alpine Rail Archive', 'd-living'], ['Kako se pravi pravi ajvar — recept moje bake', 'Kuhinja kod Mire', 'd-laptop'],
    ['Ђердапска клисура из ваздуха', 'Дунавски записи', 'd-bedroom'], ['Le métier de luthier : une guitare en douze semaines', 'Atelier Bois', 'd-shared'],
    ['I restored a 1962 lathe', 'Small Workshop', 'd-laptop'], ['Brahms im Wohnzimmer: Klarinettentrio a-Moll', 'Hausmusik am Sonntag', 'd-living'],
    ['Warum Eis glatt ist', 'Physik im Alltag', 'd-bedroom'], ['Dashi from scratch: kombu and katsuobushi', 'Kitchen Notes', 'd-shared'],
    ['Swiss rail in winter: cab ride over the pass', 'Alpine Rail Archive', 'd-tablet'],
  ];
  let k = 0;
  const filler = (n, hour) => {
    const [title, channel, deviceId] = fill[k % fill.length];
    const id = `w-f${String(++k).padStart(2, '0')}`;
    const hh = String(hour).padStart(2, '0');
    add([id, deviceId, n, `${hh}:05`, `${hh}:35`, `mockFill${String(k).padStart(3, '0')}`, title, channel, 1200, k % 3 === 0 ? 300 : 0, k % 4 === 0 ? 300 : 0, 2400, 1500, true, k % 2 ? 'chrome5' : null]);
  };
  for (let h = 19; h >= 11; h--) filler(1, h); // nine more yesterday: twelve in all
  // Two days ago: records from an older collector, grouped per day.
  add(['w-l1', 'd-laptop', 2, '09:12', '21:47', 'mockLegacy1', 'Sharpening a plane iron by hand', 'Small Workshop', 0, 0, 1460, 1046, 1046, true, 'chrome5', { rowKind: 'legacy-day' }]);
  add(['w-l2', 'd-laptop', 2, '08:30', '19:05', 'mockLegacy2', 'Derby notes: the season so far', 'Derby Notes', 0, 0, 700, 1500, 300, false, null, { rowKind: 'legacy-day' }]);
  add(['w-l3', 'd-shared', 2, '07:00', '07:40', 'mockLegacy3', 'Morning news in sign language', 'News Desk', 600, 0, 600, 2400, 1200, true, null, { rowKind: 'legacy-day' }]);
  for (const h of [16, 14, 12]) filler(2, h);
  for (const h of [21, 18, 15, 12, 9]) filler(3, h);
  // Four days ago stays empty: a calendar day without recorded playback.
  for (const h of [22, 20, 18, 16, 14, 12]) filler(5, h);
  for (const h of [20, 17, 14, 11]) filler(6, h);
  for (const h of [20, 18, 16]) filler(12, h); // 30 and 90 days only
  add(['w-o1', 'd-oldphone', 40, '20:00', '20:30', 'mockOldPhn1', 'Old phone, older times', 'Archive', 1800, 0, 0, 1800, 1800, true, null]);
  add(['w-o2', 'd-oldphone', 40, '19:00', '19:20', 'mockOldPhn2', 'Old phone, earlier still', 'Archive', 1200, 0, 0, 1200, 1200, true, null]);

  const searches = [];
  let seq = 100;
  const search = (deviceId, n, hhmm, query, lang, extraSeconds = 0) => {
    const [h, m] = hhmm.split(':').map(Number);
    const dev = byId[deviceId];
    const t = z.at(day(n), h, m) + extraSeconds * 1000;
    seq += 1;
    searches.push({ id: seq, eventId: `se-${seq}`, deviceId, deviceLabel: dev.label, deviceKind: dev.kind, personId: dev.personId, person: dev.person, query, t, date: day(n), timeLabel: z.label(t), lang, source: 'query-trigram', conf: lang && lang !== 'other' ? 'medium' : 'low' });
  };
  search('d-laptop', 6, '09:00', 'lathe restoration', 'en');
  for (let i = 0; i < 8; i++) search(i % 2 ? 'd-shared' : 'd-laptop', 5 - (i % 3), `1${i}:1${i}`, `rail cab ride ${i + 1}`, 'en');
  for (let i = 0; i < 8; i++) search('d-laptop', 2 - (i % 2), `0${i + 1}:30`, `Zahnradbahn Rigi Pilatus ${i + 1}`, 'de');
  search('d-laptop', 1, '18:00', 'Ђердапска клисура из ваздуха', 'sr');
  search('d-laptop', 1, '18:05', 'zxcvb qwerty', 'other');
  search('d-shared', 1, '18:10', 'kombu dashi', '');
  search('d-laptop', 0, '09:00', 'wetter zürich', 'de');
  search('d-laptop', 0, '09:00', 'wetter bern', 'de'); // the same second: two distinct events
  search('d-laptop', 0, '10:15', '<img src=x onerror="window.__deskXss=3"> & <b>bold</b>', 'en');
  search('d-laptop', 0, '11:00', 'Restoration_and_repair_notes_from_a_small_workshop_in_the_alps_without_spaces_for_wrapping', 'other');
  for (let i = 0; i < 9; i++) search('d-shared', 0, `1${i}:4${i}`, `luthier guitar ${i + 1}`, 'en');
  search('d-laptop', 12, '20:00', 'old search one', 'en');
  search('d-oldphone', 40, '19:30', 'from the old phone', 'en');

  return { tz, z, today, people, devices, evidence, rows, searches, nextSeq: () => ++seq };
}

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
const STUBS = { '/modules/languages/': 'Languages', '/legacy/': 'Legacy dashboard', '/diagnostics.html': 'Diagnostics', '/android-integration.html': 'Android TV guide' };
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/desk.css': 'desk.css', '/desk.js': 'desk.js', '/api.js': 'api.js', '/shared/recorded-versions.js': '../shared/recorded-versions.js' };

export async function startMock(deskDir, { tz = 'Europe/Zurich' } = {}) {
  const fx = createFixtures(tz);
  const { z } = fx;
  const mock = { generation: 7, shift: 0, expire: false, slow: [], fail: [], gone: null, invalid: null, logoutFail: false, requests: [] };
  const NOW0 = z.at(fx.today, 21, 0);
  const now = () => NOW0 + mock.shift;

  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : null); } catch { resolve(s); } }); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const matches = (rule, pathname, q) => rule.path === pathname && Object.entries(rule.when || {}).every(([k, v]) => q[k] === String(v));
  const inScope = (deviceId, q) => {
    const dev = fx.devices.find((d) => d.id === deviceId);
    if (q.device && deviceId !== q.device) return false;
    if (q.person === 'unassigned') return !dev.personId;
    if (q.person) return dev.personId === q.person;
    return true;
  };
  const dates = (until, days) => { const last = z.date(until); return Array.from({ length: days }, (_, i) => z.addDays(last, -(days - 1 - i))); };
  const bad = (q) => ![7, 30, 90].includes(Number(q.days)) || (q.query || '').length > 200 || !(Number(q.page) >= 1);

  function history(q) {
    if (bad(q) || (q.generation === undefined) !== (q.until === undefined)) return [422, { error: 'Invalid history filters or paging snapshot' }];
    if (q.generation !== undefined && Number(q.generation) !== mock.generation) return [410, { error: 'History changed. Refresh to load current records.' }];
    const until = q.until !== undefined ? Number(q.until) : now();
    const days = Number(q.days);
    const window = dates(until, days);
    const groups = new Map();
    for (const r of fx.rows.filter((r) => r.date >= window[0] && r.date <= window.at(-1) && r.lastWatched < until && inScope(r.deviceId, q))) {
      const key = JSON.stringify([r.deviceId, r.viewingId, r.videoId, r.date]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const scope = [...groups.values()].map((versions) => {
      versions.sort((a, b) => b.lastWatched - a.lastWatched);
      const row = { ...versions[0], versions, versionCount: versions.length, rowKind: versions[0].viewingId ? 'viewing' : 'legacy-day' };
      for (const field of ['seconds', 'foregroundSeconds', 'backgroundSeconds', 'unspecifiedSeconds']) row[field] = versions.reduce((n, v) => n + v[field], 0);
      row.firstWatched = Math.min(...versions.map((v) => v.firstWatched));
      // Fixture coverage ranges all start at zero, so their union is the longest.
      row.coveredSeconds = versions.some((v) => v.coveredSeconds != null) ? Math.max(...versions.map((v) => v.coveredSeconds || 0)) : null;
      row.coveragePercent = row.coveredSeconds != null && row.durationSeconds ? Math.min(100, row.coveredSeconds / row.durationSeconds * 100) : null;
      row.coverageComplete = versions.every((v) => v.coverageComplete);
      return row;
    });
    const needle = (q.query || '').trim().toLowerCase();
    const hit = (r) => !needle || r.versions.some((v) => [v.title, v.channel, v.videoId].some((s) => String(s || '').toLowerCase().includes(needle)));
    const filtered = scope.filter(hit).sort((a, b) => b.lastWatched - a.lastWatched || (a.id < b.id ? -1 : 1));
    const sum = (list, f) => list.reduce((s, r) => s + r[f], 0);
    const pages = Math.max(1, Math.ceil(filtered.length / 20));
    const page = Math.min(pages, Number(q.page));
    return [200, {
      seconds: sum(scope, 'seconds'), foregroundSeconds: sum(scope, 'foregroundSeconds'), backgroundSeconds: sum(scope, 'backgroundSeconds'), unspecifiedSeconds: sum(scope, 'unspecifiedSeconds'),
      videoCount: new Set(scope.map((r) => r.videoId)).size, perCalendarDaySeconds: sum(scope, 'seconds') / days,
      days, timezone: fx.tz, since: z.at(window[0], 0, 0), until, generation: mock.generation, devices: fx.devices, people: fx.people,
      daily: window.map((date) => { const of = scope.filter((r) => r.date === date); return { date, seconds: sum(of, 'seconds'), foregroundSeconds: sum(of, 'foregroundSeconds'), backgroundSeconds: sum(of, 'backgroundSeconds'), unspecifiedSeconds: sum(of, 'unspecifiedSeconds'), rowCount: of.length, filteredCount: of.filter(hit).length }; }),
      count: scope.length, filteredCount: filtered.length, page, pages, pageSize: 20, rows: filtered.slice((page - 1) * 20, page * 20),
    }];
  }

  function searches(q) {
    if (bad(q) || (q.before === undefined) !== (q.until === undefined)) return [422, { error: 'Invalid search filters or paging snapshot' }];
    if (q.before !== undefined && mock.gone === 'searches') { mock.gone = null; return [410, { error: 'Search snapshot expired.' }]; }
    const until = q.until !== undefined ? Number(q.until) : now();
    const before = q.before !== undefined ? Number(q.before) : Math.max(0, ...fx.searches.map((s) => s.id));
    const days = Number(q.days);
    const window = dates(until, days);
    const scope = fx.searches.filter((s) => s.id <= before && s.date >= window[0] && s.date <= window.at(-1) && s.t < until && inScope(s.deviceId, q));
    const needle = (q.query || '').trim().toLowerCase();
    const hit = (s) => !needle || s.query.toLowerCase().includes(needle);
    const filtered = scope.filter(hit).sort((a, b) => b.t - a.t || b.id - a.id);
    const devs = fx.devices.filter((d) => inScope(d.id, q));
    const capability = devs.some((d) => d.searchCapability === 'recorded') ? 'recorded' : devs.length && devs.every((d) => d.searchCapability === 'not-recorded') ? 'not-recorded' : 'unknown';
    const pages = Math.max(1, Math.ceil(filtered.length / 20));
    const page = Math.min(pages, Number(q.page));
    return [200, {
      days, timezone: fx.tz, since: z.at(window[0], 0, 0), until, before, devices: fx.devices, people: fx.people,
      daily: window.map((date) => ({ date, count: scope.filter((s) => s.date === date).length, filteredCount: filtered.filter((s) => s.date === date).length })),
      count: scope.length, filteredCount: filtered.length, page, pages, pageSize: 20, searchCapability: capability, rows: filtered.slice((page - 1) * 20, page * 20),
    }];
  }

  function evidenceFor(q) {
    const row = fx.rows.find((r) => r.deviceId === q.device && r.metadataId === q.metadata);
    if (!row) return [404, { error: 'That metadata version was not observed on this device.' }];
    const text = row.evidenceId ? fx.evidence[row.evidenceId] : null;
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return [200, { deviceId: row.deviceId, metadataId: row.metadataId, videoId: row.videoId, title: row.title, evidenceId: row.evidenceId, evidenceText: text, evidence: parsed, recorded: row.recorded }];
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const q = Object.fromEntries(url.searchParams);
    const body = req.method === 'POST' ? await readBody(req) : null;
    if (url.pathname === '/__mock') {
      if (body?.bump) {
        mock.generation += 1;
        mock.shift += 60000;
        const r = { ...fx.rows[0], id: `w-new-${mock.generation}`, viewingId: `v-new-${mock.generation}`, title: 'Arrived while you were paging', firstWatched: now() - 120000, lastWatched: now() - 30000 };
        fx.rows.push(r);
      }
      const { bump, ...rest } = body || {};
      Object.assign(mock, rest);
      return send(res, 200, { ok: true, generation: mock.generation });
    }
    if (url.pathname === '/__mock/requests') { const r = mock.requests; mock.requests = []; return send(res, 200, r); }
    if (url.pathname.startsWith('/api/')) {
      mock.requests.push({ method: req.method, path: url.pathname, query: q, body, at: Date.now() });
      const slow = mock.slow.find((rule) => matches(rule, url.pathname, q));
      if (slow) await sleep(slow.ms);
      const failIndex = mock.fail.findIndex((rule) => matches(rule, url.pathname, q));
      if (failIndex >= 0) {
        const rule = mock.fail[failIndex];
        if (rule.once) mock.fail.splice(failIndex, 1);
        if (rule.raw !== undefined) { res.writeHead(rule.status || 200, { 'Content-Type': 'text/html' }); return res.end(rule.raw); }
        return send(res, rule.status, { error: rule.error });
      }
      const authed = /(?:^|;\s*)observer_session=ok/.test(req.headers.cookie || '') && !mock.expire;
      if (url.pathname === '/api/login') {
        if (body?.token !== KEY) return send(res, 401, { error: 'Unauthorized' });
        mock.expire = false;
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'observer_session=ok; Path=/api; HttpOnly; SameSite=Strict' });
      }
      if (url.pathname === '/api/logout') {
        if (mock.logoutFail) { mock.logoutFail = false; return send(res, 503, { error: 'The server is restarting.' }); }
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'observer_session=; Path=/api; Max-Age=0' });
      }
      if (!authed) return send(res, 401, { error: 'Authentication required' });
      if (url.pathname === '/api/session') return send(res, 200, { ok: true });
      if (req.method !== 'GET') return send(res, 405, { error: 'Read only' });
      if (url.pathname === '/api/history') return send(res, ...history(q));
      if (url.pathname === '/api/history/searches') return send(res, ...searches(q));
      if (url.pathname === '/api/history/evidence') return send(res, ...evidenceFor(q));
      return send(res, 404, { error: 'Not found' });
    }
    if (STUBS[url.pathname]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(`<!doctype html><title>${STUBS[url.pathname]} stub</title><h1>${STUBS[url.pathname]}</h1>`); }
    const file = STATIC[url.pathname];
    if (!file) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(deskDir, file)).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`, key: KEY, fx, mock, now,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}
