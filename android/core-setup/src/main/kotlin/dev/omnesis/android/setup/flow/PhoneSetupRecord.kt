// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.flow

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** String key/value storage for the setup record. SharedPreferences in the app; a map in tests. */
interface SetupKeyValueStore {
    fun get(key: String): String?

    /** Stores [value] under [key]; null removes the entry. */
    fun put(key: String, value: String?)
}

class InMemorySetupKeyValueStore(initial: Map<String, String> = emptyMap()) : SetupKeyValueStore {
    private val values = initial.toMutableMap()

    override fun get(key: String): String? = synchronized(values) { values[key] }

    override fun put(key: String, value: String?) {
        synchronized(values) { if (value == null) values.remove(key) else values[key] = value }
    }
}

/** Where a first-run flow was when the app last saved it, so a killed app resumes at the same page. */
@Serializable
data class PhoneSetupProgress(
    val deviceId: String,
    /** `connected`, `choose`, `step` or `finish`. */
    val screen: String,
    val stepId: String? = null,
    val selection: List<String> = emptyList(),
    val plan: List<String> = emptyList(),
    /** Step id to a persisted [SetupOutcomeKind]. */
    val outcomes: Map<String, String> = emptyMap(),
)

/**
 * The phone's local memory of the setup flow: which paired device already
 * went through it, and where an unfinished first run stopped. Device-local on
 * purpose — nothing here reaches the gateway, and it is cleared on unpair so
 * the next pairing is offered the flow again.
 */
class PhoneSetupRecord(private val store: SetupKeyValueStore) {
    private val completed = MutableStateFlow(store.get(KEY_COMPLETED))

    /** The device id that finished or skipped the flow, or null. */
    val completedForDeviceId: StateFlow<String?> = completed.asStateFlow()

    fun markCompleted(deviceId: String) {
        require(deviceId.isNotBlank()) { "A completion names the paired device" }
        store.put(KEY_COMPLETED, deviceId)
        store.put(KEY_PROGRESS, null)
        completed.value = deviceId
    }

    fun saveProgress(progress: PhoneSetupProgress) {
        store.put(KEY_PROGRESS, CODEC.encodeToString(PhoneSetupProgress.serializer(), progress))
    }

    /** The saved position for [deviceId]; a position saved for another device is not this flow's. */
    fun progress(deviceId: String): PhoneSetupProgress? {
        val raw = store.get(KEY_PROGRESS) ?: return null
        val decoded = runCatching { CODEC.decodeFromString(PhoneSetupProgress.serializer(), raw) }.getOrNull()
        if (decoded == null) {
            store.put(KEY_PROGRESS, null)
            return null
        }
        return decoded.takeIf { it.deviceId == deviceId }
    }

    /**
     * The paired device the phone's local source state belongs to: set by the
     * pairing that last started from a clean slate, or by the first session of
     * an install that was already paired. Null until then.
     */
    val localStateDeviceId: String? get() = store.get(KEY_LOCAL_STATE_DEVICE)

    fun claimLocalState(deviceId: String?) {
        store.put(KEY_LOCAL_STATE_DEVICE, deviceId?.takeIf { it.isNotBlank() })
    }

    /**
     * Set just before a pairing exchange, so a pairing persisted by a process
     * that died before its session was built is still settled on the next
     * launch; [finishPairing] clears it once the session applied it.
     */
    val pairingPending: Boolean get() = store.get(KEY_PAIRING_PENDING) != null

    /** Set when the user asked to re-pair this phone: the pairing that follows keeps the local state. */
    val repairing: Boolean get() = store.get(KEY_REPAIRING) != null

    fun beginPairing() = store.put(KEY_PAIRING_PENDING, "true")

    /** A pairing exchange failed and nothing was persisted: no pairing is under way any more. */
    fun clearPairingPending() = store.put(KEY_PAIRING_PENDING, null)

    fun beginRepair() = store.put(KEY_REPAIRING, "true")

    fun finishPairing() {
        store.put(KEY_PAIRING_PENDING, null)
        store.put(KEY_REPAIRING, null)
    }

    /** Forgets the completion, any saved position and which device the local state belongs to. */
    fun clear() {
        store.put(KEY_COMPLETED, null)
        store.put(KEY_PROGRESS, null)
        store.put(KEY_LOCAL_STATE_DEVICE, null)
        completed.value = null
    }

    companion object {
        const val KEY_COMPLETED = "phoneSetup.completedForDeviceId"
        const val KEY_PROGRESS = "phoneSetup.progress"
        const val KEY_LOCAL_STATE_DEVICE = "phoneSetup.localStateDeviceId"
        const val KEY_PAIRING_PENDING = "phoneSetup.pairingPending"
        const val KEY_REPAIRING = "phoneSetup.repairing"
        private val CODEC = Json { ignoreUnknownKeys = true }
    }
}

/**
 * Whether a pairing to [deviceId] keeps the phone's local source state: only
 * when that state was recorded for the same device, as after a repair. A new
 * gateway, or state no pairing recorded, starts clean.
 */
fun pairingKeepsLocalState(recordedDeviceId: String?, deviceId: String?): Boolean =
    recordedDeviceId != null && recordedDeviceId == deviceId

/**
 * Whether a pairing that just landed resets the phone's local source state:
 * only a new pairing ([pending]) that is not a repair and not a pairing of
 * the device the state was recorded for. A repair keeps it whatever id the
 * pairing names, including none.
 */
fun pairingStartsClean(pending: Boolean, repairing: Boolean, recordedDeviceId: String?, deviceId: String?): Boolean =
    pending && !repairing && !pairingKeepsLocalState(recordedDeviceId, deviceId)

/** What a paired device should see when the app opens. */
enum class FirstRunDecision {
    /** The flow presents, fresh or resuming a saved position. */
    PRESENT,

    /** The device already finished or skipped it, or cannot be told apart. */
    SKIP,

    /** A phone source is already on: the device is recorded as done without seeing the flow. */
    COMPLETE_SILENTLY,
}

/** When the flow appears on its own after pairing. */
object PhoneSetupPolicy {
    /**
     * What [deviceId] should see. It records no decision; the one write it can
     * make is dropping a saved position that no longer decodes.
     *
     * A device that finished or skipped the flow never sees it again. An
     * unfinished flow saved for this device resumes, even when a source it
     * enabled is now on. Otherwise a device that already has a phone source
     * on — set up from Settings before this flow existed — is done.
     */
    fun decide(record: PhoneSetupRecord, deviceId: String?, anySourceOn: Boolean): FirstRunDecision = when {
        deviceId.isNullOrBlank() -> FirstRunDecision.SKIP
        record.completedForDeviceId.value == deviceId -> FirstRunDecision.SKIP
        record.progress(deviceId) != null -> FirstRunDecision.PRESENT
        anySourceOn -> FirstRunDecision.COMPLETE_SILENTLY
        else -> FirstRunDecision.PRESENT
    }
}
