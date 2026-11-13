import { CHANNEL, isSignal } from './protocol.js';
import { classify, videoIdFromUrl } from './language.js';
import { createClock } from './clock.js';
import { isAd, playerVideo, trackedPlayer } from './player.js';
import { localDate, splitInterval } from './calendar.js';
import { capturePolicy } from './capture-policy.js';
import { createViewings } from './viewings.js';

const clock = createClock();
const viewings = createViewings();
let signal = null, signalAt = 0, currentUrl = '', currentVideo = null, currentPlayer = null;
let previousQuery = '', previousQueryAt = 0, searchId = null, linkedVideo = null;
let pending = [], sending = null;
let visitVideoId = null, visitSeconds = 0, visitByDate = {};
const listened = new WeakSet();

function queue(event) {
  if (event.kind === 'watch') {
    for(const record of viewings.add(event)) {
      const at=pending.findIndex(old=>old.eventId===record.eventId);
      if(at<0)pending.push(record);else pending[at]=record;
    }
    if (visitVideoId !== event.videoId) { visitVideoId = event.videoId; visitSeconds = 0; visitByDate = {}; }
    visitSeconds += event.seconds;
    for (const part of splitInterval(event.t, event.seconds)) visitByDate[part.date] = (visitByDate[part.date] ?? 0) + part.seconds;
  }
}
async function send() {
  if (sending) return sending;
  if (!pending.length) return true;
  sending = (async () => {
    const batch = pending.slice(0, 100);
    const result = await chrome.runtime.sendMessage({ channel: CHANNEL, tag: 'Capture', events: batch }).catch(() => null);
    if (result?.ok) pending=pending.filter(event=>!batch.some(sent=>sent.eventId===event.eventId&&sent.revision===event.revision));
    return result?.ok === true;
  })();
  try { return await sending; } finally { sending = null; }
}

function trackingState() {
  const video = currentVideo;
  const id = videoIdFromUrl(location.href);
  if (!id) return 'no-video';
  if (!video || trackedPlayer(id) !== currentPlayer) return 'no-player';
  if (!signal || performance.now() - signalAt > 3500 || signal.videoId !== id) return 'no-signal';
  if (!capturePolicy.backgroundPlayback && document.visibilityState !== 'visible') return 'background';
  if (isAd(currentPlayer)) return 'ad';
  if (video.ended) return 'ended';
  if (video.paused) return 'paused';
  if (video.seeking) return 'seeking';
  if (video.readyState < 2) return 'buffering';
  return 'counting';
}

function active() {
  if (trackingState() !== 'counting') return null;
  const video = currentVideo;
  const durationSeconds = signal.isLive ? null : Number.isFinite(video.duration) && video.duration > 0 ? video.duration : signal.durationSeconds ?? null;
  return { kind: 'watch', videoId: signal.videoId, title: signal.title, channel: signal.channel ?? '', durationSeconds, isShort: location.pathname.startsWith('/shorts/'), lang: signal.lang, conf: signal.conf, source: signal.source, ...(capturePolicy.backgroundPlayback ? { playbackContext: document.visibilityState === 'visible' ? 'foreground' : 'background' } : {}), ...(signal.evidence ? { evidence: signal.evidence } : {}), searchId: linkedVideo === signal.videoId ? searchId : null };
}

function sample(stop = false) {
  const media = currentVideo && signal?.videoId === videoIdFromUrl(location.href) && !isAd(currentPlayer) && trackedPlayer(signal.videoId) === currentPlayer
    ? { videoId: signal.videoId, position: currentVideo.currentTime, rate: currentVideo.playbackRate, seeking: currentVideo.seeking } : null;
  const segment = clock.sample(performance.now(), Date.now(), stop ? null : active(), media);
  if (segment) queue(segment);
}

function mediaChange(event) {
  if (event.currentTarget !== currentVideo) return;
  sample();
  if (['pause','ended','waiting','emptied'].includes(event.type)) void send();
}

function checkPage() {
  if (location.href !== currentUrl) {
    const oldId = currentUrl ? videoIdFromUrl(currentUrl) : null;
    const nextId = videoIdFromUrl(location.href);
    if (oldId !== nextId) {
      sample(true); signal = null; void send();
      visitVideoId = nextId; visitSeconds = 0; visitByDate = {};
    }
    currentUrl = location.href;
    const url = new URL(currentUrl);
    const query = url.pathname === '/results' ? url.searchParams.get('search_query')?.trim().slice(0, 1000) : null;
    if (query && !(query === previousQuery && Date.now() - previousQueryAt < 5000)) {
      previousQuery = query; previousQueryAt = Date.now(); searchId = crypto.randomUUID(); linkedVideo = null;
      pending.push({ kind: 'search', eventId: searchId, t: Date.now(), query, ...classify(query), source: 'query-trigram' });
      void send();
    }
    // Only attribute the first directly opened result, not subsequent recommendations.
    if (nextId && oldId !== nextId) {
      if (searchId && linkedVideo === null && Date.now() - previousQueryAt < 30 * 60000) linkedVideo = nextId;
      else if (linkedVideo !== nextId) { searchId = null; linkedVideo = null; }
    }
  }
  const player = trackedPlayer(videoIdFromUrl(location.href));
  const video = playerVideo(player);
  if (video !== currentVideo || player !== currentPlayer) { sample(true); currentPlayer = player; currentVideo = video; sample(); }
  if (video && !listened.has(video)) {
    listened.add(video);
    for (const event of ['play','playing','pause','ended','ratechange','seeking','seeked','waiting','canplay','emptied','durationchange']) video.addEventListener(event, mediaChange);
    // Media events continue during playback even when background timers are throttled.
    if (capturePolicy.backgroundPlayback) video.addEventListener('timeupdate', mediaChange);
  }
}

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || !isSignal(event.data) || event.data.videoId !== videoIdFromUrl(location.href)) return;
  checkPage();
  sample(); signal = event.data; signalAt = performance.now(); sample();
});
document.addEventListener('visibilitychange', () => { sample(); void send(); });
document.addEventListener('yt-navigate-start', () => { sample(true); viewings.reset(); signal = null; void send(); });
document.addEventListener('yt-navigate-finish', checkPage);
window.addEventListener('pagehide', () => {
  sample(true);
  // Send the final tail even when an earlier heartbeat is still in flight. The
  // worker deduplicates IDs, so overlap is safe and a closing page needn't wait.
  if (pending.length) void chrome.runtime.sendMessage({ channel: CHANNEL, tag: 'Capture', events: pending.slice(-100) }).catch(() => {});
});
window.addEventListener('pageshow', () => { clock.reset(); checkPage(); });
setInterval(checkPage, 400);
setInterval(() => sample(), 5000);
setInterval(() => { sample(); void send(); }, capturePolicy.saveInterval);
checkPage();

// A visible product popup requests a fresh sample and durable save. The main
// total can then include it without waiting for the background rollup timer.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.channel !== CHANNEL || message.tag !== 'LiveStatus') return;
  void (async () => {
    checkPage(); sample();
    const id = videoIdFromUrl(location.href);
    const status = { state: trackingState(), videoId: id,
      title: signal?.videoId === id ? signal.title : '',
      seconds: visitVideoId === id ? visitByDate[localDate(Date.now())] ?? 0 : 0 };
    let saved = await send();
    if (saved && pending.length) saved = await send();
    respond({ ...status, saved });
  })().catch(() => respond({ state: 'disconnected', saved: false }));
  return true;
});

if (__DEV__) {
  const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
  const report = () => {
    // Count actual capture-clock segments, not an animated UI estimate or the
    // video's seek position. Half-second sampling gives immediate visible proof.
    checkPage();
    sample();
    const id = videoIdFromUrl(location.href);
    const matched = id !== null && signal?.videoId === id && performance.now() - signalAt <= 3500 && currentPlayer !== null && trackedPlayer(id) === currentPlayer;
    try {
      void chrome.runtime.sendMessage({ channel: CHANNEL, tag: 'DevTrackingStatus', status: {
        state: trackingState(), videoId: id, title: matched ? signal.title : '',
        language: matched ? `${signal.lang} · ${signal.source} · ${signal.conf}` : '',
        lang: matched ? signal.lang : null, confidence: matched ? signal.conf : null,
        position: finite(currentVideo?.currentTime), duration: finite(currentVideo?.duration) ?? (matched ? signal.durationSeconds ?? null : null),
        pending: pending.length, version: chrome.runtime.getManifest().version,
        countedSeconds: visitVideoId === id ? visitSeconds : 0,
        detectedVideoId: matched ? signal.videoId : null,
        channel: matched ? signal.channel ?? '' : '',
        isShort: location.pathname.startsWith('/shorts/'),
      } }).catch(() => {});
    } catch { /* Reloading an unpacked extension invalidates old content contexts. */ }
  };
  report();
  setInterval(report,500);
  document.addEventListener('visibilitychange',report);
}
