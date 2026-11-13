package com.ultrox.owntube;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Turns transient player measurements into bounded cumulative viewing checkpoints. */
final class ViewingRecords {
    static final long BUCKET_MS = 900_000;
    private final WatchSegments.EvidenceSink sink;
    private final Map<String, JSONObject> records = new LinkedHashMap<>();
    private String device, video, viewing;

    ViewingRecords(WatchSegments.EvidenceSink sink) { this.sink = sink; }

    void reset() { records.clear(); device = video = viewing = null; }

    void add(String deviceId, JSONObject segment, EvidenceSnapshot evidence) {
        try {
            String videoId = segment.getString("videoId");
            if (!deviceId.equals(device) || !videoId.equals(video)) {
                reset(); device = deviceId; video = videoId; viewing = UUID.randomUUID().toString();
            }
            JSONObject metadata = new JSONObject(segment.toString());
            for (String key : new String[]{"eventId", "kind", "t", "seconds", "coverage"}) metadata.remove(key);
            double t = segment.getDouble("t"), seconds = segment.getDouble("seconds"), end = t + seconds * 1000;
            JSONArray coverage = segment.optJSONArray("coverage");
            double cursor = t, remaining = seconds;
            while (cursor < end) {
                long bucket = (long) Math.floor(cursor / BUCKET_MS) * BUCKET_MS;
                double next = Math.min(end, bucket + BUCKET_MS);
                double part = next == end ? remaining : (next - cursor) / 1000;
                JSONArray ranges = new JSONArray();
                if (coverage != null) {
                    double a = coverage.getDouble(0), span = coverage.getDouble(1) - a;
                    ranges.put(new JSONArray().put(a + span * (cursor - t) / (seconds * 1000))
                            .put(a + span * (next - t) / (seconds * 1000)));
                }
                String key = bucket + ":" + signature(metadata);
                JSONObject previous = records.get(key);
                JSONArray merged = merge(previous == null ? new JSONArray() : previous.getJSONArray("coverage"), ranges);
                // Seal before payload growth or wall-clock discontinuity could invalidate a checkpoint.
                if (previous != null && (merged.length() > 500 || next < previous.getDouble("lastWatched") ||
                        previous.getDouble("seconds") + part > (next - previous.getDouble("t")) / 1000 + .001)) {
                    previous = null; merged = ranges;
                }
                JSONObject record = new JSONObject(metadata.toString()).put("kind", "viewing")
                        .put("eventId", previous == null ? "android-viewing-" + UUID.randomUUID() : previous.getString("eventId"))
                        .put("viewingId", viewing).put("bucket", bucket)
                        .put("revision", previous == null ? 1 : previous.getLong("revision") + 1)
                        .put("t", previous == null ? cursor : previous.getDouble("t"))
                        .put("lastWatched", next).put("seconds", (previous == null ? 0 : previous.getDouble("seconds")) + part)
                        .put("coverage", merged);
                records.put(key, record);
                // Neither the outbox nor an in-flight request may mutate the active accumulator.
                sink.persist(deviceId, new JSONObject(record.toString()), evidence);
                Iterator<JSONObject> old = records.values().iterator();
                while (old.hasNext()) {
                    long savedBucket = old.next().getLong("bucket");
                    if (savedBucket < bucket - BUCKET_MS || savedBucket > bucket) old.remove();
                }
                // Rapid metadata/track changes must not grow process memory indefinitely.
                while (records.size() > 64) records.remove(records.keySet().iterator().next());
                remaining -= part; cursor = next;
            }
        } catch (JSONException e) { throw new IllegalStateException("Unable to encode viewing checkpoint", e); }
    }

    static JSONArray merge(JSONArray a, JSONArray b) throws JSONException {
        List<double[]> ranges = new ArrayList<>();
        for (JSONArray source : new JSONArray[]{a, b}) for (int i = 0; i < source.length(); i++) {
            JSONArray r = source.getJSONArray(i); ranges.add(new double[]{r.getDouble(0), r.getDouble(1)});
        }
        Collections.sort(ranges, (x, y) -> Double.compare(x[0], y[0]));
        List<double[]> merged = new ArrayList<>();
        for (double[] range : ranges) {
            double[] last = merged.isEmpty() ? null : merged.get(merged.size() - 1);
            if (last != null && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
            else merged.add(range);
        }
        JSONArray result = new JSONArray();
        for (double[] range : merged) result.put(new JSONArray().put(range[0]).put(range[1]));
        return result;
    }

    private static String signature(JSONObject value) throws JSONException {
        List<String> keys = new ArrayList<>();
        Iterator<String> it = value.keys(); while (it.hasNext()) keys.add(it.next());
        Collections.sort(keys);
        JSONArray fields = new JSONArray();
        for (String key : keys) fields.put(key).put(value.get(key));
        return fields.toString();
    }

    static void validateSuccessor(JSONObject old, JSONObject next) throws Exception {
        JSONObject a = new JSONObject(old.toString()), b = new JSONObject(next.toString());
        for (String key : new String[]{"revision", "seconds", "lastWatched", "coverage"}) { a.remove(key); b.remove(key); }
        if (!signature(a).equals(signature(b)) || next.getDouble("seconds") < old.getDouble("seconds") ||
                next.getDouble("lastWatched") < old.getDouble("lastWatched")) throw new IOException("Conflicting viewing revision");
        JSONArray before = old.getJSONArray("coverage"), after = merge(next.getJSONArray("coverage"), new JSONArray());
        for (int i = 0; i < before.length(); i++) {
            JSONArray range = before.getJSONArray(i); boolean contained = false;
            for (int j = 0; j < after.length(); j++) {
                JSONArray candidate = after.getJSONArray(j);
                if (candidate.getDouble(0) <= range.getDouble(0) && candidate.getDouble(1) >= range.getDouble(1)) { contained = true; break; }
            }
            if (!contained) throw new IOException("Viewing coverage decreased");
        }
    }
}
