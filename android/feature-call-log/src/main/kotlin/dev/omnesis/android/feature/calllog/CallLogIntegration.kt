// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.HostedSourceContract
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
 * Everything the app's composition root needs from the Call Log feature,
 * behind generic seams: build a per-session [CallLogSyncCoordinator], kick the
 * post-pairing first sync, route inbound gateway commands, and
 * (de)schedule the background worker. Keeps source-specific knowledge — the
 * `android-call-log:` id prefix, the `source.sync` command contract — out of
 * the app module.
 */
@Singleton
class CallLogIntegration @Inject constructor(
    @ApplicationContext private val context: Context,
    private val settings: CallLogSettings,
) : PermissionHealthReporter, HostedSourceOptIn {
    override val sourceId = CallLogSyncCoordinator.SOURCE_ID
    override val hostedSourceContract = HostedSourceContract(
        CallLogSource.SOURCE_TYPE,
        SourceMultiDeviceMode.PARTITIONED,
    )
    override val enabled: Boolean get() = settings.callLogEnabled

    override suspend fun permissionHealth(nowMillis: Long): PermissionHealthSnapshot =
        callLogPermissionSnapshot(nowMillis, hasPermission())
    fun hasPermission(): Boolean = hasCallLogPermission(context)

    /** Builds the coordinator bound to one gateway session's clients. */
    fun buildCoordinator(
        analytics: AnalyticsClient,
        documents: DocumentsClient,
        sendEvent: (String, JsonObject) -> Unit,
    ): CallLogSyncCoordinator = CallLogSyncCoordinator(
        sourceFactory = { CallLogSource(context.contentResolver) },
        analytics = analytics,
        documents = documents,
        settings = settings,
        hasPermission = ::hasPermission,
        sendEvent = sendEvent,
    )

    /**
     * Fire-and-forget first drain after a session (re)build.
     * No-op unless the user enabled Call Log syncing. Failures are logged and
     * die here — a hiccup must never take the session down.
     */
    fun launchInitialSync(coordinator: CallLogSyncCoordinator, scope: CoroutineScope) {
        if (!settings.callLogEnabled) return
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
    fun handleCommand(coordinator: CallLogSyncCoordinator, type: String, payload: JsonObject, scope: CoroutineScope): Boolean {
        if (type != "source.sync") return false
        val sourceId = payload["sourceId"]?.jsonPrimitive?.contentOrNull ?: return false
        if (!sourceId.startsWith("${CallLogSource.SOURCE_TYPE}:")) return false
        scope.launch { logOutcome(coordinator.syncNow()) }
        return true
    }

    fun scheduleBackgroundSync() = CallLogSyncScheduler.schedule(context)

    fun cancelBackgroundSync() = CallLogSyncScheduler.cancel(context)

    /**
     * The gateway refused to have this phone host the source. Nothing is
     * contributed either way, so the persisted opt-in goes off and the
     * periodic worker with it — with or without a settings screen open.
     */
    override fun withdraw() {
        settings.callLogEnabled = false
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
        settings.callLogEnabled = true
        scheduleBackgroundSync()
        membership.resumeThenSync(sourceId, sync)
    }

    private fun logOutcome(result: CallLogSyncCoordinator.SyncResult) {
        when (result) {
            is CallLogSyncCoordinator.SyncResult.Success ->
                Log.i(TAG, "Call Log sync complete: ${result.processed} items")
            is CallLogSyncCoordinator.SyncResult.Skipped ->
                Log.i(TAG, "Call Log sync skipped: ${result.reason}")
            is CallLogSyncCoordinator.SyncResult.NeedsAttention ->
                Log.w(TAG, "Call Log sync needs attention: ${result.message}")
            is CallLogSyncCoordinator.SyncResult.Failed ->
                Log.w(TAG, "Call Log sync failed (retryable=${result.retryable}): ${result.message}")
            is CallLogSyncCoordinator.SyncResult.SourceRemoved -> {
                Log.w(TAG, "Call Log removed in Omnesis — disabled locally")
                cancelBackgroundSync()
            }
            is CallLogSyncCoordinator.SyncResult.SourcePaused ->
                Log.i(TAG, "Call Log paused in Omnesis: ${result.message}")
        }
    }

    private companion object {
        const val TAG = "Omnesis:calllog"
    }
}

/** Whether Android currently grants READ_CALL_LOG to this app. */
fun hasCallLogPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_CALL_LOG) ==
        PackageManager.PERMISSION_GRANTED

internal fun callLogPermissionSnapshot(nowMillis: Long, granted: Boolean) =
    PermissionHealthSnapshot(checkedAt = nowMillis, capabilities = listOf(
        PermissionCapability(
            id = "read-call-log",
            label = "Call history",
            state = if (granted) PermissionCapabilityState.HEALTHY else PermissionCapabilityState.PERMISSION_DEGRADED,
            requirement = PermissionRequirement.REQUIRED,
            impact = if (granted) null else "New call history cannot be indexed.",
            remediation = if (granted) null else "Allow call log access in Android Settings.",
            repairAction = if (granted) PermissionRepairAction.NONE else PermissionRepairAction.OPEN_SOURCE_SETTINGS,
        ),
    ))
