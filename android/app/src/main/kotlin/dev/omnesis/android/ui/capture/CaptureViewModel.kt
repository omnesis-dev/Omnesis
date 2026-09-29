// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.notes.CaptureOutcome
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.ui.common.classifyGatewayError
import dev.omnesis.android.ui.voice.DictationFailureNotice
import dev.omnesis.android.ui.voice.VoiceRecording
import dev.omnesis.android.voice.Endpointing
import dev.omnesis.android.voice.VoiceInput
import dev.omnesis.android.voice.VoiceInputEnd
import dev.omnesis.android.voice.VoiceInputs
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Drives the "Tell Omnesis" capture screen: starts dictation once the mic
 * permission resolves, puts the dictated words into the editable text, and saves
 * via [NotesRepository] — straight to the gateway when reachable, into the durable
 * offline queue otherwise. The surface slug rides in on the nav route so tile /
 * shortcut / in-app launches are distinguishable on the gateway.
 *
 * Dictation runs through [VoiceInputs]: on the phone's recognizer the words stream
 * in while the mic is hot; with gateway dictation the screen records, then waits
 * for the transcript.
 */
@HiltViewModel
class CaptureViewModel @Inject constructor(
    private val voiceInputs: VoiceInputs,
    private val repository: NotesRepository,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val surface: String = savedStateHandle.get<String>("surface") ?: CaptureSurface.APP

    private val _state = MutableStateFlow(CaptureUiState())
    val state: StateFlow<CaptureUiState> = _state.asStateFlow()

    /** The running dictation, or the failed one whose recording awaits a retry. */
    private var voice: VoiceInput? = null

    init {
        voiceInputs.refreshStatus(viewModelScope)
    }

    /** Called once the RECORD_AUDIO permission state is known (on open, or after the runtime prompt). */
    fun onMicPermission(granted: Boolean) {
        if (granted) startListening() else _state.update { it.copy(speech = SpeechState.DENIED) }
    }

    fun startListening() = begin(voiceInputs.preferred(viewModelScope))

    /** After a failed gateway transcription: dictate again on the phone's own recognizer. */
    fun dictateOnDevice() = begin(voiceInputs.onDevice())

    private fun begin(input: VoiceInput) {
        if (_state.value.save !is SaveState.Idle) return
        voice?.cancel()
        voice = null
        if (!input.isAvailable()) {
            _state.update { it.copy(speech = SpeechState.UNAVAILABLE, dictationFailure = null) }
            return
        }
        voice = input
        // Commit any uncommitted partial first: a still-stopping dictation was just
        // cancelled, so its final text never arrives, and the new dictation's first
        // partial would otherwise replace the words on screen.
        _state.update {
            it.copy(
                text = it.textWithPartial(),
                partialText = "",
                speech = SpeechState.LISTENING,
                dictationFailure = null,
            )
        }
        input.start(Endpointing.MANUAL, listenerFor(input))
    }

    /** Ends the dictation; heard words still arrive (a gateway recording goes on to be transcribed). */
    fun stopListening() {
        voice?.stop()
        _state.update { if (it.speech == SpeechState.LISTENING) it.copy(speech = SpeechState.IDLE) else it }
    }

    /**
     * Keyboard edits take over. Live recognition stops so it can't fight the typing;
     * a gateway recording is finished instead, so what was said is still transcribed.
     */
    fun onTextEdited(text: String) {
        when (_state.value.speech) {
            SpeechState.LISTENING -> {
                voice?.cancel()
                voice = null
            }
            SpeechState.RECORDING -> voice?.stop()
            else -> Unit
        }
        _state.update { it.copy(text = text, partialText = "", speech = it.speech.demotedToIdle()) }
    }

    /** Sends the kept recording to the gateway again. */
    fun retryTranscription() {
        if (_state.value.dictationFailure?.canRetry != true) return
        _state.update { it.copy(dictationFailure = null) }
        voice?.retry()
    }

    /** Drops a failed transcription and its recording. */
    fun dismissDictationFailure() {
        abandonVoice()
        _state.update { it.copy(dictationFailure = null) }
    }

    fun save() {
        val current = _state.value
        val text = current.textWithPartial().trim()
        if (text.isEmpty() || current.save is SaveState.Saving) return
        if (current.speech == SpeechState.RECORDING || current.speech == SpeechState.TRANSCRIBING) return
        // The displayed text (committed + partial) is the note being saved; cancel
        // so late dictation results can't mutate it mid-save.
        abandonVoice()
        _state.update {
            it.copy(
                text = text,
                partialText = "",
                speech = it.speech.demotedToIdle(),
                dictationFailure = null,
                save = SaveState.Saving,
            )
        }
        viewModelScope.launch {
            try {
                // The repository queues unreachable-gateway and feature-off (404)
                // saves itself; only deterministic per-note rejections throw.
                val outcome = repository.capture(text, surface)
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

    override fun onCleared() = abandonVoice()

    private fun abandonVoice() {
        voice?.cancel()
        voice = null
    }

    private fun listenerFor(input: VoiceInput) = object : VoiceInput.Listener {
        private fun current() = voice === input

        override fun onPartial(text: String) {
            if (current()) _state.update { it.copy(partialText = text) }
        }

        override fun onText(text: String) {
            if (current()) _state.update { it.copy(text = joinUtterances(it.text, text), partialText = "") }
        }

        override fun onRecording(level: Float, elapsedMs: Long) {
            if (current()) {
                _state.update { it.copy(speech = SpeechState.RECORDING, recording = VoiceRecording(level, elapsedMs)) }
            }
        }

        override fun onTranscribing() {
            if (current()) _state.update { it.copy(speech = SpeechState.TRANSCRIBING, recording = null) }
        }

        override fun onEnded(end: VoiceInputEnd) {
            if (!current()) return
            val failure = (end as? VoiceInputEnd.Failed)?.failure
            // A retryable failure keeps its input, which holds the recording for Retry.
            if (failure?.retryable != true) voice = null
            _state.update {
                it.copy(
                    text = it.textWithPartial(),
                    partialText = "",
                    recording = null,
                    speech = speechAfter(end),
                    dictationFailure = failure?.let { f ->
                        DictationFailureNotice.of(f, voiceInputs.onDeviceAvailable())
                    },
                )
            }
        }
    }
}

/**
 * Where the mic stands once a dictation ended. The language and permission ends
 * cannot clear on their own, so they stick and say what is wrong.
 */
private fun speechAfter(end: VoiceInputEnd): SpeechState = when (end) {
    VoiceInputEnd.Finished, VoiceInputEnd.NoSpeech, VoiceInputEnd.Fault, is VoiceInputEnd.Failed -> SpeechState.IDLE
    VoiceInputEnd.Denied -> SpeechState.DENIED
    VoiceInputEnd.LanguageNotDownloaded -> SpeechState.LANGUAGE_NOT_DOWNLOADED
    VoiceInputEnd.LanguageNotSupported, VoiceInputEnd.Unavailable -> SpeechState.UNAVAILABLE
}

/** Committed text plus the in-flight partial, joined the way the field displays them. */
internal fun CaptureUiState.textWithPartial(): String = joinUtterances(text, partialText)

internal fun joinUtterances(base: String, addition: String): String = when {
    addition.isBlank() -> base
    base.isBlank() -> addition
    else -> "${base.trimEnd()} $addition"
}

/** LISTENING falls back to IDLE; the terminal states stick, and a gateway dictation reports its own progress. */
private fun SpeechState.demotedToIdle(): SpeechState =
    if (this == SpeechState.LISTENING) SpeechState.IDLE else this
