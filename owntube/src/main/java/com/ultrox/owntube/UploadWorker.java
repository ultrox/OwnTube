package com.ultrox.owntube;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.concurrent.TimeUnit;

public final class UploadWorker extends Worker {
    static final Object LOCK = new Object();
    public UploadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }

    static void schedule(Context context, boolean periodic) {
        schedule(context, periodic, false);
    }

    static void schedule(Context context, boolean periodic, boolean paired) {
        if (!Tracking.supported(context)) return;
        try {
            Constraints network = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
            WorkManager manager = WorkManager.getInstance(context);
            manager.enqueueUniqueWork("owntube-upload", paired ? ExistingWorkPolicy.REPLACE : ExistingWorkPolicy.KEEP,
                    new OneTimeWorkRequest.Builder(UploadWorker.class).setConstraints(network)
                            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS).build());
            if (periodic) {
                manager.enqueueUniquePeriodicWork("owntube-upload-fallback", ExistingPeriodicWorkPolicy.KEEP,
                        new PeriodicWorkRequest.Builder(UploadWorker.class, 15, TimeUnit.MINUTES)
                                .setConstraints(network).build());
            }
        } catch (RuntimeException e) {
            Tracking.get(context).localError = "Upload scheduling unavailable; open tracking settings and retry.";
        }
    }

    @NonNull @Override public Result doWork() {
        if (!Tracking.supported(getApplicationContext())) return Result.success();
        synchronized (LOCK) {
            Tracking tracking = Tracking.get(getApplicationContext());
            try {
                // Read persisted credentials on cold WorkManager startup, before the async UI cache is ready.
                DeviceCredentials.Pair pair = tracking.credentials.load();
                if (pair == null) return Result.success();
                boolean retry = new Delivery(tracking.store, new YtdashApi()::ingest, System::currentTimeMillis).drain(pair);
                return retry ? Result.retry() : Result.success();
            } catch (Exception e) {
                tracking.localError = "Device key unavailable. Re-pair to resume uploads.";
                return Result.success();
            }
        }
    }
}
