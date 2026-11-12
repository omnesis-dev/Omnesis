// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.CaptureDismissal
import dev.omnesis.android.wearprotocol.EpochMillis
import dev.omnesis.android.wearprotocol.NoteCaptureTime
import dev.omnesis.android.wearprotocol.OutboxPolicy
import dev.omnesis.android.wearprotocol.TextNote
import dev.omnesis.android.wearprotocol.VoiceRecording
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

sealed interface NoteState {
    data object Idle : NoteState

    /** The note is in the outbox, on its way to the phone. */
    data class Sent(val text: String) : NoteState

    /** The note could not be kept on the watch; its text stays on screen. */
    data class Failed(val text: String) : NoteState
}

/**
 * Carries one note entered as text to the durable outbox. The note counts as
 * sent the moment it is safely there, whatever the link to the phone is
 * doing: the outbox hands it over, and again until the phone confirms it.
 */
class NoteRouter(
    private val store: OutboxStore,
    private val outbox: OutboxEngine,
    private val haptics: Haptics,
    private val environment: WatchEnvironment,
    private val scope: CoroutineScope,
    /** Ends any recording under way: a submitted note owns the screen. */
    private val cancelCapture: () -> Unit,
    /** Confirms the note the way a recorded one is; receives whether something carries it. */
    private val confirm: (carried: Deferred<Boolean>) -> Unit,
) {
    private val _state = MutableStateFlow<NoteState>(NoteState.Idle)
    val state: StateFlow<NoteState> = _state.asStateFlow()

    fun submit(text: String) {
        cancelCapture()
        val captureTime = NoteCaptureTime.at(environment.now(), environment.zone())
        val note = TextNote.of(text, captureTime, environment.newRef())
        try {
            store.add(note)
        } catch (_: IOException) {
            _state.value = NoteState.Failed(text)
            haptics.play(WatchHaptic.FAILURE)
            return
        }
        _state.value = NoteState.Sent(text)
        confirm(scope.async { note.ref in outbox.flush(OutboxPolicy.Trigger.LINK_MAY_HAVE_CHANGED) })
    }
}

sealed interface VoiceNoteState {
    data object Idle : VoiceNoteState

    data class Recording(val startedAt: EpochMillis, val limit: Duration) : VoiceNoteState

    /** The note is in the outbox. [recorded] says the gateway will transcribe it. */
    data class Sent(val recorded: Boolean) : VoiceNoteState

    /** The recording could not be kept. */
    data object Failed : VoiceNoteState

    /** Notes that waited too long for the phone were removed. */
    data class Dropped(val count: Int) : VoiceNoteState
}

/**
 * Records a note for the gateway to transcribe and hands it to the phone.
 * The watch shows no live words: it records, sends, says so, and returns to
 * the note screen. It also owns the confirmation a text note ends on, and the
 * notice about notes the outbox dropped.
 */
class VoiceNoteFlow(
    private val deps: Deps,
    private val scope: CoroutineScope,
) {
    class Deps(
        val recorder: AudioRecorder,
        val permission: MicPermission,
        val store: OutboxStore,
        val outbox: OutboxEngine,
        val haptics: Haptics,
        val environment: WatchEnvironment,
        /** Whether another flow is still using the screen or the speaker. */
        val otherWorkInFlight: () -> Boolean,
        /** Leaves the app for the watch face. */
        val leave: () -> Unit,
    )

    private val _state = MutableStateFlow<VoiceNoteState>(VoiceNoteState.Idle)
    val state: StateFlow<VoiceNoteState> = _state.asStateFlow()

    private var session: AudioRecorder.Session? = null
    private var file: File? = null
    private var recording: VoiceRecording? = null
    private var startGeneration = 0
    private var dismissal: Job? = null

    val isRecording: Boolean get() = _state.value is VoiceNoteState.Recording

    private val isShowingSent: Boolean get() = _state.value is VoiceNoteState.Sent

    /**
     * Start recording. False when the note should be entered as text instead:
     * microphone access was refused, or the microphone could not be opened.
     * A second start while recording is absorbed.
     */
    suspend fun start(limit: Duration): Boolean {
        if (isRecording) return true
        startGeneration += 1
        val current = startGeneration
        val allowed = deps.permission.request()
        if (!allowed || current != startGeneration) return false
        val ref = deps.environment.newRef()
        try {
            val target = deps.store.recordingFile(ref)
            session = deps.recorder.start(target, limit, Listener(ref))
            file = target
        } catch (_: IOException) {
            deps.store.audioFile(ref).delete()
            return false
        }
        recording = VoiceRecording(
            ref = ref,
            captureTime = NoteCaptureTime.at(deps.environment.now(), deps.environment.zone()),
            locale = deps.environment.localeTag(),
        )
        dismissal?.cancel()
        _state.value = VoiceNoteState.Recording(deps.environment.now(), limit)
        deps.haptics.play(WatchHaptic.START)
        return true
    }

    /** Stop and send what was recorded. */
    fun send() {
        if (isRecording) session?.stop()
    }

    /** Stop and throw the recording away. */
    fun cancel() {
        startGeneration += 1
        if (!isRecording) return
        session?.abandon()
        session = null
        file?.delete()
        file = null
        recording = null
        _state.value = VoiceNoteState.Idle
    }

    /** The app is leaving the screen: send what was recorded rather than leave the microphone open behind the watch face. */
    fun appDidEnterBackground() {
        startGeneration += 1
        send()
    }

    /** Tell the person about notes the outbox dropped, when nothing else is on this screen. */
    fun showDroppedIfNeeded() {
        val count = deps.store.droppedCount
        if (count <= 0 || _state.value != VoiceNoteState.Idle) return
        dismissal?.cancel()
        _state.value = VoiceNoteState.Dropped(count)
    }

    fun dismiss() {
        if (isRecording) return
        dismissal?.cancel()
        if (_state.value is VoiceNoteState.Dropped) deps.store.acknowledgeDropped()
        _state.value = VoiceNoteState.Idle
    }

    /** A note entered as text is in the outbox: confirm it the way a recorded one is, and leave the same way. */
    fun textNoteSent(carried: Deferred<Boolean>) {
        deps.haptics.play(WatchHaptic.SUCCESS)
        show(VoiceNoteState.Sent(recorded = false))
        leaveAfterConfirmation(carried)
    }

    private inner class Listener(private val ref: String) : AudioRecorder.Listener {
        override fun onFinished(success: Boolean) {
            val made = recording?.takeIf { it.ref == ref } ?: return
            session = null
            file = null
            recording = null
            // Sent means safely in the outbox, whatever the link is doing.
            val kept = success && try {
                deps.store.add(made)
                true
            } catch (_: IOException) {
                false
            }
            if (!kept) deps.store.audioFile(ref).delete()
            deps.haptics.play(if (kept) WatchHaptic.SUCCESS else WatchHaptic.FAILURE)
            show(if (kept) VoiceNoteState.Sent(recorded = true) else VoiceNoteState.Failed)
            if (kept) {
                leaveAfterConfirmation(
                    scope.async { ref in deps.outbox.flush(OutboxPolicy.Trigger.LINK_MAY_HAVE_CHANGED) },
                )
            }
        }

        /** A call or the assistant taking the microphone ends the recording; what was recorded is sent. */
        override fun onInterrupted() {
            if (recording?.ref == ref) send()
        }
    }

    private fun leaveAfterConfirmation(carried: Deferred<Boolean>) {
        scope.launch {
            delay(CaptureDismissal.CONFIRMATION_DELAY)
            val handedOver = carried.await()
            if (CaptureDismissal.shouldLeave(isShowingSent, handedOver, isRecording || deps.otherWorkInFlight())) {
                deps.leave()
            }
        }
    }

    /** Show a confirmation, and return to the screen under it after a moment. */
    private fun show(confirmation: VoiceNoteState) {
        _state.value = confirmation
        dismissal?.cancel()
        dismissal = scope.launch {
            delay(CONFIRMATION_DURATION)
            if (_state.value == confirmation) _state.value = VoiceNoteState.Idle
        }
    }

    private companion object {
        /** How long the sent or failed confirmation stays before the screen under it returns. */
        val CONFIRMATION_DURATION: Duration = 3.seconds
    }
}
