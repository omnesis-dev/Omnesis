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
 */
@HiltViewModel
class CaptureViewModel @Inject constructor(
    private val transcriber: SpeechTranscriber,
    private val repository: NotesRepository,
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

    /** Called once the RECORD_AUDIO permission state is known (on open, or after the runtime prompt). */
    fun onMicPermission(granted: Boolean) {
        when {
            !granted -> _state.update { it.copy(speech = SpeechState.DENIED) }
            !transcriber.isAvailable() -> _state.update { it.copy(speech = SpeechState.UNAVAILABLE) }
            else -> startListening()
        }
    }

    fun startListening() {
        if (_state.value.save !is SaveState.Idle) return
        wantListening = true
        consecutiveFaults = 0
        // Commit any uncommitted partial first: start() cancels a still-stopping
        // recognizer, so its final result never arrives, and the new session's
        // first partial would otherwise replace the words on screen.
        _state.update { it.copy(text = it.textWithPartial(), partialText = "", speech = SpeechState.LISTENING) }
        transcriber.start(speechListener)
    }

    fun stopListening() {
        wantListening = false
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
        _state.update { it.copy(text = text, partialText = "", speech = it.speech.demotedToIdle()) }
    }

    fun save() {
        val current = _state.value
        val text = current.textWithPartial().trim()
        if (text.isEmpty() || current.save is SaveState.Saving) return
        if (wantListening) {
            wantListening = false
            // The displayed text (committed + partial) is the note being saved;
            // cancel so a late final result can't mutate it mid-save.
            transcriber.cancel()
        }
        _state.update {
            it.copy(text = text, partialText = "", speech = it.speech.demotedToIdle(), save = SaveState.Saving)
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

    override fun onCleared() {
        wantListening = false
        transcriber.cancel()
    }

    private companion object {
        /** Transient recognizer faults do happen; a run this long is not transient. */
        const val MAX_CONSECUTIVE_FAULTS = 5
    }

    private val speechListener = object : SpeechTranscriber.Listener {
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
