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
import dev.omnesis.android.ui.common.classifyGatewayError
import dev.omnesis.android.voice.VoiceNoteSession
import dev.omnesis.android.voice.VoiceNoteSessions
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Drives the "Tell Omnesis" capture screen: starts dictation once the mic
 * permission resolves, streams partials into the editable text, and saves via
 * [NotesRepository] — straight to the gateway when reachable, into the durable
 * offline queue otherwise. The surface slug rides in on the nav route so tile /
 * shortcut / in-app launches are distinguishable on the gateway.
 *
 * When the gateway transcribes voice notes, the dictation is also recorded
 * ([VoiceNoteSessions]) and the note is sent with its audio, so the gateway can
 * replace the phone's transcript with its own later. Saving never waits for that.
 * A recognizer that cannot run on the recording (it refuses the shared audio, or
 * has no model for the language) leaves the screen recording audio alone.
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

    /** The recording of this visit's dictation, while the gateway transcribes voice notes. */
    private var voiceNote: VoiceNoteSession? = null

    /** Whether the gateway gate was consulted yet: once per visit, when dictation first starts. */
    private var voiceNoteConsulted = false

    /** Whether the recognizer produced any words from the shared recording yet. */
    private var recognizerHeardRecording = false

    /** The field as dictation left it; null once the keyboard changed it. */
    private var dictatedText: String? = ""

    /** Called once the RECORD_AUDIO permission state is known (on open, or after the runtime prompt). */
    fun onMicPermission(granted: Boolean) {
        if (!granted) {
            _state.update { it.copy(speech = SpeechState.DENIED) }
            return
        }
        startListening()
    }

    fun startListening() {
        if (_state.value.save !is SaveState.Idle) return
        val recording = voiceNoteForThisVisit()
        if (_state.value.voiceNoteOnly || (recording != null && !transcriber.isAvailable())) {
            recordWithoutRecognizer()
            return
        }
        if (!transcriber.isAvailable()) {
            _state.update { it.copy(speech = SpeechState.UNAVAILABLE) }
            return
        }
        recording?.resume()
        wantListening = true
        consecutiveFaults = 0
        // Commit any uncommitted partial first: start() cancels a still-stopping
        // recognizer, so its final result never arrives, and the new session's
        // first partial would otherwise replace the words on screen.
        _state.update { it.copy(text = it.textWithPartial(), partialText = "", speech = SpeechState.LISTENING) }
        startRecognizer()
    }

    fun stopListening() {
        wantListening = false
        voiceNote?.pause()
        if (_state.value.speech == SpeechState.RECORDING) {
            _state.update { it.copy(speech = SpeechState.IDLE) }
            return
        }
        // The partial stays uncommitted: the recognizer still delivers the
        // utterance's final result after stop(), and onFinal replaces it —
        // committing here would double the words.
        transcriber.stop()
        _state.update { it.copy(speech = it.speech.demotedToIdle()) }
    }

    /** Keyboard edits take over: the mic stops so recognition can't fight the user's typing. */
    fun onTextEdited(text: String) {
        if (wantListening) {
            wantListening = false
            transcriber.cancel()
        }
        voiceNote?.pause()
        // The note is no longer what was said: it is saved as typed, without audio.
        dictatedText = null
        _state.update { it.copy(text = text, partialText = "", speech = it.speech.demotedToIdle()) }
    }

    fun save() {
        val current = _state.value
        val text = current.textWithPartial().trim()
        if (current.save is SaveState.Saving) return
        if (text.isEmpty() && !current.voiceNoteOnly) return
        if (wantListening) {
            wantListening = false
            // The displayed text (committed + partial) is the note being saved;
            // cancel so a late final result can't mutate it mid-save.
            transcriber.cancel()
        }
        val recorded = voiceNote?.finish()
        voiceNote = null
        val audio = recorded?.takeIf { attachesVoiceNote(savedText = text, dictatedText = dictatedText) }
        if (recorded != null && audio == null) recorded.file.delete()
        if (text.isEmpty() && audio == null) {
            // The recording is gone; the next tap on the mic asks the gateway gate afresh.
            voiceNoteConsulted = false
            _state.update {
                it.copy(speech = it.speech.demotedToIdle(), voiceNoteOnly = false, save = SaveState.Failed(NOTHING_RECORDED))
            }
            return
        }
        _state.update {
            it.copy(text = text, partialText = "", speech = it.speech.demotedToIdle(), save = SaveState.Saving)
        }
        viewModelScope.launch {
            try {
                // The repository queues unreachable-gateway and feature-off (404)
                // saves itself; only deterministic per-note rejections throw.
                val outcome = repository.capture(text, surface, audio)
                _state.update { it.copy(save = SaveState.Done(queued = (outcome as? CaptureOutcome.Queued)?.reason)) }
            } catch (e: Exception) {
                _state.update { it.copy(save = SaveState.Failed(classifyGatewayError(e))) }
            }
        }
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

    private fun voiceNoteForThisVisit(): VoiceNoteSession? {
        if (!voiceNoteConsulted) {
            voiceNoteConsulted = true
            voiceNote = voiceNotes.begin()?.also { it.listener = voiceNoteListener }
        }
        return voiceNote
    }

    private fun startRecognizer() {
        val input = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) voiceNote?.recognizerInput() else null
        if (input != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            transcriber.startWithAudio(speechListener, input)
        } else {
            transcriber.start(speechListener)
        }
    }

    /**
     * Records for the gateway with no live transcript: the recognizer is missing, refused
     * the shared recording, or has no model for the language. What was typed stays; the
     * note saves with the audio as long as the keyboard has not changed it since.
     */
    private fun recordWithoutRecognizer() {
        val recording = voiceNote ?: return
        wantListening = false
        transcriber.cancel()
        if (!recording.resume()) {
            _state.update { it.copy(speech = SpeechState.UNAVAILABLE, voiceNoteOnly = false) }
            return
        }
        _state.update {
            it.copy(
                text = it.textWithPartial(),
                partialText = "",
                speech = SpeechState.RECORDING,
                voiceNoteOnly = true,
            )
        }
        dictatedText = dictatedText?.let { _state.value.text }
    }

    private fun afterDictation() {
        if (dictatedText != null) dictatedText = _state.value.textWithPartial()
    }

    private companion object {
        /** Transient recognizer faults do happen; a run this long is not transient. */
        const val MAX_CONSECUTIVE_FAULTS = 5
        const val NOTHING_RECORDED = "Nothing was recorded. Tap the mic and try again."
    }

    private val voiceNoteListener = object : VoiceNoteSession.Listener {
        override fun onLimitReached() = stopListening()

        override fun onLost() {
            // The recognizer took the microphone for itself: the note keeps the phone's
            // transcript only, and dictation carries on as usual.
            voiceNote = null
            if (_state.value.voiceNoteOnly) {
                _state.update { it.copy(speech = SpeechState.UNAVAILABLE, voiceNoteOnly = false) }
            }
        }
    }

    private val speechListener = object : SpeechTranscriber.Listener {
        override fun onPartial(text: String) {
            recognizerHeardRecording = true
            _state.update { it.copy(partialText = text) }
            afterDictation()
        }

        override fun onFinal(text: String) {
            recognizerHeardRecording = true
            _state.update { it.copy(text = joinUtterances(it.text, text), partialText = "") }
            afterDictation()
        }

        override fun onEnded(reason: SpeechTranscriber.EndReason) {
            // A fault streak means the recognizer is not going to recover on its
            // own; any session that ended for another reason proves it still
            // works, so the streak resets.
            consecutiveFaults = if (reason == SpeechTranscriber.EndReason.FAULT) consecutiveFaults + 1 else 0

            // A recognizer that fails on the shared recording before hearing a word most
            // likely does not take the audio source; a recognizer that cannot run at all
            // leaves the gateway as the only transcriber. Either way, keep recording.
            val recognizerCannotHelp = consecutiveFaults >= MAX_CONSECUTIVE_FAULTS ||
                reason == SpeechTranscriber.EndReason.LANGUAGE_NOT_DOWNLOADED ||
                reason == SpeechTranscriber.EndReason.LANGUAGE_NOT_SUPPORTED ||
                (reason == SpeechTranscriber.EndReason.FAULT && !recognizerHeardRecording)
            if (voiceNote != null && wantListening && recognizerCannotHelp) {
                _state.update { it.copy(text = it.textWithPartial(), partialText = "") }
                afterDictation()
                recordWithoutRecognizer()
                return
            }

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
                voiceNote?.pause()
                _state.update { it.copy(text = it.textWithPartial(), partialText = "", speech = terminal) }
                afterDictation()
                return
            }
            // Keep the mic hot across the recognizer's per-utterance sessions
            // until the user stops it, edits, or saves.
            if (wantListening) {
                // A session that ended without a final result (e.g. a recognizer
                // error) leaves its last partial uncommitted; commit it before
                // restarting or the new session's first partial replaces it.
                _state.update { it.copy(text = it.textWithPartial(), partialText = "") }
                afterDictation()
                startRecognizer()
            } else {
                _state.update { it.copy(text = it.textWithPartial(), partialText = "", speech = SpeechState.IDLE) }
                afterDictation()
            }
        }
    }
}

/**
 * Whether a note is sent with its audio: only when its text is exactly what dictation
 * produced. A keyboard edit makes the typed text the note — the gateway's transcript
 * would otherwise replace it — so the audio is dropped.
 */
internal fun attachesVoiceNote(savedText: String, dictatedText: String?): Boolean =
    dictatedText != null && savedText.trim() == dictatedText.trim()

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

/** LISTENING and RECORDING fall back to IDLE; the terminal states stick. */
private fun SpeechState.demotedToIdle(): SpeechState =
    if (this == SpeechState.LISTENING || this == SpeechState.RECORDING) SpeechState.IDLE else this
