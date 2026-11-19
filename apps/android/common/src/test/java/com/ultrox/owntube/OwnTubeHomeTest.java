package com.ultrox.owntube;

import com.liskovsoft.mediaserviceinterfaces.data.MediaItem;
import com.liskovsoft.smartyoutubetv2.common.app.models.data.Video;
import com.liskovsoft.smartyoutubetv2.common.utils.ClickbaitRemover;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class OwnTubeHomeTest {
    @Test public void publishedMetadataSurvivesLocalReplacementsAndCopies() throws Exception {
        String thumbnail = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg";
        Video video = Video.from(new OwnTubeHome.Item(new JSONObject()
                .put("videoId", "abcdefghijk").put("title", "Published title").put("thumbnail", thumbnail)));
        // Simulate stale asynchronous replacements and playback metadata arriving.
        video.deArrowTitle = "Replacement title";
        org.robolectric.util.ReflectionHelpers.setField(video, "metadataTitle", "Playback title");
        video.altCardImageUrl = "https://example.com/dearrow.jpg";
        video.mediaItem = video.toMediaItem();
        for (Video card : new Video[] {video, Video.from(video), video.copy()}) {
            assertEquals("Published title", card.getTitle());
            assertEquals("Published title", card.getTitleFull());
            assertEquals(thumbnail, card.getCardImageUrl());
            for (int quality = 0; quality <= 3; quality++) {
                assertEquals(thumbnail, ClickbaitRemover.updateThumbnail(card, quality));
            }
        }
        // Middle-frame selection still works for ordinary upstream cards.
        Video upstream = Video.from("abcdefghijk");
        upstream.cardImageUrl = thumbnail;
        assertEquals("https://i.ytimg.com/vi/abcdefghijk/hq2.jpg",
                ClickbaitRemover.updateThumbnail(upstream, ClickbaitRemover.THUMB_QUALITY_MIDDLE));
    }

    @Test public void serverRowsUseExistingTvCardsAndKeepTheirContinuation() throws Exception {
        OwnTubeHome.Group row = new OwnTubeHome.Group(new JSONObject("{\"id\":\"home:1\",\"title\":\"Recommended\","
                + "\"next\":\"opaque-server-cursor\",\"items\":[{\"videoId\":\"abcdefghijk\",\"channelId\":\"UCchannel\","
                + "\"title\":\"A video\",\"subtitle\":\"Channel · Yesterday\",\"badge\":\"1:02:03\","
                + "\"thumbnail\":\"https://i.ytimg.com/example.jpg\",\"isLive\":false,\"isShorts\":true}]}"));
        assertTrue(OwnTubeHome.owns(row));
        assertEquals("Recommended", row.getTitle());
        assertEquals("opaque-server-cursor", row.getNextPageKey());
        assertFalse(row.isEmpty());
        MediaItem card = row.getMediaItems().get(0);
        assertEquals(MediaItem.TYPE_VIDEO, card.getType());
        assertEquals("abcdefghijk", card.getVideoId());
        assertEquals("UCchannel", card.getChannelId());
        assertEquals(3723000L, card.getDurationMs());
        assertTrue(card.isShorts());
        assertEquals("Channel · Yesterday", card.getSecondTitle());
    }

    @Test public void channelAndPlaylistCardsStayDistinctAndNullsStayNull() throws Exception {
        OwnTubeHome.Item channel = new OwnTubeHome.Item(new JSONObject("{\"title\":\"Channel\",\"channelId\":\"UCchannel\",\"videoId\":null}"));
        OwnTubeHome.Item playlist = new OwnTubeHome.Item(new JSONObject("{\"title\":\"Playlist\",\"playlistId\":\"PLlist\",\"badge\":\"LIVE\"}"));
        assertEquals(MediaItem.TYPE_CHANNEL, channel.getType());
        assertEquals(MediaItem.TYPE_PLAYLIST, playlist.getType());
        assertNull(channel.getVideoId());
        assertNull(channel.getCardImageUrl());
        assertNotEquals(channel.getId(), playlist.getId());
        assertEquals(-1L, playlist.getDurationMs());
    }
}
