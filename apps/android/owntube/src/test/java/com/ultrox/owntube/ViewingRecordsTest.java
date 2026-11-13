package com.ultrox.owntube;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class ViewingRecordsTest {
    static final long BASE = 1_794_000_600_000L / ViewingRecords.BUCKET_MS * ViewingRecords.BUCKET_MS;
    final List<JSONObject> saved = new ArrayList<>();
    final ViewingRecords records = new ViewingRecords((device, event, evidence) -> saved.add(event));

    static JSONObject segment(long t, double seconds, double start, double end) throws Exception {
        JSONObject event = new JSONObject().put("eventId", "transient").put("kind", "watch")
                .put("t", t).put("seconds", seconds).put("videoId", "abcdefghijk")
                .put("title", "Test").put("channel", "Channel").put("isShort", false)
                .put("lang", "").put("source", "android-player").put("conf", "")
                .put("playbackContext", "foreground").put("durationSeconds", 10000);
        if (end > start) event.put("coverage", new JSONArray().put(start).put(end));
        return event;
    }
    JSONObject last() { return saved.get(saved.size() - 1); }
    void add(long t, double seconds, double start, double end) throws Exception {
        records.add("device-a", segment(t, seconds, start, end), null);
    }

    @Test public void replayAndPauseGrowTimeWithoutDuplicatingCoverageOrMutatingSnapshots() throws Exception {
        add(BASE, 5, 0, 10);
        JSONObject first = last();
        add(BASE + 20_000, 5, 0, 10);
        assertEquals(first.getString("eventId"), last().getString("eventId"));
        assertEquals(2, last().getLong("revision"));
        assertEquals(10, last().getDouble("seconds"), .000001);
        assertEquals(5, first.getDouble("seconds"), .000001);
        assertEquals("[[0,10]]", last().getJSONArray("coverage").toString());
        assertEquals(BASE + 25_000, last().getDouble("lastWatched"), .001);
    }

    @Test public void splitsMidnightBucketAndInterpolatesOnlyMeasuredCoverage() throws Exception {
        long boundary = BASE + ViewingRecords.BUCKET_MS;
        add(boundary - 500, 2, 100, 104);
        assertEquals(2, saved.size());
        JSONObject a = saved.get(0), b = saved.get(1);
        assertNotEquals(a.getString("eventId"), b.getString("eventId"));
        assertEquals(a.getString("viewingId"), b.getString("viewingId"));
        assertEquals(BASE, a.getLong("bucket"));
        assertEquals(boundary, b.getLong("bucket"));
        assertEquals(.5, a.getDouble("seconds"), .000001);
        assertEquals(1.5, b.getDouble("seconds"), .000001);
        assertEquals("[[100,101]]", a.getJSONArray("coverage").toString());
        assertEquals("[[101,104]]", b.getJSONArray("coverage").toString());
    }

    @Test public void immutableMetadataContextLanguageEvidenceAndDurationSplitRecords() throws Exception {
        add(BASE, 1, 0, 1);
        String original = last().getString("eventId");
        String[] keys = {"title", "channel", "lang", "playbackContext", "evidenceId", "durationSeconds"};
        Object[] values = {"Other", "Other", "en", "background", "abc", 20000};
        for (int i = 0; i < keys.length; i++) {
            records.add("device-a", segment(BASE + (i + 1) * 1000, 1, 1, 2).put(keys[i], values[i]), null);
            assertNotEquals(original, last().getString("eventId"));
            assertEquals(1, last().getLong("revision"));
        }
    }

    @Test public void resetDeviceAndVideoChangesStartFreshIdentities() throws Exception {
        add(BASE, 1, 0, 1);
        String first = last().getString("viewingId");
        records.reset(); add(BASE + 1000, 1, 1, 2);
        assertNotEquals(first, last().getString("viewingId"));
        first = last().getString("viewingId");
        records.add("device-b", segment(BASE + 2000, 1, 2, 3), null);
        assertNotEquals(first, last().getString("viewingId"));
        first = last().getString("viewingId");
        records.add("device-b", segment(BASE + 3000, 1, 0, 1).put("videoId", "12345678901"), null);
        assertNotEquals(first, last().getString("viewingId"));
    }

    @Test public void backwardsClockSealsRatherThanDecreasingTotals() throws Exception {
        add(BASE + 5000, 2, 0, 2);
        String first = last().getString("eventId");
        add(BASE + 4000, 2, 2, 4);
        assertNotEquals(first, last().getString("eventId"));
        assertEquals(2, last().getDouble("seconds"), .000001);
    }

    @Test public void unknownCoverageAndRangeLimitRemainBounded() throws Exception {
        add(BASE, 1, 0, 0);
        assertEquals(0, last().getJSONArray("coverage").length());
        for (int i = 0; i < 500; i++) add(BASE + (i + 1) * 1000, 1, i * 2, i * 2 + 1);
        assertEquals(500, last().getJSONArray("coverage").length());
        String first = last().getString("eventId");
        add(BASE + 501_000, 1, 1000, 1001);
        assertNotEquals(first, last().getString("eventId"));
        assertEquals(1, last().getJSONArray("coverage").length());
    }
}
