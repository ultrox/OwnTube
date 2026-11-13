package com.ultrox.owntube;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.ContextWrapper;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.google.android.exoplayer2.ExoPlaybackException;
import com.google.android.exoplayer2.PlaybackParameters;
import com.google.android.exoplayer2.Player;
import com.google.android.exoplayer2.Timeline;

/** Small ExoPlayer adapter. Actual playing state, ad state and discontinuities drive capture. */
public final class PlayerCollector implements Player.EventListener, Application.ActivityLifecycleCallbacks {
    public interface VideoSource { WatchSegments.VideoInfo current(); }
    interface WallClock { long now(); }
    private final Tracking tracking;
    private final WallClock wallClock;
    private final VideoSource source;
    private final Activity host;
    private final Application application;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final WatchSegments segments;
    private final ViewingRecords viewings;
    private final SelectedEvidence selectedEvidence = new SelectedEvidence();
    private Player player;
    private boolean visible, seeking, awaitingSource;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (player == null) return;
            sample(false, false);
            handler.postDelayed(this, 1000);
        }
    };

    public static PlayerCollector create(Context context, VideoSource source) {
        return Tracking.supported(context) ? new PlayerCollector(context, source) : null;
    }
    PlayerCollector(Context context, VideoSource source) {
        this(context, source, System::currentTimeMillis);
    }
    PlayerCollector(Context context, VideoSource source, WallClock wallClock) {
        this.source = source;
        this.wallClock = wallClock;
        tracking = Tracking.get(context);
        host = activity(context);
        application = (Application) context.getApplicationContext();
        visible = host != null && host.getWindow().getDecorView().isShown();
        viewings = new ViewingRecords(tracking::persist);
        segments = new WatchSegments(viewings::add);
    }

    public void attach(Player player) {
        detach();
        this.player = player;
        seeking = false;
        application.registerActivityLifecycleCallbacks(this);
        player.addListener(this);
        handler.post(tick);
    }

    public void beforeVideoChange() {
        sample(true, true);
        resetCapture();
        awaitingSource = true;
    }

    public void preparingSource() {
        sample(true, true);
        resetCapture();
        awaitingSource = false;
        seeking = false;
    }

    public void detach() {
        if (player != null) {
            sample(false, true);
            player.removeListener(this);
            application.unregisterActivityLifecycleCallbacks(this);
            player = null;
            resetCapture();
            UploadWorker.schedule(tracking.context, false);
        }
        handler.removeCallbacks(tick);
    }

    private void sample(boolean boundary, boolean stopped) {
        if (player == null) return;
        try {
            DeviceCredentials.Pair pair = tracking.pair;
            WatchSegments.VideoInfo video = source.current();
            boolean active = !stopped && !awaitingSource && !seeking && tracking.enabled && pair != null &&
                    video != null && !video.incognito && player.isPlaying() && !player.isPlayingAd();
            if (active) video = selectedEvidence.attach(video, player);
            String context = host == null ? null : visible ? "foreground" : "background";
            segments.sample(new WatchSegments.Frame(SystemClock.elapsedRealtime(), wallClock.now(),
                    player.getCurrentPosition(), player.getDuration(), player.getPlaybackParameters().speed,
                    active, pair == null ? null : pair.deviceId, context, video), boundary);
        } catch (RuntimeException e) {
            // Collector failures must not stop video playback. Do not infer time across this gap.
            resetCapture();
            tracking.localError = "Playback capture interrupted; check tracking status.";
        }
    }

    @Override public void onIsPlayingChanged(boolean isPlaying) { sample(false, false); }
    private void resetCapture() { segments.reset(); viewings.reset(); }
    @Override public void onPlayerStateChanged(boolean playWhenReady, int state) { sample(false, false); }
    @Override public void onPlaybackParametersChanged(PlaybackParameters parameters) { sample(false, false); }
    @Override public void onPlayerError(ExoPlaybackException error) { sample(false, true); }
    @Override public void onPositionDiscontinuity(int reason) {
        sample(true, true);
        seeking = reason == Player.DISCONTINUITY_REASON_SEEK || reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT;
        sample(true, false);
    }
    @Override public void onSeekProcessed() { seeking = false; sample(true, false); }
    @Override public void onTimelineChanged(Timeline timeline, Object manifest, int reason) { sample(true, false); }

    @Override public void onActivityStarted(Activity activity) {
        if (activity == host) { sample(false, false); visible = true; sample(false, false); }
    }
    @Override public void onActivityStopped(Activity activity) {
        if (activity == host) { sample(false, false); visible = false; sample(false, false); }
    }
    @Override public void onActivityDestroyed(Activity activity) { if (activity == host) detach(); }
    @Override public void onActivityCreated(Activity activity, Bundle state) { }
    @Override public void onActivityResumed(Activity activity) { }
    @Override public void onActivityPaused(Activity activity) { }
    @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) { }

    private static Activity activity(Context context) {
        while (context instanceof ContextWrapper) {
            if (context instanceof Activity) return (Activity) context;
            Context next = ((ContextWrapper) context).getBaseContext();
            if (next == context) break;
            context = next;
        }
        return null;
    }
}
