package com.ultrox.owntube;

import com.localebro.okhttpprofiler.OkHttpProfilerInterceptor;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.logging.HttpLoggingInterceptor;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class PlaybackHttpTest {
    @Test public void playbackReceivesHeadersBeforeTheFullVideoBody() throws Exception {
        OkHttpClient upstream = new OkHttpClient.Builder()
                .addInterceptor(new OkHttpProfilerInterceptor())
                .addInterceptor(new HttpLoggingInterceptor(message -> { }).setLevel(HttpLoggingInterceptor.Level.BODY))
                .addNetworkInterceptor(new HttpLoggingInterceptor(message -> { }).setLevel(HttpLoggingInterceptor.Level.BODY))
                .addInterceptor(chain -> chain.proceed(chain.request().newBuilder().header("X-Playback-Test", "kept").build()))
                .build();
        OkHttpClient streaming = PlaybackHttp.streamingClient(upstream);
        assertSame(upstream.connectionPool(), streaming.connectionPool());
        assertEquals(3, upstream.interceptors().size());
        CountDownLatch finishBody = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try (ServerSocket server = new ServerSocket(0)) {
            server.setSoTimeout(5000);
            Future<?> serving = executor.submit(() -> {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(5000);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    boolean retainedHeader = false;
                    String line;
                    while ((line = reader.readLine()) != null && !line.isEmpty()) {
                        if (line.equalsIgnoreCase("X-Playback-Test: kept")) retainedHeader = true;
                    }
                    assertTrue(retainedHeader);
                    socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: video/mp4\r\n\r\na"
                            .getBytes(StandardCharsets.UTF_8));
                    socket.getOutputStream().flush();
                    assertTrue(finishBody.await(5, TimeUnit.SECONDS));
                    socket.getOutputStream().write('b');
                    socket.getOutputStream().flush();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            Future<Response> loading = executor.submit(() -> streaming.newCall(new Request.Builder()
                    .url("http://127.0.0.1:" + server.getLocalPort()).build()).execute());
            // Body loggers would wait for the withheld final byte, causing this to time out.
            try (Response response = loading.get(3, TimeUnit.SECONDS)) {
                assertEquals(200, response.code());
                finishBody.countDown();
                assertEquals("ab", response.body().string());
            }
            serving.get(3, TimeUnit.SECONDS);
        } finally {
            finishBody.countDown();
            streaming.dispatcher().cancelAll();
            streaming.connectionPool().evictAll();
            executor.shutdownNow();
        }
    }
}
