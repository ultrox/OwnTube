#!/usr/bin/env node
// Seed a LOCAL development server with fictional Languages fixtures through the real APIs
// (/api/login, /api/people, /api/devices, /api/ingest). Refuses non-loopback servers.
//
//   node apps/backoffice/modules/languages/tests/seed-dev.mjs http://127.0.0.1:3211 /path/to/admin-token
//
// Everything is fictional: people "Owner"/"Guest", three devices, and made-up videos whose IDs
// start with "fx". Each run creates new devices (device creation is not idempotent), so seed a
// fresh database once. Prints the device IDs it created; never prints keys or tokens.
import crypto from 'node:crypto';
import fs from 'node:fs';

const [base = 'http://127.0.0.1:3211', tokenFile] = process.argv.slice(2);
const url = new URL(base);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
  console.error('Refusing to seed a non-loopback server.');
  process.exit(2);
}
if (!tokenFile) {
  console.error('Pass the path to the dev server’s admin-token file.');
  process.exit(2);
}
const ownerKey = fs.readFileSync(tokenFile, 'utf8').trim();
let cookie = '';

async function call(method, path, body, bearer) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (cookie) headers.Cookie = cookie;
  const res = await fetch(new URL(path, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${typeof data === 'object' ? data?.error : data}`);
  return data;
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const DAY = 86400000;
const BUCKET = 900000;
const midnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();

const chrome = (title, description, { sel = '', def = '', captions = [], text } = {}) => JSON.stringify({
  schemaVersion: 1, algorithmVersion: 'language-v2', title, description, descriptionSource: description ? 'videoDetails.shortDescription' : 'none',
  descriptionTruncated: false, selectedAudioLanguage: sel, defaultAudioLanguage: def, captions,
  text: text || { engine: 'local-trigram', status: 'unsupported', input: description ? 'description' : 'title', language: 'other', confidence: null, candidates: [] },
});
const android = (videoId, title, description, { captions = [], selected = '' } = {}) => {
  const ev = {
    schemaVersion: 1, collector: 'owntube-source-v1', videoId, languageAnalysis: 'not-run', defaultAudioLanguageStatus: 'not-exposed-by-MediaFormat',
    title, description: description ?? '', titleSource: 'MediaItemFormatInfo.getTitle', descriptionAvailable: description != null, descriptionTruncated: false,
    captions, captionCount: captions.length, captionTranslationOptionsOmitted: captions.length ? 154 : 0,
  };
  if (selected) Object.assign(ev, { selectedAudioLanguage: selected, selectedAudioLanguageSource: 'SimpleExoPlayer.getAudioFormat.language (player-normalized)' });
  return JSON.stringify(ev);
};

// [device, videoId (11), title, channel, duration s, [lang, source, conf], evidence(id, title)|null, plays [[daysAgo, hour, foreground s, background s, unspecified s]]]
const VIDEOS = [
  ['tv', 'fxZahnrad01', 'Wie funktioniert eine Zahnradbahn? Rigi, Pilatus und die Technik dahinter', 'Alpine Rail Archive', 1122, ['de', 'audio-track', 'high'],
    (id, t) => android(id, t, 'Wie Zahnradbahnen steile Strecken schaffen.', { captions: [{ language: 'de', kind: 'asr' }], selected: 'de' }), [[0, 9, 1122, 0, 0]]],
  ['tv', 'fxGotthrd02', 'Gotthard-Bergstrecke im Winter: Führerstandsmitfahrt', 'Alpine Rail Archive', 4360, ['de', 'audio-track', 'high'],
    (id, t) => android(id, t, 'Führerstandsmitfahrt ohne Kommentar.', { selected: 'de' }), [[1, 20, 2310, 0, 0], [12, 19, 1800, 600, 0]]],
  ['laptop', 'fxAjvar0003', 'Kako se pravi pravi ajvar — recept moje bake', 'Kuhinja kod Mire', 862, ['sr', 'audio-track', 'high'],
    (id, t) => chrome(t, 'Pečene paprike i puno strpljenja.', { sel: 'sr', def: 'sr', captions: [{ language: 'sr', kind: 'asr' }] }), [[1, 13, 862, 0, 0]]],
  ['tv', 'fxDjerdap04', 'Ђердапска клисура из ваздуха — пловидба од Голупца до Кладова', 'Дунавски записи', 3735, ['', 'android-player', ''],
    (id, t) => android(id, t, 'Пловидба Дунавом кроз Ђердапску клисуру.', { captions: [{ language: 'sr', kind: 'asr' }] }), [[1, 21, 1500, 314, 0]]],
  ['laptop', 'fxLathe0005', 'I restored a 1962 lathe and it changed how I think about tools', 'Small Workshop', 1450, ['en', 'audio-track', 'high'],
    (id, t) => chrome(t, 'A slow restoration of an old lathe.', { sel: 'en', def: 'en', captions: [{ language: 'en', kind: 'asr' }] }), [[2, 18, 1450, 0, 0]]],
  ['laptop', 'fxBrahms006', 'Brahms im Wohnzimmer: Klarinettentrio a-Moll', 'Hausmusik am Sonntag', 1634, ['de', 'native-text', 'medium'],
    (id, t) => chrome(t, 'Johannes Brahms, Klarinettentrio a-Moll op. 114.', { def: 'und', text: { engine: 'chrome-language-detector', status: 'available', input: 'description', language: 'de', confidence: 0.96, candidates: [{ language: 'de', confidence: 0.96 }] } }),
    [[1, 22, 0, 1634, 0]]],
  ['tv', 'fxRhine0007', 'Four hours on the Rhine: Basel to Strasbourg, no narration', 'Slow Rivers', 14590, ['', 'android-player', ''],
    (id, t) => android(id, t, 'Four hours on the Rhine. No narration, no music.'), [[2, 14, 3900, 1520, 0]]],
  ['laptop', 'fxTwoLng008', 'Zwei Sprachen, ein Tisch: ein Gespräch auf Deutsch und Serbisch', 'Map Room', 2400, ['de', 'audio-track', 'high'],
    (id, t) => chrome(t, 'Ein Gespräch, das zwischen Deutsch und Serbisch wechselt.', { sel: 'de', def: 'de' }), [[3, 20, 2100, 0, 0]]],
  ['bedroom', 'fxTop10_009', 'TOP 10 SCARIEST things caught on camera (#7 will SHOCK you)', 'TOP10 SHOCK', 728, ['', 'android-player', ''], null, [[0, 23, 0, 0, 728]]],
  ['laptop', 'fxLuthr0010', 'Le métier de luthier : une guitare en douze semaines', 'Atelier Bois', 1500, ['fr', 'audio-track', 'high'],
    (id, t) => chrome(t, 'Douze semaines dans un atelier de lutherie.', { sel: 'fr', def: 'fr' }), [[4, 17, 1240, 60, 0]]],
  ['laptop', 'fxStalk0011', 'How Tarkovsky films a room: the long take in Stalker', 'The Long Take', 1265, ['en', 'audio-track', 'high'],
    (id, t) => chrome(t, 'A close reading of one room in Stalker.', { sel: 'en', def: 'en' }), [[2, 21, 1265, 0, 0]]],
  // Same video on the TV with a German dub: a different metadata version on another device.
  ['tv', 'fxStalk0011', 'How Tarkovsky films a room: the long take in Stalker', 'The Long Take', 1265, ['', 'android-player', ''],
    (id, t) => android(id, t, 'A close reading of one room in Stalker.', { selected: 'de' }), [[3, 21, 1265, 0, 0]]],
  ['tv', 'fxEis000012', 'Warum Eis glatt ist – und warum wir es lange falsch erklärt haben', 'Physik im Alltag', 775, ['', 'android-player', ''],
    (id, t) => android(id, t, null), [[4, 19, 775, 0, 0]]],
  ['bedroom', 'fxRijal0014', 'Rijaliti: ko je ispao sinoć? Sve što ste propustili', 'Rijaliti danas', 680, ['', 'android-player', ''], null, [[0, 21, 0, 0, 655], [0, 22, 0, 0, 120]]],
  ['laptop', 'fxDashi0015', 'Dashi from scratch: kombu and katsuobushi', 'Kitchen Notes', 900, ['ja', 'audio-track', 'high'],
    (id, t) => chrome(t, 'Making dashi the slow way.', { sel: 'ja', def: 'ja', captions: [{ language: 'en', kind: 'manual' }] }), [[6, 19, 840, 0, 0]]],
  ['bedroom', 'fxUnbox0016', 'Unboxing 47 mystery boxes from an auction', 'Unboxing Loop', 2642, ['', 'android-player', ''], null, [[1, 23, 0, 0, 2642]]],
  ['laptop', 'fxPlane0020', 'Sharpening a plane iron by hand: the only three things that matter', 'Small Workshop', 1046, ['en', 'asr-caption', 'medium'],
    (id, t) => chrome(t, 'Flat back, consistent bevel, no burr.', { captions: [{ language: 'en', kind: 'asr' }] }), [[0, 8, 520, 120, 0]]],
  ['laptop', 'fxDerby0019', 'Derby notes: what changed after the red card', 'Derby Notes', 825, ['en', 'audio-track', 'high'],
    (id, t) => chrome(t, 'A tactical look at the second half.', { sel: 'en', def: 'en' }), [[9, 20, 825, 0, 0]]],
  // Hostile text, saved verbatim: the UI must show it as text.
  ['laptop', 'fxXss000021', '<img src=x onerror="window.__langXss=1"> Fake title & more', '<b>Channel</b>', 300, ['en', 'description-heuristic', 'low'],
    (id, t) => chrome(t, '</pre><script>window.__langXss=2</script> description <i>markup</i>'), [[0, 10, 200, 0, 0]]],
];

await call('POST', '/api/login', { token: ownerKey });
for (const name of ['Owner', 'Guest']) await call('POST', '/api/people', { name });
const deviceSpec = { tv: ['Living room TV', 'Owner'], bedroom: ['Bedroom TV', 'Guest'], laptop: ['Laptop', 'Owner'] };
const devices = {};
for (const [key, [label, person]] of Object.entries(deviceSpec)) {
  const d = await call('POST', '/api/devices', { label, person });
  devices[key] = { id: d.deviceId, token: d.token, label };
}

let n = 0;
for (const [key, dev] of Object.entries(devices)) {
  const events = [];
  const evidence = {};
  for (const [device, videoId, title, channel, duration, [lang, source, conf], evFn, plays] of VIDEOS) {
    if (device !== key) continue;
    const text = evFn ? evFn(videoId, title) : null;
    const evidenceId = text ? sha256(text) : null;
    if (text) evidence[evidenceId] = text;
    plays.forEach(([daysAgo, hour, fg, bg, un], p) => {
      for (const [seconds0, context] of [[fg, 'foreground'], [bg, 'background'], [un, null]]) {
        let left = seconds0;
        let start = Math.min(midnight - daysAgo * DAY + hour * 3600000, Date.now() - 6 * 3600000) + (context === 'background' ? 3600000 : context ? 0 : 2 * 3600000);
        let part = 0;
        while (left > 0) {
          const seconds = Math.min(left, 840);
          const bucket = Math.floor(start / BUCKET) * BUCKET;
          const t = bucket + 30000;
          const id = `seed-${videoId}-${key}-${p}-${context || 'none'}-${part}`;
          const ev = {
            eventId: id, kind: 'viewing', viewingId: `${id}-v`, revision: 1, bucket, t, lastWatched: t + seconds * 1000, seconds,
            videoId, title, channel, isShort: false, lang, source, conf, durationSeconds: duration, coverage: [[0, Math.min(seconds, duration)]],
          };
          if (context) ev.playbackContext = context;
          if (evidenceId) ev.evidenceId = evidenceId;
          events.push(ev);
          left -= seconds;
          start = bucket + BUCKET;
          part += 1;
        }
      }
    });
  }
  for (let i = 0; i < events.length; i += 100) {
    const chunk = events.slice(i, i + 100);
    const refs = Object.fromEntries(Object.entries(evidence).filter(([k]) => chunk.some((e) => e.evidenceId === k)));
    const receipt = await call('POST', '/api/ingest', { deviceId: dev.id, events: chunk, evidence: refs }, dev.token);
    n += receipt?.accepted?.length || 0;
  }
}
console.log(`Seeded ${n} viewing records for ${VIDEOS.length} fictional recorded versions.`);
console.log('Devices:', Object.values(devices).map((d) => `${d.label} (${d.id})`).join(', '));
