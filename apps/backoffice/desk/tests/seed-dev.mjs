#!/usr/bin/env node
// Seed a LOCAL development server with fictional History fixtures through the real APIs
// (/api/login, /api/devices, /api/ingest). Refuses non-loopback servers; never prints keys.
//
//   node apps/backoffice/desk/tests/seed-dev.mjs http://127.0.0.1:3211 /path/to/admin-token [--again]
//
// Creates three new devices labelled "Desk check · …" and uploads, relative to now:
//   Study laptop (Owner)  browser evidence; viewings whose 15-minute slices share one viewing ID
//                         (on-tab and background), a metadata change mid-viewing, a viewing across
//                         the server's midnight, a slice without coverage ranges, a replay, a Short,
//                         hostile text, a long unbroken channel; two days from an older collector
//                         ("watch" samples); 26 searches.
//   Kitchen TV (Guest)    OwnTube Android evidence, foreground and background.
//   Tablet … (no person)  no evidence, no context, no searches: an unidentified source.
// Device keys stay in a private state file (mode 600) under the OS temp directory, so the live
// check can make one more fictional upload. A second run refuses to add devices unless --again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zone } from './mock-server.mjs';

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [base = 'http://127.0.0.1:3211', tokenFile] = argv;
const url = new URL(base);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { console.error('Refusing to seed a non-loopback server.'); process.exit(2); }
if (!tokenFile) { console.error('Pass the path to the dev server’s admin-token file.'); process.exit(2); }
const stateDir = path.join(os.tmpdir(), 'owntube-desk-seed');
const stateFile = path.join(stateDir, `${url.hostname}-${url.port || 80}.json`);
// --resume reuses the devices of an interrupted run (its uploads are all-or-nothing per batch).
const resume = process.argv.includes('--resume') && fs.existsSync(stateFile);
if (fs.existsSync(stateFile) && !resume && !process.argv.includes('--again')) {
  console.error(`Already seeded (${stateFile}). Pass --again to add another set of devices, or --resume after a failed upload.`);
  process.exit(1);
}

const ownerKey = fs.readFileSync(tokenFile, 'utf8').trim();
let cookie = '';
async function call(method, p, body, bearer) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (cookie) headers.Cookie = cookie;
  const res = await fetch(new URL(p, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${typeof data === 'object' ? data?.error : data}`);
  return data;
}
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const BUCKET = 900000;

await call('POST', '/api/login', { token: ownerKey });
const tz = (await call('GET', '/api/history?days=7&device=&person=&query=&page=1')).timezone || 'Europe/Zurich';
const z = zone(tz);
const today = z.date(Date.now());
const day = (n) => z.addDays(today, -n);
const NOW = Date.now();
// A local time n days ago, early enough that even the longest fixture viewing has ended by now.
const at = (n, hh, mm) => Math.min(z.at(day(n), hh, mm), NOW - 45 * 60000);

const chrome = (title, description, sel = 'en') => JSON.stringify({
  schemaVersion: 1, algorithmVersion: 'language-v2', title, description, descriptionSource: 'videoDetails.shortDescription', descriptionTruncated: false,
  selectedAudioLanguage: sel, defaultAudioLanguage: sel, captions: [{ language: sel, kind: 'asr' }],
  text: { engine: 'chrome-language-detector', status: 'available', input: 'description', language: sel, confidence: 0.91, candidates: [{ language: sel, confidence: 0.91 }] },
});
const android = (videoId, title, description) => JSON.stringify({
  schemaVersion: 1, collector: 'owntube-source-v1', videoId, languageAnalysis: 'not-run', defaultAudioLanguageStatus: 'not-exposed-by-MediaFormat',
  title, description, titleSource: 'MediaItemMetadata.getTitle', descriptionAvailable: true, descriptionTruncated: false,
  captions: [{ language: 'de', kind: 'asr' }], captionCount: 1, captionTranslationOptionsOmitted: 80,
  selectedAudioLanguage: 'de', selectedAudioLanguageSource: 'SimpleExoPlayer.getAudioFormat.language (player-normalized)',
});

// One viewing: segments [seconds, context|null, coverage start|null] played back to back from
// `start`, cut into slices at 15-minute boundaries. Every slice carries the same viewing ID.
function viewing(id, start, segments, meta) {
  const events = [];
  let t = start;
  let part = 0;
  for (const [seconds, context, from] of segments) {
    let left = seconds;
    let pos = from;
    while (left > 0) {
      const bucket = Math.floor(t / BUCKET) * BUCKET;
      const s = Math.min(left, (bucket + BUCKET - t) / 1000, 900);
      const ev = {
        eventId: `${id}-${part++}`, kind: 'viewing', viewingId: id, revision: 1, bucket, t, lastWatched: t + s * 1000, seconds: s,
        videoId: meta.videoId, title: meta.title, channel: meta.channel, isShort: !!meta.isShort, lang: meta.lang ?? 'en', source: meta.source ?? 'audio-track', conf: meta.conf ?? 'high',
        durationSeconds: meta.duration ?? null,
      };
      if (context) ev.playbackContext = context;
      // Every slice carries its ranges; an empty list is a slice recorded without coverage.
      ev.coverage = pos != null && meta.duration ? [[Math.min(pos, meta.duration - 1), Math.min(pos + s, meta.duration)]] : [];
      if (pos != null) pos += s;
      if (meta.evidenceId) ev.evidenceId = meta.evidenceId;
      if (ev.durationSeconds == null) delete ev.durationSeconds;
      events.push(ev);
      left -= s;
      t += s * 1000;
    }
  }
  return events;
}

// Older collector: 20-second "watch" samples without a visit identity, grouped per day by the server.
function samples(id, start, count, meta, gapAfter = 0, gapMs = 0) {
  const events = [];
  for (let i = 0; i < count; i++) {
    const t = start + i * 20000 + (gapAfter && i >= gapAfter ? gapMs : 0);
    const pos = (i * 20) % Math.max(1, meta.duration - 20);
    const ev = { eventId: `${id}-${i}`, kind: 'watch', t, videoId: meta.videoId, seconds: 20, title: meta.title, channel: meta.channel, lang: 'en', source: 'audio-track', conf: 'medium', durationSeconds: meta.duration, coverage: [pos, pos + 20] };
    if (meta.evidenceId) ev.evidenceId = meta.evidenceId;
    events.push(ev);
  }
  return events;
}

const devices = resume ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).devices : [
  { role: 'browser', label: 'Desk check · Study laptop', person: 'Owner' },
  { role: 'tv', label: 'Desk check · Kitchen TV', person: 'Guest' },
  { role: 'unknown', label: 'Desk check · Tablet in the guest apartment upstairs (unpaired profile two)', person: '' },
];
if (!resume) {
  for (const d of devices) {
    const created = await call('POST', '/api/devices', { label: d.label, person: d.person });
    d.deviceId = created.deviceId;
    d.token = created.token;
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, JSON.stringify({ server: base, createdAt: new Date().toISOString(), timezone: tz, devices }, null, 2), { mode: 0o600 });
}

const plan = { browser: { events: [], evidence: {} }, tv: { events: [], evidence: {} }, unknown: { events: [], evidence: {} } };
const ev = (role, text) => { const id = sha256(text); plan[role].evidence[id] = text; return id; };
const push = (role, list) => plan[role].events.push(...list);

// Study laptop: eighteen ordinary viewings over the week, then the special cases.
const titles = [
  ['I restored a 1962 lathe and it changed how I think about tools', 'Small Workshop'], ['Kako se pravi pravi ajvar — recept moje bake', 'Kuhinja kod Mire'],
  ['Le métier de luthier : une guitare en douze semaines', 'Atelier Bois'], ['Dashi from scratch: kombu and katsuobushi', 'Kitchen Notes'],
  ['Brahms im Wohnzimmer: Klarinettentrio a-Moll', 'Hausmusik am Sonntag'], ['How Tarkovsky films a room: the long take in Stalker', 'The Long Take'],
];
for (let i = 0; i < 18; i++) {
  const [title, channel] = titles[i % titles.length];
  const videoId = `fxDesk${String(i).padStart(5, '0')}`;
  const evidenceId = ev('browser', chrome(title, `Fictional description ${i + 1} for the desk check.`));
  const n = i % 7;
  push('browser', viewing(`desk-view-${i}`, at(n, 8 + (i % 12), 5), [[600 + i * 30, 'foreground', 0], [i % 3 === 0 ? 300 : 0, 'background', 600 + i * 30]].filter(([s]) => s > 0),
    { videoId, title, channel, duration: 2400, evidenceId }));
}
// A metadata change in the middle of one viewing: two versions, two entries.
const metaA = ev('browser', chrome('Derby notes: what changed after the red card', 'First upload.'));
const metaB = ev('browser', chrome('Derby notes: what changed after the red card (revised)', 'The uploader edited the title and description.'));
const derbyStart = at(1, 20, 0);
push('browser', viewing('desk-derby', derbyStart, [[420, 'foreground', 0]], { videoId: 'fxDeskDerby', title: 'Derby notes: what changed after the red card', channel: 'Derby Notes', duration: 1500, evidenceId: metaA }));
push('browser', viewing('desk-derby', derbyStart + 420000, [[480, 'foreground', 420]], { videoId: 'fxDeskDerby', title: 'Derby notes: what changed after the red card (revised)', channel: 'Derby Notes', duration: 1500, evidenceId: metaB })
  .map((e, i) => ({ ...e, eventId: `desk-derby-b-${i}` })));
// One viewing across the server's midnight (two days ago into yesterday): one entry per date.
push('browser', viewing('desk-midnight', z.at(day(2), 23, 50), [[1200, 'foreground', 0]], { videoId: 'fxDeskNight', title: 'Night train across midnight', channel: 'Rail Nights', duration: 5400, evidenceId: ev('browser', chrome('Night train across midnight', 'Overnight, fictional.')) }));
// A slice without coverage ranges (partial coverage) and a replay of the same minutes.
push('browser', viewing('desk-partial', at(3, 19, 0), [[300, 'foreground', 0], [300, 'foreground', null], [300, 'foreground', 0]], { videoId: 'fxDeskPart1', title: 'Coverage with a gap in the record', channel: 'Small Workshop', duration: 1800 }));
// A Short, hostile text, and a long unbroken channel.
push('browser', viewing('desk-short', at(0, 9, 10), [[50, 'foreground', 0]], { videoId: 'fxDeskShort', title: 'One-minute dashi', channel: 'Kitchen Notes', duration: 58, isShort: true }));
push('browser', viewing('desk-hostile', at(0, 9, 30), [[200, 'foreground', 0]], { videoId: 'fxDeskXss01', title: '<img src=x onerror="window.__deskXss=1"> Hostile & title', channel: '<b>Bold channel</b>', duration: 600,
  evidenceId: ev('browser', chrome('<img src=x onerror="window.__deskXss=4"> Hostile', '</pre><script>window.__deskXss=2</script> & <b>bold</b>')) }));
push('browser', viewing('desk-longname', at(0, 9, 50), [[300, 'foreground', 0]], { videoId: 'fxDeskLong1', title: 'Restoration_notes_without_any_spaces_in_the_title_for_wrapping_checks', channel: 'Restoration_and_repair_notes_from_a_small_workshop_in_the_alps', duration: 300 }));
// Older collector, three days ago: one video sampled morning and evening, one without evidence.
const plane = ev('browser', chrome('Sharpening a plane iron by hand', 'Flat back, consistent bevel, no burr.'));
push('browser', samples('desk-legacy-a', z.at(day(3), 9, 12), 104, { videoId: 'fxDeskOld01', title: 'Sharpening a plane iron by hand', channel: 'Small Workshop', duration: 1046, evidenceId: plane }, 52, 12 * 3600000));
push('browser', samples('desk-legacy-b', z.at(day(3), 15, 0), 45, { videoId: 'fxDeskOld02', title: 'Derby notes: the season so far', channel: 'Derby Notes', duration: 1500 }));
// Searches: 26 over the week, including the same second twice, Cyrillic, hostile and long text.
const queries = [
  ['Zahnradbahn Rigi', 'de'], ['Zahnradbahn Pilatus', 'de'], ['Zahnradbahn Brienz Rothorn', 'de'], ['Zahnradbahn Wengernalp', 'de'],
  ['Zahnradbahn Technik', 'de'], ['Zahnradbahn Winter', 'de'], ['Zahnradbahn Geschichte', 'de'], ['Zahnradbahn Modell', 'de'],
  ['lathe restoration', 'en'], ['plane iron sharpening', 'en'], ['luthier guitar build', 'en'], ['kombu dashi', ''],
  ['Ђердапска клисура из ваздуха', 'sr'], ['zxcvb qwerty', 'other'], ['<img src=x onerror="window.__deskXss=3"> & <b>bold</b>', 'en'],
  ['Restoration_and_repair_notes_from_a_small_workshop_in_the_alps_without_spaces_for_wrapping', 'other'],
  ['tarkovsky stalker room', 'en'], ['ajvar recept', 'sr'], ['brahms klarinettentrio', 'de'], ['derby red card', 'en'],
  ['night train belgrade', 'en'], ['cab ride gotthard', 'en'], ['rhine basel strasbourg', 'en'], ['ice why slippery', 'en'],
];
queries.forEach(([query, lang], i) => {
  const t = at(i % 7, 7 + (i % 14), 15);
  plan.browser.events.push({ kind: 'search', eventId: `desk-search-${i}`, t, query, lang, conf: lang && lang !== 'other' ? 'medium' : 'low', source: 'query-trigram' });
});
const same = at(0, 8, 0);
plan.browser.events.push({ kind: 'search', eventId: 'desk-search-same-a', t: same, query: 'wetter zürich', lang: 'de', conf: 'medium', source: 'query-trigram' });
plan.browser.events.push({ kind: 'search', eventId: 'desk-search-same-b', t: same, query: 'wetter bern', lang: 'de', conf: 'medium', source: 'query-trigram' });

// Kitchen TV: OwnTube Android evidence, foreground and background.
const tvTitles = ['Wie funktioniert eine Zahnradbahn?', 'Gotthard-Bergstrecke im Winter', 'Warum Eis glatt ist', 'Four hours on the Rhine', 'Schubert: Forellenquintett', 'Ђердапска клисура'];
tvTitles.forEach((title, i) => {
  const videoId = `fxDeskTv${String(i).padStart(3, '0')}`;
  push('tv', viewing(`desk-tv-${i}`, at(i % 5, 18 + (i % 4), 0), [[900 + i * 120, 'foreground', 0], [i % 2 ? 240 : 0, 'background', 900 + i * 120]].filter(([s]) => s > 0),
    { videoId, title, channel: 'Fictional TV channel', lang: '', source: 'android-player', conf: '', duration: 3600, evidenceId: ev('tv', android(videoId, title, `Fictional TV description ${i + 1}.`)) }));
});

// Tablet: no evidence and no context; one entry without a duration.
['Unboxing 47 mystery boxes from an auction', 'The mystery of the empty town (part 3)', 'Rijaliti: ko je ispao sinoć?', 'TOP 10 things caught on camera'].forEach((title, i) => {
  push('unknown', viewing(`desk-tab-${i}`, at(i % 4, 21, 10), [[600 + i * 60, null, i === 3 ? null : 0]], { videoId: `fxDeskTab${String(i).padStart(2, '0')}`, title, channel: 'Fictional channel', lang: '', source: '', conf: '', duration: i === 3 ? null : 2600 }));
});

let accepted = 0;
for (const d of devices) {
  const { events, evidence } = plan[d.role];
  const ids = Object.keys(evidence);
  for (let i = 0; i < events.length; i += 100) {
    const chunk = events.slice(i, i + 100);
    const refs = i === 0 ? Object.fromEntries(ids.slice(0, 100).map((k) => [k, evidence[k]])) : {};
    if (i === 0 && ids.length > 100) throw new Error('Too many evidence snapshots for one batch.');
    const receipt = await call('POST', '/api/ingest', { deviceId: d.deviceId, events: chunk, evidence: refs }, d.token);
    accepted += receipt?.accepted?.length || 0;
  }
}
console.log(`Seeded ${accepted} fictional events (viewings, older-collector samples and searches) in ${tz}.`);
console.log(`Devices: ${devices.map((d) => `${d.label} (${d.deviceId})`).join('; ')}`);
console.log(`Private state (device keys, mode 600): ${stateFile}`);
