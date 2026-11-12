// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.AskActivitySnapshot
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.CaptureButtons
import dev.omnesis.android.wearprotocol.CaptureDismissal
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.NoteCaptureTime
import dev.omnesis.android.wearprotocol.OutboxPolicy
import dev.omnesis.android.wearprotocol.VoiceRecording
import dev.omnesis.android.wearprotocol.WearLine
import dev.omnesis.android.wearprotocol.captureButtons
import dev.omnesis.android.wearprotocol.captureRecordingLimit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException
import kotlin.math.pow
import kotlin.time.Duration.Companion.milliseconds

sealed interface CapturePhase {
    data object Idle : CapturePhase

    /** Reading the gate, asking for the microphone, opening it. */
    data object Preparing : CapturePhase

    data object Recording : CapturePhase

    /** The microphone stopped before a send button was pressed; the recording waits for one. */
    data object Ready : CapturePhase

    /** A send button was pressed and the recording is being closed. */
    data object Saving : CapturePhase

    /** The recording is in the outbox. [route] is what was chosen, then what the phone decided. */
    data class Sent(val route: CaptureRoute) : CapturePhase

    data object Failed : CapturePhase
}

/** The unified recorder as its screen shows it. */
data class CaptureState(
    val phase: CapturePhase = CapturePhase.Idle,
    val buttons: CaptureButtons = CaptureButtons.ASK_AND_TELL,
    /** The recording follows up the answer on screen. */
    val followUp: Boolean = false,
    /** Opened from the tile or a complication rather than from inside the app. */
    val fromSurface: Boolean = false,
    /** The smoothed microphone level, 0 to 1. */
    val level: Float = 0f,
    /** The step the phone reports a sent question is on. */
    val activity: AskActivitySnapshot? = null,
) {
    val isSent: Boolean get() = phase is CapturePhase.Sent

    /** The line under "Got it." for a sent recording. */
    val sentLine: String?
        get() = when ((phase as? CapturePhase.Sent)?.route) {
            CaptureRoute.ASK -> activity?.label ?: WearLine.WAITING_FOR_ANSWER.text
            CaptureRoute.AUTOMATIC -> WearLine.WORKING_OUT_ROUTE.text
            CaptureRoute.NOTE -> WearLine.NOTE_ACCEPTED.text
            null -> null
        }
}

/** Turns microphone power readings into the level the halo follows. */
object CaptureLevel {
    /**
     * The level after a reading of [powerDb]. A soft attack and a slower
     * release keep breath and syllables from making the halo twitch.
     */
    fun next(level: Float, powerDb: Float): Float {
        val target = ((powerDb + FLOOR_DB) / RANGE_DB).coerceIn(0f, 1f).pow(1.5f)
        return level + (target - level) * (if (target > level) ATTACK else RELEASE)
    }

    private const val FLOOR_DB = 55f
    private const val RANGE_DB = 40f
    private const val ATTACK = 0.32f
    private const val RELEASE = 0.14f
}

/**
 * The unified recorder behind the home screen, the tile, the complication
 * and follow-ups: record, then choose what the recording is. Sending always
 * takes a press, even after the time limit, an interruption or leaving the
 * screen stopped the microphone.
 */
class CaptureFlow(
    private val deps: Deps,
    private val scope: CoroutineScope,
) {
    /** What the recorder needs from the device and from the rest of the watch. */
    class Deps(
        val recorder: AudioRecorder,
        val permission: MicPermission,
        val gates: GateStore,
        val store: OutboxStore,
        val outbox: OutboxEngine,
        val haptics: Haptics,
        val environment: WatchEnvironment,
        val ask: AskRouter,
        val screen: ScreenPresence,
        /** Ends whatever else holds the microphone or the screen before a recording starts. */
        val preempt: () -> Unit,
        /** Shows the ask screen, where an answer is presented. */
        val showAsk: () -> Unit,
        /** Whether another flow is still using the screen or the speaker. */
        val otherWorkInFlight: () -> Boolean,
        /** Leaves the app for the watch face. */
        val leave: () -> Unit,
    )

    private val _state = MutableStateFlow(CaptureState())
    val state: StateFlow<CaptureState> = _state.asStateFlow()

    private var session: AudioRecorder.Session? = null
    private var file: File? = null
    private var recording: VoiceRecording? = null
    private var selectedRoute: CaptureRoute? = null
    private var meter: Job? = null
    private var preparing: Job? = null

    /** Bumped whenever the flow starts over, so work begun for an earlier run can tell it is stale. */
    private var generation = 0
    private var sentRef: String? = null
    private var answeredRef: String? = null
    private var carried: Deferred<Boolean>? = null

    private val phase: CapturePhase get() = _state.value.phase

    /** Whether the microphone is open or about to be. */
    val holdsMicrophone: Boolean get() = phase == CapturePhase.Preparing || phase == CapturePhase.Recording

    fun start(followUp: Boolean = false, fromSurface: Boolean = false) {
        if (phase != CapturePhase.Idle && phase != CapturePhase.Failed && !_state.value.isSent) return
        val resume = if (followUp) deps.ask.conversationId else null
        deps.ask.cancelPending(preserveAnswer = followUp)
        deps.preempt()
        reset()
        val current = generation
        _state.value = CaptureState(CapturePhase.Preparing, followUp = followUp, fromSurface = fromSurface)
        preparing = scope.launch { open(current, followUp, resume) }
    }

    private suspend fun open(current: Int, followUp: Boolean, resume: String?) {
        val gate = deps.gates.current()
        if (stale(current)) return
        val buttons = captureButtons(gate, deps.environment.now(), followUp)
        _state.update { it.copy(buttons = buttons) }
        if (buttons == CaptureButtons.UNSUPPORTED) return fail()
        val allowed = deps.permission.request()
        if (stale(current)) return
        if (!allowed) return fail()
        try {
            val ref = deps.environment.newRef()
            val target = deps.store.recordingFile(ref)
            file = target
            recording = VoiceRecording(
                ref = ref,
                captureTime = NoteCaptureTime.at(deps.environment.now(), deps.environment.zone()),
                locale = deps.environment.localeTag(),
                conversationId = resume,
            )
            val limit = captureRecordingLimit(gate, deps.environment.now())
            session = deps.recorder.start(target, limit, Listener(current))
        } catch (_: IOException) {
            discard()
            return fail()
        }
        _state.update { it.copy(phase = CapturePhase.Recording) }
        deps.haptics.play(WatchHaptic.START)
        meter = scope.launch {
            while (isActive) {
                val power = session?.powerDb() ?: SILENCE_DB
                _state.update { it.copy(level = CaptureLevel.next(it.level, power)) }
                delay(METER_INTERVAL)
            }
        }
    }

    private fun stale(current: Int) = current != generation || phase != CapturePhase.Preparing

    private fun fail() {
        _state.update { it.copy(phase = CapturePhase.Failed, level = 0f) }
    }

    /** A send button was pressed. */
    fun send(route: CaptureRoute) {
        when (phase) {
            CapturePhase.Ready -> {
                selectedRoute = route
                persist()
            }
            CapturePhase.Recording -> {
                selectedRoute = route
                _state.update { it.copy(phase = CapturePhase.Saving) }
                session?.stop()
            }
            else -> Unit
        }
    }

    /** The app left the screen, or something else took the microphone: stop recording and wait for a press. */
    fun pause() {
        when (phase) {
            CapturePhase.Preparing -> cancel()
            CapturePhase.Recording -> session?.stop()
            else -> Unit
        }
    }

    /** Throw away whatever is in progress and close the recorder. A recording already sent stays in the outbox. */
    fun cancel() {
        reset()
        _state.value = CaptureState()
    }

    /**
     * Cancel pressed. A recorder opened from the tile or a complication was
     * the whole interaction, so cancelling it leaves the app; one opened from
     * inside the app, and any follow-up, returns to the screen under it.
     */
    fun cancelByUser() {
        val returnToFace = _state.value.fromSurface && !_state.value.followUp
        cancel()
        if (!returnToFace) return
        // Only this unsent recording was discarded. Hand any older waiting
        // notes over before leaving, as the confirmation path does.
        scope.launch { deps.outbox.flush(OutboxPolicy.Trigger.LINK_MAY_HAVE_CHANGED) }
        deps.leave()
    }

    private fun reset() {
        generation += 1
        preparing?.cancel()
        preparing = null
        sentRef = null
        answeredRef = null
        carried = null
        discard()
    }

    /** Close the microphone and delete the recording it was making. */
    private fun discard() {
        releaseMicrophone()
        session?.abandon()
        session = null
        file?.delete()
        file = null
        recording = null
        selectedRoute = null
    }

    private fun releaseMicrophone() {
        meter?.cancel()
        meter = null
    }

    private inner class Listener(private val current: Int) : AudioRecorder.Listener {
        override fun onFinished(success: Boolean) {
            if (current != generation || session == null) return
            releaseMicrophone()
            session = null
            if (!success) {
                discard()
                return fail()
            }
            if (selectedRoute != null) persist() else _state.update { it.copy(phase = CapturePhase.Ready, level = 0f) }
        }

        override fun onInterrupted() {
            if (current == generation) pause()
        }
    }

    private fun persist() {
        val made = recording ?: return
        val route = selectedRoute ?: return
        // A follow-up resumes its conversation only as a question.
        val sent = made.copy(route = route, conversationId = made.conversationId.takeIf { route == CaptureRoute.ASK })
        try {
            deps.store.add(sent)
        } catch (_: IOException) {
            discard()
            fail()
            deps.haptics.play(WatchHaptic.FAILURE)
            return
        }
        // The outbox owns the file now; closing the recorder must not delete it.
        file = null
        recording = null
        selectedRoute = null
        sentRef = sent.ref
        _state.update { it.copy(phase = CapturePhase.Sent(route), level = 0f, activity = null) }
        deps.haptics.play(WatchHaptic.SUCCESS)
        carried = scope.async { sent.ref in deps.outbox.flush(OutboxPolicy.Trigger.LINK_MAY_HAVE_CHANGED) }
        if (route == CaptureRoute.NOTE) leaveAfterConfirmation()
    }

    /** The phone decided what the recording named [ref] is. */
    fun resolved(route: CaptureRoute, ref: String) {
        if (sentRef != ref || !_state.value.isSent) return
        _state.update { it.copy(phase = CapturePhase.Sent(route)) }
        if (route == CaptureRoute.NOTE) {
            // The phone resolving the route proves it has the audio.
            carried = scope.async { true }
            leaveAfterConfirmation()
        }
    }

    /** Progress for the recorded question named [ref]. */
    fun report(activity: AskActivitySnapshot, ref: String?) {
        if (sentRef != ref || !_state.value.isSent) return
        _state.update { it.copy(activity = activity) }
    }

    /**
     * The answer to the recorded question named [ref]: close the recorder and
     * present it on the ask screen, unspoken. Returns whether the person is
     * looking at it. A second copy of the same answer changes nothing.
     */
    fun answered(outcome: AskOutcome, ref: String, conversationId: String? = null): Boolean {
        if (answeredRef == ref) return deps.screen.isVisibleAndAwake()
        if (sentRef != ref || !_state.value.isSent) return false
        cancel()
        answeredRef = ref
        deps.showAsk()
        deps.ask.answered(outcome, conversationId)
        deps.haptics.play(WatchHaptic.NOTIFICATION)
        return deps.screen.isVisibleAndAwake()
    }

    /** Leave for the watch face once the confirmation has been seen, when that is safe. */
    private fun leaveAfterConfirmation() {
        val current = generation
        scope.launch {
            delay(CaptureDismissal.CONFIRMATION_DELAY)
            val handedOver = carried?.await() ?: false
            if (current != generation || phase != CapturePhase.Sent(CaptureRoute.NOTE)) return@launch
            if (CaptureDismissal.shouldLeave(_state.value.isSent, handedOver, deps.otherWorkInFlight())) deps.leave()
        }
    }

    private companion object {
        val METER_INTERVAL = 80.milliseconds
        const val SILENCE_DB = -55f
    }
}
