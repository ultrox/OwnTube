package com.ultrox.owntube;

import static org.junit.Assert.*;
import com.liskovsoft.mediaserviceinterfaces.data.*;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class SourceEvidenceTest {
    static <T> T source(Class<T> type, Object... pairs) {
        Map<String, Object> values = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) values.put((String) pairs[i], pairs[i + 1]);
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (proxy, method, args) -> {
            if (values.containsKey(method.getName())) {
                Object value = values.get(method.getName());
                if (value instanceof RuntimeException) throw (RuntimeException) value;
                return value;
            }
            if (method.getReturnType() == boolean.class) return false;
            if (method.getReturnType() == int.class) return -1;
            if (method.getReturnType() == long.class) return -1L;
            if (method.getReturnType() == float.class) return -1f;
            return null;
        }));
    }

    @Test public void sourceValuesSurviveWithoutGuessingLanguageOrParsingDisplayCounts() throws Exception {
        SourceEvidence evidence = new SourceEvidence("abcdefghijk");
        evidence.format(source(MediaItemFormatInfo.class, "getVideoId", "abcdefghijk", "getTitle", "Source title",
                "getDescription", "Описание 🎥", "getLengthSeconds", "123", "getChannelId", "UCsource",
                "getUrlFormats", Arrays.asList(source(MediaFormat.class, "getITag", "251", "getAudioTrackId", "en.4",
                        "getLanguage", "en (original)", "getUrl", "https://secret/?token=secret"))));
        evidence.metadata(source(MediaItemMetadata.class, "getVideoId", "abcdefghijk", "getTitle", "Metadata title",
                "getDescription", "Metadata description", "getLikeCount", "1.2K likes", "getPublishedDate", "Nov 7, 2026",
                "getChapters", Arrays.asList(source(ChapterItem.class, "getTitle", "Intro", "getStartTimeMs", 0L))));
        JSONObject json = new JSONObject(evidence.snapshot("Browse title").json);
        assertEquals("Source title", json.getString("title"));
        assertEquals("Описание 🎥", json.getString("description"));
        assertEquals("videoDetails.shortDescription", json.getString("descriptionSource"));
        assertEquals("Metadata description", json.getJSONObject("metadata").getString("description"));
        assertEquals("1.2K likes", json.getJSONObject("metadata").getString("likeCount"));
        assertEquals(0, json.getJSONObject("metadata").getJSONArray("chapters").getJSONObject(0).getLong("startTimeMs"));
        assertEquals("en (original)", json.getJSONObject("formatInfo").getJSONArray("urlFormats").getJSONObject(0).getString("language"));
        assertFalse(json.has("defaultAudioLanguage")); assertFalse(json.has("selectedAudioLanguage"));
        assertFalse(json.has("algorithmVersion")); assertFalse(json.has("text"));
        assertFalse(json.toString().contains("secret"));
    }

    @Test public void translatedOptionsAndSameLanguageAliasesAreNotOriginalCaptionTracks() throws Exception {
        String url = "https://captions.example/?lang=en&token=secret";
        MediaSubtitle original = source(MediaSubtitle.class, "getLanguageCode", "en", "getVssId", "a.en",
                "getType", "asr", "getBaseUrl", url);
        MediaSubtitle translated = source(MediaSubtitle.class, "getLanguageCode", "de", "getVssId", "a.en",
                "getType", "asr", "getBaseUrl", url + "&tlang=de");
        SourceEvidence evidence = new SourceEvidence("abcdefghijk");
        evidence.format(source(MediaItemFormatInfo.class, "getVideoId", "abcdefghijk", "getSubtitles",
                Arrays.asList(original, translated, original)));
        JSONObject json = new JSONObject(evidence.snapshot("Title").json);
        assertEquals(1, json.getJSONArray("captions").length());
        assertEquals("en", json.getJSONArray("captions").getJSONObject(0).getString("language"));
        assertFalse(json.has("captionTranslationOptions"));
        assertEquals(1, json.getInt("captionTranslationOptionsOmitted"));
        assertEquals(1, json.getInt("captionDuplicateOptionsOmitted"));
        assertFalse(json.toString().contains("secret"));
    }

    @Test public void missingValuesAndForeignCallbacksCannotContaminateCurrentVideo() throws Exception {
        SourceEvidence evidence = new SourceEvidence("abcdefghijk");
        evidence.format(source(MediaItemFormatInfo.class, "getVideoId", "lmnopqrstuv", "getDescription", "Wrong video"));
        evidence.metadata(source(MediaItemMetadata.class, "getVideoId", "lmnopqrstuv", "getDescription", "Wrong video"));
        JSONObject json = new JSONObject(evidence.snapshot("Browse title").json);
        assertEquals("", json.getString("description")); assertFalse(json.getBoolean("descriptionAvailable"));
        assertFalse(json.has("captions")); assertFalse(json.has("formatInfo")); assertFalse(json.has("metadata"));
        assertFalse(json.toString().contains("Wrong video"));
        evidence.metadata(source(MediaItemMetadata.class, "getVideoId", "abcdefghijk", "getDescription", "Real metadata"));
        JSONObject later = new JSONObject(evidence.snapshot("Browse title").json);
        assertEquals("Real metadata", later.getString("description"));
        assertEquals("MediaItemMetadata.getDescription", later.getString("descriptionSource"));
    }

    @Test public void snapshotsAreImmutableAndBoundedWithExplicitTruncation() throws Exception {
        String huge = new String(new char[15_000]).replace("\0", "🎥\n");
        JSONArray formats = new JSONArray();
        for (int i = 0; i < 600; i++) formats.put(new JSONObject().put("label", huge));
        JSONObject source = new JSONObject().put("title", huge).put("description", huge).put("formats", formats);
        EvidenceSnapshot snapshot = EvidenceSnapshot.create(source);
        JSONObject json = new JSONObject(snapshot.json);
        assertTrue(snapshot.json.getBytes(StandardCharsets.UTF_8).length <= 64_000);
        assertTrue(json.getString("title").length() <= 500);
        assertTrue(json.getString("description").length() <= 10_000);
        assertTrue(json.getBoolean("descriptionTruncated"));
        assertTrue(json.getJSONArray("truncatedFields").length() > 0);
        assertEquals(EvidenceSnapshot.hash(snapshot.json), snapshot.id);
        source.put("title", "Changed"); assertFalse(snapshot.json.contains("Changed"));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", EvidenceSnapshot.hash("abc"));
    }

    @Test public void segmentUsesEvidenceFromItsStartEvenIfMetadataChangesBeforeNextTick() throws Exception {
        SourceEvidence evidence = new SourceEvidence("abcdefghijk");
        EvidenceSnapshot first = evidence.snapshot("Original");
        evidence.metadata(source(MediaItemMetadata.class, "getVideoId", "abcdefghijk", "getDescription", "Arrived later"));
        EvidenceSnapshot second = evidence.snapshot("Original");
        WatchSegments segments = new WatchSegments((WatchSegments.EvidenceSink) (device, event, snapshot) -> {
            assertSame(first, snapshot); assertEquals(first.id, event.optString("evidenceId"));
        });
        segments.sample(new WatchSegments.Frame(0, 1000, 0, 10000, 1, true, "device", "foreground",
                new WatchSegments.VideoInfo("abcdefghijk", "Title", "", false, false, false, first)), false);
        segments.sample(new WatchSegments.Frame(1000, 2000, 1000, 10000, 1, true, "device", "foreground",
                new WatchSegments.VideoInfo("abcdefghijk", "Title", "", false, false, false, second)), false);
        assertNotEquals(first.id, second.id);
    }

    @Test public void failingOptionalGetterPreservesAlreadyObservedValuesAndRecordsFailure() throws Exception {
        SourceEvidence evidence = new SourceEvidence("abcdefghijk");
        evidence.format(source(MediaItemFormatInfo.class, "getVideoId", "abcdefghijk", "getDescription", "Available",
                "getUrlFormats", new IllegalStateException("Do not expose token=secret")));
        JSONObject json = new JSONObject(evidence.snapshot("Browse title").json);
        assertEquals("Available", json.getString("description"));
        assertEquals("IllegalStateException", json.getJSONObject("formatInfo").getString("mappingError"));
        assertFalse(json.toString().contains("secret"));
    }

    @Test public void selectedDecoderFormatPreservesLanguageLabelAndOmitsUnknownMeasurements() throws Exception {
        com.google.android.exoplayer2.Format format = com.google.android.exoplayer2.Format.createAudioSampleFormat(
                "251", "audio/opus", "opus", 128000, -1, 2, 48000, null, null, 0, "en");
        JSONObject json = SelectedEvidence.format(format);
        assertEquals(format.language, json.getString("language"));
        assertEquals(48000, json.getInt("sampleRate"));
        assertEquals(2, json.getInt("channelCount"));
        assertFalse(json.has("height")); assertFalse(json.has("defaultAudioLanguage"));
    }
}
