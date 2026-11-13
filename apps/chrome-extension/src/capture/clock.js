// Real elapsed time, independent of playback position/rate. A suspended timer never
// credits a whole laptop sleep. Each returned segment is at most one five-second tick.
export function createClock() {
  let previous = null;
  return {
    sample(now, wall, state, media = null) {
      const elapsed = previous ? (now - previous.now) / 1000 : 0;
      const segment = previous?.state && elapsed > 0 && elapsed <= 6
        ? { ...previous.state, t: wall - elapsed * 1000, seconds: elapsed }
        : null;
      const before = previous?.media;
      if (segment && before && media && before.videoId === media.videoId && !before.seeking && !media.seeking && segment.durationSeconds > 0) {
        const delta = media.position - before.position;
        const end = Math.min(segment.durationSeconds, media.position);
        // Large jumps are seeks, not playback. Seeking events also break the
        // continuity, so even short seeks cannot fill skipped sections.
        if (delta > 0 && delta <= elapsed * before.rate + 0.5 && before.position >= 0 && end > before.position) segment.coverage = [before.position, end];
      }
      previous = { now, state, media };
      return segment;
    },
    reset() { previous = null; },
  };
}
