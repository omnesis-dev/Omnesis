// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.flow

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** How the flow was opened. */
enum class PhoneSetupEntry {
    /** On its own after pairing: starts at Connected, remembers its position, and records the device as done. */
    FIRST_RUN,

    /** From the "Set up this phone" row in Settings: starts at Choose and records nothing. */
    SETTINGS,

    /** From one source's card in Settings: that source's page alone, then back to Settings. */
    SOURCE,
}

sealed interface PhoneSetupScreen {
    data object Connected : PhoneSetupScreen
    data object Choose : PhoneSetupScreen
    data class Step(val stepId: String) : PhoneSetupScreen
    data object Finish : PhoneSetupScreen
}

data class PhoneSetupState(
    val entry: PhoneSetupEntry,
    val screen: PhoneSetupScreen,
    /** Rows ticked on Choose. */
    val selection: Set<String> = emptySet(),
    /** The steps being walked, in Choose order. */
    val plan: List<String> = emptyList(),
    val outcomes: Map<String, SetupOutcome> = emptyMap(),
    /** Pages the host added to the end of [plan], before Finish, rather than chosen on Choose. */
    val inserted: List<String> = emptyList(),
    /** The flow is done; the host takes the user to where it opened from. */
    val closed: Boolean = false,
) {
    /** Position within [plan] of the current step page, or null off the step pages. */
    val stepIndex: Int? get() = (screen as? PhoneSetupScreen.Step)?.let { plan.indexOf(it.stepId).takeIf { i -> i >= 0 } }

    /** Whether any walked step ended sending data to the gateway. */
    val contributing: Boolean get() = plan.any { outcomes[it]?.kind?.contributing == true }

    /** The first walked step that ended on, whose example question the Finish hint offers. */
    val firstOnStepId: String? get() = plan.firstOrNull { outcomes[it]?.kind == SetupOutcomeKind.ON }

    fun selectedCount(rows: List<SetupRow>): Int = rows.count { it.selectable && it.id in selection }
}

/**
 * The setup flow as a state machine, with no UI in it: which page is showing,
 * what was selected, how each step ended, and when the flow is finished.
 *
 * A first run saves every change for [deviceId], so a killed app reopens at
 * the same page, and finishing or skipping records that device as done. A
 * flow opened from Settings saves nothing. Steps this build does not know
 * ([knownStepIds]) are dropped from a saved position. Pages the host inserted
 * before Finish are never saved: a flow reopened while on one resumes at
 * Finish, and one reopened earlier walks them only if the host inserts them
 * again.
 */
class PhoneSetupFlow(
    private val persisted: PhoneSetupRecord,
    private val deviceId: String?,
    entry: PhoneSetupEntry,
    private val knownStepIds: Set<String>,
    focusStepId: String? = null,
) {
    private val _state = MutableStateFlow(initialState(entry, focusStepId))
    val state: StateFlow<PhoneSetupState> = _state.asStateFlow()

    // A flow opened from Settings keeps no position, so after the process dies it fails closed: it reopens at Settings and completes nothing it was waiting on.
    private val remembersPosition: Boolean = entry == PhoneSetupEntry.FIRST_RUN && !deviceId.isNullOrBlank()

    private fun initialState(entry: PhoneSetupEntry, focusStepId: String?): PhoneSetupState {
        when (entry) {
            PhoneSetupEntry.SETTINGS -> return PhoneSetupState(entry, PhoneSetupScreen.Choose)
            PhoneSetupEntry.SOURCE -> {
                val focus = focusStepId?.takeIf { it in knownStepIds }
                    ?: return PhoneSetupState(entry, PhoneSetupScreen.Choose, closed = true)
                return PhoneSetupState(entry, PhoneSetupScreen.Step(focus), setOf(focus), listOf(focus))
            }
            PhoneSetupEntry.FIRST_RUN -> Unit
        }
        val saved = deviceId?.takeIf { it.isNotBlank() }?.let(persisted::progress)
            ?: return PhoneSetupState(entry, PhoneSetupScreen.Connected)
        val plan = saved.plan.filter { it in knownStepIds }
        val outcomes = saved.outcomes
            .filterKeys { it in knownStepIds }
            .mapNotNull { (id, kind) -> SetupOutcomeKind.fromPersisted(kind)?.restored()?.let { id to it } }
            .toMap()
        val screen = when (saved.screen) {
            SCREEN_CHOOSE -> PhoneSetupScreen.Choose
            SCREEN_STEP -> saved.stepId?.takeIf { it in plan }?.let(PhoneSetupScreen::Step) ?: PhoneSetupScreen.Choose
            SCREEN_FINISH -> if (plan.isEmpty()) PhoneSetupScreen.Choose else PhoneSetupScreen.Finish
            else -> PhoneSetupScreen.Connected
        }
        return PhoneSetupState(entry, screen, saved.selection.filter { it in knownStepIds }.toSet(), plan, outcomes)
    }

    /** Connected → Choose. */
    fun chooseWhatToAdd() = mutate { it.copy(screen = PhoneSetupScreen.Choose) }

    /** Ticks or unticks [row]; rows that are on, disabled or hidden never change. */
    fun toggle(row: SetupRow) = mutate {
        if (!row.selectable) return@mutate it
        it.copy(selection = if (row.id in it.selection) it.selection - row.id else it.selection + row.id)
    }

    /**
     * Choose → the first selected step, walking them in [rows] order. Steps
     * resolved on an earlier pass keep their outcomes. Nothing happens with
     * nothing selected.
     */
    fun setUp(rows: List<SetupRow>) = mutate { state ->
        val chosen = rows.filter { it.selectable && it.id in state.selection }.map { it.id }
        if (chosen.isEmpty()) return@mutate state
        state.copy(plan = chosen + state.inserted, screen = PhoneSetupScreen.Step(chosen.first()))
    }

    /** "Skip for now": the flow closes. */
    fun skipForNow() = close()

    /**
     * Records how [stepId] ended; null makes it unresolved again (a fixed
     * reason, a cleared choice). A skip or a kept device on the current page moves on at once.
     */
    fun record(stepId: String, outcome: SetupOutcome?) {
        mutate { state ->
            state.copy(outcomes = if (outcome == null) state.outcomes - stepId else state.outcomes + (stepId to outcome))
        }
        val current = _state.value.screen
        if (outcome?.kind?.passesOver == true && current is PhoneSetupScreen.Step && current.stepId == stepId) next()
    }

    /** The next step page; after the last, Finish, or back to Settings for a single source. */
    fun next() {
        val state = _state.value
        val index = state.stepIndex ?: return
        val nextId = state.plan.getOrNull(index + 1)
        when {
            nextId != null -> mutate { it.copy(screen = PhoneSetupScreen.Step(nextId)) }
            state.entry == PhoneSetupEntry.SOURCE -> close()
            else -> mutate { it.copy(screen = PhoneSetupScreen.Finish) }
        }
    }

    /**
     * One page back. Returns false at the flow's first page, where the host
     * decides what back means (leaving the app for a first run, returning to
     * Settings otherwise).
     */
    fun back(): Boolean {
        val state = _state.value
        if (state.closed) return false
        val previous: PhoneSetupScreen = when (val screen = state.screen) {
            PhoneSetupScreen.Connected -> return false
            PhoneSetupScreen.Choose -> if (state.entry == PhoneSetupEntry.FIRST_RUN) PhoneSetupScreen.Connected else return false
            is PhoneSetupScreen.Step -> {
                if (state.entry == PhoneSetupEntry.SOURCE) return false
                val index = state.plan.indexOf(screen.stepId)
                if (index > 0) PhoneSetupScreen.Step(state.plan[index - 1]) else PhoneSetupScreen.Choose
            }
            PhoneSetupScreen.Finish -> state.plan.lastOrNull()?.let(PhoneSetupScreen::Step) ?: PhoneSetupScreen.Choose
        }
        mutate { it.copy(screen = previous) }
        return true
    }

    /**
     * Adds [stepId] as the last page before Finish, where the walk will reach
     * it after every chosen step. Nothing changes once Finish is showing, or
     * when the page is already planned.
     */
    fun insertBeforeFinish(stepId: String) = mutate { state ->
        if (stepId in state.inserted || state.screen == PhoneSetupScreen.Finish) {
            state
        } else {
            state.copy(plan = state.plan + stepId, inserted = state.inserted + stepId)
        }
    }

    /**
     * Takes an inserted page out of the walk — answered, or no longer needed.
     * A user on that page moves on to Finish, or back to Settings for a single
     * source.
     */
    fun removeInserted(stepId: String) {
        val state = _state.value
        if (stepId !in state.inserted) return
        val leaving = state.screen == PhoneSetupScreen.Step(stepId)
        mutate {
            it.copy(
                plan = it.plan - stepId,
                inserted = it.inserted - stepId,
                outcomes = it.outcomes - stepId,
                screen = if (leaving && it.entry != PhoneSetupEntry.SOURCE) PhoneSetupScreen.Finish else it.screen,
            )
        }
        if (leaving && state.entry == PhoneSetupEntry.SOURCE) close()
    }

    /** "Start asking" on Finish: the flow closes. */
    fun startAsking() = close()

    private fun close() {
        if (_state.value.closed) return
        if (remembersPosition) persisted.markCompleted(deviceId!!)
        _state.update { it.copy(closed = true) }
    }

    private inline fun mutate(transform: (PhoneSetupState) -> PhoneSetupState) {
        val before = _state.value
        if (before.closed) return
        val after = transform(before)
        if (after == before) return
        _state.value = after
        if (remembersPosition) persisted.saveProgress(after.toProgress(deviceId!!))
    }

    private fun PhoneSetupState.toProgress(device: String): PhoneSetupProgress {
        val onInsertedPage = (screen as? PhoneSetupScreen.Step)?.stepId in inserted
        return PhoneSetupProgress(
            deviceId = device,
            screen = when (screen) {
                PhoneSetupScreen.Connected -> SCREEN_CONNECTED
                PhoneSetupScreen.Choose -> SCREEN_CHOOSE
                is PhoneSetupScreen.Step -> if (onInsertedPage) SCREEN_FINISH else SCREEN_STEP
                PhoneSetupScreen.Finish -> SCREEN_FINISH
            },
            stepId = (screen as? PhoneSetupScreen.Step)?.stepId?.takeUnless { onInsertedPage },
            selection = selection.sorted(),
            plan = plan - inserted.toSet(),
            outcomes = outcomes.filterKeys { it !in inserted }.mapValues { it.value.kind.persisted },
        )
    }

    private companion object {
        const val SCREEN_CONNECTED = "connected"
        const val SCREEN_CHOOSE = "choose"
        const val SCREEN_STEP = "step"
        const val SCREEN_FINISH = "finish"
    }
}
