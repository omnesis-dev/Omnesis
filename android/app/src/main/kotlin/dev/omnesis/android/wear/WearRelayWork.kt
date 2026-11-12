// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.app.Notification
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.R
import dev.omnesis.android.notifications.FcmPushManager
import dev.omnesis.android.session.SessionManager
import java.util.concurrent.TimeUnit

/**
 * The relay's three uses of WorkManager, each a unique piece of work:
 *
 * - **Hold.** Expedited work that runs while the relay is busy. The listener
 *   service the watch's events arrive through is bound only for its callbacks,
 *   and a process with nothing else running is frozen seconds after they
 *   return, mid-question. A running job keeps the process live, and an
 *   expedited one may start from the background without a notification on
 *   Android 12 and later.
 * - **Retry.** Run when a network is available, with backoff, while a
 *   recording is kept because it could not be processed.
 * - **Gate refresh.** Twice a day once a watch has been seen, so the watch can
 *   tell a phone that stopped refreshing from one whose answer held.
 *
 * Nothing is enqueued until a watch has sent something or been seen.
 */
class WorkManagerRelayScheduler(private val context: Context) : RelayKeepAlive, RetryScheduler {
    override fun hold() {
        enqueue(
            HOLD_WORK,
            ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<WearRelayWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setInputData(workDataOf(WearRelayWorker.KEY_MODE to WearRelayWorker.MODE_HOLD)),
        )
    }

    override fun retryLater() {
        enqueue(
            RETRY_WORK,
            ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<WearRelayWorker>()
                .setConstraints(CONNECTED)
                .setInitialDelay(RETRY_DELAY_MINUTES, TimeUnit.MINUTES)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, RETRY_DELAY_MINUTES, TimeUnit.MINUTES)
                .setInputData(workDataOf(WearRelayWorker.KEY_MODE to WearRelayWorker.MODE_RETRY)),
        )
    }

    override fun keepGateFresh() {
        runCatching {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                GATE_WORK,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<WearRelayWorker>(GATE_PERIOD_HOURS, TimeUnit.HOURS)
                    .setConstraints(CONNECTED)
                    .setInputData(workDataOf(WearRelayWorker.KEY_MODE to WearRelayWorker.MODE_GATE))
                    .build(),
            )
        }
    }

    private fun enqueue(
        name: String,
        policy: ExistingWorkPolicy,
        request: androidx.work.OneTimeWorkRequest.Builder,
    ) {
        // Scheduling is a convenience over work already running in the process; a WorkManager
        // that cannot take it must not end that work.
        runCatching { WorkManager.getInstance(context).enqueueUniqueWork(name, policy, request.build()) }
    }

    private companion object {
        const val HOLD_WORK = "wear-relay-hold"
        const val RETRY_WORK = "wear-relay-retry"
        const val GATE_WORK = "wear-relay-gate"
        const val RETRY_DELAY_MINUTES = 10L

        /** Half the gate's refresh interval, so a run that comes early is followed by one in time. */
        const val GATE_PERIOD_HOURS = 12L
        val CONNECTED = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
    }
}

/**
 * The relay's background work. A plain worker: its dependencies resolve
 * through a Hilt entry point, which works when WorkManager starts the process
 * with no activity ever created.
 */
class WearRelayWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun wearRelayForWork(): WearRelay

        fun wearGatewayForWork(): WearGateway

        fun wearRelaySessions(): SessionManager

        fun wearRelayPush(): FcmPushManager
    }

    override suspend fun doWork(): Result {
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        if (!deps.wearGatewayForWork().available()) return Result.success()
        val relay = deps.wearRelayForWork()
        return when (inputData.getString(KEY_MODE)) {
            MODE_GATE -> {
                deps.wearRelaySessions().refreshStatus()
                relay.refreshGate()
                Result.success()
            }
            MODE_RETRY -> {
                relay.resumePending()
                relay.awaitIdle()
                if (relay.waitingRecordings() > 0) Result.retry() else Result.success()
            }
            else -> {
                // A process started for this job has nothing running yet: pick up what an
                // earlier one left, then stay for as long as anything is under way.
                relay.resumePending()
                relay.awaitIdle()
                Result.success()
            }
        }
    }

    /** Before Android 12 expedited work runs as a foreground service, which needs a notification. */
    override suspend fun getForegroundInfo(): ForegroundInfo {
        EntryPointAccessors.fromApplication(applicationContext, Deps::class.java).wearRelayPush().prepareChannels()
        val notification: Notification =
            NotificationCompat.Builder(applicationContext, FcmPushManager.NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(R.drawable.omnesis_logo)
                .setContentTitle("Finishing a request from your watch")
                .setOngoing(true)
                .build()
        return ForegroundInfo(FOREGROUND_NOTIFICATION_ID, notification)
    }

    companion object {
        const val KEY_MODE = "mode"
        const val MODE_HOLD = "hold"
        const val MODE_RETRY = "retry"
        const val MODE_GATE = "gate"
        private const val FOREGROUND_NOTIFICATION_ID = 0x7761 // "wa"
    }
}
