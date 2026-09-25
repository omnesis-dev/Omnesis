// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

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
 * leg must hold: the user opted in, usage access is granted, and a paired
 * session exists to upload into.
 */
fun shouldRunBackgroundSync(
    enabled: Boolean,
    hasUsageAccess: Boolean,
    hasSession: Boolean,
): Boolean = enabled && hasUsageAccess && hasSession

/**
 * Periodic background drain of the App Usage source. Plain (non-Hilt) worker:
 * dependencies resolve through a Hilt [EntryPoint] against the application
 * component, which also works when WorkManager cold-starts the process with
 * no activity ever created. Gates not met → skip-success (the periodic chain
 * stays alive); transient drain failure → retry with backoff.
 */
class AppUsageSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    // Method names must not collide with another feature module's own
    // `@EntryPoint interface Deps` (Hilt aggregates every entry point into one
    // generated component).
    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun appUsageSettings(): AppUsageSettings

        fun appUsageIntegration(): AppUsageIntegration

        fun appUsageSessionProvider(): AppUsageSessionProvider
        fun appUsagePermissionHealthCoordinator(): PermissionHealthCoordinator
    }

    override suspend fun doWork(): Result {
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        val coordinator = deps.appUsageSessionProvider().coordinator()
        deps.appUsagePermissionHealthCoordinator().refreshSource(AppUsageSyncCoordinator.SOURCE_ID)

        val shouldRun = shouldRunBackgroundSync(
            enabled = deps.appUsageSettings().appUsageEnabled,
            hasUsageAccess = deps.appUsageIntegration().hasUsageAccess(),
            hasSession = coordinator != null,
        )
        if (!shouldRun || coordinator == null) return Result.success()

        return when (val result = coordinator.syncNow()) {
            is AppUsageSyncCoordinator.SyncResult.Failed ->
                if (result.retryable) Result.retry() else Result.failure()
            is AppUsageSyncCoordinator.SyncResult.NeedsAttention -> Result.failure()
            is AppUsageSyncCoordinator.SyncResult.SourceRemoved -> {
                AppUsageSyncScheduler.cancel(applicationContext)
                Result.failure()
            }
            is AppUsageSyncCoordinator.SyncResult.SourcePaused -> Result.retry()
            is AppUsageSyncCoordinator.SyncResult.Success,
            is AppUsageSyncCoordinator.SyncResult.Skipped,
            -> Result.success()
        }
    }
}

/**
 * Schedules/cancels the unique periodic [AppUsageSyncWorker]. The App Usage
 * settings surface calls [schedule] when the user enables syncing and
 * [cancel] when they disable it.
 */
object AppUsageSyncScheduler {
    const val UNIQUE_WORK_NAME = "android-app-usage-sync"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<AppUsageSyncWorker>(1, TimeUnit.HOURS)
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
