// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.transport.PermissionHealthCoordinator
import java.util.concurrent.TimeUnit

/**
 * The background-sync gate, pure so the truth table is unit-testable. Every
 * leg must hold: the user opted in, the READ_CALL_LOG permission is granted,
 * and a paired session exists to upload into.
 */
fun shouldRunBackgroundSync(
    enabled: Boolean,
    hasPermission: Boolean,
    hasSession: Boolean,
): Boolean = enabled && hasPermission && hasSession

/**
 * Periodic background drain of the Call Log source. Plain (non-Hilt) worker:
 * dependencies resolve through a Hilt [EntryPoint] against the application
 * component, which also works when WorkManager cold-starts the process with
 * no activity ever created. Gates not met → skip-success (the periodic chain
 * stays alive); transient drain failure → retry with backoff.
 */
class CallLogSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    // Method names must not collide with another feature module's own
    // `@EntryPoint interface Deps` (Hilt aggregates every entry point into one
    // generated component; two interfaces declaring a same-named getter with
    // different return types fail to compile) — see HealthSyncWorker.Deps.
    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun callLogSettings(): CallLogSettings

        fun callLogIntegration(): CallLogIntegration

        fun callLogSessionProvider(): CallLogSessionProvider
        fun callLogPermissionHealthCoordinator(): PermissionHealthCoordinator
    }

    override suspend fun doWork(): Result {
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        val coordinator = deps.callLogSessionProvider().coordinator()
        deps.callLogPermissionHealthCoordinator().refreshSource(CallLogSyncCoordinator.SOURCE_ID)

        val shouldRun = shouldRunBackgroundSync(
            enabled = deps.callLogSettings().callLogEnabled,
            hasPermission = deps.callLogIntegration().hasPermission(),
            hasSession = coordinator != null,
        )
        if (!shouldRun || coordinator == null) return Result.success()

        return when (val result = coordinator.syncNow()) {
            is CallLogSyncCoordinator.SyncResult.Failed ->
                if (result.retryable) Result.retry() else Result.failure()
            is CallLogSyncCoordinator.SyncResult.NeedsAttention -> Result.failure()
            is CallLogSyncCoordinator.SyncResult.SourceRemoved -> {
                CallLogSyncScheduler.cancel(applicationContext)
                Result.failure()
            }
            is CallLogSyncCoordinator.SyncResult.SourcePaused -> Result.retry()
            is CallLogSyncCoordinator.SyncResult.Success,
            is CallLogSyncCoordinator.SyncResult.Skipped,
            -> Result.success()
        }
    }
}

/**
 * Schedules/cancels the unique periodic [CallLogSyncWorker]. The Call Log
 * settings surface calls [schedule] when the user enables syncing and
 * [cancel] when they disable it.
 */
object CallLogSyncScheduler {
    const val UNIQUE_WORK_NAME = "android-call-log-sync"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<CallLogSyncWorker>(1, TimeUnit.HOURS)
            .setConstraints(Constraints.Builder().setRequiresBatteryNotLow(true).build())
            .build()
        WorkManager.getInstance(context)
            // KEEP: re-enabling must not reset the period of an already-scheduled chain.
            .enqueueUniquePeriodicWork(UNIQUE_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_WORK_NAME)
    }
}
