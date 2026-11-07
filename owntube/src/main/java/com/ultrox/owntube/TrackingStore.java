package com.ultrox.owntube;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Immutable, device-bound records. Kept outside Android backup along with delivery state. */
final class TrackingStore extends SQLiteOpenHelper {
    static final class Event {
        final String id, json, evidenceId, evidence;
        Event(String id, String json, String evidenceId, String evidence) {
            this.id = id; this.json = json; this.evidenceId = evidenceId; this.evidence = evidence;
        }
    }
    static final class State {
        int failures;
        long nextAttempt, lastAck, acknowledged;
        boolean paused;
        String error = "";
    }

    TrackingStore(Context context) {
        super(context, new File(context.getNoBackupFilesDir(), "ytdash-outbox.db").getAbsolutePath(), null, 2);
        setWriteAheadLoggingEnabled(true);
    }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE events (event_id TEXT PRIMARY KEY, origin TEXT NOT NULL, device TEXT NOT NULL," +
                " payload TEXT NOT NULL, held INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')");
        db.execSQL("CREATE INDEX event_queue ON events(origin, device, held)");
        db.execSQL("CREATE TABLE delivery (origin TEXT NOT NULL, device TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0," +
                " next_attempt INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, last_ack INTEGER NOT NULL DEFAULT 0," +
                " acknowledged INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', PRIMARY KEY(origin,device))");
        addEvidenceSchema(db);
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion == 1 && newVersion == 2) addEvidenceSchema(db);
        else throw new IllegalStateException("An explicit outbox migration is required");
    }
    private static void addEvidenceSchema(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE evidence (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)");
        db.execSQL("ALTER TABLE events ADD COLUMN evidence_id TEXT");
        db.execSQL("CREATE INDEX event_evidence ON events(evidence_id)");
    }

    synchronized void append(String device, JSONObject event) throws Exception {
        append(device, event, null);
    }
    synchronized void append(String device, JSONObject event, EvidenceSnapshot evidence) throws Exception {
        if (evidence == null ? event.has("evidenceId") : !evidence.id.equals(event.optString("evidenceId"))) {
            throw new IOException("Evidence reference mismatch");
        }
        String payload = event.toString();
        ContentValues values = new ContentValues();
        values.put("event_id", event.getString("eventId"));
        values.put("origin", YtdashApi.ORIGIN);
        values.put("device", device);
        values.put("payload", payload);
        if (evidence != null) values.put("evidence_id", evidence.id);
        if (payload.getBytes(StandardCharsets.UTF_8).length > 64_000) {
            values.put("held", 1);
            values.put("error", "Event exceeds 64,000 bytes");
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            if (evidence != null) {
                ContentValues snapshot = new ContentValues();
                snapshot.put("id", evidence.id); snapshot.put("snapshot", evidence.json);
                db.insertWithOnConflict("evidence", null, snapshot, SQLiteDatabase.CONFLICT_IGNORE);
            }
            db.insertOrThrow("events", null, values);
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized List<Event> pending(String device) {
        List<Event> events = new ArrayList<>();
        int bytes = 4096;
        Set<String> evidenceIds = new HashSet<>();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT e.event_id,e.payload,e.evidence_id,s.snapshot " +
                "FROM events e LEFT JOIN evidence s ON s.id=e.evidence_id " +
                "WHERE e.origin=? AND e.device=? AND e.held=0 ORDER BY e.rowid LIMIT 100", binding(device))) {
            while (c.moveToNext()) {
                String json = c.getString(1);
                String evidenceId = c.getString(2), snapshot = c.getString(3);
                if (evidenceId != null && snapshot == null) throw new IllegalStateException("Missing evidence snapshot");
                int size = json.getBytes(StandardCharsets.UTF_8).length + 1;
                if (evidenceId != null && !evidenceIds.contains(evidenceId)) {
                    // The protocol embeds evidence as a JSON STRING, so count its escaping too.
                    size += JSONObject.quote(snapshot).getBytes(StandardCharsets.UTF_8).length + 70;
                }
                if (bytes + size > 3_000_000) break;
                events.add(new Event(c.getString(0), json, evidenceId, snapshot));
                if (evidenceId != null) evidenceIds.add(evidenceId);
                bytes += size;
            }
        }
        return events;
    }

    synchronized int count(String device, boolean held) {
        String query = "SELECT COUNT(*) FROM events WHERE origin=? AND held=?" + (device == null ? "" : " AND device=?");
        String[] args = device == null ? new String[]{YtdashApi.ORIGIN, held ? "1" : "0"} :
                new String[]{YtdashApi.ORIGIN, held ? "1" : "0", device};
        try (Cursor c = getReadableDatabase().rawQuery(query, args)) { c.moveToFirst(); return c.getInt(0); }
    }

    synchronized State state(String device) {
        State state = new State();
        if (device == null) return state;
        try (Cursor c = getReadableDatabase().query("delivery", null, "origin=? AND device=?", binding(device), null, null, null)) {
            if (c.moveToFirst()) {
                state.failures = c.getInt(c.getColumnIndexOrThrow("failures"));
                state.nextAttempt = c.getLong(c.getColumnIndexOrThrow("next_attempt"));
                state.paused = c.getInt(c.getColumnIndexOrThrow("paused")) != 0;
                state.lastAck = c.getLong(c.getColumnIndexOrThrow("last_ack"));
                state.acknowledged = c.getLong(c.getColumnIndexOrThrow("acknowledged"));
                state.error = c.getString(c.getColumnIndexOrThrow("error"));
            }
        }
        return state;
    }

    private void saveState(SQLiteDatabase db, String device, State state) {
        ContentValues values = new ContentValues();
        values.put("origin", YtdashApi.ORIGIN); values.put("device", device);
        values.put("failures", state.failures); values.put("next_attempt", state.nextAttempt);
        values.put("paused", state.paused ? 1 : 0); values.put("last_ack", state.lastAck);
        values.put("acknowledged", state.acknowledged); values.put("error", state.error);
        db.insertWithOnConflict("delivery", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    synchronized void failure(String device, String message, boolean paused, long retryAt, long now, double jitter) {
        State state = state(device);
        state.failures = Math.min(20, state.failures + 1);
        long delay = Math.min(6 * 60 * 60 * 1000L, 5_000L << Math.min(13, state.failures - 1));
        state.nextAttempt = Math.max(retryAt, now + (long) (delay * (0.75 + jitter * 0.5)));
        state.paused = paused;
        state.error = message;
        saveState(getWritableDatabase(), device, state);
    }

    synchronized void resume(String device) {
        State state = state(device);
        if (state.paused) {
            state.paused = false; state.failures = 0; state.nextAttempt = 0; state.error = "";
        }
        saveState(getWritableDatabase(), device, state);
    }

    /** Validate the complete receipt before changing any rows. Deletion and receipt share one transaction. */
    synchronized void acknowledge(String device, List<Event> submitted, String body, long now) throws Exception {
        JSONObject receipt = new JSONObject(body);
        if (!device.equals(receipt.opt("deviceId"))) throw new IOException("Receipt device mismatch");
        JSONArray accepted = receipt.optJSONArray("accepted");
        if (accepted == null || accepted.length() == 0) throw new IOException("Empty or invalid receipt");
        Set<String> sent = new HashSet<>(), ids = new HashSet<>();
        for (Event event : submitted) sent.add(event.id);
        for (int i = 0; i < accepted.length(); i++) {
            Object value = accepted.get(i);
            if (!(value instanceof String) || !sent.contains(value) || !ids.add((String) value)) {
                throw new IOException("Invalid receipt IDs");
            }
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            int deleted = 0;
            for (String id : ids) {
                deleted += db.delete("events", "origin=? AND device=? AND event_id=? AND held=0",
                        new String[]{YtdashApi.ORIGIN, device, id});
            }
            State state = state(device);
            state.lastAck = now; state.acknowledged += deleted;
            state.failures = 0; state.nextAttempt = 0; state.error = ""; state.paused = false;
            saveState(db, device, state);
            db.execSQL("DELETE FROM evidence WHERE NOT EXISTS (SELECT 1 FROM events WHERE evidence_id=evidence.id)");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized void hold(String device, Event event, int status) {
        ContentValues values = new ContentValues();
        values.put("held", 1); values.put("error", "HTTP " + status);
        getWritableDatabase().update("events", values, "origin=? AND device=? AND event_id=?",
                new String[]{YtdashApi.ORIGIN, device, event.id});
    }

    synchronized void retryHeld(String device) {
        ContentValues values = new ContentValues();
        values.put("held", 0); values.put("error", "");
        getWritableDatabase().update("events", values, "origin=? AND device=?", binding(device));
        // Explicitly retry held events, but retain auth pauses and server Retry-After deadlines.
    }

    synchronized void export(OutputStream output) throws Exception {
        output.write("{\"format\":\"owntube-outbox-v2\",\"events\":[".getBytes(StandardCharsets.UTF_8));
        boolean first = true;
        try (Cursor c = getReadableDatabase().query("events", null, null, null, null, null, "rowid")) {
            while (c.moveToNext()) {
                JSONObject row = new JSONObject().put("origin", c.getString(c.getColumnIndexOrThrow("origin")))
                        .put("deviceId", c.getString(c.getColumnIndexOrThrow("device")))
                        .put("held", c.getInt(c.getColumnIndexOrThrow("held")) != 0)
                        .put("error", c.getString(c.getColumnIndexOrThrow("error")))
                        .put("event", new JSONObject(c.getString(c.getColumnIndexOrThrow("payload"))));
                if (!first) output.write(',');
                output.write(row.toString().getBytes(StandardCharsets.UTF_8));
                first = false;
            }
        }
        output.write("],\"evidence\":{".getBytes(StandardCharsets.UTF_8));
        first = true;
        try (Cursor c = getReadableDatabase().query("evidence", new String[]{"id", "snapshot"}, null, null, null, null, "id")) {
            while (c.moveToNext()) {
                if (!first) output.write(',');
                output.write((JSONObject.quote(c.getString(0)) + ":" + JSONObject.quote(c.getString(1))).getBytes(StandardCharsets.UTF_8));
                first = false;
            }
        }
        output.write("}}".getBytes(StandardCharsets.UTF_8));
    }

    private static String[] binding(String device) { return new String[]{YtdashApi.ORIGIN, device}; }
}
