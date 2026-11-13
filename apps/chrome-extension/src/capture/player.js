// Shared DOM-only selection for MAIN and ISOLATED worlds. The MAIN script tags
// only the player whose fresh response matches the URL; the isolated script
// uses that same element instead of guessing among preloaded Shorts videos.
export const PLAYER_ATTRIBUTE = 'data-youtube-observer-video-id';

function visibleArea(element) {
  if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return 0;
  const rect = element.getBoundingClientRect();
  return Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) *
    Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
}

export function playerCandidates() {
  return [...document.querySelectorAll('.html5-video-player, #movie_player, #shorts-player')]
    .map(player => ({ player, area: visibleArea(player) }))
    .filter(({ area }) => area > 0)
    .sort((a, b) => b.area - a.area)
    .map(({ player }) => player);
}

export function clearPlayerMarkers(keep = null) {
  for (const player of document.querySelectorAll(`[${PLAYER_ATTRIBUTE}]`)) {
    if (player !== keep) player.removeAttribute(PLAYER_ATTRIBUTE);
  }
}

export function trackedPlayer(videoId) {
  if (!videoId) return null;
  return playerCandidates().find(player => player.getAttribute(PLAYER_ATTRIBUTE) === videoId) ?? null;
}

export function playerVideo(player) {
  if (!player) return null;
  return [...player.querySelectorAll('video')].filter(video => visibleArea(video) > 0)
    .sort((a, b) => visibleArea(b) - visibleArea(a))[0] ?? null;
}

export const isAd = player => player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting');
