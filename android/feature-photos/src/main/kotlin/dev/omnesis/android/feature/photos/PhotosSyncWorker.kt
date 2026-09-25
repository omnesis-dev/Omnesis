// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import android.content.Context
import android.util.Log
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
import kotlinx.coroutines.CancellationException
import java.util.concurrent.TimeUnit

/**
 * The background-sync gate, pure so the truth table is unit-testable. Every
 * leg must hold: the user opted in, the Photos permission is granted, and a
 * paired session exists to upload into.
 */
fun shouldRunPhotosBackgroundSync(
    enabled: Boolean,
    hasPermission: Boolean,
    hasSession: Boolean,
): Boolean = enabled && hasPermission && hasSession

internal suspend fun reportPhotosHealthBeforeBackgroundGate(
    reportHealth: suspend () -> Unit,
    gate: () -> Boolean,
): Boolean {
    reportHealth()
    return gate()
}

/**
 * Periodic background drain of the Photos source — the unconditional
 * convergence backstop (also what drives the throttled reconcile). Plain
 * (non-Hilt) worker: dependencies resolve through a Hilt [EntryPoint]
 * against the application component, which also works when WorkManager
 * cold-starts the process with no activity ever created.
 */
class PhotosSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    // Method names must not collide with another feature module's own
    // `@EntryPoint interface Deps` (Hilt aggregates every entry point into
    // one generated component) — see CallLogSyncWorker.Deps.
    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun photosSettings(): PhotosSettings

        fun photosIntegration(): PhotosIntegration

        fun photosSessionProvider(): PhotosSessionProvider
        fun photosPermissionHealthCoordinator(): PermissionHealthCoordinator
    }

    override suspend fun doWork(): Result = protectPhotosWorkerResult(
        isTriggeredDrain = tags.contains(PhotosMediaObserverJobService.TRIGGERED_WORK_TAG),
        run = { runPhotosSync() },
    )

    private suspend fun runPhotosSync(): Result {
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        val coordinator = deps.photosSessionProvider().coordinator()
        val shouldRun = reportPhotosHealthBeforeBackgroundGate(
            reportHealth = {
                deps.photosPermissionHealthCoordinator().refreshSource(PhotosSyncCoordinator.SOURCE_ID)
            },
            gate = {
                shouldRunPhotosBackgroundSync(
                    enabled = deps.photosSettings().photosEnabled,
                    hasPermission = deps.photosIntegration().hasPermission(),
                    hasSession = coordinator != null,
                )
            },
        )
        if (!shouldRun || coordinator == null) return Result.success()

        val isTriggeredDrain = tags.contains(PhotosMediaObserverJobService.TRIGGERED_WORK_TAG)
        return when (val result = coordinator.syncNow()) {
            is PhotosSyncCoordinator.SyncResult.Failed ->
                if (result.retryable) Result.retry() else terminalResult(isTriggeredDrain)
            is PhotosSyncCoordinator.SyncResult.NeedsAttention -> terminalResult(isTriggeredDrain)
            is PhotosSyncCoordinator.SyncResult.SourceRemoved -> {
                PhotosSyncScheduler.cancel(applicationContext)
                terminalResult(isTriggeredDrain)
            }
            is PhotosSyncCoordinator.SyncResult.SourcePaused -> Result.retry()
            is PhotosSyncCoordinator.SyncResult.Success,
            is PhotosSyncCoordinator.SyncResult.Skipped,
            -> Result.success()
        }
    }
}

internal fun terminalResult(isTriggeredDrain: Boolean): androidx.work.ListenableWorker.Result =
    // A content-triggered drain reports its sync error through the
    // coordinator, but must complete its WorkManager link successfully.
    // Otherwise a notification queued while it ran becomes a failed child
    // and never gets its own scan, even with APPEND_OR_REPLACE.
    if (isTriggeredDrain) androidx.work.ListenableWorker.Result.success()
    else androidx.work.ListenableWorker.Result.failure()

internal suspend fun protectPhotosWorkerResult(
    isTriggeredDrain: Boolean,
    run: suspend () -> androidx.work.ListenableWorker.Result,
): androidx.work.ListenableWorker.Result = try {
    run()
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (error: Exception) {
    // A cold-start dependency failure must not mark already-appended media
    // notifications FAILED. Retry the head; successors retain their scans.
    Log.w("Omnesis:photos", "Photos background sync could not start", error)
    if (isTriggeredDrain) androidx.work.ListenableWorker.Result.retry()
    else androidx.work.ListenableWorker.Result.failure()
}

/**
 * Schedules/cancels the unique periodic [PhotosSyncWorker]. The Photos
 * settings surface calls [schedule] when the user enables syncing and
 * [cancel] when they disable it.
 */
object PhotosSyncScheduler {
    const val UNIQUE_WORK_NAME = "photos-sync"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<PhotosSyncWorker>(1, TimeUnit.HOURS)
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
