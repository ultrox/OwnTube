package com.ultrox.owntube;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;
import android.app.Activity;
import android.os.Looper;
import com.google.android.exoplayer2.PlaybackParameters;
import com.google.android.exoplayer2.Player;
import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
public class PlayerCollectorTest {
    Activity activity;
    Tracking tracking;
    PlayerCollector collector;
    Player.EventListener listener;
    long position;
    boolean playing = true, ad;

    @Before public void setup() throws Exception {
        Field instance = Tracking.class.getDeclaredField("instance"); instance.setAccessible(true); instance.set(null, null);
        activity = Robolectric.buildActivity(Activity.class).setup().visible().get();
        tracking = Tracking.get(activity);
        tracking.disk.submit(() -> { }).get();
        tracking.pair = new DeviceCredentials.Pair("device-a", "test-key", "", ""); tracking.enabled = true;
        Player player = (Player) Proxy.newProxyInstance(Player.class.getClassLoader(), new Class<?>[]{Player.class}, (proxy, method, args) -> {
            switch (method.getName()) {
                case "isPlaying": return playing;
                case "isPlayingAd": return ad;
                case "getCurrentPosition": return position;
                case "getDuration": return 600_000L;
                case "getPlaybackParameters": return new PlaybackParameters(1);
                case "addListener": listener = (Player.EventListener) args[0]; return null;
                case "removeListener": return null;
                default: throw new AssertionError(method.getName());
            }
        });
        // Looper time is simulated; the JVM's wall clock does not advance with idleFor.
        collector = new PlayerCollector(activity, () -> new WatchSegments.VideoInfo("abcdefghijk", "Test", "Channel", false, false, false),
                () -> ViewingRecordsTest.BASE + android.os.SystemClock.elapsedRealtime());
        collector.attach(player);
        collector.onActivityStarted(activity);
        shadowOf(Looper.getMainLooper()).idle();
    }
    @After public void teardown() throws Exception {
        collector.detach(); tracking.disk.submit(() -> { }).get(); tracking.disk.shutdown(); tracking.store.close();
        Field instance = Tracking.class.getDeclaredField("instance"); instance.setAccessible(true); instance.set(null, null);
    }
    void second(long mediaPosition) throws Exception {
        position = mediaPosition;
        shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS);
        tracking.disk.submit(() -> { }).get();
    }

    @Test public void actualPlayerAdAndBufferStatesExcludeTheirIntervals() throws Exception {
        second(1000);
        ad = true; listener.onPositionDiscontinuity(Player.DISCONTINUITY_REASON_AD_INSERTION);
        second(2000); second(3000);
        ad = false; listener.onPositionDiscontinuity(Player.DISCONTINUITY_REASON_AD_INSERTION);
        second(4000);
        playing = false; listener.onIsPlayingChanged(false);
        second(4000); second(4000);
        assertEquals(1, tracking.store.count("device-a", false));
        assertEquals(2, new JSONObject(tracking.store.pending("device-a").get(0).json).getDouble("seconds"), .001);
    }

    @Test public void seekDoesNotMeasureTimeUntilThePlayerProcessesIt() throws Exception {
        second(1000);
        position = 120_000; listener.onPositionDiscontinuity(Player.DISCONTINUITY_REASON_SEEK);
        second(120_000); second(120_000);
        listener.onSeekProcessed();
        second(121_000);
        assertEquals(1, tracking.store.count("device-a", false));
        JSONObject last = new JSONObject(tracking.store.pending("device-a").get(0).json);
        assertEquals(2, last.getDouble("seconds"), .001);
        assertEquals(2, last.getJSONArray("coverage").length());
        assertEquals(120, last.getJSONArray("coverage").getJSONArray(1).getDouble(0), 0.001);
    }

    @Test public void stoppedHostWithPlayingAudioIsBackground() throws Exception {
        second(1000);
        collector.onActivityStopped(activity);
        second(2000);
        assertEquals("foreground", new JSONObject(tracking.store.pending("device-a").get(0).json).getString("playbackContext"));
        assertEquals("background", new JSONObject(tracking.store.pending("device-a").get(1).json).getString("playbackContext"));
    }
}
