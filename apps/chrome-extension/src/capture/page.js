import { videoIdFromUrl, videoSignal } from './language.js';
import { attempt } from './protocol.js';
import { clearPlayerMarkers, PLAYER_ATTRIBUTE, playerCandidates } from './player.js';
import { createTextDetector } from './text-detector.js';

const textDetector = createTextDetector();
for (const type of ['pointerdown','keydown']) document.addEventListener(type, event => { if (event.isTrusted) textDetector.enable(); }, { capture: true, passive: true });

async function publish() {
  const id = videoIdFromUrl(location.href);
  if (!id) { clearPlayerMarkers(); return; }
  for (const player of playerCandidates()) {
    if (typeof player.getPlayerResponse !== 'function') continue;
    // One stale/throwing preload must not suppress the currently visible player.
    const response = await attempt(() => player.getPlayerResponse());
    if (!response.ok || response.value?.videoDetails?.videoId !== id) continue;
    const audio = await attempt(() => player.getAudioTrack?.());
    const result = await attempt(() => videoSignal(response.value, audio.ok ? audio.value : null, id));
    if (videoIdFromUrl(location.href) !== id) return;
    if (!result.ok || !result.value) continue;
    const evidence = result.value.evidence;
    const nativeText = textDetector.lookup(evidence.description.trim() || evidence.title);
    const signal = videoSignal(response.value, audio.ok ? audio.value : null, id, nativeText);
    clearPlayerMarkers(player);
    player.setAttribute(PLAYER_ATTRIBUTE, id);
    window.postMessage({ ...signal, isShort: location.pathname.startsWith('/shorts/') }, location.origin);
    return;
  }
  if (videoIdFromUrl(location.href) === id) clearPlayerMarkers();
}
setInterval(publish, 1000);
document.addEventListener('yt-navigate-finish', publish);
