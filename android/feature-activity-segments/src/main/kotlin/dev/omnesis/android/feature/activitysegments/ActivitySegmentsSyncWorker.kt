// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

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
 * The background-sync gate, pure so the truth table is unit-testable. Four
 * legs — one more than Call Log/App Usage's plainer three, mirroring Health
 * Connect's extra-legs pattern: the user opted in, the permission is
 * granted, Google Play services is actually usable, and a paired session
 * exists to upload into.
 */
fun shouldRunBackgroundSync(
    enabled: Boolean,
    hasPermission: Boolean,
    availability: ActivitySegmentsAvailability,
    hasSession: Boolean,
): Boolean = enabled && hasPermission && availability == ActivitySegmentsAvailability.Available && hasSession

/**
 * Periodic background drain of the Activity Segments source. Plain
 * (non-Hilt) worker, same [EntryPoint] pattern as `CallLogSyncWorker`/
 * `AppUsageSyncWorker`.
 *
 * Before draining, this worker unconditionally re-issues the GMS
 * subscription whenever the gate permits it — `requestActivityTransitionUpdates`
 * with an identical request + `PendingIntent` is documented as safe/idempotent
 * (a refresh, not a duplicate-registration error). This is the actual answer
 * to "what if the subscription was silently lost" (a missed boot broadcast,
 * a GMS self-update, an ambiguous permission-revoke) — cheaper and more
 * robust than trying to detect the loss, and it runs every hourly pass
 * regardless of whether [BootCompletedReceiver] ever fired.
 */
class ActivitySegmentsSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun activitySegmentsSettings(): ActivitySegmentsSettings

        fun activitySegmentsIntegration(): ActivitySegmentsIntegration

        fun activitySegmentsSessionProvider(): ActivitySegmentsSessionProvider
        fun activityPermissionHealthCoordinator(): PermissionHealthCoordinator
    }

    override suspend fun doWork(): Result {
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        val integration = deps.activitySegmentsIntegration()
        val coordinator = deps.activitySegmentsSessionProvider().coordinator()
        deps.activityPermissionHealthCoordinator().refreshSource(ActivitySegmentsSyncCoordinator.SOURCE_ID)

        val shouldRun = shouldRunBackgroundSync(
            enabled = deps.activitySegmentsSettings().activitySegmentsEnabled,
            hasPermission = integration.hasPermission(),
            availability = integration.availability(),
            hasSession = coordinator != null,
        )
        if (!shouldRun || coordinator == null) return Result.success()

        // Behind whatever change to the subscription is already queued, so a
        // self-heal cannot resubscribe over an unsubscribe that is still in
        // flight. Play-services failures are logged inside and die there.
        integration.applyTransitions(subscribed = true)

        return when (val result = coordinator.syncNow()) {
            is ActivitySegmentsSyncCoordinator.SyncResult.Failed ->
                if (result.retryable) Result.retry() else Result.failure()
            is ActivitySegmentsSyncCoordinator.SyncResult.NeedsAttention -> Result.failure()
            is ActivitySegmentsSyncCoordinator.SyncResult.SourceRemoved -> {
                ActivitySegmentsSyncScheduler.cancel(applicationContext)
                Result.failure()
            }
            is ActivitySegmentsSyncCoordinator.SyncResult.SourcePaused -> Result.retry()
            is ActivitySegmentsSyncCoordinator.SyncResult.Success,
            is ActivitySegmentsSyncCoordinator.SyncResult.Skipped,
            -> Result.success()
        }
    }
}

/**
 * Schedules/cancels the unique periodic [ActivitySegmentsSyncWorker]. The
 * Activity Segments settings surface calls [schedule] when the user enables
 * syncing and [cancel] when they disable it.
 */
object ActivitySegmentsSyncScheduler {
    const val UNIQUE_WORK_NAME = "android-activity-segments-sync"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<ActivitySegmentsSyncWorker>(1, TimeUnit.HOURS)
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
