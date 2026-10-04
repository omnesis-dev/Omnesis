// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import android.os.Build
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.notes.CaptureOutcome
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notes.VoiceNoteAudio
import dev.omnesis.android.ui.common.classifyGatewayError
import dev.omnesis.android.voice.VoiceNoteSession
import dev.omnesis.android.voice.VoiceNoteSessions
import dev.omnesis.android.voice.audioLevel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Drives the "Tell Omnesis" capture screen, saving via [NotesRepository] — straight
 * to the gateway when reachable, into the durable offline queue otherwise. The surface
 * slug rides in on the nav route so tile / shortcut / in-app launches are
 * distinguishable on the gateway.
 *
 * Two kinds of note:
 *
 * - **Dictated on the phone** (the gateway does not transcribe voice notes): dictation
 *   streams the recognizer's words into the editable text as they are heard.
 * - **Voice note** (it does — [VoiceNoteSessions] starts a recording): the screen shows
 *   the recording, never the words. The recognizer still listens to a copy of the audio,
 *   out of sight, and its transcript goes with the note only to stand in if the gateway
 *   cannot transcribe it. Saving sends the note at once; the gateway's transcript
 *   replaces the text later. Discarding the recording turns the screen into a typed note.
 */
@HiltViewModel
class CaptureViewModel @Inject constructor(
    private val transcriber: SpeechTranscriber,
    private val repository: NotesRepository,
    private val voiceNotes: VoiceNoteSessions,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val surface: String = savedStateHandle.get<String>("surface") ?: CaptureSurface.APP

    private val _state = MutableStateFlow(CaptureUiState())
    val state: StateFlow<CaptureUiState> = _state.asStateFlow()

    /** True while the user wants the mic hot — recognition sessions auto-restart until this drops. */
    private var wantListening = false

    /**
     * Consecutive sessions that ended on a recognizer fault. Faults end a
     * session immediately, so retrying without a bound spins the mic at full
     * speed; past [MAX_CONSECUTIVE_FAULTS] the recognizer is treated as unusable
     * rather than retried forever. Ordinary silence never counts here.
     */
    private var consecutiveFaults = 0

    /** The recording of the voice note this capture is, if it is one. */
    private var voiceNote: VoiceNoteSession? = null

    /** The recognizer's transcript of the voice note: sent with it, never shown. */
    private var hiddenTranscript = ""
    private var hiddenPartial = ""

    /** The recognizer produced words from the recording, so it does take the shared audio. */
    private var recognizerHeardRecording = false

    /** The recognizer cannot run on the recording; the voice note carries on without it. */
    private var recognizerGaveUp = false

    /** The recording was taken from this visit once; later dictation stays on the phone. */
    private var voiceNotesUnusable = false

    /** Called once the RECORD_AUDIO permission state is known (on open, or after the runtime prompt). */
    fun onMicPermission(granted: Boolean) {
        if (!granted) {
            _state.update { it.copy(speech = SpeechState.DENIED) }
            return
        }
        startListening()
    }

    fun startListening() {
        transcriber.setPurpose("dictation")
        if (_state.value.save !is SaveState.Idle) return
        val existing = voiceNote
        if (existing != null) {
            recordMore(existing)
            return
        }
        // A new voice note only on a blank screen: typed words are a typed note.
        val fresh = if (!voiceNotesUnusable && _state.value.textWithPartial().isBlank()) voiceNotes.begin() else null
        if (fresh != null) {
            startVoiceNote(fresh)
            return
        }
        if (!transcriber.isAvailable()) {
            _state.update { it.copy(speech = SpeechState.UNAVAILABLE) }
            return
        }
        wantListening = true
        consecutiveFaults = 0
        // Commit any uncommitted partial first: start() cancels a still-stopping
        // recognizer, so its final result never arrives, and the new session's
        // first partial would otherwise replace the words on screen.
        _state.update { it.copy(text = it.textWithPartial(), partialText = "", speech = SpeechState.LISTENING) }
        transcriber.start(visibleListener)
    }

    fun stopListening() {
        wantListening = false
        val recording = voiceNote
        if (recording != null) {
            recording.pause()
            // The recognizer finishes the words it already has, out of sight.
            if (!recognizerGaveUp) transcriber.stop()
            _state.update {
                it.copy(speech = SpeechState.IDLE, voiceNote = it.voiceNote?.copy(recording = false, level = 0f))
            }
            return
        }
        // The partial stays uncommitted: the recognizer still delivers the
        // utterance's final result after stop(), and onFinal replaces it —
        // committing here would double the words.
        transcriber.stop()
        _state.update { it.copy(speech = it.speech.demotedToIdle()) }
    }

    /**
     * Throws the voice note away and leaves a blank typed note. The recording and its
     * hidden transcript are deleted with it.
     */
    fun discardVoiceNote() {
        val recording = voiceNote ?: return
        wantListening = false
        transcriber.cancel()
        recording.discard()
        voiceNote = null
        resetHiddenTranscript()
        _state.update { it.copy(text = "", partialText = "", speech = SpeechState.IDLE, voiceNote = null) }
    }

    /** Keyboard edits take over: the mic stops so recognition can't fight the user's typing. */
    fun onTextEdited(text: String) {
        // A voice note has no editable text; the screen offers no field while one exists.
        if (voiceNote != null) return
        if (wantListening) {
            wantListening = false
            transcriber.cancel()
        }
        _state.update { it.copy(text = text, partialText = "", speech = it.speech.demotedToIdle()) }
    }

    fun save() {
        val current = _state.value
        if (current.save is SaveState.Saving) return
        val recording = voiceNote
        if (recording != null) {
            saveVoiceNote(recording)
            return
        }
        val text = current.textWithPartial().trim()
        if (text.isEmpty()) return
        if (wantListening) {
            wantListening = false
            // The displayed text (committed + partial) is the note being saved;
            // cancel so a late final result can't mutate it mid-save.
            transcriber.cancel()
        }
        _state.update {
            it.copy(text = text, partialText = "", speech = it.speech.demotedToIdle(), save = SaveState.Saving)
        }
        send(text, null)
    }

    /** Clears a failed save so the note can be edited and retried. */
    fun dismissError() {
        _state.update { it.copy(save = SaveState.Idle) }
    }

    override fun onCleared() {
        wantListening = false
        transcriber.cancel()
        voiceNote?.discard()
        voiceNote = null
    }

    private fun startVoiceNote(recording: VoiceNoteSession) {
        voiceNote = recording
        recording.listener = voiceNoteListener
        resetHiddenTranscript()
        _state.update {
            it.copy(speech = SpeechState.RECORDING, voiceNote = VoiceNoteUi(recording = true, elapsedMs = 0))
        }
        listenSilently()
    }

    private fun recordMore(recording: VoiceNoteSession) {
        if (!recording.resume()) {
            // The microphone could not be reopened: what was recorded can still be saved.
            _state.update { it.copy(speech = SpeechState.IDLE) }
            return
        }
        _state.update { it.copy(speech = SpeechState.RECORDING, voiceNote = it.voiceNote?.copy(recording = true)) }
        listenSilently()
    }

    /** Runs the recognizer on the recording, out of sight, for the stand-in transcript. */
    private fun listenSilently() {
        wantListening = true
        consecutiveFaults = 0
        if (recognizerGaveUp || !transcriber.isAvailable()) {
            recognizerGaveUp = true
            return
        }
        startHiddenSession()
    }

    private fun startHiddenSession() {
        val input = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) voiceNote?.recognizerInput() else null
        if (input == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // Without the shared audio the recognizer would take the microphone from the recording.
            recognizerGaveUp = true
            return
        }
        transcriber.startWithAudio(hiddenListener, input)
    }

    private fun saveVoiceNote(recording: VoiceNoteSession) {
        wantListening = false
        transcriber.cancel()
        val fallback = joinUtterances(hiddenTranscript, hiddenPartial).trim()
        val audio = recording.finish()
        voiceNote = null
        resetHiddenTranscript()
        if (audio == null) {
            _state.update {
                it.copy(speech = SpeechState.IDLE, voiceNote = null, save = SaveState.Failed(NOTHING_RECORDED))
            }
            return
        }
        _state.update {
            it.copy(speech = SpeechState.IDLE, voiceNote = it.voiceNote?.copy(recording = false, level = 0f), save = SaveState.Saving)
        }
        send(fallback, audio)
    }

    private fun send(text: String, audio: VoiceNoteAudio?) {
        viewModelScope.launch {
            try {
                // The repository queues unreachable-gateway and feature-off (404)
                // saves itself; only deterministic per-note rejections throw.
                val outcome = repository.capture(text, surface, audio)
                _state.update { it.copy(save = SaveState.Done(queued = (outcome as? CaptureOutcome.Queued)?.reason)) }
            } catch (e: Exception) {
                _state.update { it.copy(voiceNote = null, save = SaveState.Failed(classifyGatewayError(e))) }
            }
        }
    }

    private fun resetHiddenTranscript() {
        hiddenTranscript = ""
        hiddenPartial = ""
        recognizerHeardRecording = false
        recognizerGaveUp = false
    }

    private companion object {
        /** Transient recognizer faults do happen; a run this long is not transient. */
        const val MAX_CONSECUTIVE_FAULTS = 5
        const val NOTHING_RECORDED = "Nothing was recorded. Tap the mic and try again."
    }

    private val voiceNoteListener = object : VoiceNoteSession.Listener {
        override fun onPeak(peak: Int, elapsedMs: Long) {
            _state.update { s ->
                val note = s.voiceNote?.takeIf { it.recording } ?: return@update s
                s.copy(voiceNote = note.copy(elapsedMs = elapsedMs, level = audioLevel(peak)))
            }
        }

        override fun onLimitReached() = stopListening()

        override fun onLost() {
            // The microphone was taken from the recording (a recognizer that ignored the
            // shared audio). Nothing can reach the gateway, so the phone's transcript
            // becomes the note, editable like any other, and this visit stays on the phone.
            voiceNote = null
            voiceNotesUnusable = true
            wantListening = false
            transcriber.cancel()
            val words = joinUtterances(hiddenTranscript, hiddenPartial)
            resetHiddenTranscript()
            _state.update { it.copy(text = words, partialText = "", speech = SpeechState.IDLE, voiceNote = null) }
        }
    }

    /** The voice note's recognizer: its words stay off screen. */
    private val hiddenListener = object : SpeechTranscriber.Listener {
        override fun onPartial(text: String) {
            recognizerHeardRecording = true
            hiddenPartial = text
        }

        override fun onFinal(text: String) {
            recognizerHeardRecording = true
            hiddenTranscript = joinUtterances(hiddenTranscript, text)
            hiddenPartial = ""
        }

        override fun onEnded(reason: SpeechTranscriber.EndReason) {
            if (voiceNote == null) return
            hiddenTranscript = joinUtterances(hiddenTranscript, hiddenPartial)
            hiddenPartial = ""
            consecutiveFaults = if (reason == SpeechTranscriber.EndReason.FAULT) consecutiveFaults + 1 else 0
            // A recognizer that fails on the shared recording before hearing a word most
            // likely does not take the audio source; one without the language cannot run.
            // The recording does not need it, so it simply stops listening.
            val gaveUp = reason != SpeechTranscriber.EndReason.NORMAL &&
                (reason != SpeechTranscriber.EndReason.FAULT || !recognizerHeardRecording ||
                    consecutiveFaults >= MAX_CONSECUTIVE_FAULTS)
            if (gaveUp) {
                recognizerGaveUp = true
                return
            }
            if (wantListening) startHiddenSession()
        }
    }

    /** The on-device note's recognizer: words stream into the editable text. */
    private val visibleListener = object : SpeechTranscriber.Listener {
        override fun onPartial(text: String) {
            _state.update { it.copy(partialText = text) }
        }

        override fun onFinal(text: String) {
            _state.update { it.copy(text = joinUtterances(it.text, text), partialText = "") }
        }

        override fun onEnded(reason: SpeechTranscriber.EndReason) {
            // A fault streak means the recognizer is not going to recover on its
            // own; any session that ended for another reason proves it still
            // works, so the streak resets.
            consecutiveFaults = if (reason == SpeechTranscriber.EndReason.FAULT) consecutiveFaults + 1 else 0

            val terminal = if (consecutiveFaults >= MAX_CONSECUTIVE_FAULTS) {
                SpeechState.UNAVAILABLE
            } else {
                terminalState(reason)
            }
            if (terminal != null) {
                // None of these clear by retrying, so stop wanting the mic and
                // say what is wrong. Restarting instead would leave the mic
                // visibly hot while every session failed on arrival.
                wantListening = false
                _state.update { it.copy(text = it.textWithPartial(), partialText = "", speech = terminal) }
                return
            }
            // Keep the mic hot across the recognizer's per-utterance sessions
            // until the user stops it, edits, or saves.
            if (wantListening) {
                // A session that ended without a final result (e.g. a recognizer
                // error) leaves its last partial uncommitted; commit it before
                // restarting or the new session's first partial replaces it.
                _state.update { it.copy(text = it.textWithPartial(), partialText = "") }
                transcriber.start(this)
            } else {
                _state.update { it.copy(text = it.textWithPartial(), partialText = "", speech = SpeechState.IDLE) }
            }
        }
    }
}

/** The sticky state a terminal end reason lands on, or null when listening may resume. */
private fun terminalState(reason: SpeechTranscriber.EndReason): SpeechState? = when (reason) {
    // A one-off fault is retried; only a streak of them gives up (see MAX_CONSECUTIVE_FAULTS).
    SpeechTranscriber.EndReason.NORMAL, SpeechTranscriber.EndReason.FAULT -> null
    SpeechTranscriber.EndReason.DENIED -> SpeechState.DENIED
    SpeechTranscriber.EndReason.LANGUAGE_NOT_DOWNLOADED -> SpeechState.LANGUAGE_NOT_DOWNLOADED
    SpeechTranscriber.EndReason.LANGUAGE_NOT_SUPPORTED -> SpeechState.UNAVAILABLE
}

/** Committed text plus the in-flight partial, joined the way the field displays them. */
internal fun CaptureUiState.textWithPartial(): String = joinUtterances(text, partialText)

internal fun joinUtterances(base: String, addition: String): String = when {
    addition.isBlank() -> base
    base.isBlank() -> addition
    else -> "${base.trimEnd()} $addition"
}

/** LISTENING falls back to IDLE; the terminal states stick. */
private fun SpeechState.demotedToIdle(): SpeechState =
    if (this == SpeechState.LISTENING) SpeechState.IDLE else this
