package com.ultrox.owntube;

import android.content.Context;
import com.liskovsoft.smartyoutubetv2.common.app.models.data.Video;
import com.liskovsoft.smartyoutubetv2.common.app.models.playback.controllers.VideoStateController;
import com.liskovsoft.smartyoutubetv2.common.app.models.playback.listener.PlayerEventListener;
import com.liskovsoft.smartyoutubetv2.common.app.presenters.PlaybackPresenter;

/** All SmartTube-specific metadata mapping lives here, outside upstream player code. */
public final class SmartTubeTracking {
    public interface VideoSource { Video current(); }

    public static PlayerCollector create(Context context, VideoSource source, PlayerEventListener listener) {
        return PlayerCollector.create(context, () -> {
            Video video = source.current();
            VideoStateController state = listener instanceof PlaybackPresenter ?
                    ((PlaybackPresenter) listener).getController(VideoStateController.class) : null;
            return video == null ? null : new WatchSegments.VideoInfo(video.videoId, video.title, video.author,
                    video.isShorts, video.isLive, video.incognito || (state != null && state.isIncognitoSession()));
        });
    }
}
