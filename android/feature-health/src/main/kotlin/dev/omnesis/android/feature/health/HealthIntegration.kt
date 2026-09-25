// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import dev.omnesis.android.feature.health.di.HealthConnectStatusReader
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.HostedSourceContract
import dev.omnesis.android.transport.SourceMultiDeviceMode
import dev.omnesis.android.transport.PermissionCapability
import dev.omnesis.android.transport.PermissionCapabilityState
import dev.omnesis.android.transport.PermissionHealthReporter
import dev.omnesis.android.transport.PermissionHealthSnapshot
import dev.omnesis.android.transport.PermissionRepairAction
import dev.omnesis.android.transport.PermissionRequirement
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.client.AnalyticsClient
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Everything the app's composition root needs from the Health Connect feature,
 * behind generic seams: build a per-session [HealthSyncCoordinator], kick the
 * post-pairing first sync, route inbound gateway commands, and
 * (de)schedule the background worker. Keeps source-specific knowledge — the
 * `health-connect:` id prefix, the `source.sync` command contract — out of the
 * app module.
 */
@Singleton
class HealthIntegration @Inject constructor(
    @ApplicationContext private val context: Context,
    private val settings: HealthSettings,
    private val statusReader: HealthConnectStatusReader,
) : PermissionHealthReporter, HostedSourceOptIn {
    override val sourceId = HealthSyncCoordinator.SOURCE_ID
    override val hostedSourceContract = HostedSourceContract(
        sourceType = HealthConnectSource.SOURCE_TYPE,
        multiDeviceMode = SourceMultiDeviceMode.PARTITIONED,
    )
    override val enabled: Boolean get() = settings.healthConnectEnabled

    override suspend fun permissionHealth(nowMillis: Long): PermissionHealthSnapshot {
        val availability = statusReader.availability()
        val granted = statusReader.grantedPermissions()
        val enabledPermissions = enabledHealthTypePermissions(settings, statusReader::featureAvailable)
        val backgroundSupported = statusReader.featureAvailable(
            HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND,
        )
        val historySupported = statusReader.featureAvailable(
            HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY,
        )
        return healthPermissionSnapshot(
            nowMillis,
            availability,
            enabledPermissions,
            granted,
            backgroundSupported,
            historySupported,
        )
    }

    override fun repairIntent(context: Context, capabilityId: String): Intent =
        if (statusReader.availability() == HealthConnectAvailability.Available) {
            Intent("android.health.connect.action.MANAGE_HEALTH_PERMISSIONS")
                .putExtra(Intent.EXTRA_PACKAGE_NAME, context.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        } else {
            Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

    /**
     * Builds the coordinator bound to one gateway session's clients. The
     * [HealthConnectSource] is created lazily per drain, after the coordinator's
     * availability gate passed — `getOrCreate` throws on devices without a
     * usable provider.
     */
    fun buildCoordinator(
        analytics: AnalyticsClient,
        sendEvent: (String, JsonObject) -> Unit,
    ): HealthSyncCoordinator = HealthSyncCoordinator(
        sourceFactory = {
            HealthConnectSource(
                client = HealthConnectClient.getOrCreate(context),
                accountId = HealthConnectSource.ACCOUNT_ID_LOCAL,
                selfPackageName = context.packageName,
                settings = settings,
            )
        },
        analytics = analytics,
        settings = settings,
        availability = { HealthConnectAvailability.detect(context) },
        sendEvent = sendEvent,
    )

    /**
     * Fire-and-forget first drain after a session (re)build.
     * No-op unless the user enabled Health Connect. Failures are logged and
     * die here — a health hiccup must never take the session down.
     */
    fun launchInitialSync(coordinator: HealthSyncCoordinator, scope: CoroutineScope) {
        if (!settings.healthConnectEnabled) return
        scope.launch {
            logOutcome(coordinator.syncNow())
        }
    }

    /**
     * Routes a gateway WS command to the coordinator when it targets this
     * source (manual "Sync now" from another client lands here). Anything
     * else is ignored. Returns whether this integration claimed the command;
     * the socket's acknowledgement is built from that answer.
     */
    fun handleCommand(coordinator: HealthSyncCoordinator, type: String, payload: JsonObject, scope: CoroutineScope): Boolean {
        if (type != "source.sync") return false
        val sourceId = payload["sourceId"]?.jsonPrimitive?.contentOrNull ?: return false
        if (!sourceId.startsWith("${HealthConnectSource.SOURCE_TYPE}:")) return false
        scope.launch { logOutcome(coordinator.syncNow()) }
        return true
    }

    /**
     * The local half of an explicit enable, once the gateway accepted this
     * phone: the switch and the hourly worker go on, and this device's
     * membership is restored before [sync] runs.
     */
    fun optIn(membership: SourceMembership, sync: () -> Unit) {
        membership.clearRefusal(sourceId)
        settings.healthConnectEnabled = true
        scheduleBackgroundSync()
        membership.resumeThenSync(sourceId, sync)
    }

    override fun forget() {
        // Settings first: a failure to cancel the background work must not leave the opt-in behind.
        settings.reset()
        cancelBackgroundSync()
    }

    fun scheduleBackgroundSync() = HealthSyncScheduler.schedule(context)

    fun cancelBackgroundSync() = HealthSyncScheduler.cancel(context)

    /**
     * The gateway refused to have this phone host the source. Nothing is
     * contributed either way, so the persisted opt-in goes off and the
     * periodic worker with it — with or without a settings screen open.
     */
    override fun withdraw() {
        settings.healthConnectEnabled = false
        cancelBackgroundSync()
    }

    private fun logOutcome(result: HealthSyncCoordinator.SyncResult) {
        when (result) {
            is HealthSyncCoordinator.SyncResult.Success ->
                Log.i(TAG, "Health Connect sync complete: ${result.processed} rows")
            is HealthSyncCoordinator.SyncResult.Skipped ->
                Log.i(TAG, "Health Connect sync skipped: ${result.reason}")
            is HealthSyncCoordinator.SyncResult.NeedsAttention ->
                Log.w(TAG, "Health Connect sync needs attention: ${result.message}")
            is HealthSyncCoordinator.SyncResult.Failed ->
                Log.w(TAG, "Health Connect sync failed (retryable=${result.retryable}): ${result.message}")
            is HealthSyncCoordinator.SyncResult.SourceRemoved -> {
                // Removed in Omnesis — the coordinator already disabled syncing;
                // stop the periodic worker so it doesn't keep waking to no-op.
                Log.w(TAG, "Health Connect removed in Omnesis — disabled locally")
                cancelBackgroundSync()
            }
            is HealthSyncCoordinator.SyncResult.SourcePaused ->
                Log.i(TAG, "Health Connect paused in Omnesis: ${result.message}")
        }
    }

    private companion object {
        const val TAG = "Omnesis:health"
    }
}

internal fun enabledHealthTypePermissions(
    settings: HealthSettings,
    featureAvailable: (Int) -> Boolean = { true },
): Set<String> =
    HealthTypeCatalog.entries
        .filter { entry -> HealthCategory.fromTableName(entry.tableName)?.let(settings::isCategoryEnabled) == true }
        .filter { entry -> entry.requiredFeature?.let(featureAvailable) != false }
        .map(HealthTypeCatalog::readPermissionFor)
        .toSet()

internal fun healthPermissionSnapshot(
    nowMillis: Long,
    availability: HealthConnectAvailability,
    enabledTypePermissions: Set<String>,
    granted: Set<String>,
    backgroundSupported: Boolean,
    historySupported: Boolean,
): PermissionHealthSnapshot {
    if (availability != HealthConnectAvailability.Available) {
        return PermissionHealthSnapshot(
            checkedAt = nowMillis,
            capabilities = listOf(
                PermissionCapability(
                    id = "provider",
                    label = "Health Connect",
                    state = PermissionCapabilityState.UNAVAILABLE,
                    requirement = PermissionRequirement.REQUIRED,
                    impact = "Health records cannot sync on this device.",
                    remediation = if (availability == HealthConnectAvailability.NotSupported) {
                        "No settings change can enable Health Connect on this device."
                    } else {
                        "Install or update Health Connect."
                    },
                    repairAction = if (availability == HealthConnectAvailability.NotSupported) PermissionRepairAction.NONE else PermissionRepairAction.OPEN_SYSTEM_SETTINGS,
                ),
            ),
        )
    }
    val missingTypes = enabledTypePermissions - granted
    val backgroundGranted = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in granted
    val historyGranted = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in granted
    val optionalCapabilities = if (enabledTypePermissions.isEmpty()) {
        emptyList()
    } else {
        listOfNotNull(
            if (backgroundSupported) PermissionCapability(
                id = "background-read",
                label = "Background health updates",
                state = if (backgroundGranted) PermissionCapabilityState.HEALTHY else PermissionCapabilityState.BACKGROUND_ACCESS_MISSING,
                requirement = PermissionRequirement.OPTIONAL,
                impact = if (backgroundGranted) null else "Health data updates only while Omnesis is open.",
                remediation = if (backgroundGranted) null else "Allow background access in Health Connect.",
                repairAction = if (backgroundGranted) PermissionRepairAction.NONE else PermissionRepairAction.OPEN_SOURCE_SETTINGS,
            ) else null,
            if (historySupported) PermissionCapability(
                id = "history-read",
                label = "Health history",
                state = if (historyGranted) PermissionCapabilityState.HEALTHY else PermissionCapabilityState.PERMISSION_DEGRADED,
                requirement = PermissionRequirement.OPTIONAL,
                impact = if (historyGranted) null else "Older health history may be incomplete.",
                remediation = if (historyGranted) null else "Allow health history access in Health Connect.",
                repairAction = if (historyGranted) PermissionRepairAction.NONE else PermissionRepairAction.OPEN_SOURCE_SETTINGS,
            ) else null,
        )
    }
    return PermissionHealthSnapshot(
        checkedAt = nowMillis,
        capabilities = listOf(
            PermissionCapability(
                id = "record-types",
                label = "Health record access",
                state = if (missingTypes.isEmpty()) PermissionCapabilityState.HEALTHY else PermissionCapabilityState.PERMISSION_DEGRADED,
                requirement = PermissionRequirement.REQUIRED,
                impact = missingTypes.takeIf { it.isNotEmpty() }?.let { "${it.size} enabled health data type(s) cannot sync." },
                remediation = missingTypes.takeIf { it.isNotEmpty() }?.let { "Review Omnesis permissions in Health Connect." },
                repairAction = if (missingTypes.isEmpty()) PermissionRepairAction.NONE else PermissionRepairAction.OPEN_SOURCE_SETTINGS,
            ),
        ) + optionalCapabilities,
    )
}
