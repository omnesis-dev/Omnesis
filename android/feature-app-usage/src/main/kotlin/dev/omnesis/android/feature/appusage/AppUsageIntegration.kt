// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.os.Process
import android.provider.Settings
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.feature.appusage.setup.usageAccessSettingsIntent
import dev.omnesis.android.transport.HostedSourceContract
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.PermissionCapability
import dev.omnesis.android.transport.PermissionCapabilityState
import dev.omnesis.android.transport.PermissionHealthReporter
import dev.omnesis.android.transport.PermissionHealthSnapshot
import dev.omnesis.android.transport.PermissionRepairAction
import dev.omnesis.android.transport.PermissionRequirement
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.SourceMultiDeviceMode
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.client.DocumentsClient
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Everything the app's composition root needs from the App Usage feature,
 * behind generic seams: build a per-session [AppUsageSyncCoordinator], kick
 * the post-pairing first sync, route inbound gateway commands,
 * and (de)schedule the background worker. Keeps source-specific knowledge —
 * the `android-app-usage:` id prefix, the `source.sync` command contract —
 * out of the app module.
 */
@Singleton
class AppUsageIntegration @Inject constructor(
    @ApplicationContext private val context: Context,
    private val settings: AppUsageSettings,
) : PermissionHealthReporter, HostedSourceOptIn {
    override val sourceId = AppUsageSyncCoordinator.SOURCE_ID
    override val hostedSourceContract = HostedSourceContract(
        AppUsageSource.SOURCE_TYPE,
        SourceMultiDeviceMode.PARTITIONED,
    )
    override val enabled: Boolean get() = settings.appUsageEnabled

    override suspend fun permissionHealth(nowMillis: Long): PermissionHealthSnapshot =
        appUsagePermissionSnapshot(nowMillis, hasUsageAccess())

    override fun repairIntent(context: Context, capabilityId: String): Intent = usageAccessSettingsIntent(context)

    /** Whether this app holds "usage access"; see the top-level [hasUsageAccess]. */
    fun hasUsageAccess(): Boolean = dev.omnesis.android.feature.appusage.hasUsageAccess(context)

    /** Builds the coordinator bound to one gateway session's clients. */
    fun buildCoordinator(
        analytics: AnalyticsClient,
        documents: DocumentsClient,
        sendEvent: (String, JsonObject) -> Unit,
    ): AppUsageSyncCoordinator {
        val usageStatsManager = context.getSystemService(Context.USAGE_STATS_SERVICE) as android.app.usage.UsageStatsManager
        return AppUsageSyncCoordinator(
            sourceFactory = { AppUsageSource(usageStatsManager, labelResolver = ::resolveLabel) },
            analytics = analytics,
            documents = documents,
            settings = settings,
            hasUsageAccess = { hasUsageAccess() },
            sendEvent = sendEvent,
        )
    }

    /** App label for a package, falling back to the raw package name if it's since been uninstalled. */
    private fun resolveLabel(packageName: String): String = runCatching {
        val pm = context.packageManager
        pm.getApplicationInfo(packageName, 0).loadLabel(pm).toString()
    }.getOrDefault(packageName)

    /**
     * Fire-and-forget first drain after a session (re)build.
     * No-op unless the user enabled App Usage. Failures are logged and die
     * here — a hiccup must never take the session down.
     */
    fun launchInitialSync(coordinator: AppUsageSyncCoordinator, scope: CoroutineScope) {
        if (!settings.appUsageEnabled) return
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
    fun handleCommand(coordinator: AppUsageSyncCoordinator, type: String, payload: JsonObject, scope: CoroutineScope): Boolean {
        if (type != "source.sync") return false
        val sourceId = payload["sourceId"]?.jsonPrimitive?.contentOrNull ?: return false
        if (!sourceId.startsWith("${AppUsageSource.SOURCE_TYPE}:")) return false
        scope.launch { logOutcome(coordinator.syncNow()) }
        return true
    }

    fun scheduleBackgroundSync() = AppUsageSyncScheduler.schedule(context)

    fun cancelBackgroundSync() = AppUsageSyncScheduler.cancel(context)

    /**
     * The gateway refused to have this phone host the source. Nothing is
     * contributed either way, so the persisted opt-in goes off and the
     * periodic worker with it — with or without a settings screen open.
     */
    override fun withdraw() {
        settings.appUsageEnabled = false
        cancelBackgroundSync()
    }

    override fun forget() {
        // Settings first: a failure to cancel the background work must not leave the opt-in behind.
        settings.reset()
        cancelBackgroundSync()
    }

    /**
     * The local half of an explicit enable, once the gateway accepted this
     * phone: the switch and the periodic worker go on, and this device's
     * membership is restored before [sync] runs the first pass.
     */
    fun optIn(membership: SourceMembership, sync: () -> Unit) {
        membership.clearRefusal(sourceId)
        settings.appUsageEnabled = true
        scheduleBackgroundSync()
        membership.resumeThenSync(sourceId, sync)
    }

    private fun logOutcome(result: AppUsageSyncCoordinator.SyncResult) {
        when (result) {
            is AppUsageSyncCoordinator.SyncResult.Success ->
                Log.i(TAG, "App Usage sync complete: ${result.processed} items")
            is AppUsageSyncCoordinator.SyncResult.Skipped ->
                Log.i(TAG, "App Usage sync skipped: ${result.reason}")
            is AppUsageSyncCoordinator.SyncResult.NeedsAttention ->
                Log.w(TAG, "App Usage sync needs attention: ${result.message}")
            is AppUsageSyncCoordinator.SyncResult.Failed ->
                Log.w(TAG, "App Usage sync failed (retryable=${result.retryable}): ${result.message}")
            is AppUsageSyncCoordinator.SyncResult.SourceRemoved -> {
                Log.w(TAG, "App Usage removed in Omnesis — disabled locally")
                cancelBackgroundSync()
            }
            is AppUsageSyncCoordinator.SyncResult.SourcePaused ->
                Log.i(TAG, "App Usage paused in Omnesis: ${result.message}")
        }
    }

    private companion object {
        const val TAG = "Omnesis:appusage"
    }
}

/**
 * Whether this app has been granted "usage access" — a special AppOps
 * access, not a runtime permission dialog. `checkOpNoThrow` against
 * `OPSTR_GET_USAGE_STATS` is the documented, side-effect-free way to read
 * this grant: unlike issuing a live `queryUsageStats`/`queryEvents` call
 * and treating an empty result as "not granted", it can't produce a false
 * negative just because the device happens to have no usage history yet,
 * and it never touches the usage-stats data path at all.
 */
fun hasUsageAccess(context: Context): Boolean {
    val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
    val mode = appOps.checkOpNoThrow(
        AppOpsManager.OPSTR_GET_USAGE_STATS,
        Process.myUid(),
        context.packageName,
    )
    return mode == AppOpsManager.MODE_ALLOWED
}

internal fun appUsagePermissionSnapshot(nowMillis: Long, granted: Boolean) =
    PermissionHealthSnapshot(checkedAt = nowMillis, capabilities = listOf(
        PermissionCapability(
            id = "usage-access",
            label = "Usage access",
            state = if (granted) PermissionCapabilityState.HEALTHY else PermissionCapabilityState.PERMISSION_DEGRADED,
            requirement = PermissionRequirement.REQUIRED,
            impact = if (granted) null else "New app activity cannot be indexed.",
            remediation = if (granted) null else "Grant usage access in Android Settings.",
            repairAction = if (granted) PermissionRepairAction.NONE else PermissionRepairAction.OPEN_SOURCE_SETTINGS,
        ),
    ))
