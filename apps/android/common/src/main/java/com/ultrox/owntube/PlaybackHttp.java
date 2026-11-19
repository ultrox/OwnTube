package com.ultrox.owntube;

import com.localebro.okhttpprofiler.OkHttpProfilerInterceptor;
import okhttp3.Interceptor;
import okhttp3.OkHttpClient;
import okhttp3.logging.HttpLoggingInterceptor;

/** Streaming responses must reach the player without debug tools consuming their bodies first. */
public final class PlaybackHttp {
    private PlaybackHttp() { }

    public static OkHttpClient streamingClient(OkHttpClient upstream) {
        OkHttpClient.Builder builder = upstream.newBuilder();
        builder.interceptors().removeIf(PlaybackHttp::buffersBody);
        builder.networkInterceptors().removeIf(PlaybackHttp::buffersBody);
        return builder.build();
    }

    private static boolean buffersBody(Interceptor interceptor) {
        return interceptor instanceof OkHttpProfilerInterceptor || interceptor instanceof HttpLoggingInterceptor;
    }
}
