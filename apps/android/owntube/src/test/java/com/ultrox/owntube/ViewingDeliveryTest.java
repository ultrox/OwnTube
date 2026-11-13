package com.ultrox.owntube;

import static org.junit.Assert.*;
import java.util.List;
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
public class ViewingDeliveryTest {
    TrackingStore store;
    @Before public void open() { store = new TrackingStore(RuntimeEnvironment.getApplication()); }
    @After public void close() { store.close(); }
    JSONObject record(int revision) throws Exception {
        return ViewingRecordsTest.segment(ViewingRecordsTest.BASE, revision, 0, revision)
                .put("eventId", "viewing-a").put("kind", "viewing").put("viewingId", "session-a")
                .put("bucket", ViewingRecordsTest.BASE).put("revision", revision)
                .put("lastWatched", ViewingRecordsTest.BASE + revision * 1000)
                .put("coverage", new JSONArray().put(new JSONArray().put(0).put(revision)));
    }
    String receipt() { return "{\"deviceId\":\"device-a\",\"accepted\":[\"viewing-a\"]}"; }

    @Test public void olderReceiptAndRejectionCannotRemoveOrHoldNewerRevision() throws Exception {
        store.append("device-a", record(1));
        List<TrackingStore.Event> sent = store.pending("device-a");
        store.append("device-a", record(2));
        store.acknowledge("device-a", sent, receipt(), 123);
        store.hold("device-a", sent.get(0), 409);
        assertEquals(1, store.count("device-a", false));
        assertEquals(0, store.count("device-a", true));
        assertEquals(2, new JSONObject(store.pending("device-a").get(0).json).getInt("revision"));
        assertEquals(1, store.state("device-a").acknowledged);
        store.acknowledge("device-a", store.pending("device-a"), receipt(), 124);
        assertEquals(0, store.count("device-a", false));
    }

    @Test public void staleRetriesConflictsAndDecreasingTotalsPreserveQueue() throws Exception {
        store.append("device-a", record(2));
        store.append("device-a", record(1));
        store.append("device-a", record(2));
        for (JSONObject bad : new JSONObject[]{record(2).put("title", "conflict"),
                record(3).put("title", "changed"), record(3).put("seconds", 1),
                record(3).put("lastWatched", ViewingRecordsTest.BASE + 1000),
                record(3).put("coverage", new JSONArray())}) {
            try { store.append("device-a", bad); fail("Accepted conflicting revision"); }
            catch (java.io.IOException expected) { }
        }
        assertEquals(record(2).toString(), store.pending("device-a").get(0).json);
    }

    @Test public void heldRevisionsStayHeldAndLegacyQueueSurvivesRestart() throws Exception {
        store.append("device-a", ViewingRecordsTest.segment(ViewingRecordsTest.BASE - 1000, 1, 0, 1));
        store.append("device-a", record(1));
        store.hold("device-a", store.pending("device-a").get(1), 422);
        store.append("device-a", record(2));
        store.close(); open();
        assertEquals(1, store.count("device-a", false));
        assertEquals(1, store.count("device-a", true));
        assertEquals("watch", new JSONObject(store.pending("device-a").get(0).json).getString("kind"));
        store.retryHeld("device-a");
        assertEquals(2, new JSONObject(store.pending("device-a").get(1).json).getInt("revision"));
    }
}
