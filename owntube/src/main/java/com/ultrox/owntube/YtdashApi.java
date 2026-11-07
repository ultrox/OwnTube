package com.ultrox.owntube;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

final class YtdashApi {
    static final String ORIGIN = "https://ytdash.gromobran.com";
    static final class Reply {
        final int code;
        final String body;
        final long retryAt;
        Reply(int code, String body, long retryAt) { this.code = code; this.body = body; this.retryAt = retryAt; }
    }
    interface Transport { Reply send(String key, String body) throws Exception; }
    private final OkHttpClient client;
    YtdashApi() { this(new OkHttpClient()); }
    YtdashApi(OkHttpClient client) {
        this.client = client.newBuilder().followRedirects(false).followSslRedirects(false)
                .callTimeout(20, TimeUnit.SECONDS).connectTimeout(20, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS).writeTimeout(20, TimeUnit.SECONDS).build();
    }

    DeviceCredentials.Pair pair(String key) throws Exception {
        if (key.isEmpty() || key.length() > 1024 || !key.matches("[\\x21-\\x7e]+")) {
            throw new IOException("Enter a valid device key from People & devices.");
        }
        Reply reply = request("/api/device", key, null);
        if (reply.code != 200) throw new IOException("Pairing failed (HTTP " + reply.code + "). Check the device key.");
        JSONObject json = new JSONObject(reply.body);
        Object id = json.opt("deviceId");
        if (!(id instanceof String) || ((String) id).isEmpty() || ((String) id).length() > 200) {
            throw new IOException("Invalid pairing response: missing device ID.");
        }
        return new DeviceCredentials.Pair((String) id, key, json.optString("label"), json.optString("person"));
    }

    Reply ingest(String key, String body) throws Exception { return request("/api/ingest", key, body); }

    private Reply request(String path, String key, String body) throws Exception {
        Request.Builder builder = new Request.Builder().url(ORIGIN + path)
                .header("Authorization", "Bearer " + key).header("Accept", "application/json")
                .header("User-Agent", "OwnTube/1.0");
        if (body != null) builder.post(RequestBody.create(MediaType.parse("application/json; charset=utf-8"), body));
        try (Response response = client.newCall(builder.build()).execute()) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            if (response.body() != null) {
                try (InputStream input = response.body().byteStream()) {
                    byte[] buffer = new byte[4096];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > 64_000) throw new IOException("Server response too large");
                        output.write(buffer, 0, count);
                    }
                }
            }
            return new Reply(response.code(), new String(output.toByteArray(), StandardCharsets.UTF_8),
                    retryAfter(response.header("Retry-After"), System.currentTimeMillis()));
        }
    }

    static long retryAfter(String value, long now) {
        if (value == null) return 0;
        try {
            long seconds = Long.parseLong(value.trim());
            if (seconds >= 0 && seconds <= (Long.MAX_VALUE - now) / 1000) return now + seconds * 1000;
        } catch (NumberFormatException ignored) { }
        try {
            SimpleDateFormat format = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US);
            format.setTimeZone(TimeZone.getTimeZone("GMT"));
            return Math.max(now, format.parse(value).getTime());
        } catch (Exception ignored) { return 0; }
    }
}
