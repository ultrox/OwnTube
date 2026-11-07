package com.ultrox.owntube;

import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Monotonic wall-time accounting. No Android/player/network dependencies. */
public final class WatchSegments {
    public interface Sink { void persist(String deviceId, JSONObject event); }
    public interface EvidenceSink { void persist(String deviceId, JSONObject event, EvidenceSnapshot evidence); }

    public static final class VideoInfo {
        public final String id, title, channel;
        public final boolean shorts, live, incognito;
        public final EvidenceSnapshot evidence;
        public VideoInfo(String id, String title, String channel, boolean shorts, boolean live, boolean incognito) {
            this(id, title, channel, shorts, live, incognito, null);
        }
        public VideoInfo(String id, String title, String channel, boolean shorts, boolean live, boolean incognito, EvidenceSnapshot evidence) {
            this.id = id;
            this.title = trim(title, 500);
            this.channel = trim(channel, 500);
            this.shorts = shorts;
            this.live = live;
            this.incognito = incognito;
            this.evidence = evidence;
        }
    }

    public static final class Frame {
        final long elapsed, unix, position, duration;
        final double speed;
        final boolean playing;
        final String device, context;
        final VideoInfo video;
        public Frame(long elapsed, long unix, long position, long duration, double speed,
                     boolean playing, String device, String context, VideoInfo video) {
            this.elapsed = elapsed; this.unix = unix; this.position = position; this.duration = duration;
            this.speed = speed; this.playing = playing; this.device = device; this.context = context; this.video = video;
        }
    }

    private final EvidenceSink sink;
    private Frame previous;
    public WatchSegments(Sink sink) { this.sink = (device, event, evidence) -> sink.persist(device, event); }
    public WatchSegments(EvidenceSink sink) { this.sink = sink; }

    /** A boundary is a seek/source/identity discontinuity: never turn its jump into coverage. */
    public void sample(Frame next, boolean boundary) {
        Frame before = previous;
        previous = next;
        if (before == null || !before.playing || before.device == null || before.video == null ||
                before.video.incognito || before.video.id == null || !before.video.id.matches("[A-Za-z0-9_-]{11}")) return;
        // A key/device change between observations must never attribute new-device time to the old device.
        if (!before.device.equals(next.device)) return;
        long millis = next.elapsed - before.elapsed;
        // A stalled main thread/suspend is not evidence of uninterrupted playback. Never extrapolate a long gap.
        if (millis <= 0 || millis > 20_000) return;
        double seconds = millis / 1000.0;
        boolean same = next.video != null && before.video.id.equals(next.video.id);
        double start = before.position / 1000.0, end = next.position / 1000.0;
        double delta = end - start;
        double expected = seconds * before.speed;
        // Polling alone must not interpret a frozen position as watching.
        if (!boundary && same && delta <= 0) return;
        try {
            JSONObject event = new JSONObject()
                    .put("eventId", "android-watch-" + UUID.randomUUID())
                    .put("kind", "watch").put("t", before.unix).put("seconds", seconds)
                    .put("videoId", before.video.id).put("title", before.video.title)
                    .put("channel", before.video.channel).put("isShort", before.video.shorts)
                    .put("lang", "").put("source", "android-player").put("conf", "");
            if ("foreground".equals(before.context) || "background".equals(before.context)) {
                event.put("playbackContext", before.context);
            }
            double duration = before.duration / 1000.0;
            if (!before.video.live && duration > 0 && duration <= 31_536_000) {
                event.put("durationSeconds", duration);
                if (!boundary && same && before.position >= 0 && delta > 0 && end <= duration &&
                        Math.abs(delta - expected) <= Math.max(0.35, expected * 0.25) && delta <= seconds * 16 + 0.5) {
                    event.put("coverage", new JSONArray().put(start).put(end));
                }
            }
            if (before.video.evidence != null) event.put("evidenceId", before.video.evidence.id);
            sink.persist(before.device, event, before.video.evidence);
        } catch (JSONException e) {
            throw new IllegalStateException("Unable to encode watch segment", e);
        }
    }

    public void reset() { previous = null; }

    static String trim(String value, int limit) {
        if (value == null) return "";
        if (value.length() <= limit) return value;
        int end = Character.isHighSurrogate(value.charAt(limit - 1)) ? limit - 1 : limit;
        return value.substring(0, end);
    }
}
