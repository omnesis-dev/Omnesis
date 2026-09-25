// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.flow

import dev.omnesis.android.transport.ActivationChoice
import dev.omnesis.android.transport.ActivationStep
import dev.omnesis.android.transport.SourceMultiDeviceMode
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** The two gateway halves of a phone source's explicit enable, around the OS grant. */
interface SourceEnableActions {
    /** Asks the gateway how this phone would contribute, before Android asks the user anything. */
    suspend fun inspect(choice: ActivationChoice?): ActivationStep

    /** Commits the contribution and turns the source on locally, once Android granted access. */
    suspend fun commit(choice: ActivationChoice?): ActivationStep

    companion object {
        /** For a step with no gateway membership: both halves are ready at once. */
        val Local: SourceEnableActions = object : SourceEnableActions {
            override suspend fun inspect(choice: ActivationChoice?): ActivationStep = ActivationStep.Ready
            override suspend fun commit(choice: ActivationChoice?): ActivationStep = ActivationStep.Ready
        }
    }
}

/** How a step asks Android for access. */
enum class SetupAccessKind {
    /** A system dialog whose answer comes back as a launcher result. */
    DIALOG,

    /** A system screen that gives no result: the answer is read when the app resumes. */
    ROUND_TRIP,
}

/**
 * Remembers, beyond the process, that the user agreed to turn a source on
 * and was sent to a system screen to grant access, and which option they
 * picked if the gateway asked. Only a grant this covers may complete the
 * enable after the app restarted; a grant the user made for any other reason
 * never turns the source on by itself.
 */
interface ExplicitEnableMemory {
    var pending: Boolean

    /** The option the agreement was made with, when the gateway asked for one. */
    var choice: ActivationChoice?
        get() = null
        set(_) = Unit

    companion object {
        val None: ExplicitEnableMemory = object : ExplicitEnableMemory {
            override var pending: Boolean
                get() = false
                set(_) = Unit
        }
    }
}

/** A request for the showing page to open Android's prompt; its [id] tells a page whether it was already launched. */
data class SetupLaunchRequest(val id: String)

/**
 * One step's enable, in order: the gateway inspection, Android's access
 * request, the gateway commit and the local enable, and the outcome read back
 * from the phone. Every answer is folded into a [SetupOutcome]; nothing
 * throws out of it.
 *
 * It belongs to the step for the life of the process, not to a page: the
 * page that asked can be recreated, left and reopened while an enable is
 * under way, and at most one runs at a time. A page launches Android's prompt
 * when [launchRequest] names one no page has launched yet ([launchedRequestId]),
 * and hands the answer back through [onAccessResult] or [onResume].
 */
class SourceEnableSequence(
    private val scope: CoroutineScope,
    private val actions: SourceEnableActions,
    private val isOn: () -> Boolean,
    private val isGranted: suspend () -> Boolean,
    private val outcomeAfterEnable: suspend () -> SetupOutcome,
    private val accessKind: () -> SetupAccessKind = { SetupAccessKind.DIALOG },
    private val unavailable: suspend () -> SetupOutcome.Unavailable? = { null },
    private val memory: ExplicitEnableMemory = ExplicitEnableMemory.None,
    /** The options offered when the gateway asks how this phone should contribute; see [hostedSourceChoices]. */
    private val choiceOptions: (SourceMultiDeviceMode) -> List<SetupChoice> = { emptyList() },
    /**
     * Whether Android already allows everything this enable would ask for, so
     * no prompt or system screen is needed at all. The grant itself by default;
     * a step whose prompt can add to an existing grant narrows it.
     */
    private val grantedWithoutAsking: suspend () -> Boolean = isGranted,
) {
    private enum class Awaiting { DIALOG, ROUND_TRIP, SETTINGS, MORE_ACCESS }

    private val _busy = MutableStateFlow(SetupBusy.IDLE)
    val busy: StateFlow<SetupBusy> = _busy.asStateFlow()

    private val _outcomes = MutableSharedFlow<SetupOutcome?>(extraBufferCapacity = 16)

    /** How each enable ended, as it happens; null makes the step unresolved again. */
    val outcomes: SharedFlow<SetupOutcome?> = _outcomes.asSharedFlow()

    private val _launchRequest = MutableStateFlow<SetupLaunchRequest?>(null)
    val launchRequest: StateFlow<SetupLaunchRequest?> = _launchRequest.asStateFlow()

    /** The last request a page launched; a request with another id is still waiting for a page. */
    @Volatile
    var launchedRequestId: String? = null
        private set

    private var running: Job? = null
    private var awaiting: Awaiting? = null
    private var awaitingChoice: ActivationChoice? = null

    /** The option the latest enable started with, for a grant made after its outcome showed. */
    private var lastChoice: ActivationChoice? = null

    private val working: Boolean get() = running?.isActive == true

    /** Whether an enable is under way: talking to the gateway, or waiting for Android's answer. */
    val inFlight: Boolean
        get() = working || awaiting == Awaiting.DIALOG || awaiting == Awaiting.ROUND_TRIP || awaiting == Awaiting.MORE_ACCESS

    /** Starts the enable, optionally with the user's answer to an earlier [SetupOutcome.ChoiceRequired]. */
    fun start(choice: ActivationChoice? = null) {
        if (inFlight) return
        awaiting = null
        lastChoice = choice
        memory.pending = true
        memory.choice = choice
        work {
            when (val inspected = actions.inspect(choice)) {
                ActivationStep.Ready -> requestAccess(choice)
                ActivationStep.KeptOther -> finish(SetupOutcome.KeptOther)
                is ActivationStep.ChoiceRequired -> finish(SetupOutcome.ChoiceRequired(choiceOptions(inspected.mode)))
                is ActivationStep.Failed -> finish(SetupOutcome.Failed(inspected.message))
            }
        }
    }

    /** Continues with the option the user picked from [SetupOutcome.ChoiceRequired]. */
    fun choose(option: SetupChoice) {
        ActivationChoice.entries.firstOrNull { it.name == option.id }?.let(::start)
    }

    /** A page marks the request it opened Android's prompt for, so no other page opens it again. */
    fun markLaunched(id: String) {
        launchedRequestId = id
    }

    /**
     * "Try again": the enable runs once more while the failed outcome stays
     * on screen, and its result replaces it. A request no page answered is
     * dropped first.
     */
    fun retry() {
        if (working) return
        dropUnanswered()
        start(lastChoice)
    }

    /** The user declined the page: nothing they agreed to is outstanding any more, answered or not. */
    fun notNow() {
        if (working) return
        dropUnanswered()
        lastChoice = null
        memory.pending = false
        memory.choice = null
    }

    /**
     * The page showing this step left composition. An agreement with nothing
     * under way — no gateway call, no prompt or system screen out — is
     * dropped, so a grant made later for another reason cannot complete it.
     */
    fun onPageLeft() {
        if (!working) {
            // A Settings trip from a page that is gone is no longer continued on return.
            if (awaiting == Awaiting.SETTINGS) awaiting = null
            lastChoice = null
        }
        if (inFlight) return
        memory.pending = false
        memory.choice = null
    }

    /**
     * The phone unpaired or started re-pairing: whatever is under way is
     * cancelled and nothing the user agreed to on this page survives.
     */
    fun reset() {
        running?.cancel()
        running = null
        dropUnanswered()
        lastChoice = null
        launchedRequestId = null
        memory.pending = false
        memory.choice = null
    }

    /** Publishes an outcome the step read by other means, such as availability after an install. */
    fun report(outcome: SetupOutcome?) {
        _outcomes.tryEmit(outcome)
    }

    /** Asks Android for more of the access the source already has (a larger photo selection). */
    fun requestMoreAccess() {
        if (inFlight) return
        awaiting = Awaiting.MORE_ACCESS
        _busy.value = SetupBusy.WAITING_FOR_SYSTEM
        requestLaunch()
    }

    /** The page is sending the user to system Settings; the next resume re-reads the grant. */
    fun settingsOpened() {
        if (!inFlight) awaiting = Awaiting.SETTINGS
    }

    /** The system screen the page tried to open does not exist on this phone. */
    fun onLaunchFailed() {
        when (awaiting) {
            Awaiting.SETTINGS -> awaiting = null
            null -> Unit
            else -> finish(SetupOutcome.Failed(null))
        }
    }

    /**
     * Android answered a dialog. A grant that arrives with nothing waiting —
     * the page that asked was recreated, or the app restarted while the dialog
     * was up — still completes the enable the user started, with the option
     * they picked.
     */
    fun onAccessResult(granted: Boolean) {
        if (working) return
        when (awaiting) {
            Awaiting.MORE_ACCESS -> {
                awaiting = null
                work { finish(outcomeAfterEnable()) }
            }
            Awaiting.DIALOG, Awaiting.ROUND_TRIP -> {
                val choice = awaitingChoice
                awaiting = null
                if (granted) work { commit(choice) } else finish(SetupOutcome.NotAllowed)
            }
            Awaiting.SETTINGS, null -> if (granted && !isOn()) {
                val choice = memory.choice
                work { commit(choice) }
            }
        }
    }

    /**
     * The app came back to the foreground. A system screen this enable opened
     * is read now; after a restart, only a round trip the user agreed to may
     * complete from the grant it finds, with the option they picked.
     */
    fun onResume() {
        if (working) return
        when (awaiting) {
            Awaiting.ROUND_TRIP -> {
                val choice = awaitingChoice
                awaiting = null
                work { if (isGranted()) commit(choice) else finish(SetupOutcome.NotAllowed) }
            }
            Awaiting.SETTINGS -> {
                awaiting = null
                val choice = lastChoice
                work {
                    if (!isGranted()) return@work
                    if (isOn()) finish(outcomeAfterEnable()) else commit(choice)
                }
            }
            Awaiting.DIALOG, Awaiting.MORE_ACCESS -> Unit
            null -> if (memory.pending && accessKind() == SetupAccessKind.ROUND_TRIP && !isOn()) {
                val choice = memory.choice
                work { if (isGranted()) commit(choice) }
            }
        }
    }

    private suspend fun requestAccess(choice: ActivationChoice?) {
        unavailable()?.let {
            finish(it)
            return
        }
        // Already allowed: straight to the commit, never through a prompt or its wait.
        if (grantedWithoutAsking()) {
            commit(choice)
            return
        }
        val kind = accessKind()
        awaitingChoice = choice
        memory.choice = choice
        awaiting = if (kind == SetupAccessKind.DIALOG) Awaiting.DIALOG else Awaiting.ROUND_TRIP
        _busy.value = SetupBusy.WAITING_FOR_SYSTEM
        requestLaunch()
    }

    private fun requestLaunch() {
        _launchRequest.value = SetupLaunchRequest(UUID.randomUUID().toString())
    }

    /** Forgets a prompt or system screen that was asked for, answered or not. */
    private fun dropUnanswered() {
        awaiting = null
        awaitingChoice = null
        _launchRequest.value = null
        _busy.value = SetupBusy.IDLE
    }

    private suspend fun commit(choice: ActivationChoice?) {
        _busy.value = SetupBusy.WORKING
        when (val committed = actions.commit(choice)) {
            ActivationStep.Ready -> finish(outcomeAfterEnable())
            ActivationStep.KeptOther -> finish(SetupOutcome.KeptOther)
            // The gateway's decision changed while Android was asked: the user picks again.
            is ActivationStep.ChoiceRequired -> finish(SetupOutcome.ChoiceRequired(choiceOptions(committed.mode)))
            is ActivationStep.Failed -> finish(SetupOutcome.Failed(committed.message))
        }
    }

    private fun finish(outcome: SetupOutcome) {
        memory.pending = false
        memory.choice = null
        awaiting = null
        awaitingChoice = null
        _busy.value = SetupBusy.IDLE
        _outcomes.tryEmit(outcome)
    }

    /** Runs [block] as the one piece of work under way, never leaving the page busy when it ends. */
    private fun work(block: suspend () -> Unit) {
        _busy.value = SetupBusy.WORKING
        running = scope.launch {
            try {
                block()
                if (awaiting == null && _busy.value == SetupBusy.WORKING) _busy.value = SetupBusy.IDLE
            } catch (e: CancellationException) {
                if (awaiting == null) _busy.value = SetupBusy.IDLE
                throw e
            } catch (_: Exception) {
                finish(SetupOutcome.Failed(null))
            }
        }
    }
}

/**
 * The ways a phone-hosted source named [sourceName] can contribute when
 * another device already sends it. Keeping the other device is always
 * offered, and so is moving the source to this phone; sharing it is offered
 * only where the gateway lets several phones contribute to one source.
 */
fun hostedSourceChoices(sourceName: String): (SourceMultiDeviceMode) -> List<SetupChoice> = { mode ->
    buildList {
        add(
            SetupChoice(
                ActivationChoice.KEEP_OTHER.name,
                "Keep using the other device",
                "Nothing changes, and this phone will not ask for access.",
            ),
        )
        if (mode == SourceMultiDeviceMode.REPLICATED) {
            add(
                SetupChoice(
                    ActivationChoice.USE_BOTH.name,
                    "Use both phones",
                    "Both phones contribute for better continuity when one is offline.",
                ),
            )
        }
        add(
            SetupChoice(
                ActivationChoice.TAKE_OVER.name,
                "Use only this phone",
                "Moves $sourceName to this phone, and the other device stops contributing.",
            ),
        )
    }
}
