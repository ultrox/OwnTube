package com.ultrox.owntube;

import static org.junit.Assert.*;
import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class DeliveryTest {
    TrackingStore store;
    long now = 1_794_000_000_000L;
    DeviceCredentials.Pair pair = new DeviceCredentials.Pair("device-a", "test-key", "Test", "Tester");
    @Before public void open() { store = new TrackingStore(RuntimeEnvironment.getApplication()); }
    @After public void close() { store.close(); }
    JSONObject event(String id) throws Exception {
        return new JSONObject().put("eventId", id).put("kind", "watch").put("t", now).put("seconds", 1)
                .put("videoId", "abcdefghijk").put("title", "Test").put("lang", "").put("source", "android-player").put("conf", "");
    }
    void add(String id) throws Exception { store.append(pair.deviceId, event(id)); }
    String receipt(String device, String... ids) throws Exception {
        JSONArray accepted = new JSONArray(); for (String id : ids) accepted.put(id);
        return new JSONObject().put("deviceId", device).put("accepted", accepted).toString();
    }
    YtdashApi.Reply accept(String body) throws Exception {
        JSONObject json = new JSONObject(body);
        JSONArray ids = new JSONArray();
        JSONArray events = json.getJSONArray("events");
        for (int i = 0; i < events.length(); i++) ids.put(events.getJSONObject(i).getString("eventId"));
        return new YtdashApi.Reply(200, new JSONObject().put("deviceId", json.getString("deviceId")).put("accepted", ids).toString(), 0);
    }

    @Test public void restartPreservesImmutableEventsAndReceiptState() throws Exception {
        add("one"); add("two");
        String original = store.pending(pair.deviceId).get(0).json;
        store.close(); store = new TrackingStore(RuntimeEnvironment.getApplication());
        assertEquals(original, store.pending(pair.deviceId).get(0).json);
        store.acknowledge(pair.deviceId, store.pending(pair.deviceId), receipt(pair.deviceId, "one"), now);
        store.close(); store = new TrackingStore(RuntimeEnvironment.getApplication());
        assertEquals(1, store.count(pair.deviceId, false));
        assertEquals("two", store.pending(pair.deviceId).get(0).id);
        assertEquals(now, store.state(pair.deviceId).lastAck);
        assertEquals(1, store.state(pair.deviceId).acknowledged);
    }

    @Test public void malformedForeignAndDuplicateReceiptsDeleteNothing() throws Exception {
        add("one"); add("two");
        for (String body : new String[]{"not-json", "{}", receipt("wrong-device", "one"),
                receipt(pair.deviceId), receipt(pair.deviceId, "one", "one"), receipt(pair.deviceId, "one", "unknown")}) {
            try { store.acknowledge(pair.deviceId, store.pending(pair.deviceId), body, now); fail(body); }
            catch (Exception expected) { assertEquals(2, store.count(pair.deviceId, false)); }
        }
        assertEquals(0, store.state(pair.deviceId).lastAck);
    }

    @Test public void lostResponseResendsIdenticalBatchWithoutIncreasingServerTotals() throws Exception {
        add("one"); add("two");
        Set<String> serverIds = new HashSet<>();
        String[] original = {null}; int[] calls = {0};
        YtdashApi.Transport server = (key, body) -> {
            assertEquals("test-key", key);
            if (original[0] == null) original[0] = body; else assertEquals(original[0], body);
            JSONArray events = new JSONObject(body).getJSONArray("events");
            for (int i = 0; i < events.length(); i++) serverIds.add(events.getJSONObject(i).getString("eventId"));
            if (calls[0]++ == 0) throw new IOException("Response lost after server commit");
            return accept(body);
        };
        assertTrue(new Delivery(store, server, () -> now).drain(pair));
        assertEquals(2, store.count(pair.deviceId, false));
        now += 60_000;
        assertFalse(new Delivery(store, server, () -> now).drain(pair));
        assertEquals(2, serverIds.size()); assertEquals(0, store.count(pair.deviceId, false));
    }

    @Test public void keyRevocationPausesAndRotationResumesSameDeviceQueue() throws Exception {
        add("one");
        assertFalse(new Delivery(store, (key, body) -> new YtdashApi.Reply(401, "", 0), () -> now).drain(pair));
        assertTrue(store.state(pair.deviceId).paused);
        new Delivery(store, (key, body) -> { fail("Paused device must not upload"); return null; }, () -> now).drain(pair);
        store.resume(pair.deviceId);
        DeviceCredentials.Pair replacement = new DeviceCredentials.Pair(pair.deviceId, "replacement-key", "", "");
        assertFalse(new Delivery(store, (key, body) -> { assertEquals("replacement-key", key); return accept(body); }, () -> now).drain(replacement));
        assertEquals(0, store.count(pair.deviceId, false));
    }

    @Test public void retryAfterAndBackoffSurviveRestart() throws Exception {
        add("one"); long deadline = now + 120_000;
        assertTrue(new Delivery(store, (key, body) -> new YtdashApi.Reply(429, "", deadline), () -> now).drain(pair));
        store.close(); store = new TrackingStore(RuntimeEnvironment.getApplication());
        assertTrue(store.state(pair.deviceId).nextAttempt >= deadline);
        store.resume(pair.deviceId);
        assertTrue("Re-pairing must not bypass a server Retry-After", store.state(pair.deviceId).nextAttempt >= deadline);
        new Delivery(store, (key, body) -> { fail("Retry-After must be respected"); return null; }, () -> now).drain(pair);
        now = deadline + 1;
        assertFalse(new Delivery(store, (key, body) -> accept(body), () -> now).drain(pair));
    }

    @Test public void batchRejectionIsolatesBadEventAndExportsItUnchanged() throws Exception {
        add("good-one"); add("bad"); add("good-two");
        String bad = store.pending(pair.deviceId).get(1).json;
        YtdashApi.Transport server = (key, body) -> body.contains("\"eventId\":\"bad\"") ?
                new YtdashApi.Reply(422, "", 0) : accept(body);
        assertFalse(new Delivery(store, server, () -> now).drain(pair));
        assertEquals(0, store.count(pair.deviceId, false)); assertEquals(1, store.count(pair.deviceId, true));
        ByteArrayOutputStream output = new ByteArrayOutputStream(); store.export(output);
        JSONObject held = new JSONObject(output.toString("UTF-8")).getJSONArray("events").getJSONObject(0);
        assertEquals("HTTP 422", held.getString("error")); assertEquals(bad, held.getJSONObject("event").toString());
        assertFalse(output.toString("UTF-8").contains("test-key"));
        store.retryHeld(pair.deviceId);
        assertEquals(bad, store.pending(pair.deviceId).get(0).json);
        assertFalse(new Delivery(store, (key, body) -> accept(body), () -> now).drain(pair));
    }

    @Test public void switchingDeviceNeverMovesOrUploadsTheOriginalQueue() throws Exception {
        add("one"); store.append("device-b", event("two"));
        DeviceCredentials.Pair other = new DeviceCredentials.Pair("device-b", "key-b", "", "");
        new Delivery(store, (key, body) -> {
            assertFalse(body.contains("\"one\"")); assertEquals("device-b", new JSONObject(body).getString("deviceId"));
            return accept(body);
        }, () -> now).drain(other);
        assertEquals(1, store.count(pair.deviceId, false)); assertEquals(0, store.count("device-b", false));
    }

    @Test public void partialReceiptOnlyRemovesAcceptedRecords() throws Exception {
        add("one"); add("two");
        List<TrackingStore.Event> submitted = store.pending(pair.deviceId);
        store.acknowledge(pair.deviceId, submitted, receipt(pair.deviceId, "one"), now);
        assertEquals("two", store.pending(pair.deviceId).get(0).id);
        assertEquals(1, store.count(pair.deviceId, false));
    }

    EvidenceSnapshot evidence(String description) throws Exception {
        return EvidenceSnapshot.create(new JSONObject().put("title", "A title").put("description", description));
    }
    void add(String id, EvidenceSnapshot snapshot) throws Exception {
        store.append(pair.deviceId, event(id).put("evidenceId", snapshot.id), snapshot);
    }
    JSONObject export() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); store.export(output);
        return new JSONObject(output.toString("UTF-8"));
    }

    @Test public void evidenceSurvivesLostReceiptRestartPartialAckAndHeldExportExactly() throws Exception {
        EvidenceSnapshot snapshot = evidence("Unicode 🎥 \"quoted\"\nline two");
        add("one", snapshot); add("two", snapshot);
        String body = Delivery.body(pair.deviceId, store.pending(pair.deviceId));
        assertEquals(1, new JSONObject(body).getJSONObject("evidence").length());
        assertEquals(snapshot.json, new JSONObject(body).getJSONObject("evidence").getString(snapshot.id));
        new Delivery(store, (key, payload) -> { throw new IOException("Lost receipt"); }, () -> now).drain(pair);
        store.close(); store = new TrackingStore(RuntimeEnvironment.getApplication());
        assertEquals(body, Delivery.body(pair.deviceId, store.pending(pair.deviceId)));
        store.acknowledge(pair.deviceId, store.pending(pair.deviceId), receipt(pair.deviceId, "one"), now);
        store.hold(pair.deviceId, store.pending(pair.deviceId).get(0), 422);
        assertEquals(snapshot.json, export().getJSONObject("evidence").getString(snapshot.id));
        store.retryHeld(pair.deviceId);
        now += 60_000;
        assertFalse(new Delivery(store, (key, payload) -> {
            assertEquals(snapshot.json, new JSONObject(payload).getJSONObject("evidence").getString(snapshot.id));
            return accept(payload);
        }, () -> now).drain(pair));
        assertEquals(0, export().getJSONObject("evidence").length());
    }

    @Test public void failedAppendRollsBackEvidenceAndCannotCreateDanglingReference() throws Exception {
        add("one"); EvidenceSnapshot snapshot = evidence("New evidence");
        try { add("one", snapshot); fail("Duplicate should roll back"); } catch (android.database.SQLException expected) { }
        assertEquals(0, export().getJSONObject("evidence").length());
        try { store.append(pair.deviceId, event("two").put("evidenceId", snapshot.id)); fail(); }
        catch (IOException expected) { }
        assertEquals(1, store.count(pair.deviceId, false));
    }

    @Test public void sharedEvidenceRemainsWhileOtherDeviceReferencesIt() throws Exception {
        EvidenceSnapshot snapshot = evidence("Shared source"); add("one", snapshot);
        store.append("device-b", event("two").put("evidenceId", snapshot.id), snapshot);
        store.acknowledge(pair.deviceId, store.pending(pair.deviceId), receipt(pair.deviceId, "one"), now);
        assertEquals(snapshot.json, store.pending("device-b").get(0).evidence);
    }

    @Test public void batchBudgetIncludesEscapedEvidenceAndDeduplicatesSharedSnapshots() throws Exception {
        String large = new String(new char[10_000]).replace("\0", "\n\"");
        for (int i = 0; i < 100; i++) add("event-" + i, evidence(i + large));
        List<TrackingStore.Event> batch = store.pending(pair.deviceId);
        assertTrue(batch.size() < 100); assertTrue(batch.size() > 1);
        String body = Delivery.body(pair.deviceId, batch);
        assertTrue(body.getBytes(java.nio.charset.StandardCharsets.UTF_8).length < 3_000_000);
        assertEquals(batch.size(), new JSONObject(body).getJSONObject("evidence").length());
    }

    @Test public void versionOneMigrationPreservesPayloadHeldStateAndDeliveryDeadline() throws Exception {
        store.close();
        java.io.File file = new java.io.File(RuntimeEnvironment.getApplication().getNoBackupFilesDir(), "ytdash-outbox.db");
        android.database.sqlite.SQLiteDatabase.deleteDatabase(file);
        android.database.sqlite.SQLiteDatabase db = android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(file, null);
        db.execSQL("CREATE TABLE events (event_id TEXT PRIMARY KEY, origin TEXT NOT NULL, device TEXT NOT NULL, payload TEXT NOT NULL, held INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')");
        db.execSQL("CREATE TABLE delivery (origin TEXT NOT NULL, device TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, last_ack INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', PRIMARY KEY(origin,device))");
        String payload = event("legacy").toString();
        db.execSQL("INSERT INTO events VALUES (?,?,?,?,1,'HTTP 422')", new Object[]{"legacy", YtdashApi.ORIGIN, pair.deviceId, payload});
        db.execSQL("INSERT INTO delivery (origin,device,next_attempt) VALUES (?,?,?)", new Object[]{YtdashApi.ORIGIN, pair.deviceId, now + 60_000});
        db.setVersion(1); db.close();
        store = new TrackingStore(RuntimeEnvironment.getApplication());
        assertEquals(1, store.count(pair.deviceId, true));
        assertEquals(now + 60_000, store.state(pair.deviceId).nextAttempt);
        store.retryHeld(pair.deviceId);
        assertEquals(payload, store.pending(pair.deviceId).get(0).json);
        assertNull(store.pending(pair.deviceId).get(0).evidence);
        EvidenceSnapshot snapshot = evidence("Post-migration"); add("new", snapshot);
        assertEquals(2, store.count(pair.deviceId, false));
    }
}
