package com.ultrox.owntube;

import android.content.Context;
import android.os.Build;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** OwnTube-only entry point. Upstream app variants neither initialize nor run the collector. */
public final class Tracking {
    private static Tracking instance;
    final Context context;
    final TrackingStore store;
    final ExecutorService disk = Executors.newSingleThreadExecutor();
    final DeviceCredentials credentials;
    volatile DeviceCredentials.Pair pair;
    volatile String localError = "";
    volatile boolean enabled;
    volatile EvidenceSnapshot latestEvidence;
    private long lastSchedule;

    public static boolean supported(Context context) {
        return Build.VERSION.SDK_INT >= 23 && "com.ultrox.owntube".equals(context.getPackageName());
    }
    static synchronized Tracking get(Context context) {
        if (instance == null) instance = new Tracking(context.getApplicationContext());
        return instance;
    }
    private Tracking(Context context) {
        this.context = context;
        store = new TrackingStore(context);
        credentials = new DeviceCredentials(context);
        enabled = context.getSharedPreferences("owntube_tracking", 0).getBoolean("enabled", false);
        disk.execute(() -> {
            try { pair = credentials.load(); }
            catch (Exception e) { localError = "Saved device key unavailable. Pair again to resume the existing queue."; }
            UploadWorker.schedule(context, true);
        });
    }

    void persist(String device, JSONObject event, EvidenceSnapshot evidence) {
        // Copy before crossing threads. Capture time/binding never depend on whichever pairing exists later.
        String immutable = event.toString();
        disk.execute(() -> {
            try {
                store.append(device, new JSONObject(immutable), evidence);
                latestEvidence = evidence;
                localError = "";
                long now = android.os.SystemClock.elapsedRealtime();
                if (now - lastSchedule >= 30_000 || lastSchedule == 0) {
                    lastSchedule = now;
                    UploadWorker.schedule(context, false);
                }
            } catch (Exception e) {
                localError = "Could not persist watch data. Check device storage; tracking is paused.";
                setEnabled(false);
            }
        });
    }

    void pair(String key) throws Exception {
        DeviceCredentials.Pair validated = new YtdashApi().pair(key);
        // Serialize configuration changes with the uploader; no stale 401 can undo key rotation.
        synchronized (UploadWorker.LOCK) {
            credentials.save(validated);
            store.resume(validated.deviceId);
            pair = validated;
            localError = "";
            setEnabled(true);
        }
        UploadWorker.schedule(context, true, true);
    }

    void setEnabled(boolean value) {
        enabled = value;
        context.getSharedPreferences("owntube_tracking", 0).edit().putBoolean("enabled", value).apply();
    }
}
