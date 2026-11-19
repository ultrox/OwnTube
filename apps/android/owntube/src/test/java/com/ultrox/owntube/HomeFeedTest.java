package com.ultrox.owntube;

import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class HomeFeedTest {
    @Test public void localHomeUsesSeparateKeyAndOnlyAnAdbLoopbackOrigin() throws Exception {
        HomeFeed.Target target = HomeFeed.localTarget(new JSONObject()
                .put("origin", "http://127.0.0.1:3219/").put("key", "local-device"));
        assertEquals("http://127.0.0.1:3219", target.origin);
        assertEquals("local-device", target.key);
        for (String origin : new String[] {"http://example.test", "http://127.0.0.1:3219/api", "http://user@127.0.0.1:3219"}) {
            try {
                HomeFeed.localTarget(new JSONObject().put("origin", origin).put("key", "local-device"));
                fail("Expected rejection of " + origin);
            } catch (IOException expected) { }
        }
    }

    @Test public void releaseBuildIgnoresLocalPreference() {
        android.content.Context context = org.robolectric.RuntimeEnvironment.getApplication();
        context.getApplicationInfo().flags |= android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE;
        HomeFeed.setLocal(context, true);
        assertTrue(HomeFeed.local(context));
        context.getApplicationInfo().flags &= ~android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE;
        assertFalse(HomeFeed.local(context));
    }

    @Test public void deviceAndYoutubeCredentialsStaySeparateAndCursorUsesOurServer() throws Exception {
        OkHttpClient client = new OkHttpClient.Builder().addInterceptor(chain -> {
            assertEquals("https://example.test/api/device/home", chain.request().url().toString());
            assertEquals("Bearer our-device", chain.request().header("Authorization"));
            assertEquals("Bearer youtube-access", chain.request().header("X-YouTube-Authorization"));
            assertEquals("profile", chain.request().header("X-YouTube-Page-Id"));
            okio.Buffer body = new okio.Buffer();
            chain.request().body().writeTo(body);
            assertTrue(body.readUtf8().contains("opaque-cursor"));
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                    .body(ResponseBody.create(MediaType.parse("application/json"), "{\"version\":1,\"source\":\"owntube\",\"rows\":[],\"next\":null}")).build();
        }).build();
        JSONObject page = HomeFeed.request(client, "https://example.test", "our-device", new JSONObject().put("cursor", "opaque-cursor"), "Bearer youtube-access", "profile");
        assertEquals("owntube", page.getString("source"));
    }

    @Test public void serverFailureDoesNotRetryAgainstYoutube() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        OkHttpClient client = new OkHttpClient.Builder().addInterceptor(chain -> {
            calls.incrementAndGet();
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(410).message("Gone")
                    .body(ResponseBody.create(MediaType.parse("application/json"), "{\"error\":\"Home page expired. Refresh Home.\"}")).build();
        }).build();
        try {
            HomeFeed.request(client, "https://example.test", "device", new JSONObject(), null, null);
            fail("Expected explicit refresh error");
        } catch (IOException e) { assertEquals("Home page expired. Refresh Home.", e.getMessage()); }
        assertEquals(1, calls.get());
    }
}
