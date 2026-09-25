// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.phonesetup

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.RelayConsentActions
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.setup.SetupStatusLine
import dev.omnesis.android.setup.flow.PhoneSetupEntry
import dev.omnesis.android.setup.flow.PhoneSetupFlow
import dev.omnesis.android.setup.flow.PhoneSetupGate
import dev.omnesis.android.setup.flow.PhoneSetupScreen
import dev.omnesis.android.setup.flow.PhoneSetupState
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.flow.SetupRow
import dev.omnesis.android.setup.flow.setupStatusLine
import dev.omnesis.android.transport.SourceSyncStatusReader
import java.net.URI
import javax.inject.Inject
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The navigation argument naming how the flow was opened. */
const val PHONE_SETUP_ENTRY_ARGUMENT = "entry"

/** The navigation argument naming the one step a source's Settings card opens the flow on. */
const val PHONE_SETUP_STEP_ARGUMENT = "step"

/**
 * Runs one showing of the phone setup flow: the engine for the paired device,
 * the rows the phone can offer right now, each source's live sync line, and
 * the presentation gate, held from the moment the showing exists until it
 * closes — through activity recreation — so nothing the shell presents on
 * its own lands on top of it.
 */
@HiltViewModel
class PhoneSetupViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    stepSet: Set<@JvmSuppressWildcards PhoneSetupStep>,
    coordinator: PhoneSetupCoordinator,
    session: SessionManager,
    private val statusReader: SourceSyncStatusReader,
) : ViewModel() {
    val entry: PhoneSetupEntry = savedStateHandle.get<String>(PHONE_SETUP_ENTRY_ARGUMENT)
        ?.let { name -> PhoneSetupEntry.entries.firstOrNull { it.name == name } }
        ?: PhoneSetupEntry.FIRST_RUN

    val steps: List<PhoneSetupStep> = stepSet.sortedBy { it.order }

    private val gate: PhoneSetupGate = coordinator.gate

    private val pairing = session.session?.pairing

    private val relayConsent: RelayConsentActions = session

    /** The gateway's host as the user scanned it. */
    val gatewayHost: String = pairing?.url?.let { url -> runCatching { URI(url).host }.getOrNull() } ?: pairing?.url.orEmpty()

    private val flow = PhoneSetupFlow(
        persisted = coordinator.record,
        deviceId = pairing?.deviceId,
        entry = entry,
        knownStepIds = steps.map { it.id }.toSet() + RELAY_CONSENT_STEP_ID,
        focusStepId = savedStateHandle.get<String>(PHONE_SETUP_STEP_ARGUMENT),
    )
    val state: StateFlow<PhoneSetupState> = flow.state

    private val relaySetup = RelayConsentSetup(flow, relayConsent)

    /** The relay request the inserted "Private notification wakes" page answers, while one is waiting. */
    val relayPrompt: StateFlow<SessionManager.RelayConsentPrompt?> = relayConsent.relayConsentPrompt

    private val _rows = MutableStateFlow(readRows())
    val rows: StateFlow<List<SetupRow>> = _rows.asStateFlow()

    private val _rowsReady = MutableStateFlow(false)

    /** False until the first refresh has read what the phone offers, including what can only be read asynchronously. */
    val rowsReady: StateFlow<Boolean> = _rowsReady.asStateFlow()

    private val _statusLines = MutableStateFlow<Map<String, SetupStatusLine>>(emptyMap())

    /** Each source step's sync line for this device, by step id. */
    val statusLines: StateFlow<Map<String, SetupStatusLine>> = _statusLines.asStateFlow()

    private var refreshing: Job? = null

    /** Parent of the outcome and status collectors. */
    private val watchers = SupervisorJob(viewModelScope.coroutineContext[Job])

    init {
        gate.present(this)
        if (entry == PhoneSetupEntry.FIRST_RUN) {
            // The first run's host is replaced as soon as the device is recorded as done, without clearing this
            // view model, so on closing it lets go of the gate and stops watching.
            viewModelScope.launch {
                flow.state.first { it.closed }
                gate.dismiss(this@PhoneSetupViewModel)
                watchers.cancel()
            }
        }
        observeOutcomes()
        observeStatuses()
        observeRelayConsent()
    }

    /**
     * A flow on the shell's back stack lets go only once its destination is
     * gone: a launch released any earlier would be navigated to on top of the
     * flow, then popped with it.
     */
    override fun onCleared() {
        gate.dismiss(this)
    }

    fun stepById(id: String): PhoneSetupStep? = steps.firstOrNull { it.id == id }

    /**
     * Keeps the relay page in the walk while a request waits and the
     * Notifications row is on. Every return to the foreground re-reads the
     * rows, so notifications turned off or on in system Settings mid-flow drop
     * or add the page without the Notifications page being walked.
     */
    private fun observeRelayConsent() {
        val notificationsId = steps.firstOrNull { it is NotificationsSetupStep }?.id
        viewModelScope.launch(watchers) {
            relaySetup.follow(
                prompts = relayConsent.relayConsentPrompt,
                notificationsOn = rows.map { current -> current.any { it.id == notificationsId && it.on } },
            )
        }
    }

    /**
     * Re-reads what the phone offers — when the flow first shows and on every
     * return to the foreground — lets each resolved step re-derive its outcome
     * from what changed meanwhile in system Settings, and lets the step on
     * screen, still unresolved, read the grant a system screen may have made.
     */
    fun refresh() {
        refreshing?.cancel()
        refreshing = viewModelScope.launch {
            steps.forEach { step ->
                try {
                    step.refresh()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // A step that cannot read the phone keeps its last answer.
                }
            }
            _rows.value = readRows()
            _rowsReady.value = true
            rereadOutcomes(steps, state.value.outcomes).forEach { (id, outcome) -> record(id, outcome) }
            val current = state.value
            (current.screen as? PhoneSetupScreen.Step)?.stepId
                ?.takeIf { it !in current.outcomes }
                ?.let(::stepById)
                ?.resume()
        }
    }

    fun chooseWhatToAdd() = flow.chooseWhatToAdd()

    fun toggle(id: String) {
        _rows.value.firstOrNull { it.id == id }?.let(flow::toggle)
    }

    fun setUp() = flow.setUp(_rows.value)

    fun skip() = flow.skipForNow()

    /** "Not now" on [step]'s page: nothing the user agreed to there stays outstanding, and the flow moves on. */
    fun notNow(step: PhoneSetupStep) {
        step.notNow()
        record(step.id, SetupOutcome.Skipped)
    }

    fun next() = flow.next()

    fun allowRelay() = relaySetup.allow()

    fun declineRelay() = relaySetup.notNow()

    fun back(): Boolean = flow.back()

    fun startAsking() = flow.startAsking()

    private fun record(stepId: String, outcome: SetupOutcome?) {
        flow.record(stepId, outcome)
        _rows.value = readRows()
    }

    private fun readRows(): List<SetupRow> = steps.map { step ->
        SetupRow(step.id, step.group, step.availabilitySafely(), step.isOnSafely())
    }

    /** Every step's enable reports here however its page was left or recreated while it ran. */
    private fun observeOutcomes() {
        steps.forEach { step ->
            viewModelScope.launch(watchers) {
                step.outcomes.collect { outcome -> record(step.id, outcome) }
            }
        }
    }

    private fun observeStatuses() {
        steps.forEach { step ->
            val sourceId = step.sourceId ?: return@forEach
            viewModelScope.launch(watchers) {
                try {
                    statusReader.observe(sourceId).collect { status ->
                        if (status != null) {
                            _statusLines.update { it + (step.id to setupStatusLine(status, step.copy.unit)) }
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // The line keeps its last reading until the next session or resume.
                }
            }
        }
    }
}

/**
 * Each resolved step's outcome as the phone reads it now, for the steps whose
 * reading changed; a null value makes that step unresolved again.
 */
internal suspend fun rereadOutcomes(steps: List<PhoneSetupStep>, outcomes: Map<String, SetupOutcome>): Map<String, SetupOutcome?> {
    val changed = linkedMapOf<String, SetupOutcome?>()
    outcomes.forEach { (id, outcome) ->
        val step = steps.firstOrNull { it.id == id } ?: return@forEach
        val reread = try {
            step.refreshOutcome(outcome)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            outcome
        }
        if (reread != outcome) changed[id] = reread
    }
    return changed
}
