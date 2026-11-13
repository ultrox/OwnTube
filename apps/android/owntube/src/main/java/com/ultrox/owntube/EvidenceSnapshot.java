package com.ultrox.owntube;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import org.json.JSONArray;
import org.json.JSONObject;

/** Exact serialized UTF-8 bytes are the identity; never reserialize a stored snapshot. */
public final class EvidenceSnapshot {
    public final String id, json;
    private EvidenceSnapshot(String json) {
        this.json = json;
        this.id = hash(json);
    }

    public static EvidenceSnapshot create(JSONObject source) {
        try {
            JSONObject copy = new JSONObject(source.toString());
            JSONArray truncated = copy.optJSONArray("truncatedFields");
            if (truncated == null) truncated = new JSONArray();
            bound(copy, "", truncated);
            copy.put("truncatedFields", truncated);
            // Escaping and multibyte text can exceed the limit despite character bounds.
            // Reduce the largest remaining field, recording the exact affected path.
            while (copy.toString().getBytes(StandardCharsets.UTF_8).length > 63_800) {
                Candidate largest = new Candidate();
                largest.find(copy, "");
                if (largest.parent == null) throw new IllegalStateException("Evidence cannot be bounded");
                Object value = largest.parent.get(largest.key);
                if (value instanceof JSONArray) {
                    JSONArray old = (JSONArray) value, keep = new JSONArray();
                    for (int i = 0; i < old.length() / 2; i++) keep.put(old.get(i));
                    largest.parent.put(largest.key, keep);
                } else {
                    largest.parent.put(largest.key, WatchSegments.trim((String) value, ((String) value).length() / 2));
                }
                truncated.put(largest.path);
            }
            for (int i = 0; i < truncated.length(); i++) {
                if ("description".equals(truncated.optString(i))) copy.put("descriptionTruncated", true);
            }
            return new EvidenceSnapshot(copy.toString());
        } catch (Exception e) { throw new IllegalStateException("Unable to encode evidence", e); }
    }

    private static void bound(JSONObject object, String path, JSONArray truncated) throws Exception {
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next(), field = path.isEmpty() ? key : path + "." + key;
            if (key.equals("truncatedFields")) continue;
            Object value = object.get(key);
            if (value instanceof String) {
                int limit = key.equals("description") ? 10_000 : key.equals("title") ? 500 : 1000;
                String text = (String) value, shortened = WatchSegments.trim(text, limit);
                if (!text.equals(shortened)) { object.put(key, shortened); truncated.put(field); }
            } else if (value instanceof JSONObject) bound((JSONObject) value, field, truncated);
            else if (value instanceof JSONArray) {
                JSONArray array = (JSONArray) value;
                for (int i = 0; i < array.length(); i++) {
                    if (array.optJSONObject(i) != null) bound(array.getJSONObject(i), field + "[" + i + "]", truncated);
                }
            }
        }
    }

    private static final class Candidate {
        JSONObject parent;
        String key, path;
        int bytes;
        void find(JSONObject object, String prefix) throws Exception {
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String name = keys.next();
                if (name.equals("truncatedFields")) continue;
                Object value = object.get(name);
                String field = prefix.isEmpty() ? name : prefix + "." + name;
                if (value instanceof JSONObject) find((JSONObject) value, field);
                else if (value instanceof String || value instanceof JSONArray) {
                    int size = value.toString().getBytes(StandardCharsets.UTF_8).length;
                    if (size > bytes) { bytes = size; parent = object; key = name; path = field; }
                }
            }
        }
    }

    public static String hash(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(64);
            for (byte b : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            return result.toString();
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
}
