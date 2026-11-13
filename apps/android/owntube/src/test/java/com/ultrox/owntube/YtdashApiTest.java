package com.ultrox.owntube;

import static org.junit.Assert.*;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class YtdashApiTest {
    @Test public void productionOriginAndDeviceKeyAreUsedWithoutCookies() throws Exception {
        YtdashApi api = new YtdashApi(new OkHttpClient.Builder().addInterceptor(chain -> {
            assertEquals("https://ytdash.gromobran.com/api/device", chain.request().url().toString());
            assertEquals("Bearer test-key", chain.request().header("Authorization"));
            assertEquals("OwnTube/1.0", chain.request().header("User-Agent"));
            assertNull(chain.request().header("Cookie"));
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                    .body(ResponseBody.create(MediaType.parse("application/json"), "{\"deviceId\":\"server-id\",\"label\":\"TV\",\"person\":\"Tester\"}")).build();
        }).build());
        assertEquals("server-id", api.pair("test-key").deviceId);
    }

    @Test public void redirectIsReturnedWithoutForwardingCredentials() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        YtdashApi api = new YtdashApi(new OkHttpClient.Builder().addInterceptor(chain -> {
            calls.incrementAndGet();
            assertEquals("ytdash.gromobran.com", chain.request().url().host());
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(302).message("Redirect")
                    .header("Location", "https://other.example/steal").body(ResponseBody.create(null, "")).build();
        }).build());
        assertEquals(302, api.ingest("test-key", "{}").code);
        assertEquals(1, calls.get());
    }

    @Test public void retryAfterSupportsSecondsAndHttpDate() {
        assertEquals(125_000, YtdashApi.retryAfter("120", 5000));
        assertEquals(1445412480000L, YtdashApi.retryAfter("Wed, 21 Oct 2015 07:28:00 GMT", 0));
        assertEquals(0, YtdashApi.retryAfter("invalid", 0));
    }
}
