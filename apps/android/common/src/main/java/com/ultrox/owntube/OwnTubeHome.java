package com.ultrox.owntube;

import android.content.Context;
import com.liskovsoft.googlecommon.common.helpers.RetrofitOkHttpHelper;
import com.liskovsoft.googlecommon.common.locale.LocaleManager;
import com.liskovsoft.mediaserviceinterfaces.data.MediaGroup;
import com.liskovsoft.mediaserviceinterfaces.data.MediaItem;
import com.liskovsoft.mediaserviceinterfaces.oauth.Account;
import com.liskovsoft.sharedutils.rx.RxHelper;
import com.liskovsoft.youtubeapi.app.AppService;
import com.liskovsoft.youtubeapi.service.YouTubeSignInService;
import com.liskovsoft.youtubeapi.service.data.YouTubeMediaGroup;
import com.liskovsoft.youtubeapi.service.data.YouTubeMediaItem;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import io.reactivex.Observable;
import org.json.JSONArray;
import org.json.JSONObject;

/** Small adapter at the existing Home/continuation boundary; no upstream edits. */
public final class OwnTubeHome {
    private OwnTubeHome() { }

    public static Observable<List<MediaGroup>> home(Context context) {
        return category(context, MediaGroup.TYPE_HOME);
    }

    public static Observable<List<MediaGroup>> category(Context context, int type) {
        return RxHelper.create(emitter -> {
            Session session = new Session(context, type);
            String next = null;
            Set<String> seen = new HashSet<>();
            int pages = 0;
            do {
                if (emitter.isDisposed()) return;
                if (++pages > 100 || (next != null && !seen.add(next))) throw new IOException("Refresh Home to load more rows.");
                JSONObject page = session.fetch(next);
                List<MediaGroup> groups = new ArrayList<>();
                JSONArray rows = page.getJSONArray("rows");
                for (int i = 0; i < rows.length(); i++) {
                    if (emitter.isDisposed()) return;
                    Group group = fill(session, new Group(rows.getJSONObject(i), type));
                    if (!group.isEmpty()) groups.add(group);
                }
                if (!groups.isEmpty()) emitter.onNext(groups);
                next = optional(page, "next");
            } while (next != null);
            emitter.onComplete();
        });
    }

    public static boolean owns(MediaGroup group) { return group instanceof Group; }
    public static boolean owns(MediaItem item) { return item instanceof Item; }

    public static Observable<MediaGroup> continueGroup(Context context, MediaGroup group) {
        return RxHelper.create(emitter -> {
            if (!(group instanceof Group)) throw new IOException("This row is not an OwnTube Home row.");
            String cursor = group.getNextPageKey();
            if (cursor != null && !emitter.isDisposed()) {
                Session session = new Session(context, group.getType());
                emitter.onNext(fill(session, session.row(cursor)));
            }
            emitter.onComplete();
        });
    }

    // A block may remove every card on a page. Follow its next cursor instead of
    // hiding the row and losing all subsequent allowed content.
    private static Group fill(Session session, Group group) throws Exception {
        Set<String> seen = new HashSet<>();
        while (group.isEmpty() && group.getNextPageKey() != null) {
            String next = group.getNextPageKey();
            if (seen.size() >= 20 || !seen.add(next)) throw new IOException("Too many empty Home pages. Refresh Home.");
            group = session.row(next);
        }
        return group;
    }

    private static final class Session {
        final Context context;
        final String authorization, pageId;
        final JSONObject request;
        final int type;
        Session(Context context, int type) throws Exception {
            this.context = context.getApplicationContext();
            this.type = type;
            YouTubeSignInService.instance().checkAuth();
            Map<String, String> headers = RetrofitOkHttpHelper.getAuthHeaders();
            authorization = headers.get("Authorization");
            pageId = headers.get("X-Goog-Pageid");
            LocaleManager locale = LocaleManager.instance();
            Account account = YouTubeSignInService.instance().getSelectedAccount();
            String identity = account == null ? "anonymous" : account.getId() + ":" + account.getEmail() + ":" + account.getName();
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8));
            StringBuilder accountKey = new StringBuilder();
            for (byte b : digest) accountKey.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            request = new JSONObject().put("language", locale.getLanguage()).put("country", locale.getCountry())
                    .put("utcOffsetMinutes", locale.getUtcOffsetMinutes()).put("visitorData", AppService.instance().getVisitorData())
                    .put("accountKey", accountKey.toString()).put("category", categoryName(type));
        }
        JSONObject fetch(String cursor) throws Exception {
            request.put("cursor", cursor == null ? JSONObject.NULL : cursor);
            return HomeFeed.fetch(context, request, authorization, pageId);
        }
        Group row(String cursor) throws Exception {
            JSONArray rows = fetch(cursor).getJSONArray("rows");
            if (rows.length() != 1) throw new IOException("Invalid OwnTube row continuation.");
            return new Group(rows.getJSONObject(0), type);
        }
    }

    static String categoryName(int type) {
        switch (type) {
            case MediaGroup.TYPE_MUSIC: return "music";
            case MediaGroup.TYPE_NEWS: return "news";
            case MediaGroup.TYPE_GAMING: return "gaming";
            case MediaGroup.TYPE_SPORTS: return "sports";
            case MediaGroup.TYPE_LIVE: return "live";
            case MediaGroup.TYPE_TRENDING: return "trending";
            default: return "home";
        }
    }

    static String optional(JSONObject object, String name) {
        return object.isNull(name) || object.optString(name).isEmpty() ? null : object.optString(name);
    }

    static final class Group extends YouTubeMediaGroup {
        final String rowId;
        Group(JSONObject row) throws Exception {
            this(row, MediaGroup.TYPE_HOME);
        }
        Group(JSONObject row, int type) throws Exception {
            super(type);
            rowId = row.getString("id");
            setTitle(row.getString("title"));
            mNextPageKey = optional(row, "next");
            List<MediaItem> items = new ArrayList<>();
            JSONArray cards = row.getJSONArray("items");
            for (int i = 0; i < cards.length(); i++) items.add(new Item(cards.getJSONObject(i)));
            setMediaItems(items);
        }
    }

    static final class Item extends YouTubeMediaItem {
        final boolean shorts;
        Item(JSONObject card) throws Exception {
            setVideoId(optional(card, "videoId"));
            setChannelId(optional(card, "channelId"));
            setPlaylistId(optional(card, "playlistId"));
            setTitle(card.getString("title"));
            setSecondTitle(card.optString("subtitle"));
            setCardImageUrl(optional(card, "thumbnail"));
            setBadgeText(optional(card, "badge"));
            setLive(card.optBoolean("isLive"));
            setUpcoming(card.optBoolean("isUpcoming"));
            shorts = card.optBoolean("isShorts");
        }
        @Override public int getType() {
            return getVideoId() != null ? MediaItem.TYPE_VIDEO : getPlaylistId() != null ? MediaItem.TYPE_PLAYLIST : MediaItem.TYPE_CHANNEL;
        }
        @Override public int getId() {
            return (getType() + ":" + (getVideoId() != null ? getVideoId() : getPlaylistId() != null ? getPlaylistId() : getChannelId())).hashCode();
        }
        @Override public boolean isShorts() { return shorts; }
        @Override public long getDurationMs() {
            String badge = getBadgeText();
            if (badge == null || !badge.matches("\\d+(?::\\d{2}){1,2}")) return -1;
            try {
                long seconds = 0;
                for (String part : badge.split(":")) seconds = Math.addExact(Math.multiplyExact(seconds, 60), Long.parseLong(part));
                return Math.multiplyExact(seconds, 1000);
            } catch (ArithmeticException | NumberFormatException e) { return -1; }
        }
    }
}
