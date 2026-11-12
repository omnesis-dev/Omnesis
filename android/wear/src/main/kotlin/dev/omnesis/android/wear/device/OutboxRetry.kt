// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.device

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.omnesis.android.wear.WearApp
import dev.omnesis.android.wear.core.RetryScheduler
import dev.omnesis.android.wearprotocol.EpochMillis
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** Schedules the outbox's next pass with WorkManager, so it runs even after the app has exited. */
class WorkManagerRetryScheduler(private val context: Context, private val now: () -> EpochMillis) : RetryScheduler {
    override fun schedule(at: EpochMillis?) {
        val work = WorkManager.getInstance(context)
        if (at == null) {
            work.cancelUniqueWork(WORK_NAME)
            return
        }
        val delay = (at - now()).coerceAtLeast(MINIMUM_DELAY_MS)
        val request = OneTimeWorkRequestBuilder<OutboxRetryWorker>()
            .setInitialDelay(delay, TimeUnit.MILLISECONDS)
            .build()
        work.enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    companion object {
        /** The one pending pass; scheduling again replaces it. */
        const val WORK_NAME = "omnesis-outbox-retry"
        const val MINIMUM_DELAY_MS = 1_000L
    }
}

/** One scheduled pass of the outbox. The pass itself schedules the next when one is due. */
class OutboxRetryWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as WearApp).container
        withContext(Dispatchers.Main.immediate) { container.core.retryOutbox() }
        return Result.success()
    }
}
