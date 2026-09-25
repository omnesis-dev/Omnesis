// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import dagger.hilt.android.qualifiers.ApplicationContext
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
import dev.omnesis.android.transport.client.DocumentsClient
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Everything the app's composition root needs from the Activity Segments
 * feature, behind generic seams: build a per-session
 * [ActivitySegmentsSyncCoordinator], kick the post-pairing
 * first sync, route inbound gateway commands, and (de)schedule the
 * background worker + GMS subscription. Keeps source-specific knowledge out
 * of the app module.
 */
@Singleton
class ActivitySegmentsIntegration @Inject constructor(
    @ApplicationContext private val context: Context,
    private val settings: ActivitySegmentsSettings,
    private val buffer: ActivityTransitionBuffer,
) : PermissionHealthReporter, HostedSourceOptIn {
    override val sourceId = ActivitySegmentsSyncCoordinator.SOURCE_ID
    override val hostedSourceContract = HostedSourceContract(
        sourceType = ActivitySegmentsSyncCoordinator.SOURCE_TYPE,
        multiDeviceMode = SourceMultiDeviceMode.PARTITIONED,
    )
    override val enabled: Boolean get() = settings.activitySegmentsEnabled

    /**
     * Where every change to the activity-transition subscription runs, and
     * the lock that keeps two of them from interleaving.
     *
     * The subscription is a Play-services registration this app holds until
     * it takes it back, so a change to it must outlive the screen that asked
     * for it: a settings screen closing mid-`Task` would otherwise leave the
     * phone subscribed, buffering transitions for a source it no longer
     * hosts. The lock is fair, so changes take effect in the order they were
     * asked for — an opt-in immediately refused ends unsubscribed, not
     * subscribed to a source the gateway will not have this phone host.
     */
    private val transitionScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val transitionLock = Mutex()

    override suspend fun permissionHealth(nowMillis: Long): PermissionHealthSnapshot =
        activitySegmentsPermissionSnapshot(nowMillis, availability(), hasPermission())

    override fun repairIntent(context: Context, capabilityId: String): Intent =
        if (availability() == ActivitySegmentsAvailability.Available) {
            super<PermissionHealthReporter>.repairIntent(context, capabilityId)
        } else {
            Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.gms")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

    /** Whether activity recognition is granted; see [hasActivityRecognitionPermission]. */
    fun hasPermission(): Boolean = hasActivityRecognitionPermission(context)

    fun availability(): ActivitySegmentsAvailability = ActivitySegmentsAvailability.detect(context)

    /** Builds the coordinator bound to one gateway session's clients. */
    fun buildCoordinator(
        analytics: AnalyticsClient,
        documents: DocumentsClient,
        sendEvent: (String, JsonObject) -> Unit,
    ): ActivitySegmentsSyncCoordinator = ActivitySegmentsSyncCoordinator(
        buffer = buffer,
        history = ActivitySegmentsHistoryStore(context),
        analytics = analytics,
        documents = documents,
        settings = settings,
        hasPermission = ::hasPermission,
        availability = ::availability,
        sendEvent = sendEvent,
    )

    /**
     * Fire-and-forget first drain after a
     * session (re)build. No-op unless the user enabled Activity Segments.
     * Failures are logged and die here — a hiccup must never take the
     * session down.
     */
    fun launchInitialSync(coordinator: ActivitySegmentsSyncCoordinator, scope: CoroutineScope) {
        if (!settings.activitySegmentsEnabled) return
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
    fun handleCommand(coordinator: ActivitySegmentsSyncCoordinator, type: String, payload: JsonObject, scope: CoroutineScope): Boolean {
        if (type != "source.sync") return false
        val sourceId = payload["sourceId"]?.jsonPrimitive?.contentOrNull ?: return false
        if (!sourceId.startsWith("${ActivitySegmentsSyncCoordinator.SOURCE_TYPE}:")) return false
        scope.launch { logOutcome(coordinator.syncNow()) }
        return true
    }

    /**
     * Queues [subscribed] onto the transition subscription and returns at
     * once, on a scope no screen owns. The returned [Job] is for a caller
     * that has a reason to wait; nobody has to.
     */
    fun applyTransitionSubscription(subscribed: Boolean): Job =
        transitionScope.launch { applyTransitions(subscribed) }

    /**
     * One change to the transition subscription, behind whatever change is
     * already queued. Subscribing is refused unless Play services is actually
     * usable. A Play-services failure is logged and dies here: it leaves the
     * subscription where it was, and there is nothing a caller could do about
     * it that this has not already done.
     */
    suspend fun applyTransitions(subscribed: Boolean) = transitionLock.withLock {
        runCatching {
            if (subscribed) {
                if (hasPermission() && availability() == ActivitySegmentsAvailability.Available) {
                    subscriber().subscribe()
                }
            } else {
                subscriber().unsubscribe()
            }
        }.onFailure {
            Log.w(TAG, "Activity transition ${if (subscribed) "subscribe" else "unsubscribe"} failed: $it")
        }
        Unit
    }

    /**
     * The gateway refused to have this phone host the source. Nothing is
     * contributed either way, so the persisted opt-in goes off, the periodic
     * worker with it, and the transition subscription too — there is nowhere
     * left to send what it would collect, and the drain that would empty the
     * buffer has just been cancelled.
     */
    override fun withdraw() {
        settings.activitySegmentsEnabled = false
        cancelBackgroundSync()
        applyTransitionSubscription(subscribed = false)
    }

    override fun forget() {
        // Settings first: a failure to stop the background work must not leave the opt-in behind.
        settings.reset()
        cancelBackgroundSync()
        applyTransitionSubscription(subscribed = false)
    }

    /**
     * The local half of an explicit enable, once the gateway accepted this
     * phone: the switch, the periodic worker and the transition subscription
     * go on, and this device's membership is restored before [sync] runs.
     */
    fun optIn(membership: SourceMembership, sync: () -> Unit) {
        membership.clearRefusal(sourceId)
        settings.activitySegmentsEnabled = true
        scheduleBackgroundSync()
        applyTransitionSubscription(subscribed = true)
        membership.resumeThenSync(sourceId, sync)
    }

    fun scheduleBackgroundSync() = ActivitySegmentsSyncScheduler.schedule(context)

    fun cancelBackgroundSync() = ActivitySegmentsSyncScheduler.cancel(context)

    private fun subscriber() = ActivityTransitionSubscriber(context)

    private fun logOutcome(result: ActivitySegmentsSyncCoordinator.SyncResult) {
        when (result) {
            is ActivitySegmentsSyncCoordinator.SyncResult.Success ->
                Log.i(TAG, "Activity Segments sync complete: ${result.processed} items")
            is ActivitySegmentsSyncCoordinator.SyncResult.Skipped ->
                Log.i(TAG, "Activity Segments sync skipped: ${result.reason}")
            is ActivitySegmentsSyncCoordinator.SyncResult.NeedsAttention ->
                Log.w(TAG, "Activity Segments sync needs attention: ${result.message}")
            is ActivitySegmentsSyncCoordinator.SyncResult.Failed ->
                Log.w(TAG, "Activity Segments sync failed (retryable=${result.retryable}): ${result.message}")
            is ActivitySegmentsSyncCoordinator.SyncResult.SourceRemoved -> {
                Log.w(TAG, "Activity Segments removed in Omnesis — disabled locally")
                cancelBackgroundSync()
            }
            is ActivitySegmentsSyncCoordinator.SyncResult.SourcePaused ->
                Log.i(TAG, "Activity Segments paused in Omnesis: ${result.message}")
        }
    }

    private companion object {
        const val TAG = "Omnesis:activitysegments"
    }
}

/**
 * `ACTIVITY_RECOGNITION` is a real runtime "dangerous" permission only on
 * API 29+; below that it is implicitly granted at install time via the
 * GMS-declared `com.google.android.gms.permission.ACTIVITY_RECOGNITION`,
 * with no dialog to show at all.
 */
fun hasActivityRecognitionPermission(context: Context): Boolean =
    if (Build.VERSION.SDK_INT >= 29) {
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) ==
            PackageManager.PERMISSION_GRANTED
    } else {
        true
    }

internal fun activitySegmentsPermissionSnapshot(
    nowMillis: Long,
    availability: ActivitySegmentsAvailability,
    granted: Boolean,
): PermissionHealthSnapshot {
    val available = availability == ActivitySegmentsAvailability.Available
    return PermissionHealthSnapshot(
        checkedAt = nowMillis,
        capabilities = listOf(
            PermissionCapability(
                id = "activity-recognition",
                label = "Activity recognition",
                state = when {
                    !available -> PermissionCapabilityState.UNAVAILABLE
                    granted -> PermissionCapabilityState.HEALTHY
                    else -> PermissionCapabilityState.PERMISSION_DEGRADED
                },
                requirement = PermissionRequirement.REQUIRED,
                impact = when {
                    !available -> "Activity detection is unavailable on this device."
                    !granted -> "New activity segments cannot be indexed."
                    else -> null
                },
                remediation = when {
                    !available -> "Install or update Google Play services."
                    !granted -> "Allow physical activity access in Android Settings."
                    else -> null
                },
                repairAction = when {
                    !available -> PermissionRepairAction.OPEN_SYSTEM_SETTINGS
                    !granted -> PermissionRepairAction.OPEN_SOURCE_SETTINGS
                    else -> PermissionRepairAction.NONE
                },
            ),
        ),
    )
}
