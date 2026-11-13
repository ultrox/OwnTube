package com.ultrox.owntube;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.OutputStream;
import java.text.DateFormat;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Deliberately small, D-pad accessible UI, independent of upstream's settings implementation. */
public final class TrackingActivity extends Activity {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private Tracking tracking;
    private TextView status, message;
    private EditText key;
    private Button pairButton, toggle;
    private boolean busy, resumed;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            if (!resumed) return;
            refreshStatus();
            main.postDelayed(this, 2000);
        }
    };

    public static void open(Context context) {
        if (!Tracking.supported(context)) return;
        Intent intent = new Intent(context, TrackingActivity.class);
        if (!(context instanceof Activity)) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (!Tracking.supported(this)) { finish(); return; }
        tracking = Tracking.get(this);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE |
                WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(48), dp(24), dp(48), dp(32));
        ScrollView scroll = new ScrollView(this);
        scroll.addView(column);
        setContentView(scroll);
        text(column, "OwnTube · Tracking", 30);
        text(column, YtdashApi.ORIGIN, 17);
        text(column, "Pair with the device key from ytdash → People & devices. The server supplies your device ID.", 16);
        status = text(column, "Loading…", 17);
        key = new EditText(this);
        key.setHint("Device key (not device ID)");
        key.setSingleLine(true);
        key.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        key.setSaveEnabled(false);
        key.setTextSize(18);
        column.addView(key, new LinearLayout.LayoutParams(-1, dp(60)));
        pairButton = button(column, "Pair / replace key", () -> pair());
        toggle = button(column, "Pause tracking", () -> {
            tracking.setEnabled(!tracking.enabled);
            refreshStatus();
        });
        button(column, "Upload now", () -> {
            UploadWorker.schedule(this, false);
            message.setText("Upload requested. Network backoff and key errors still apply.");
            refreshStatus();
        });
        button(column, "Inspect latest captured evidence", () -> {
            EvidenceSnapshot evidence = tracking.latestEvidence;
            if (evidence == null) { message.setText("No evidence captured in this app session yet. Play a video first."); return; }
            TextView content = new TextView(this);
            content.setTextIsSelectable(true);
            content.setPadding(dp(16), dp(16), dp(16), dp(16));
            content.setText("SHA-256: " + evidence.id + "\n" + evidence.json);
            ScrollView evidenceScroll = new ScrollView(this);
            evidenceScroll.addView(content);
            new android.app.AlertDialog.Builder(this).setTitle("Captured source evidence")
                    .setView(evidenceScroll).setPositiveButton("Close", null).show();
        });
        button(column, "Retry held events for this device", () -> {
            DeviceCredentials.Pair pair = tracking.pair;
            if (pair == null) return;
            io.execute(() -> {
                tracking.store.retryHeld(pair.deviceId);
                UploadWorker.schedule(this, false);
                ui(() -> { message.setText("Held events queued unchanged for retry."); refreshStatus(); });
            });
        });
        button(column, "Export queued and held events", () -> {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json")
                    .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, "owntube-outbox.json");
            try { startActivityForResult(intent, 10); }
            catch (RuntimeException e) { message.setText("No document picker available on this device."); }
        });
        message = text(column, "Cumulative viewing records replace their totals on each revision. Acknowledgements count uploaded checkpoints, not extra watch time. " +
                "Only actual playback is collected. Pauses, buffering, ads and incognito videos are excluded. " +
                "Previously queued events still upload when capture is paused.", 15);
        button(column, "Back", this::finish);
        pairButton.requestFocus();
    }

    private void pair() {
        if (busy) return;
        String value = key.getText().toString().trim();
        if (value.isEmpty()) { message.setText("Enter the device key first."); return; }
        busy = true;
        pairButton.setEnabled(false);
        message.setText("Validating device key…");
        io.execute(() -> {
            String result;
            try {
                tracking.pair(value);
                result = "Paired. Playback tracking is on.";
            } catch (Exception e) {
                result = e instanceof java.io.IOException ? e.getMessage() : "Pairing could not be saved. Please try again.";
            }
            String display = result;
            ui(() -> {
                ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(key.getWindowToken(), 0);
                key.setText("");
                busy = false;
                pairButton.setEnabled(true);
                message.setText(display);
                toggle.requestFocus();
                refreshStatus();
            });
        });
    }

    private void refreshStatus() {
        if (tracking == null || io.isShutdown()) return;
        io.execute(() -> {
            DeviceCredentials.Pair pair = tracking.pair;
            String device = pair == null ? null : pair.deviceId;
            TrackingStore.State delivery = tracking.store.state(device);
            int pending = tracking.store.count(device, false), held = tracking.store.count(device, true);
            int other = device == null ? 0 : tracking.store.count(null, false) + tracking.store.count(null, true) - pending - held;
            String value = pair == null ? "Not paired" : pair.label + " · " + pair.person + "\nDevice ID: " + pair.deviceId;
            value += "\nCapture: " + (tracking.enabled && pair != null ? "On" : "Off") +
                    " · Pending: " + pending + " · Held: " + held + " · Acknowledged: " + delivery.acknowledged;
            value += "\nLast acknowledgement: " + (delivery.lastAck == 0 ? "None" : date(delivery.lastAck));
            if (other > 0) value += "\n" + other + " events belong to another device. Pair its key to deliver them.";
            if (delivery.paused) value += "\nUploads paused: replace the device key.";
            else if (delivery.nextAttempt > System.currentTimeMillis()) value += "\nRetry after: " + date(delivery.nextAttempt);
            if (!delivery.error.isEmpty()) value += "\n" + delivery.error;
            if (!tracking.localError.isEmpty()) value += "\n" + tracking.localError;
            String display = value;
            ui(() -> {
                status.setText(display);
                toggle.setEnabled(pair != null);
                toggle.setText(tracking.enabled ? "Pause tracking" : "Resume tracking");
            });
        });
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != 10 || result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        io.execute(() -> {
            String resultText;
            try (OutputStream output = getContentResolver().openOutputStream(uri)) {
                if (output == null) throw new java.io.IOException();
                tracking.store.export(output);
                resultText = "Export saved. Events remain queued; no device keys are exported.";
            } catch (Exception e) { resultText = "Export failed. Events remain queued."; }
            String display = resultText;
            ui(() -> message.setText(display));
        });
    }

    @Override protected void onResume() { super.onResume(); resumed = true; main.post(refresh); }
    @Override protected void onPause() { resumed = false; main.removeCallbacks(refresh); super.onPause(); }
    @Override protected void onDestroy() { main.removeCallbacksAndMessages(null); io.shutdown(); super.onDestroy(); }
    private void ui(Runnable action) { main.post(() -> { if (!isFinishing() && !isDestroyed()) action.run(); }); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private static String date(long millis) { return DateFormat.getDateTimeInstance().format(new Date(millis)); }
    private TextView text(LinearLayout parent, String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size);
        view.setTextColor(Color.WHITE); view.setPadding(0, dp(6), 0, dp(8)); parent.addView(view); return view;
    }
    private Button button(LinearLayout parent, String title, Runnable action) {
        Button button = new Button(this); button.setText(title); button.setAllCaps(false);
        button.setOnClickListener(view -> action.run());
        parent.addView(button, new LinearLayout.LayoutParams(-1, dp(52))); return button;
    }
}
