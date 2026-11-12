// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.AskActivity
import dev.omnesis.android.wearprotocol.AskActivitySnapshot
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.WearLine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface AskState {
    data object Idle : AskState

    data class Asking(val question: String, val ref: String) : AskState

    /**
     * The settled ask. The question is not carried into this state: a screen
     * showing an answer shows only the answer.
     */
    data class Answered(val text: String, val kind: AskOutcome.Kind, val statusTitle: String) : AskState
}

/** The signal that announces an outcome of [kind], so the three stay distinguishable without looking. */
fun hapticFor(kind: AskOutcome.Kind): WatchHaptic = when (kind) {
    AskOutcome.Kind.ANSWER -> WatchHaptic.SUCCESS
    AskOutcome.Kind.STATUS -> WatchHaptic.NOTIFICATION
    AskOutcome.Kind.FAILURE -> WatchHaptic.FAILURE
}

/**
 * Carries one question from its text to its presented answer. The router,
 * not a screen, owns the relay: a relay tied to a screen would be cancelled
 * with it and sent again when the screen came back. A relay is cancelled only
 * when a newer question replaces it.
 */
class AskRouter(
    private val relay: AskRelay,
    private val speaker: Speaker,
    private val haptics: Haptics,
    private val screen: ScreenPresence,
    private val environment: WatchEnvironment,
    private val scope: CoroutineScope,
    /** Ends any recording under way: a submitted question owns the screen. */
    private val cancelCapture: () -> Unit,
) {
    private val _state = MutableStateFlow<AskState>(AskState.Idle)
    val state: StateFlow<AskState> = _state.asStateFlow()

    private val _activity = MutableStateFlow<AskActivitySnapshot?>(null)

    /** The step the phone reports the turn is on. Best effort: null until one arrives. */
    val activity: StateFlow<AskActivitySnapshot?> = _activity.asStateFlow()

    /** The conversation the answer on screen belongs to, which a follow-up resumes. */
    var conversationId: String? = null
        private set

    private var inFlight: Job? = null

    val isAsking: Boolean get() = _state.value is AskState.Asking

    /** A new recording owns the screen. [preserveAnswer] keeps the answer a follow-up continues. */
    fun cancelPending(preserveAnswer: Boolean = false) {
        inFlight?.cancel()
        inFlight = null
        if (!preserveAnswer || _state.value is AskState.Asking) {
            _state.value = AskState.Idle
            conversationId = null
        }
        _activity.value = null
        speaker.stop()
    }

    /** Relay a question entered as text, then show its answer and, when the app is still on screen, read it aloud. */
    fun submit(question: String) {
        cancelCapture()
        val ref = environment.newRef()
        conversationId = null
        _state.value = AskState.Asking(question, ref)
        _activity.value = null
        inFlight?.cancel()
        inFlight = scope.launch {
            val settlement = relay.relay(AskRequest(question, ref)) {
                report(AskActivitySnapshot(AskActivity.wakingPhoneLabel), ref)
            }
            answered(settlement.outcome, settlement.conversationId)
            // The wrist is often down through a long wait, so the result
            // announces itself through the one channel that reaches it.
            haptics.play(hapticFor(settlement.outcome.kind))
            // An answer that lands after the person left the app waits on
            // screen for Speak answer rather than talking from a lowered wrist.
            if (screen.isVisibleAndAwake()) speaker.speak(WearLine.forOutcome(settlement.outcome))
        }
    }

    /** Progress for the question named [ref]. Late progress from a finished turn changes nothing. */
    fun report(activity: AskActivitySnapshot, ref: String?) {
        val asking = _state.value as? AskState.Asking ?: return
        if (ref != asking.ref) return
        _activity.value = activity
    }

    /** Present [outcome], keeping its text ready for Speak answer without speaking it. */
    fun answered(outcome: AskOutcome, conversationId: String? = null) {
        this.conversationId = conversationId
        val text = WearLine.forOutcome(outcome)
        speaker.prepare(text)
        _state.value = AskState.Answered(text, outcome.kind, WearLine.statusTitle(outcome))
        _activity.value = null
    }
}
