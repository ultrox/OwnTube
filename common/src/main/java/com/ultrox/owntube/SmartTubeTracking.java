package com.ultrox.owntube;

import android.content.Context;
import com.liskovsoft.smartyoutubetv2.common.app.models.data.Video;
import com.liskovsoft.smartyoutubetv2.common.app.models.playback.controllers.VideoStateController;
import com.liskovsoft.smartyoutubetv2.common.app.models.playback.listener.PlayerEventListener;
import com.liskovsoft.smartyoutubetv2.common.app.presenters.PlaybackPresenter;
import com.liskovsoft.mediaserviceinterfaces.data.MediaItemFormatInfo;
import com.liskovsoft.mediaserviceinterfaces.data.MediaItemMetadata;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

/** SmartTube playback bridge; source-field mapping lives in OwnTube's SourceEvidence. */
public final class SmartTubeTracking {
    public interface VideoSource { Video current(); }
    private static final List<Entry> entries = new ArrayList<>();
    private static final class Entry {
        final WeakReference<Video> video;
        final String id;
        final SourceEvidence evidence;
        Entry(Video video) {
            this.video = new WeakReference<>(video); id = video.videoId; evidence = new SourceEvidence(id);
        }
    }
    private static synchronized SourceEvidence evidence(Video video) {
        entries.removeIf(entry -> entry.video.get() == null);
        for (Entry entry : entries) {
            if (entry.video.get() == video && entry.id.equals(video.videoId)) return entry.evidence;
        }
        Entry entry = new Entry(video);
        if (entries.size() >= 8) entries.remove(0);
        entries.add(entry);
        return entry.evidence;
    }
    public static void format(Context context, Video video, MediaItemFormatInfo info) {
        if (!Tracking.supported(context) || video == null || video.videoId == null || video.incognito) return;
        try { evidence(video).format(info); } catch (RuntimeException ignored) { /* Metadata must not break playback. */ }
    }
    public static void metadata(Context context, Video video, MediaItemMetadata info) {
        if (!Tracking.supported(context) || video == null || video.videoId == null || video.incognito) return;
        try { evidence(video).metadata(info); } catch (RuntimeException ignored) { /* Metadata must not break playback. */ }
    }

    public static PlayerCollector create(Context context, VideoSource source, PlayerEventListener listener) {
        return PlayerCollector.create(context, () -> {
            Video video = source.current();
            VideoStateController state = listener instanceof PlaybackPresenter ?
                    ((PlaybackPresenter) listener).getController(VideoStateController.class) : null;
            if (video == null) return null;
            boolean incognito = video.incognito || (state != null && state.isIncognitoSession());
            return new WatchSegments.VideoInfo(video.videoId, video.title, video.author,
                    video.isShorts, video.isLive, incognito,
                    incognito || video.videoId == null ? null : evidence(video).snapshot(video.title));
        });
    }
}
