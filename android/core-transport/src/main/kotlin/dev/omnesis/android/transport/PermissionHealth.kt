// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.util.Log
import dev.omnesis.android.transport.client.AdminClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Complete, short-lived statement of one phone source's current OS capabilities. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PermissionHealthSnapshot(
    val checkedAt: Long,
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val validForMs: Long = DEFAULT_VALID_FOR_MS,
    val capabilities: List<PermissionCapability>,
) {
    companion object { const val DEFAULT_VALID_FOR_MS = 6 * 60 * 60 * 1_000L }
}

@Serializable
data class PermissionCapability(
    val id: String,
    val label: String,
    val state: PermissionCapabilityState,
    val requirement: PermissionRequirement,
    val impact: String? = null,
    val remediation: String? = null,
    val repairAction: PermissionRepairAction,
)

@Serializable
enum class PermissionCapabilityState {
    @SerialName("healthy") HEALTHY,
    @SerialName("permission-degraded") PERMISSION_DEGRADED,
    @SerialName("background-access-missing") BACKGROUND_ACCESS_MISSING,
    @SerialName("unavailable") UNAVAILABLE,
    @SerialName("unknown") UNKNOWN,
}

@Serializable
enum class PermissionRequirement {
    @SerialName("required") REQUIRED,
    @SerialName("optional") OPTIONAL,
}

/** Finite, non-source-specific routes which the app can translate into safe Android intents. */
@Serializable
enum class PermissionRepairAction {
    @SerialName("open-source-settings") OPEN_SOURCE_SETTINGS,
    @SerialName("open-app-settings") OPEN_APP_SETTINGS,
    @SerialName("open-system-settings") OPEN_SYSTEM_SETTINGS,
    @SerialName("none") NONE,
}

/** Implemented inside a feature module so permission knowledge never leaks into app renderers. */
interface PermissionHealthReporter {
    val sourceId: String
    val enabled: Boolean
    suspend fun permissionHealth(nowMillis: Long = System.currentTimeMillis()): PermissionHealthSnapshot
    fun repairIntent(context: Context, capabilityId: String): Intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.fromParts("package", context.packageName, null)
    }
}

data class PermissionHealthEntry(
    val sourceId: String,
    val snapshot: PermissionHealthSnapshot,
) {
    val actionable: List<PermissionCapability> = snapshot.capabilities.filter {
        it.state == PermissionCapabilityState.PERMISSION_DEGRADED ||
            it.state == PermissionCapabilityState.BACKGROUND_ACCESS_MISSING ||
            it.state == PermissionCapabilityState.UNAVAILABLE
    }
}

/**
 * One foreground/worker reporting path for every source-owned permission reader.
 *
 * Refresh requests coalesce into runs: every request made before a run starts
 * is served by that run, and requests made while a run is on the wire are
 * gathered into exactly one more run after it. A burst of screens and workers
 * asking at once reports each source once, and nothing asked for mid-run is
 * lost.
 *
 * A source the gateway answers "source not found" for is checked against the
 * gateway's source list: when this device neither owns nor joins it, its
 * phone-side opt-in is stale and [forgetSource] turns it off; when the device
 * does host it, it is reported again once. Any other 404 — a gateway that
 * predates permission health — simply stops reporting the source. Reporting
 * resumes on a new session, when the source is turned back on, or on
 * [resetReporting]. Local snapshots are always read, so the phone keeps
 * showing what needs fixing.
 */
class PermissionHealthCoordinator(
    private val reporters: () -> Collection<PermissionHealthReporter>,
    private val admin: () -> AdminClient?,
    private val scope: CoroutineScope,
    /** This pairing's device id, for checking whether a missing source is this phone's. */
    private val deviceId: () -> String? = { null },
    /** Turns a source's phone-side opt-in off when the gateway has no such source for this device. */
    private val forgetSource: (String) -> Unit = {},
) {
    private val _state = MutableStateFlow<List<PermissionHealthEntry>>(emptyList())
    val state: StateFlow<List<PermissionHealthEntry>> = _state.asStateFlow()

    private val requestLock = Any()
    private var runner: Job? = null
    private var nextRun: CompletableDeferred<Unit>? = null
    private var requestedAll = false
    private val requestedIds = mutableSetOf<String>()

    private val unregisteredLock = Any()
    private val unregistered = mutableSetOf<String>()
    private val membershipChecked = mutableSetOf<String>()
    private var unregisteredFor: AdminClient? = null

    /** Refreshes every source in the next run that has not started yet. */
    fun refresh(): Job = request(sourceId = null)

    /** Refreshes [sourceId] in the next run that has not started yet, and waits for it. */
    suspend fun refreshSource(sourceId: String) = request(sourceId).await()

    /** Refreshes every source in the next run that has not started yet, and waits for it. */
    suspend fun refreshNow() = request(sourceId = null).await()

    /** A source's registration may have changed (it was registered or opted in): report every source again. */
    fun resetReporting() = synchronized(unregisteredLock) {
        unregistered.clear()
        membershipChecked.clear()
    }

    fun repairIntent(context: Context, sourceId: String, capabilityId: String): Intent? {
        val capability = _state.value.firstOrNull { it.sourceId == sourceId }
            ?.snapshot?.capabilities?.firstOrNull { it.id == capabilityId }
            ?: return null
        if (capability.repairAction == PermissionRepairAction.NONE) return null
        return reporters().firstOrNull { it.sourceId == sourceId && it.enabled }
            ?.repairIntent(context, capabilityId)
    }

    private fun request(sourceId: String?): CompletableDeferred<Unit> {
        var start: Job? = null
        val run = synchronized(requestLock) {
            if (sourceId == null) requestedAll = true else requestedIds += sourceId
            val pending = nextRun ?: CompletableDeferred<Unit>().also { nextRun = it }
            if (runner == null) {
                start = scope.launch(start = CoroutineStart.LAZY) { drain() }.also { runner = it }
            }
            pending
        }
        start?.start()
        return run
    }

    /** Runs gathered requests until none are left; a request made during a run is served by the run after it. */
    private suspend fun drain() {
        while (true) {
            val batch = synchronized(requestLock) {
                val pending = nextRun
                if (pending == null) {
                    runner = null
                    return
                }
                RefreshBatch(requestedAll, requestedIds.toSet(), pending).also {
                    requestedAll = false
                    requestedIds.clear()
                    nextRun = null
                }
            }
            try {
                if (batch.all) reportAll() else batch.ids.forEach { reportOne(it) }
                batch.run.complete(Unit)
            } catch (error: Throwable) {
                batch.run.completeExceptionally(error)
                if (error is CancellationException && !currentCoroutineContext().isActive) {
                    synchronized(requestLock) {
                        runner = null
                        nextRun?.completeExceptionally(error)
                        nextRun = null
                    }
                    throw error
                }
            }
        }
    }

    private suspend fun reportAll() {
        _state.value = reporters().mapNotNull { report(it) }.sortedBy { it.sourceId }
    }

    private suspend fun reportOne(sourceId: String) {
        val reporter = reporters().firstOrNull { it.sourceId == sourceId } ?: return
        val entry = report(reporter)
        _state.value = (_state.value.filterNot { it.sourceId == sourceId } + listOfNotNull(entry)).sortedBy { it.sourceId }
    }

    private suspend fun report(reporter: PermissionHealthReporter): PermissionHealthEntry? {
        if (!reporter.enabled) {
            // Turning a source back on goes through registration, so its next report is worth sending.
            synchronized(unregisteredLock) {
                unregistered.remove(reporter.sourceId)
                membershipChecked.remove(reporter.sourceId)
            }
            return null
        }
        return try {
            val snapshot = reporter.permissionHealth()
            admin()?.let { current ->
                if (!isRegisteredOn(current, reporter.sourceId)) return@let
                try {
                    current.putPermissionHealth(reporter.sourceId, snapshot)
                } catch (notFound: GatewayException.NotFound) {
                    settleNotFound(current, reporter.sourceId, notFound)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    // Network reporting is best-effort; local remediation must remain visible.
                    Log.w("Omnesis:permissions", "Could not report permission health: $error")
                }
            }
            PermissionHealthEntry(reporter.sourceId, snapshot)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            Log.w("Omnesis:permissions", "Could not refresh permission health: $error")
            null
        }
    }

    /**
     * The gateway has no [sourceId] to report against. Only its own "source not
     * found" answer is worth one look at the source list; the answer decides
     * between a stale phone-side opt-in and a source this device does host.
     */
    private suspend fun settleNotFound(client: AdminClient, sourceId: String, error: GatewayException.NotFound) {
        val device = deviceId()
        val sourceMissing = error.body?.contains(SOURCE_NOT_FOUND, ignoreCase = true) == true
        val firstLook = synchronized(unregisteredLock) { membershipChecked.add(sourceId) }
        if (!sourceMissing || device.isNullOrBlank() || !firstLook) {
            markUnregistered(sourceId)
            return
        }
        val hosted = try {
            client.sources().firstOrNull { it.id == sourceId }?.hosts(device) == true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (lookup: Exception) {
            Log.w("Omnesis:permissions", "Could not check whether this phone hosts $sourceId: $lookup")
            null
        }
        when (hosted) {
            false -> {
                markUnregistered(sourceId)
                runCatching { forgetSource(sourceId) }
                    .onFailure { Log.w("Omnesis:permissions", "Could not turn off the stale opt-in for $sourceId: $it") }
            }
            true -> synchronized(unregisteredLock) { unregistered.remove(sourceId) }
            null -> markUnregistered(sourceId)
        }
    }

    private fun markUnregistered(sourceId: String) = synchronized(unregisteredLock) { unregistered += sourceId }

    /** Whether [sourceId] may be reported through [client]; a new session starts with nothing ruled out. */
    private fun isRegisteredOn(client: AdminClient, sourceId: String): Boolean = synchronized(unregisteredLock) {
        if (unregisteredFor !== client) {
            unregistered.clear()
            membershipChecked.clear()
            unregisteredFor = client
        }
        sourceId !in unregistered
    }

    /** The requests one run serves, and what its requesters wait on. */
    private class RefreshBatch(val all: Boolean, val ids: Set<String>, val run: CompletableDeferred<Unit>)

    private companion object {
        const val SOURCE_NOT_FOUND = "source not found"
    }
}
