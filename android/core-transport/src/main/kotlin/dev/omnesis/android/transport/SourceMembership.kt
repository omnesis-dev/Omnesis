// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.client.AdminClient
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** What this phone wants its membership of a source to become. */
@Serializable
enum class MembershipIntent {
    /** Stop contributing: leave the source's member list, or pause the source when this is its only host. */
    @SerialName("detach")
    DETACH,

    /** Contribute again: rejoin the member list, and unpause the source if it is paused. */
    @SerialName("resume")
    RESUME;

    fun pendingMessage(): String = when (this) {
        DETACH -> "Stop pending — uploads are off on this phone. The gateway will detach or pause when reachable; this phone's partition may be deleted."
        RESUME -> "Resume pending — waiting for the gateway. Rejoining is blocked while removal cleanup runs."
    }
}

/**
 * One intent the gateway has not yet been told about. [deviceId] is the
 * gateway-assigned id the intent was recorded under: a pairing that hands this
 * phone a different id makes the op meaningless, and it is dropped rather than
 * replayed against a gateway that never knew the old device.
 */
@Serializable
data class MembershipOp(
    val sourceId: String,
    val deviceId: String,
    val intent: MembershipIntent,
    /** Token-row id of the exact pairing that recorded the operation. */
    val pairingGeneration: String? = null,
    /** Gateway origin that owned this membership; absent only on old queued blobs. */
    val gateway: String? = null,
)

data class PairingIdentity(
    val deviceId: String,
    val gateway: String?,
    val generation: String?,
)

/**
 * The durable half of [SourceMembership]: the intents still to be carried out,
 * at most one per source, the latest replacing the earlier. Durable because the
 * user's tap is the only moment the intent exists — an app killed before the
 * gateway answered would otherwise leave the phone a member whose cursor never
 * moves again. Storage is a string key/value store — SharedPreferences in
 * production — reached through [read]/[write] so this stays independent of
 * any one source's settings class.
 */
class MembershipOutbox(
    private val read: (String) -> String?,
    private val write: (String, String?) -> Unit,
    private val key: String = DEFAULT_KEY,
    private val log: (String) -> Unit = {},
) {
    private val lock = Any()

    /** Every queued op, oldest first. */
    fun pending(): List<MembershipOp> = synchronized(lock) { load() }

    /** Queues [op], replacing the same gateway/source intent only. */
    fun record(op: MembershipOp) {
        synchronized(lock) {
            store(load().filterNot { it.sourceId == op.sourceId && it.gateway == op.gateway } + op)
        }
    }

    /**
     * Retires [op] once it has been carried out. Only an identical op is
     * removed: an intent recorded for the same source while this one was in
     * flight is newer and still owed to the gateway.
     */
    fun clear(op: MembershipOp) {
        synchronized(lock) { store(load().filterNot { it == op }) }
    }

    /**
     * The queue as stored. A blob that will not decode is a queue that can
     * never be carried out, so it is reported rather than swallowed: without
     * the line, every intent the user recorded disappears with no signal that
     * anything was owed. It is also dropped — nothing in it can be recovered,
     * and leaving it in place makes every later read fail and re-report the
     * same way.
     */
    private fun load(): List<MembershipOp> {
        val raw = read(key) ?: return emptyList()
        return runCatching { CODEC.decodeFromString(SERIALIZER, raw) }
            .onFailure {
                log("Queued membership intents could not be read and will not run: ${it::class.simpleName}")
                write(key, null)
            }
            .getOrDefault(emptyList())
    }

    private fun store(ops: List<MembershipOp>) {
        write(key, if (ops.isEmpty()) null else CODEC.encodeToString(SERIALIZER, ops))
    }

    private companion object {
        const val DEFAULT_KEY = "omnesis.membership.pending"
        val CODEC = Json { ignoreUnknownKeys = true }
        val SERIALIZER = ListSerializer(MembershipOp.serializer())
    }
}

/**
 * Keeps the gateway's view of which sources this phone contributes to in step
 * with the phone's own opt-in switches. Every device-hosted source goes through
 * this one object, so the rules below exist in one place:
 *
 *  - **Stop contributing** detaches this device from the source's member list.
 *    A device that is the source's only host pauses the source instead, since
 *    a detach would leave the row with nobody to sync it. A source the gateway
 *    no longer has, or never counted this device a member of, needs nothing.
 *  - **Contribute again** rejoins the member list when another device kept the
 *    source alive, and unpauses the source if it is paused — whoever paused it.
 *    Only an explicit tap on the phone's switch asks for this, and that tap is
 *    a request for the source to run; a pause made elsewhere is not preserved
 *    against it. A source with no row is created through the source's explicit
 *    registration callback before this intent settles.
 *
 * A refusal no later pass could get past is published on [refusals] as well as
 * logged: a phone whose resume was refused hosts nothing, however its switch
 * reads, so the surface that asked has to hear about it.
 *
 * Each intent is recorded in the [MembershipOutbox] before the gateway is
 * asked, and stays queued until the gateway gives an answer that settles it —
 * anything short of that (no network, a 5xx, a refused pairing) is retried on
 * the next foreground. A successful partitioned detach removes this device's
 * stream when a sibling remains; a last-member refusal becomes a pause and
 * retains the data.
 */
class SourceMembership(
    private val admin: () -> AdminClient?,
    private val pairingIdentity: () -> PairingIdentity?,
    private val outbox: MembershipOutbox,
    private val scope: CoroutineScope,
    /**
     * Where this object narrates what it did. Source ids, gateway addresses
     * and error bodies are deliberately absent from what it is handed: logcat
     * is readable by anything holding `READ_LOGS` or an adb cable, and what
     * this phone hosts — and which gateway it hosts it for — is the user's
     * business, not a debugging convenience.
     */
    private val log: (String) -> Unit = {},
    private val removalReconciler: SourceRemovalReconciler? = null,
    private val registerAbsentSource: (suspend (MembershipOp, AdminClient) -> Unit)? = null,
) {
    /** Compatibility constructor for source-level tests and legacy embedders. */
    constructor(
        admin: () -> AdminClient?,
        deviceId: () -> String?,
        outbox: MembershipOutbox,
        scope: CoroutineScope,
        pairingGeneration: () -> String? = { null },
        log: (String) -> Unit = {},
        registerAbsentSource: (suspend (MembershipOp, AdminClient) -> Unit)? = null,
    ) : this(
        admin = admin,
        pairingIdentity = {
            deviceId()?.let { PairingIdentity(it, null, pairingGeneration()) }
        },
        outbox = outbox,
        scope = scope,
        log = log,
        registerAbsentSource = registerAbsentSource,
    )

    /** How the gateway answered one op. */
    sealed interface Outcome {
        /** The device left the member list; the other members keep hosting the source. */
        data object Detached : Outcome

        /** The device was the last host, so the source was paused instead of losing it. */
        data object PausedInstead : Outcome

        /** The gateway has no such source, or never counted this device among its hosts. */
        data object NotAMember : Outcome

        /** The device hosts the source again and the source is enabled. */
        data object Resumed : Outcome

        /** No row exists to rejoin; registering the source creates one. */
        data object NoRow : Outcome

        /** A newer local intent or pairing superseded this operation. */
        data object Superseded : Outcome

        /**
         * The gateway will not have this device as a host — the source's type
         * takes one host at a time and another device has it, this kind of
         * device does not host the type, or this device is revoked. Retrying
         * would refuse identically, so the intent is dropped.
         */
        data class Refused(val code: String, val message: String) : Outcome {
            /**
             * What a phone screen shows. The gateway's own [message] names
             * source ids and, for some refusals, a command line — neither of
             * which is readable or actionable here — so the stable code is
             * turned into a sentence instead.
             */
            fun explain(): String = when (code) {
                "SOURCE_REMOVED" -> "This phone is not contributing in Omnesis. Enable explicitly; cleanup can delay rejoining."
                "SOURCE_ALREADY_HOSTED" ->
                    "Another device already syncs that source, and it takes one host at a time. " +
                        "Turned it back off on this phone."
                "DEVICE_CANNOT_HOST_TYPE" -> "This phone can't host that source. Turned it back off."
                "DEVICE_REVOKED" ->
                    "This phone's pairing was revoked. Re-pair from Settings, then turn this " +
                        "source back on — it won't resume on its own."
                else -> "The gateway won't have this phone host that source. Turned it back off."
            }
        }

        /** Nothing conclusive happened; the op stays queued for a later pass. */
        data class Retry(val cause: Throwable) : Outcome
    }

    /**
     * One in-flight op per source, rather than one overall. A queued op's
     * calls run on a 30s-call / 15s-connect budget, so a shared lock would put
     * a tap on one source's switch behind every other source's HTTP — three
     * detaches queued by a network drop would hold an opt-in for a minute and
     * a half, with no spinner and no result, because the work it is waiting on
     * is not its own. Serialising per source is the granularity that matters:
     * two passes over the same source must not interleave.
     */
    private val sourceLocks = mutableMapOf<String, Mutex>()

    private fun lockFor(sourceId: String): Mutex =
        synchronized(sourceLocks) { sourceLocks.getOrPut(sourceId) { Mutex() } }

    /**
     * Refusals the gateway will repeat however often it is asked, by source
     * id. A phone whose resume was refused is not contributing, so the switch
     * that asked is put back off and the reason shown.
     *
     * A refusal **stands** until the user deliberately asks again — it is not
     * dropped by whoever reads it. It is what keeps a source that infers its
     * own opt-in (a grant with no result callback to hang one off) from
     * quietly opting the phone back in and re-asking the gateway in a loop, and
     * it is what a settings screen opened long afterwards reads to explain a
     * switch the user did not turn off. Only [clearRefusal] drops one, from the
     * taps that mean "ask again" or "I don't want this": survives no further
     * than the process either way, since it describes what the user should be
     * told now rather than durable state.
     */
    private val _refusals = MutableStateFlow<Map<String, Outcome.Refused>>(emptyMap())
    val refusals: StateFlow<Map<String, Outcome.Refused>> = _refusals.asStateFlow()

    init {
        scope.launch {
            removalReconciler?.removed?.collect {
                removalReconciler.withRemovedAuthority { removed ->
                    _refusals.update { existing ->
                        existing.filterValues { it.code != "SOURCE_REMOVED" } +
                            removed.associateWith { Outcome.Refused("SOURCE_REMOVED", "") }
                    }
                }
            }
        }
    }

    private val _pending = MutableStateFlow(currentPending())
    val pending: StateFlow<List<MembershipOp>> = _pending.asStateFlow()

    init {
        removalReconciler?.pendingResumesFrom {
            currentPending().filter { it.intent == MembershipIntent.RESUME }.map { it.sourceId }.toSet()
        }
    }

    private fun refreshPending() {
        val pending = currentPending()
        _pending.value = pending
        removalReconciler?.updatePendingResumes(pending.filter { it.intent == MembershipIntent.RESUME }.map { it.sourceId }.toSet())
    }

    private val intentLock = Any()
    private val intentGenerations = mutableMapOf<String, Long>()

    private fun intentGeneration(sourceId: String): Long = synchronized(intentLock) { intentGenerations[sourceId] ?: 0L }

    private fun recordIntent(op: MembershipOp): Long {
        val generation = synchronized(intentLock) {
            val next = (intentGenerations[op.sourceId] ?: 0L) + 1
            intentGenerations[op.sourceId] = next
            outbox.record(op)
            next
        }
        refreshPending()
        return generation
    }

    private fun currentPending() = outbox.pending().filter { op ->
        val identity = pairingIdentity()
        identity != null && op.deviceId == identity.deviceId &&
            op.gateway == identity.gateway && op.pairingGeneration == identity.generation
    }

    /**
     * Drops [sourceId]'s refusal. Called from the taps that ask the gateway
     * again or turn the source off for good — never on merely having read it,
     * which would put the phone back where the refusal found it.
     */
    fun clearRefusal(sourceId: String) = synchronized(intentLock) {
        intentGenerations[sourceId] = (intentGenerations[sourceId] ?: 0L) + 1
        _refusals.update { it - sourceId }
    }

    /** A delayed refusal consumer cannot apply an authority a new tap already cleared. */
    fun applyRefusalIfCurrent(sourceId: String, expected: Outcome.Refused, withdraw: () -> Unit) = synchronized(intentLock) {
        if (expected.code != "SOURCE_REMOVED" && _refusals.value[sourceId] === expected) withdraw()
    }

    /** Resolve the source decision before protected access, without mutation. */
    suspend fun inspectActivation(
        sourceId: String,
        desiredMode: SourceMultiDeviceMode,
        choice: ActivationChoice? = null,
    ): ActivationOutcome {
        val identity = pairingIdentity() ?: return ActivationOutcome.Ready
        val client = admin() ?: throw IllegalStateException("not paired")
        val source = client.sources().firstOrNull { it.id == sourceId }
        return when (val plan = MobileSourceActivation.plan(source, identity.deviceId, desiredMode)) {
            ActivationPlan.Ready, ActivationPlan.Join, ActivationPlan.AddPartition -> ActivationOutcome.Ready
            is ActivationPlan.Incompatible -> ActivationOutcome.Incompatible(plan.current, plan.desired)
            is ActivationPlan.Choose -> when (choice) {
                null -> ActivationOutcome.ChoiceRequired(plan.mode)
                ActivationChoice.KEEP_OTHER -> ActivationOutcome.KeptOther
                ActivationChoice.USE_BOTH -> if (
                    desiredMode != SourceMultiDeviceMode.EXCLUSIVE && plan.mode == desiredMode
                ) ActivationOutcome.Ready else throw InvalidActivationChoice(choice, plan.mode)
                ActivationChoice.TAKE_OVER -> {
                    val persistedMode = SourceMultiDeviceMode.entries.firstOrNull {
                        it.wireValue == (source?.multiDeviceMode ?: SourceMultiDeviceMode.EXCLUSIVE.wireValue)
                    } ?: SourceMultiDeviceMode.EXCLUSIVE
                    if (persistedMode == SourceMultiDeviceMode.EXCLUSIVE) {
                        ActivationOutcome.Ready
                    } else {
                        throw InvalidActivationChoice(choice, persistedMode)
                    }
                }
            }
        }
    }

    /** Commit the inspected activation after Android grants protected access. */
    suspend fun commitActivation(
        sourceId: String,
        desiredMode: SourceMultiDeviceMode,
        choice: ActivationChoice? = null,
    ): ActivationOutcome = withActivation(sourceId) { commitActivationRequest(sourceId, desiredMode, choice) }

    private suspend fun commitActivationRequest(
        sourceId: String,
        desiredMode: SourceMultiDeviceMode,
        choice: ActivationChoice?,
    ): ActivationOutcome {
        val identity = pairingIdentity() ?: return ActivationOutcome.Ready
        val client = admin() ?: throw IllegalStateException("not paired")
        val source = client.sources().firstOrNull { it.id == sourceId }
        return MobileSourceActivation.execute(
            source = source,
            deviceId = identity.deviceId,
            desiredMode = desiredMode,
            choice = choice,
            operations = ActivationOperations(
                setMode = { id, mode -> client.patchSource(id, multiDeviceMode = mode) },
                join = { id, deviceId -> joinAfterCleanup(client, id, deviceId) },
                transfer = { id, deviceId -> client.patchSource(id, deviceId = deviceId) },
            ),
        )
    }

    /**
     * Records that this phone stopped contributing to [sourceId] and tells the
     * gateway now, on the holder's own scope so the screen that asked can go
     * away. Nothing is recorded while unpaired: there is no membership to end.
     * Returns the pass carrying the op, or null when nothing was recorded.
     */
    fun stopContributing(sourceId: String): Job? {
        val identity = pairingIdentity() ?: return null
        val op = MembershipOp(
            sourceId,
            identity.deviceId,
            MembershipIntent.DETACH,
            identity.generation,
            identity.gateway,
        )
        val generation = recordIntent(op)
        return scope.launch {
            runQueued(op, generation)
            drainQueue(skip = sourceId)
        }
    }

    /**
     * Records that this phone contributes to [sourceId] again and waits for
     * the gateway to reflect it, including missing-row registration, so the first sync
     * runs against a source that will accept its pages. Supersedes a queued detach
     * the gateway has not seen yet. Never throws: a gateway that could not be
     * reached leaves the intent queued for the next foreground.
     *
     * Only this source's op is awaited; whatever else is queued is carried out
     * on the holder's scope behind it. Returns how the gateway answered, or
     * null while unpaired or when another pass carried the op out first.
     */
    suspend fun resumeContributing(sourceId: String): Outcome? = withActivation(sourceId) { resumeMembership(sourceId) }

    private suspend fun <T> withActivation(sourceId: String, action: suspend () -> T): T =
        if (removalReconciler != null) removalReconciler.activating(sourceId, action) else action()

    private suspend fun resumeMembership(sourceId: String): Outcome? {
        val identity = pairingIdentity() ?: return null
        val op = MembershipOp(
            sourceId,
            identity.deviceId,
            MembershipIntent.RESUME,
            identity.generation,
            identity.gateway,
        )
        val generation = recordIntent(op)
        val outcome = runQueued(op, generation)
        if (outbox.pending().any { it.sourceId != sourceId }) {
            scope.launch { drainQueue(skip = sourceId) }
        }
        return outcome
    }

    /**
     * The opt-in half of a phone-hosted source's switch: this phone's
     * membership is restored first, then [sync] runs — against a source the
     * gateway will by then accept a registration and a page for.
     *
     * The resume is recorded whatever happens next. A sync that declines to
     * run — one already in flight, or a session without a coordinator — must
     * not swallow it: the detach the opt-out queued would still be owed, and
     * the next foreground would carry it out and pause a source whose switch
     * reads on.
     *
     * [sync] runs only once the gateway will accept a page. A pass that half
     * completed — the join landed, unpausing did not — leaves the source
     * paused and stays queued; syncing into it would earn a rejection and tell
     * the user their source is paused a moment after they turned it on. A
     * refused pass means this phone hosts nothing, so there is nothing to
     * sync.
     */
    fun resumeThenSync(sourceId: String, sync: () -> Unit): Job =
        scope.launch {
            when (resumeContributing(sourceId)) {
                // Another pass carried the op out, or the phone is unpaired
                // and `sync` will no-op on its own.
                null -> sync()
                Outcome.Resumed -> sync()
                // Legacy embedders without a registration callback own missing-row setup.
                Outcome.NoRow -> sync()
                else -> Unit
            }
        }

    /**
     * Carries out whatever an earlier pass left queued. Called on every
     * foreground. Returns the pass, or null when nothing was queued.
     */
    fun retryPending(): Job? {
        refreshPending()
        if (outbox.pending().isEmpty()) return null
        return scope.launch { drain() }
    }

    /**
     * Runs every queued op, oldest first. An op recorded under a pairing this
     * phone no longer holds is dropped, not replayed.
     */
    suspend fun drain() = drainQueue(skip = null)

    private suspend fun drainQueue(skip: String?) {
        for (op in outbox.pending()) {
            if (op.sourceId == skip) continue
            runQueued(op)
        }
    }

    /**
     * Carries out one queued op under its own source's lock, and settles it.
     * Returns null when there was nothing left to do — another pass had
     * already carried the op out while this one waited for the lock, or it was
     * recorded under a pairing this phone no longer holds.
     */
    private suspend fun runQueued(op: MembershipOp, generation: Long = intentGeneration(op.sourceId)): Outcome? = lockFor(op.sourceId).withLock {
        if (generation != intentGeneration(op.sourceId)) return@withLock Outcome.Superseded
        if (op !in outbox.pending()) return@withLock null
        val current = pairingIdentity()
        if (current != null &&
            (current.deviceId != op.deviceId ||
                current.gateway != op.gateway ||
                current.generation != op.pairingGeneration)
        ) {
            log("Dropping a queued ${op.intent}: recorded under a previous pairing")
            outbox.clear(op)
            refreshPending()
            return@withLock null
        }
        val outcome = if (op.intent == MembershipIntent.RESUME) withActivation(op.sourceId) { perform(op) } else perform(op)
        synchronized(intentLock) {
            if (generation != intentGeneration(op.sourceId) || (pairingIdentity() != null && op !in currentPending())) {
                return@withLock Outcome.Superseded
            }
            when (outcome) {
                // The cause names the gateway it could not reach; only that it
                // is still owed is said out loud.
                is Outcome.Retry -> log("${op.intent} did not settle and stays queued")
                // The message is the gateway's own, and may quote the source.
                is Outcome.Refused -> {
                    log("${op.intent} refused for good: ${outcome.code}")
                    outbox.clear(op)
                    refreshPending()
                    _refusals.update { it + (op.sourceId to outcome) }
                }
                else -> {
                    log("${op.intent}: $outcome")
                    outbox.clear(op)
                    refreshPending()
                }
            }
            outcome
        }
    }

    /** One op against the gateway, every failure folded into an [Outcome]. */
    suspend fun perform(op: MembershipOp): Outcome {
        val client = admin() ?: return Outcome.Retry(IllegalStateException("not paired"))
        return try {
            when (op.intent) {
                MembershipIntent.DETACH -> detach(client, op)
                MembershipIntent.RESUME -> resume(client, op)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: GatewayException.NotFound) {
            // A concurrent removal must not settle an explicit resume. The next
            // pass can register through its guarded callback after cleanup.
            when (op.intent) {
                MembershipIntent.DETACH -> Outcome.NotAMember
                MembershipIntent.RESUME -> if (registerAbsentSource != null) Outcome.Retry(e) else Outcome.NoRow
            }
        } catch (e: Exception) {
            Outcome.Retry(e)
        }
    }

    private suspend fun detach(client: AdminClient, op: MembershipOp): Outcome =
        try {
            client.detachSourceMember(op.sourceId, op.deviceId)
            Outcome.Detached
        } catch (e: GatewayException.ServerError) {
            when (e.code) {
                CODE_LAST_MEMBER -> {
                    client.patchSource(op.sourceId, enabled = false)
                    Outcome.PausedInstead
                }
                CODE_DEVICE_NOT_MEMBER -> Outcome.NotAMember
                else -> throw e
            }
        }

    private suspend fun resume(client: AdminClient, op: MembershipOp): Outcome {
        val row = client.sources().firstOrNull { it.id == op.sourceId }
        if (row == null) {
            val register = registerAbsentSource ?: return Outcome.NoRow
            register(op, client)
            return Outcome.Resumed
        }
        if (!row.hosts(op.deviceId)) {
            try {
                joinAfterCleanup(client, op.sourceId, op.deviceId)
            } catch (e: GatewayException.ServerError) {
                if (e.code in TERMINAL_JOIN_REFUSALS) return Outcome.Refused(e.code.orEmpty(), e.body.orEmpty())
                throw e
            }
        }
        // Whoever paused the row, the tap that queued this op asked for the
        // source to run; an unpause the phone skipped would leave the switch
        // on over a source that syncs nothing.
        if (!row.enabled) client.patchSource(op.sourceId, enabled = true)
        return Outcome.Resumed
    }

    /**
     * A detach removes the member before its stream cleanup finishes. A quick
     * opt-out/opt-in can therefore find the source row ready while the stream
     * is still fenced. That 409 is transient by contract: wait through the
     * bounded cleanup window instead of turning a valid user action into a
     * generic connection error. Every other refusal remains immediate.
     */
    private suspend fun joinAfterCleanup(client: AdminClient, sourceId: String, deviceId: String) {
        repeat(CLEANUP_JOIN_ATTEMPTS) { attempt ->
            try {
                client.joinSourceMember(sourceId, deviceId)
                return
            } catch (e: GatewayException.ServerError) {
                if (e.code != CODE_STREAM_CLEANUP || attempt == CLEANUP_JOIN_ATTEMPTS - 1) throw e
                delay(CLEANUP_JOIN_RETRY_MILLIS)
            }
        }
    }

    private companion object {
        const val CODE_LAST_MEMBER = "LAST_MEMBER"
        const val CODE_DEVICE_NOT_MEMBER = "DEVICE_NOT_MEMBER"
        const val CODE_STREAM_CLEANUP = "SOURCE_STREAM_CLEANUP_IN_PROGRESS"
        const val CLEANUP_JOIN_ATTEMPTS = 21
        const val CLEANUP_JOIN_RETRY_MILLIS = 250L

        /**
         * Refusals a later pass would earn again: the source's type takes one
         * host at a time, this device's kind does not host the type, or the
         * device is revoked.
         */
        val TERMINAL_JOIN_REFUSALS =
            setOf("SOURCE_ALREADY_HOSTED", "DEVICE_CANNOT_HOST_TYPE", "DEVICE_REVOKED")
    }
}
