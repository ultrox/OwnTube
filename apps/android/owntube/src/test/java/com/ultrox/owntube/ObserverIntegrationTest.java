package com.ultrox.owntube;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;
import java.io.IOException;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/** Optional contract test: run only against a fresh loopback Observer instance. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class ObserverIntegrationTest {
    final OkHttpClient client = new OkHttpClient();
    String origin, cookie;
    YtdashApi.Reply request(String path, String body, String key) throws Exception {
        Request.Builder request = new Request.Builder().url(origin + path);
        if (key != null) request.header("Authorization", "Bearer " + key);
        if (cookie != null) request.header("Cookie", cookie);
        if (body != null) request.post(RequestBody.create(MediaType.parse("application/json"), body));
        try (Response response = client.newCall(request.build()).execute()) {
            if (response.header("Set-Cookie") != null) cookie = response.header("Set-Cookie").split(";", 2)[0];
            return new YtdashApi.Reply(response.code(), response.body().string(), 0);
        }
    }
    @Test public void realServerReplacesAndroidCheckpointsAcrossLostReceiptAndRestart() throws Exception {
        origin = System.getenv("OWNTUBE_TEST_OBSERVER");
        assumeTrue(origin != null);
        assertTrue(origin.matches("http://127\\.0\\.0\\.1:[0-9]+"));
        assertEquals(200, request("/api/login", new JSONObject().put("token", System.getenv("OWNTUBE_TEST_ADMIN")).toString(), null).code);
        JSONObject device = new JSONObject(request("/api/devices", "{\"label\":\"OwnTube integration\",\"person\":\"Test\"}", null).body);
        DeviceCredentials.Pair pair = new DeviceCredentials.Pair(device.getString("deviceId"), device.getString("token"), "Test", "Test");
        TrackingStore initial = new TrackingStore(RuntimeEnvironment.getApplication());
        final TrackingStore[] store = {initial};
        final long[] now = {System.currentTimeMillis()};
        ViewingRecords records = new ViewingRecords((id, event, evidence) -> {
            try { store[0].append(id, event, evidence); } catch (Exception e) { throw new IllegalStateException(e); }
        });
        long base = now[0] / ViewingRecords.BUCKET_MS * ViewingRecords.BUCKET_MS - ViewingRecords.BUCKET_MS;
        EvidenceSnapshot evidence = EvidenceSnapshot.create(new JSONObject().put("title", "Test").put("description", "Android contract evidence"));
        JSONObject first = ViewingRecordsTest.segment(base, 5, 120, 130).put("evidenceId", evidence.id);
        records.add(pair.deviceId, first, evidence);
        String oldBody = Delivery.body(pair.deviceId, store[0].pending(pair.deviceId));
        try {
            // Commit revision 1, persist revision 2 while it is in flight, then lose its response.
            new Delivery(store[0], (key, body) -> {
                YtdashApi.Reply reply = request("/api/ingest", body, key);
                assertEquals(200, reply.code);
                records.add(pair.deviceId, ViewingRecordsTest.segment(base + 10_000, 3, 130, 136).put("evidenceId", evidence.id), evidence);
                throw new IOException("simulated lost response");
            }, () -> now[0]).drain(pair);
            assertEquals(1, store[0].count(pair.deviceId, false));
            store[0].close(); store[0] = new TrackingStore(RuntimeEnvironment.getApplication());
            now[0] += 10_000;
            assertFalse(new Delivery(store[0], (key, body) -> request("/api/ingest", body, key), () -> now[0]).drain(pair));
            assertEquals(0, store[0].count(pair.deviceId, false));
            assertEquals(200, request("/api/ingest", oldBody, pair.key).code);

            // Fresh playback after restart plus an untouched legacy backlog.
            records.reset();
            records.add(pair.deviceId, ViewingRecordsTest.segment(base + 20_000, 2, 120, 122), null);
            store[0].append(pair.deviceId, ViewingRecordsTest.segment(base - 1000, 1, 0, 1).put("eventId", "legacy-queued-android"));
            assertFalse(new Delivery(store[0], (key, body) -> request("/api/ingest", body, key), () -> now[0]).drain(pair));
            JSONObject dashboard = new JSONObject(request("/api/dashboard?days=7", null, null).body);
            assertEquals(11, dashboard.getDouble("seconds"), .000001);
            JSONObject exported = new JSONObject(request("/api/export", null, null).body);
            assertEquals(2, exported.getJSONArray("viewings").length());
            assertEquals(1, exported.getJSONArray("events").length());
            boolean foundEvidence = false;
            JSONArray viewings = exported.getJSONArray("viewings");
            for (int i = 0; i < viewings.length(); i++) {
                JSONObject row = viewings.getJSONObject(i);
                if (evidence.id.equals(row.getJSONObject("event").optString("evidenceId"))) {
                    assertEquals("Android contract evidence", row.getJSONObject("evidence").getString("description"));
                    foundEvidence = true;
                }
            }
            assertTrue(foundEvidence);

            // Transactionally reject an equal-revision conflict without changing the total.
            JSONObject conflict = new JSONObject(oldBody);
            conflict.getJSONArray("events").getJSONObject(0).put("revision", 2).put("title", "Conflict");
            assertEquals(409, request("/api/ingest", conflict.toString(), pair.key).code);
            assertEquals(11, new JSONObject(request("/api/dashboard?days=7", null, null).body).getDouble("seconds"), .000001);
        } finally { store[0].close(); }
    }
}
