package com.ultrox.owntube;

import com.google.android.exoplayer2.Format;
import com.google.android.exoplayer2.Player;
import com.google.android.exoplayer2.SimpleExoPlayer;
import com.google.android.exoplayer2.trackselection.TrackSelection;
import com.google.android.exoplayer2.trackselection.TrackSelectionArray;
import org.json.JSONArray;
import org.json.JSONObject;

/** Selected decoder formats, not a guess based on the available tracks. */
final class SelectedEvidence {
    private String previousKey;
    private EvidenceSnapshot previous;
    WatchSegments.VideoInfo attach(WatchSegments.VideoInfo video, Player player) {
        if (video == null || video.evidence == null || !(player instanceof SimpleExoPlayer)) return video;
        try {
            SimpleExoPlayer exo = (SimpleExoPlayer) player;
            JSONObject selected = new JSONObject().put("source", "SimpleExoPlayer selected decoder formats");
            Format audio = exo.getAudioFormat(), visual = exo.getVideoFormat();
            if (audio != null) selected.put("audio", format(audio));
            if (visual != null) selected.put("video", format(visual));
            JSONArray text = new JSONArray();
            TrackSelectionArray selections = player.getCurrentTrackSelections();
            for (int i = 0; i < selections.length; i++) {
                TrackSelection selection = selections.get(i);
                if (selection == null || player.getRendererType(i) != com.google.android.exoplayer2.C.TRACK_TYPE_TEXT) continue;
                text.put(format(selection.getSelectedFormat()));
            }
            selected.put("text", text);
            String key = video.evidence.id + selected;
            if (!key.equals(previousKey)) {
                JSONObject root = new JSONObject(video.evidence.json).put("selectedFormats", selected);
                if (audio != null && audio.language != null) {
                    root.put("selectedAudioLanguage", audio.language)
                            .put("selectedAudioLanguageSource", "SimpleExoPlayer.getAudioFormat.language (player-normalized)");
                }
                previous = EvidenceSnapshot.create(root); previousKey = key;
            }
            return new WatchSegments.VideoInfo(video.id, video.title, video.channel, video.shorts, video.live, video.incognito, previous);
        } catch (Exception e) { throw new IllegalStateException("Unable to map selected formats", e); }
    }

    static JSONObject format(Format f) throws Exception {
        JSONObject result = new JSONObject();
        SourceEvidence.put(result, "id", f.id); SourceEvidence.put(result, "label", f.label);
        SourceEvidence.put(result, "language", f.language); SourceEvidence.put(result, "codecs", f.codecs);
        SourceEvidence.put(result, "sampleMimeType", f.sampleMimeType);
        SourceEvidence.put(result, "containerMimeType", f.containerMimeType);
        if (f.bitrate > 0) result.put("bitrate", f.bitrate);
        if (f.width > 0) result.put("width", f.width);
        if (f.height > 0) result.put("height", f.height);
        if (f.frameRate > 0) result.put("frameRate", f.frameRate);
        if (f.channelCount > 0) result.put("channelCount", f.channelCount);
        if (f.sampleRate > 0) result.put("sampleRate", f.sampleRate);
        result.put("selectionFlags", f.selectionFlags);
        if (f.colorInfo != null) {
            JSONObject color = new JSONObject();
            if (f.colorInfo.colorSpace != -1) color.put("space", f.colorInfo.colorSpace);
            if (f.colorInfo.colorRange != -1) color.put("range", f.colorInfo.colorRange);
            if (f.colorInfo.colorTransfer != -1) color.put("transfer", f.colorInfo.colorTransfer);
            result.put("colorInfo", color);
        }
        return result;
    }
}
