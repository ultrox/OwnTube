package com.ultrox.owntube;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class WatchSegmentsTest {
    private final List<JSONObject> events = new ArrayList<>();
    private final List<String> devices = new ArrayList<>();
    private final WatchSegments collector = new WatchSegments((device, event) -> { devices.add(device); events.add(event); });
    private final WatchSegments.VideoInfo video = new WatchSegments.VideoInfo("abcdefghijk", "Title", "Channel", false, false, false);
    private WatchSegments.Frame frame(long elapsed, long position, double speed, boolean playing, String context) {
        return new WatchSegments.Frame(elapsed, 1_794_000_000_000L + elapsed, position, 600_000, speed, playing, "device-a", context, video);
    }
    private double seconds() { return events.stream().mapToDouble(e -> e.optDouble("seconds")).sum(); }

    @Test public void fiveSecondsAtDoubleSpeedIsFiveWatchSecondsAndTenMediaSeconds() throws Exception {
        collector.sample(frame(0, 120_000, 2, true, "foreground"), false);
        for (int i = 1; i <= 5; i++) collector.sample(frame(i * 1000, 120_000 + i * 2000, 2, true, "foreground"), false);
        assertEquals(5, seconds(), 0.001);
        assertEquals(120, events.get(0).getJSONArray("coverage").getDouble(0), 0.001);
        assertEquals(130, events.get(4).getJSONArray("coverage").getDouble(1), 0.001);
        assertEquals(1_794_000_000_000L, events.get(0).getLong("t"));
        assertNotEquals(events.get(0).getString("eventId"), events.get(1).getString("eventId"));
    }

    @Test public void pausedBufferingAndAdIntervalsAreNotCounted() {
        collector.sample(frame(0, 0, 1, true, "foreground"), false);
        collector.sample(frame(1000, 1000, 1, false, "foreground"), false);
        collector.sample(frame(6000, 1000, 1, false, "foreground"), false);
        collector.sample(frame(10_000, 1000, 1, true, "foreground"), false);
        collector.sample(frame(11_000, 2000, 1, false, "foreground"), false);
        assertEquals(2, seconds(), 0.001);
    }

    @Test public void seekSplitsSegmentWithoutInventingCoverage() {
        collector.sample(frame(0, 0, 1, true, "foreground"), false);
        collector.sample(frame(500, 120_000, 1, false, "foreground"), true);
        collector.sample(frame(1500, 120_000, 1, true, "foreground"), true);
        collector.sample(frame(2500, 121_000, 1, true, "foreground"), false);
        assertEquals(1.5, seconds(), 0.001);
        assertFalse(events.get(0).has("coverage"));
        assertEquals(120, events.get(1).optJSONArray("coverage").optDouble(0), 0.001);
    }

    @Test public void contextChangesSplitForegroundFromBackground() {
        collector.sample(frame(0, 0, 1, true, "foreground"), false);
        collector.sample(frame(500, 500, 1, true, "background"), false);
        collector.sample(frame(1500, 1500, 1, true, "background"), false);
        assertEquals("foreground", events.get(0).optString("playbackContext"));
        assertEquals("background", events.get(1).optString("playbackContext"));
        assertEquals(0.5, events.get(0).optDouble("seconds"), 0.001);
    }

    @Test public void unknownContextAndDurationAreOmittedAndShortsAreExplicit() {
        WatchSegments.VideoInfo shortVideo = new WatchSegments.VideoInfo("abcdefghijk", null, null, true, false, false);
        collector.sample(new WatchSegments.Frame(0, 5000, 0, -1, 1, true, "device-a", null, shortVideo), false);
        collector.sample(new WatchSegments.Frame(1000, 6000, 1000, -1, 1, true, "device-a", null, shortVideo), false);
        JSONObject event = events.get(0);
        assertFalse(event.has("playbackContext")); assertFalse(event.has("durationSeconds")); assertFalse(event.has("coverage"));
        assertTrue(event.optBoolean("isShort")); assertEquals("", event.optString("title"));
        assertEquals("", event.optString("lang"));
    }

    @Test public void staleClockGapsAndFrozenPositionAreNotPlaybackEvidence() {
        collector.sample(frame(0, 0, 1, true, "foreground"), false);
        collector.sample(frame(30_000, 30_000, 1, true, "foreground"), false);
        collector.sample(frame(31_000, 30_000, 1, true, "foreground"), false);
        assertTrue(events.isEmpty());
        collector.sample(frame(32_000, 31_000, 1, true, "foreground"), false);
        assertEquals(1, seconds(), 0.001);
    }

    @Test public void wallClockAdjustmentDoesNotChangeElapsedWatchTime() {
        collector.sample(frame(0, 0, 1, true, "foreground"), false);
        collector.sample(new WatchSegments.Frame(1000, 42, 1000, 600_000, 1, true, "device-a", "foreground", video), false);
        assertEquals(1, seconds(), 0.001);
        assertEquals(1_794_000_000_000L, events.get(0).optLong("t"));
    }

    @Test public void newDeviceDoesNotInheritThePreviousDeviceInterval() {
        collector.sample(frame(0, 0, 1, true, "foreground"), false);
        collector.sample(new WatchSegments.Frame(1000, 1000, 1000, 600_000, 1, true, "device-b", "foreground", video), false);
        collector.sample(new WatchSegments.Frame(2000, 2000, 2000, 600_000, 1, true, "device-b", "foreground", video), false);
        assertEquals(1, events.size()); assertEquals("device-b", devices.get(0));
    }

    @Test public void videoBoundaryKeepsOldIdentityButDoesNotCoverTheNewVideo() {
        collector.sample(frame(0, 5000, 1, true, "foreground"), false);
        WatchSegments.VideoInfo next = new WatchSegments.VideoInfo("lmnopqrstuv", "Next", "Channel", false, false, false);
        collector.sample(new WatchSegments.Frame(500, 500, 0, 600_000, 1, false, "device-a", "foreground", next), true);
        assertEquals("abcdefghijk", events.get(0).optString("videoId"));
        assertFalse(events.get(0).has("coverage"));
    }

    @Test public void invalidVideosAndIncognitoNeverProduceEvents() {
        for (WatchSegments.VideoInfo info : new WatchSegments.VideoInfo[]{
                new WatchSegments.VideoInfo("not-an-id", "", "", false, false, false),
                new WatchSegments.VideoInfo("abcdefghijk", "", "", false, false, true)}) {
            collector.reset();
            collector.sample(new WatchSegments.Frame(0, 0, 0, 10000, 1, true, "device-a", "foreground", info), false);
            collector.sample(new WatchSegments.Frame(1000, 1000, 1000, 10000, 1, true, "device-a", "foreground", info), false);
        }
        assertTrue(events.isEmpty());
    }
}
