package com.ultrox.owntube;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

/** Device-authenticated Home transport. Playback and tracking use their own paths. */
public final class HomeFeed {
    private static final String PREFS = "owntube_home";
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .followRedirects(false).followSslRedirects(false)
            .connectTimeout(10, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build();

    public static boolean enabled(Context context) {
        return Tracking.supported(context) && context.getSharedPreferences(PREFS, 0).getBoolean("enabled", false);
    }

    public static void setEnabled(Context context, boolean enabled) {
        if (Tracking.supported(context)) context.getSharedPreferences(PREFS, 0).edit().putBoolean("enabled", enabled).apply();
    }

    public static boolean developmentBuild(Context context) {
        return (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    public static boolean local(Context context) {
        return developmentBuild(context) && context.getSharedPreferences(PREFS, 0).getBoolean("local", false);
    }

    public static void setLocal(Context context, boolean local) {
        if (developmentBuild(context)) context.getSharedPreferences(PREFS, 0).edit().putBoolean("local", local).apply();
    }

    static final class Target {
        final String origin, key;
        Target(String origin, String key) { this.origin = origin; this.key = key; }
    }

    static Target localTarget(JSONObject config) throws Exception {
        HttpUrl url = HttpUrl.parse(config.getString("origin"));
        if (url == null || !"http".equals(url.scheme()) || !"127.0.0.1".equals(url.host())
                || !"/".equals(url.encodedPath()) || url.query() != null || url.fragment() != null
                || !url.username().isEmpty() || !url.password().isEmpty()) {
            throw new IOException("Local Home must use the loopback ADB tunnel.");
        }
        String key = config.getString("key");
        if (key.isEmpty()) throw new IOException("Local Home needs its own test device key.");
        return new Target(url.toString().replaceAll("/$", ""), key);
    }

    static Target target(Context context) throws Exception {
        if (local(context)) {
            File config = new File(context.getNoBackupFilesDir(), "home-test.json");
            if (!config.isFile() || config.length() > 8192) {
                throw new IOException("Configure the local Home test key and ADB tunnel first.");
            }
            try (InputStream input = new FileInputStream(config)) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[1024];
                int n;
                while ((n = input.read(buffer)) != -1) {
                    if (output.size() + n > 8192) throw new IOException("Local Home configuration too large.");
                    output.write(buffer, 0, n);
                }
                return localTarget(new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8)));
            }
        }
        DeviceCredentials.Pair pair = new DeviceCredentials(context.getApplicationContext()).load();
        if (pair == null) throw new IOException("Pair OwnTube with the backoffice before using server Home.");
        return new Target(YtdashApi.ORIGIN, pair.key);
    }

    public static JSONObject fetch(Context context, JSONObject body, String youtubeAuthorization, String youtubePageId) throws Exception {
        Target target = target(context);
        // The initial cache build outlives individual HTTP requests. Subsequent
        // category opens and all pagination are served from its published version.
        for (int attempt = 0; attempt < 90; attempt++) {
            try { return request(CLIENT, target.origin, target.key, body, youtubeAuthorization, youtubePageId); }
            catch (Preparing e) { Thread.sleep(1500); }
        }
        throw new IOException("The cached feed is still preparing. Reopen this category shortly.");
    }

    static final class Preparing extends IOException { }
    static JSONObject request(OkHttpClient client, String origin, String key, JSONObject body,
                              String youtubeAuthorization, String youtubePageId) throws Exception {
        Request.Builder builder = new Request.Builder().url(origin + "/api/device/home")
                .header("Authorization", "Bearer " + key).header("Accept", "application/json")
                .post(RequestBody.create(MediaType.parse("application/json; charset=utf-8"), body.toString()));
        if (youtubeAuthorization != null && !youtubeAuthorization.isEmpty()) builder.header("X-YouTube-Authorization", youtubeAuthorization);
        if (youtubePageId != null && !youtubePageId.isEmpty()) builder.header("X-YouTube-Page-Id", youtubePageId);
        try (Response response = client.newCall(builder.build()).execute()) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            if (response.body() != null) try (InputStream input = response.body().byteStream()) {
                byte[] buffer = new byte[4096];
                int n;
                while ((n = input.read(buffer)) != -1) {
                    if (output.size() + n > 2 * 1024 * 1024) throw new IOException("OwnTube Home response too large.");
                    output.write(buffer, 0, n);
                }
            }
            JSONObject json;
            try { json = new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8)); }
            catch (Exception e) { throw new IOException("Invalid OwnTube Home response (HTTP " + response.code() + ")."); }
            if (response.code() == 202 && "building".equals(json.optString("status"))) throw new Preparing();
            if (response.code() != 200) throw new IOException(json.optString("error", "OwnTube Home unavailable (HTTP " + response.code() + ")."));
            if (json.optInt("version") != 1 || !"owntube".equals(json.optString("source")) || json.optJSONArray("rows") == null) {
                throw new IOException("Unsupported OwnTube Home response.");
            }
            return json;
        }
    }
}
