package com.ultrox.owntube;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** A single serial drain. Retries reuse exactly the stored IDs, timestamps and measurements. */
final class Delivery {
    interface Clock { long now(); }
    private final TrackingStore store;
    private final YtdashApi.Transport transport;
    private final Clock clock;
    private int requests;
    Delivery(TrackingStore store, YtdashApi.Transport transport, Clock clock) {
        this.store = store; this.transport = transport; this.clock = clock;
    }

    boolean drain(DeviceCredentials.Pair pair) {
        TrackingStore.State state = store.state(pair.deviceId);
        if (state.paused) return false;
        if (state.nextAttempt > clock.now()) return true;
        try {
            while (requests < 24) {
                List<TrackingStore.Event> batch = store.pending(pair.deviceId);
                if (batch.isEmpty()) return false;
                if (!send(pair, batch)) return !store.state(pair.deviceId).paused;
            }
        } catch (Exception e) {
            // Do not expose bearer keys, response bodies, or video metadata in diagnostic strings.
            store.failure(pair.deviceId, "Delivery interrupted or invalid receipt; events retained.", false, 0, clock.now(), Math.random());
        }
        return store.count(pair.deviceId, false) > 0;
    }

    private boolean send(DeviceCredentials.Pair pair, List<TrackingStore.Event> batch) throws Exception {
        if (requests++ >= 24) return false;
        JSONArray events = new JSONArray();
        for (TrackingStore.Event event : batch) events.put(new JSONObject(event.json));
        String body = new JSONObject().put("deviceId", pair.deviceId).put("events", events)
                .put("evidence", new JSONObject()).toString();
        YtdashApi.Reply reply = transport.send(pair.key, body);
        if (reply.code == 200) {
            store.acknowledge(pair.deviceId, batch, reply.body, clock.now());
            return true;
        }
        if (reply.code == 409 || reply.code == 413 || reply.code == 422) {
            if (batch.size() == 1) {
                store.hold(pair.deviceId, batch.get(0), reply.code);
                return true;
            }
            int middle = batch.size() / 2;
            return send(pair, new ArrayList<>(batch.subList(0, middle))) &&
                    send(pair, new ArrayList<>(batch.subList(middle, batch.size())));
        }
        boolean auth = reply.code == 401 || reply.code == 403;
        store.failure(pair.deviceId, auth ? "Device key rejected. Pair a valid or replacement key." :
                "HTTP " + reply.code + "; events retained for retry.", auth, reply.retryAt, clock.now(), Math.random());
        return false;
    }
}
