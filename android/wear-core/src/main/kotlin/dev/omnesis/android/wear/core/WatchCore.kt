// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.AskProgress
import dev.omnesis.android.wearprotocol.AskResult
import dev.omnesis.android.wearprotocol.CaptureAnswer
import dev.omnesis.android.wearprotocol.CaptureDeferred
import dev.omnesis.android.wearprotocol.CaptureLaunchRequests
import dev.omnesis.android.wearprotocol.CaptureRouteUpdate
import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.DisplayedReceipt
import dev.omnesis.android.wearprotocol.NoteAck
import dev.omnesis.android.wearprotocol.OutboxPolicy
import dev.omnesis.android.wearprotocol.RecordingReceipt
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer
import dev.omnesis.android.wearprotocol.recordingLimit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

/** Which flow's screen is under the recorder. */
enum class WatchScreen { ASK, NOTE }

/** What a text entered on the system input screen is for. */
enum class TextInputPurpose { QUESTION, NOTE }

/** Something the logic needs the app's screen to do. */
sealed interface WatchEffect {
    /** Return to the watch face. */
    data object Leave : WatchEffect

    /** Open the system text input, and hand what was entered to [WatchCore.textEntered]. */
    data class RequestTextInput(val purpose: TextInputPurpose) : WatchEffect
}

/** Everything [WatchCore] needs from the device. */
class WatchDevice(
    val link: PhoneLink,
    val recorder: AudioRecorder,
    val permission: MicPermission,
    val speech: SpeechEngine,
    val haptics: Haptics,
    val screen: ScreenPresence,
    val retry: RetryScheduler,
    val environment: WatchEnvironment,
    val log: WatchLog,
    /** A directory that is not backed up, for the outbox and the cached gate. */
    val storage: File,
)

/**
 * The watch app's logic: the ask, note and recorder flows, the outbox, and
 * the routing of what the phone sends. It holds no gateway credential and
 * makes no gateway call; the phone app owns the pairing. Every entry point
 * must be called on the thread [scope] dispatches to.
 */
class WatchCore(device: WatchDevice, private val scope: CoroutineScope) {
    private val environment = device.environment
    private val link = device.link
    private val haptics = device.haptics
    private val log = device.log

    private val _screen = MutableStateFlow(WatchScreen.ASK)
    val screen: StateFlow<WatchScreen> = _screen.asStateFlow()

    private val _effects = MutableSharedFlow<WatchEffect>(extraBufferCapacity = 8)
    val effects: SharedFlow<WatchEffect> = _effects.asSharedFlow()

    private val _launchRequests = MutableStateFlow(0)

    /** Bumped by each request to open the recorder, for the screen to consume once it is up. */
    val launchRequests: StateFlow<Int> = _launchRequests.asStateFlow()
    private val pendingLaunch = CaptureLaunchRequests()

    val store = OutboxStore(File(device.storage, "outbox"), environment::now)
    val gates = GateStore(File(device.storage, "dictation-gate.json"), link)
    val outbox = OutboxEngine(store, link, environment, log, device.retry, scope) {
        voiceNote.showDroppedIfNeeded()
    }
    private val relay = AskRelay(link, environment, log)

    val speaker = Speaker(device.speech) { capture.holdsMicrophone || voiceNote.isRecording }
    val ask = AskRouter(relay, speaker, haptics, device.screen, environment, scope) { capture.cancel() }

    val voiceNote: VoiceNoteFlow = VoiceNoteFlow(
        VoiceNoteFlow.Deps(
            recorder = device.recorder,
            permission = device.permission,
            store = store,
            outbox = outbox,
            haptics = haptics,
            environment = environment,
            otherWorkInFlight = { ask.isAsking || speaker.isSpeaking || capture.state.value.phase != CapturePhase.Idle },
            leave = ::leave,
        ),
        scope,
    )

    val capture: CaptureFlow = CaptureFlow(
        CaptureFlow.Deps(
            recorder = device.recorder,
            permission = device.permission,
            gates = gates,
            store = store,
            outbox = outbox,
            haptics = haptics,
            environment = environment,
            ask = ask,
            screen = device.screen,
            preempt = {
                noteDictation?.cancel()
                voiceNote.cancel()
                voiceNote.dismiss()
            },
            showAsk = { _screen.value = WatchScreen.ASK },
            otherWorkInFlight = { ask.isAsking || speaker.isSpeaking || voiceNote.state.value != VoiceNoteState.Idle },
            leave = ::leave,
        ),
        scope,
    )

    val note = NoteRouter(store, outbox, haptics, environment, scope, { capture.cancel() }, voiceNote::textNoteSent)

    private var noteDictation: Job? = null

    /** The app process started: hand over whatever waited through the last run. */
    fun launched() {
        flushOutbox(OutboxPolicy.Trigger.LINK_MAY_HAVE_CHANGED)
    }

    /** The phone app became reachable, or stopped being so. */
    fun linkChanged() {
        flushOutbox(OutboxPolicy.Trigger.LINK_MAY_HAVE_CHANGED)
    }

    /**
     * A scheduled retry fell due. The pass runs to its end even when the
     * caller stops waiting for it.
     */
    suspend fun retryOutbox() {
        scope.launch { outbox.flush(OutboxPolicy.Trigger.RETRY) }.join()
    }

    private fun flushOutbox(trigger: OutboxPolicy.Trigger) {
        scope.launch { outbox.flush(trigger) }
    }

    /** The app's screen came up: notes the outbox had to drop are told on the next visit. */
    fun screenAppeared() {
        voiceNote.showDroppedIfNeeded()
    }

    /** The app left the screen: nothing keeps talking or listening behind the watch face. */
    fun enteredBackground() {
        noteDictation?.cancel()
        speaker.stop()
        voiceNote.appDidEnterBackground()
        capture.pause()
    }

    /** The tile or a complication asked for the recorder. The request waits for the screen to consume it. */
    fun requestCapture() {
        pendingLaunch.request(environment.now())
        _launchRequests.value += 1
    }

    /** The screen is up: open the recorder for a request made recently enough to still be meant. */
    fun openRequestedCapture() {
        if (pendingLaunch.consume(environment.now())) capture.start(fromSurface = true)
    }

    /**
     * Back, or a swipe away, on whatever covers the ask screen: the topmost
     * thing closes, as its own Cancel or Done would close it.
     */
    fun dismissTop() {
        val recorder = capture.state.value
        when {
            recorder.isSent -> capture.cancel()
            recorder.phase != CapturePhase.Idle -> capture.cancelByUser()
            voiceNote.isRecording -> voiceNote.cancel()
            voiceNote.state.value != VoiceNoteState.Idle -> voiceNote.dismiss()
            else -> _screen.value = WatchScreen.ASK
        }
    }

    /** Ask for a question as text. */
    fun enterQuestion() {
        capture.cancel()
        _screen.value = WatchScreen.ASK
        speaker.stop()
        _effects.tryEmit(WatchEffect.RequestTextInput(TextInputPurpose.QUESTION))
    }

    /** Show the note screen. */
    fun showNotes() {
        capture.cancel()
        _screen.value = WatchScreen.NOTE
    }

    /**
     * Take a new note. While the phone reports that the gateway transcribes
     * voice notes the watch records one; otherwise, and whenever recording
     * cannot start, the note is entered on the system's text input.
     */
    fun dictateNote() {
        if (voiceNote.isRecording || noteDictation?.isActive == true) return
        capture.cancel()
        _screen.value = WatchScreen.NOTE
        // An answer still being read aloud would talk over the dictation.
        speaker.stop()
        noteDictation = scope.launch {
            val limit = gates.current()?.recordingLimit(environment.now())
            if (limit != null && voiceNote.start(limit)) return@launch
            _effects.emit(WatchEffect.RequestTextInput(TextInputPurpose.NOTE))
        }
    }

    /** The system text input returned [text]. Nothing entered leaves the screen as it was. */
    fun textEntered(purpose: TextInputPurpose, text: String?) {
        val entered = text?.trim().orEmpty()
        if (entered.isEmpty()) return
        when (purpose) {
            TextInputPurpose.QUESTION -> {
                _screen.value = WatchScreen.ASK
                ask.submit(entered)
            }
            TextInputPurpose.NOTE -> {
                _screen.value = WatchScreen.NOTE
                note.submit(entered)
            }
        }
    }

    /** The phone published [gate]. */
    fun gatePublished(gate: DictationGate) {
        gates.remember(gate)
    }

    /**
     * Something the phone sent on [path]. Messages are told apart by their
     * kind, not their path. For a request, the returned bytes are the reply.
     */
    fun received(path: String, payload: ByteArray, isRequest: Boolean): ByteArray? {
        when (val message = WearCodec.decode(payload)) {
            is AskProgress -> message.snapshot?.let { snapshot ->
                ask.report(snapshot, message.ref)
                capture.report(snapshot, message.ref)
            }
            // A result without a ref could answer the wrong question; the
            // reply or the timeout settles the wait instead.
            is AskResult -> message.ref?.let { relay.resolve(it, message) }
            is CaptureRouteUpdate -> capture.resolved(message.route, message.ref)
            is CaptureDeferred -> capture.deferred(message.ref)
            is CaptureAnswer -> {
                val displayed = capture.answered(message.toOutcome(), message.ref, message.conversationId)
                val receipt = WearCodec.encode(DisplayedReceipt(displayed, message.ref))
                // Said on its own as well: the phone stops waiting for the reply after a moment.
                if (displayed) scope.launch { link.send(WearDataLayer.DISPLAYED_PATH, receipt) }
                if (isRequest) return receipt
            }
            is RecordingReceipt -> outbox.confirmed(message.ref)
            is NoteAck -> message.ref?.let(outbox::confirmed)
            is DictationGate -> gatePublished(message)
            else -> log.info("Ignored a message on $path")
        }
        return if (isRequest) WearCodec.encode(DisplayedReceipt(displayed = false)) else null
    }

    private fun leave() {
        _effects.tryEmit(WatchEffect.Leave)
    }
}
