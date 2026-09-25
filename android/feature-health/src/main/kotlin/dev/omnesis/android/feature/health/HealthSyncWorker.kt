// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
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
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import java.util.concurrent.TimeUnit

/**
 * The background-sync gate, pure so the truth table is unit-testable. Every
 * leg must hold: the user opted in, the provider is usable, Health Connect
 * granted background reads AND this device's provider supports the
 * background-read feature at all, and a paired session exists to upload into.
 */
fun shouldRunBackgroundSync(
    enabled: Boolean,
    availability: HealthConnectAvailability,
    backgroundReadGranted: Boolean,
    backgroundReadFeatureAvailable: Boolean,
    hasSession: Boolean,
): Boolean =
    enabled &&
        availability == HealthConnectAvailability.Available &&
        backgroundReadGranted &&
        backgroundReadFeatureAvailable &&
        hasSession

/**
 * Hourly background drain of the Health Connect source. Plain (non-Hilt)
 * worker: dependencies resolve through a Hilt [EntryPoint] against the
 * application component, which also works when WorkManager cold-starts the
 * process with no activity ever created. Gates not met → skip-success (the
 * periodic chain stays alive); transient drain failure → retry with backoff.
 */
class HealthSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun settings(): HealthSettings

        fun sessionProvider(): HealthSessionProvider
        fun healthPermissionHealthCoordinator(): PermissionHealthCoordinator
    }

    override suspend fun doWork(): Result {
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        val availability = HealthConnectAvailability.detect(applicationContext)
        val coordinator = deps.sessionProvider().coordinator()
        deps.healthPermissionHealthCoordinator().refreshSource(HealthSyncCoordinator.SOURCE_ID)

        var backgroundReadGranted = false
        var backgroundReadFeatureAvailable = false
        if (availability == HealthConnectAvailability.Available) {
            val client = HealthConnectClient.getOrCreate(applicationContext)
            backgroundReadGranted =
                HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in
                    client.permissionController.getGrantedPermissions()
            backgroundReadFeatureAvailable = client.features.getFeatureStatus(
                HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND,
            ) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        }

        val shouldRun = shouldRunBackgroundSync(
            enabled = deps.settings().healthConnectEnabled,
            availability = availability,
            backgroundReadGranted = backgroundReadGranted,
            backgroundReadFeatureAvailable = backgroundReadFeatureAvailable,
            hasSession = coordinator != null,
        )
        if (!shouldRun || coordinator == null) return Result.success()

        return when (val result = coordinator.syncNow()) {
            is HealthSyncCoordinator.SyncResult.Failed ->
                if (result.retryable) Result.retry() else Result.failure()
            is HealthSyncCoordinator.SyncResult.NeedsAttention -> Result.failure()
            is HealthSyncCoordinator.SyncResult.SourceRemoved -> {
                // Removed in Omnesis — the coordinator already disabled syncing;
                // stop the periodic worker so it doesn't keep waking to no-op.
                HealthSyncScheduler.cancel(applicationContext)
                Result.failure()
            }
            // Paused in Omnesis — retry later; the data is retained for resume.
            is HealthSyncCoordinator.SyncResult.SourcePaused -> Result.retry()
            is HealthSyncCoordinator.SyncResult.Success,
            is HealthSyncCoordinator.SyncResult.Skipped,
            -> Result.success()
        }
    }
}

/**
 * Schedules/cancels the unique periodic [HealthSyncWorker]. The Health Connect
 * settings surface calls [schedule] when the user enables syncing and [cancel]
 * when they disable it.
 */
object HealthSyncScheduler {
    const val UNIQUE_WORK_NAME = "health-connect-sync"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<HealthSyncWorker>(1, TimeUnit.HOURS)
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
