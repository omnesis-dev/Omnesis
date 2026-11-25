// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Seam through which the recording feature reaches the live gateway session
 * without depending on the app's composition root. Null while unpaired.
 */
fun interface RecordingSessionProvider {
    fun gateway(): RecordingsGateway?
}

/**
 * Drains the recording outbox to the gateway. Plain worker resolving its
 * dependencies through a Hilt [EntryPoint], so it also runs when WorkManager
 * cold-starts the process after the app was killed mid-upload; it first
 * closes any recording that kill interrupted. Unpaired → retry later (the
 * audio waits); a failure that may clear → retry with backoff.
 *
 * It drains until a pass sends nothing and no upload was requested since the
 * pass began, so a chunk filed while it runs is not left behind (a request
 * made while it runs is otherwise dropped by [ExistingWorkPolicy.KEEP]).
 */
class RecordingUploadWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun recordingOutbox(): RecordingOutbox

        fun recordingController(): RecordingController

        fun recordingSessionProvider(): RecordingSessionProvider
    }

    override suspend fun doWork(): Result {
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        deps.recordingController().recoverInterrupted()
        val gateway = deps.recordingSessionProvider().gateway() ?: return Result.retry()
        val uploader = RecordingUploader(deps.recordingOutbox(), gateway)
        while (true) {
            val requests = RecordingUploadScheduler.requests
            when (val result = uploader.drain()) {
                is RecordingUploader.Result.Done ->
                    if (result.sent == 0 && RecordingUploadScheduler.requests == requests) return Result.success()
                is RecordingUploader.Result.Retry -> {
                    Log.i(TAG, "Recording upload paused: ${result.reason}")
                    return Result.retry()
                }
            }
        }
    }

    private companion object {
        const val TAG = "Omnesis:Recording"
    }
}

/** Enqueues the one upload drain; requests while one is queued or running coalesce into it. */
object RecordingUploadScheduler {
    const val UNIQUE_WORK_NAME = "recording-upload"

    private val requestCount = AtomicLong()

    /** How many uploads this process has requested; the worker reads it to catch requests it coalesced. */
    val requests: Long get() = requestCount.get()

    /**
     * Request a drain. [replace] cancels a queued or running one and enqueues
     * afresh, for a change of network constraint (every route is idempotent,
     * so cutting a drain short is safe).
     */
    fun enqueue(context: Context, wifiOnly: Boolean, replace: Boolean = false) {
        requestCount.incrementAndGet()
        val request = OneTimeWorkRequestBuilder<RecordingUploadWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            UNIQUE_WORK_NAME,
            if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
            request,
        )
    }
}
