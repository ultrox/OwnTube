package com.ultrox.owntube;

import android.net.Uri;
import com.liskovsoft.mediaserviceinterfaces.data.*;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Allowlisted values exposed by SmartTube, not a dump of signed playback responses. */
public final class SourceEvidence {
    private final String videoId;
    private JSONObject format, metadata;
    private EvidenceSnapshot cached;
    public SourceEvidence(String videoId) { this.videoId = videoId; }

    public synchronized void format(MediaItemFormatInfo info) {
        if (info == null || !videoId.equals(info.getVideoId())) return;
        try {
            JSONObject result = new JSONObject().put("source", "MediaItemFormatInfo")
                    .put("observedAt", System.currentTimeMillis());
            format = result; cached = null;
            put(result, "title", info.getTitle()); put(result, "description", info.getDescription());
            put(result, "author", info.getAuthor()); put(result, "channelId", info.getChannelId());
            put(result, "lengthSeconds", info.getLengthSeconds()); put(result, "viewCount", info.getViewCount());
            put(result, "uploadDate", info.getUploadDate()); put(result, "startTimestamp", info.getStartTimestamp());
            put(result, "paidContentText", info.getPaidContentText());
            result.put("isLive", info.isLive()).put("isLiveContent", info.isLiveContent())
                    .put("isLiveDvrEnabled", info.isLiveDvrEnabled());
            // Both current upstream implementations take this from videoDetails.shortDescription.
            put(result, "descriptionSource", info.getDescription() == null ? null : "videoDetails.shortDescription");
            List<MediaSubtitle> subtitles = info.getSubtitles();
            if (subtitles != null) {
                JSONArray captions = new JSONArray();
                Set<String> originalKeys = new HashSet<>();
                int duplicateOptions = 0, translationOptions = 0;
                for (MediaSubtitle track : subtitles) {
                    if (query(track.getBaseUrl(), "tlang") != null) {
                        translationOptions++;
                        continue;
                    }
                    JSONObject caption = new JSONObject();
                    put(caption, "language", track.getLanguageCode()); put(caption, "kind", track.getType());
                    put(caption, "vssId", track.getVssId()); put(caption, "name", track.getName());
                    put(caption, "mimeType", track.getMimeType()); put(caption, "codecs", track.getCodecs());
                    caption.put("isTranslatable", track.isTranslatable());
                    // Upstream also appends a same-language translation alias with no tlang.
                    String identity = track.getLanguageCode() + "\n" + track.getVssId() + "\n" + track.getBaseUrl();
                    if (originalKeys.add(identity)) captions.put(caption); else duplicateOptions++;
                }
                result.put("captions", captions)
                        .put("captionCount", captions.length()).put("captionTranslationOptionsOmitted", translationOptions)
                        .put("captionDuplicateOptionsOmitted", duplicateOptions)
                        .put("captionsSource", "MediaItemFormatInfo.getSubtitles; tlang options excluded; same-URL aliases deduplicated");
            }
            formats(result, "urlFormats", info.getUrlFormats());
            format = result; cached = null;
        } catch (Exception e) { mappingError(format, e); }
    }

    public synchronized void metadata(MediaItemMetadata info) {
        if (info == null || !videoId.equals(info.getVideoId())) return;
        try {
            JSONObject result = new JSONObject().put("source", "MediaItemMetadata")
                    .put("observedAt", System.currentTimeMillis());
            metadata = result; cached = null;
            put(result, "title", info.getTitle()); put(result, "description", info.getDescription());
            put(result, "author", info.getAuthor()); put(result, "channelId", info.getChannelId());
            put(result, "viewCount", info.getViewCount()); put(result, "likeCount", info.getLikeCount());
            put(result, "dislikeCount", info.getDislikeCount()); put(result, "subscriberCount", info.getSubscriberCount());
            put(result, "publishedDate", info.getPublishedDate()); put(result, "badgeText", info.getBadgeText());
            if (info.getDurationMs() > 0) result.put("durationMs", info.getDurationMs());
            result.put("isLive", info.isLive()).put("isUpcoming", info.isUpcoming());
            if (info.getChapters() != null) {
                JSONArray chapters = new JSONArray();
                for (ChapterItem chapter : info.getChapters()) {
                    JSONObject item = new JSONObject().put("startTimeMs", chapter.getStartTimeMs());
                    put(item, "title", chapter.getTitle()); chapters.put(item);
                }
                result.put("chapters", chapters).put("chapterCount", chapters.length());
            }
            metadata = result; cached = null;
        } catch (Exception e) { mappingError(metadata, e); }
    }

    public synchronized EvidenceSnapshot snapshot(String browseTitle) {
        if (cached != null) return cached;
        try {
            JSONObject result = new JSONObject().put("schemaVersion", 1).put("collector", "owntube-source-v1")
                    .put("videoId", videoId).put("languageAnalysis", "not-run")
                    .put("defaultAudioLanguageStatus", "not-exposed-by-MediaFormat");
            JSONObject titleSource = format != null && format.has("title") ? format :
                    metadata != null && metadata.has("title") ? metadata : null;
            JSONObject descriptionSource = format != null && format.has("description") ? format : metadata;
            String title = titleSource == null ? browseTitle : titleSource.optString("title", browseTitle);
            String description = descriptionSource == null ? null : descriptionSource.optString("description", null);
            result.put("title", title == null ? "" : title).put("description", description == null ? "" : description)
                    .put("titleSource", titleSource == null ? "Video.title" : titleSource.getString("source") + ".getTitle")
                    .put("descriptionAvailable", description != null)
                    .put("descriptionTruncated", description != null && description.length() > 10_000);
            if (description != null) result.put("descriptionSource", descriptionSource == format ?
                    "videoDetails.shortDescription" : "MediaItemMetadata.getDescription");
            if (format != null) {
                JSONObject details = new JSONObject(format.toString());
                for (String key : new String[]{"captions", "captionsSource", "captionDuplicateOptionsOmitted",
                        "captionCount", "captionTranslationOptionsOmitted"}) {
                    if (details.has(key)) result.put(key, details.remove(key));
                }
                result.put("formatInfo", details);
            }
            if (metadata != null) result.put("metadata", metadata);
            cached = EvidenceSnapshot.create(result);
            return cached;
        } catch (Exception e) { throw new IllegalStateException(e); }
    }

    private static void formats(JSONObject result, String key, List<MediaFormat> formats) throws Exception {
        if (formats == null) return;
        JSONArray list = new JSONArray();
        for (MediaFormat format : formats) {
            JSONObject item = new JSONObject().put("formatType", format.getFormatType()).put("isDrc", format.isDrc());
            put(item, "itag", format.getITag()); put(item, "mimeType", format.getMimeType());
            put(item, "bitrate", format.getBitrate()); put(item, "contentLength", format.getClen());
            put(item, "audioSamplingRate", format.getAudioSamplingRate());
            put(item, "audioTrackId", format.getAudioTrackId()); put(item, "language", format.getLanguage());
            put(item, "qualityLabel", format.getQualityLabel()); put(item, "fps", format.getFps());
            put(item, "projectionType", format.getProjectionType());
            if (format.getWidth() > 0) item.put("width", format.getWidth());
            if (format.getHeight() > 0) item.put("height", format.getHeight());
            list.put(item);
        }
        result.put(key, list).put(key + "Count", formats.size())
                .put("formatLanguageSource", "MediaFormat.getLanguage (SmartTube-normalized label)");
    }

    static void put(JSONObject object, String key, String value) throws Exception {
        if (value != null) object.put(key, value);
    }
    private void mappingError(JSONObject partial, Exception error) {
        cached = null;
        try {
            if (partial != null) partial.put("mappingError", error.getClass().getSimpleName());
        } catch (Exception ignored) { }
    }
    private static String query(String url, String key) {
        if (url == null) return null;
        try { return Uri.parse(url).getQueryParameter(key); } catch (RuntimeException e) { return null; }
    }
}
