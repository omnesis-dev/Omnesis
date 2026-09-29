// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.ui.capture.joinUtterances
import dev.omnesis.android.ui.voice.DictationFailureNotice
import dev.omnesis.android.voice.Endpointing
import dev.omnesis.android.voice.VoiceInput
import dev.omnesis.android.voice.VoiceInputEnd
import dev.omnesis.android.voice.VoiceInputs
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update

/**
 * The agent composer's mic. Dictation fills the draft and never sends it: on the
 * phone's recognizer the words appear in the field as they are heard; with gateway
 * dictation the composer shows the recording, then the transcription, and the
 * transcript lands in the field. Sending stays the person's tap.
 *
 * The draft itself belongs to the composer, so finished text is handed over as a
 * [ComposerDictationState.delivery] the composer appends and acknowledges.
 */
@HiltViewModel
class ComposerDictationViewModel @Inject constructor(
    private val voiceInputs: VoiceInputs,
) : ViewModel() {

    private val _state = MutableStateFlow(ComposerDictationState())
    val state: StateFlow<ComposerDictationState> = _state.asStateFlow()

    private var voice: VoiceInput? = null

    /** Text final within the running dictation, not yet delivered to the draft. */
    private var committed = ""
    private var nextDeliveryId = 1L

    init {
        voiceInputs.anyAvailable()
            .onEach { available -> _state.update { it.copy(available = available) } }
            .launchIn(viewModelScope)
        voiceInputs.refreshStatus(viewModelScope)
    }

    /** The mic was tapped with the microphone permission granted. */
    fun toggle() {
        when (_state.value.phase) {
            ComposerDictationPhase.Listening, is ComposerDictationPhase.Recording -> voice?.stop()
            ComposerDictationPhase.Transcribing -> Unit
            ComposerDictationPhase.Idle, is ComposerDictationPhase.Failed -> begin(voiceInputs.preferred(viewModelScope))
        }
    }

    /** [permanently]: Android will not ask again, so only its app settings can grant the mic. */
    fun onMicPermissionDenied(permanently: Boolean) {
        abandon()
        _state.update { it.copy(phase = ComposerDictationPhase.Failed(micOff(openSettings = permanently))) }
    }

    fun retry() {
        val failed = _state.value.phase as? ComposerDictationPhase.Failed ?: return
        if (failed.notice.canRetry) voice?.retry()
    }

    fun dictateOnDevice() = begin(voiceInputs.onDevice())

    fun dismissFailure() {
        abandon()
        _state.update { it.copy(phase = ComposerDictationPhase.Idle) }
    }

    /**
     * The person typed into the draft, which already shows the live words. Live
     * recognition stops so it can't fight the typing; a gateway recording is finished
     * instead, so what was said is still transcribed and appended.
     */
    fun onDraftEdited() {
        when (_state.value.phase) {
            ComposerDictationPhase.Listening -> {
                abandon()
                _state.update { it.copy(phase = ComposerDictationPhase.Idle, liveText = "") }
            }
            is ComposerDictationPhase.Recording -> voice?.stop()
            else -> Unit
        }
    }

    /** The draft, live words included, was sent: nothing of this dictation remains to deliver. */
    fun onSent() {
        if (_state.value.phase == ComposerDictationPhase.Listening) {
            abandon()
            _state.update { it.copy(phase = ComposerDictationPhase.Idle, liveText = "") }
        }
    }

    /**
     * The composer started a fresh draft (a new conversation). Whatever this dictation
     * would have added belongs to the old draft, so it stops and nothing is delivered.
     */
    fun onDraftReplaced() {
        abandon()
        _state.update { it.copy(phase = ComposerDictationPhase.Idle, liveText = "", delivery = null) }
    }

    fun onDeliveryConsumed(id: Long) {
        _state.update { if (it.delivery?.id == id) it.copy(delivery = null) else it }
    }

    override fun onCleared() = abandon()

    private fun begin(input: VoiceInput) {
        abandon()
        if (!input.isAvailable()) {
            _state.update { it.copy(phase = ComposerDictationPhase.Failed(UNAVAILABLE)) }
            return
        }
        voice = input
        _state.update { it.copy(phase = ComposerDictationPhase.Listening, liveText = "") }
        input.start(Endpointing.MANUAL, listenerFor(input))
    }

    private fun abandon() {
        voice?.cancel()
        voice = null
        committed = ""
    }

    private fun listenerFor(input: VoiceInput) = object : VoiceInput.Listener {
        private fun current() = voice === input

        override fun onPartial(text: String) {
            if (current()) _state.update { it.copy(liveText = joinUtterances(committed, text)) }
        }

        override fun onText(text: String) {
            if (!current()) return
            committed = joinUtterances(committed, text)
            _state.update { it.copy(liveText = committed) }
        }

        override fun onRecording(level: Float, elapsedMs: Long) {
            if (current()) _state.update { it.copy(phase = ComposerDictationPhase.Recording(level, elapsedMs)) }
        }

        override fun onTranscribing() {
            if (current()) _state.update { it.copy(phase = ComposerDictationPhase.Transcribing) }
        }

        override fun onEnded(end: VoiceInputEnd) {
            if (!current()) return
            val heard = committed
            committed = ""
            val failure = (end as? VoiceInputEnd.Failed)?.failure
            if (failure?.retryable != true) voice = null
            _state.update {
                it.copy(
                    phase = phaseAfter(end),
                    liveText = "",
                    delivery = if (heard.isNotBlank()) DictationDelivery(nextDeliveryId++, heard) else it.delivery,
                )
            }
        }
    }

    private fun phaseAfter(end: VoiceInputEnd): ComposerDictationPhase = when (end) {
        VoiceInputEnd.Finished, VoiceInputEnd.NoSpeech, VoiceInputEnd.Fault -> ComposerDictationPhase.Idle
        is VoiceInputEnd.Failed ->
            ComposerDictationPhase.Failed(DictationFailureNotice.of(end.failure, voiceInputs.onDeviceAvailable()))
        VoiceInputEnd.Denied -> ComposerDictationPhase.Failed(micOff(openSettings = true))
        VoiceInputEnd.LanguageNotDownloaded -> ComposerDictationPhase.Failed(LANGUAGE_PACK_MISSING)
        VoiceInputEnd.LanguageNotSupported, VoiceInputEnd.Unavailable -> ComposerDictationPhase.Failed(UNAVAILABLE)
    }

    private companion object {
        fun micOff(openSettings: Boolean) = DictationFailureNotice(
            "Microphone access is off.",
            canRetry = false,
            canDictateOnDevice = false,
            canOpenSettings = openSettings,
        )
        val UNAVAILABLE = DictationFailureNotice(
            "Dictation isn't available on this phone.",
            canRetry = false,
            canDictateOnDevice = false,
        )
        val LANGUAGE_PACK_MISSING = DictationFailureNotice(
            "Your language's offline speech pack isn't installed.",
            canRetry = false,
            canDictateOnDevice = false,
        )
    }
}

/** Everything the composer's mic renders. */
@Immutable
data class ComposerDictationState(
    /** Whether the mic is offered at all. */
    val available: Boolean = false,
    val phase: ComposerDictationPhase = ComposerDictationPhase.Idle,
    /** Words of the running on-device dictation, shown after the draft until delivered. */
    val liveText: String = "",
    /** A finished dictation's text for the composer to append to its draft. */
    val delivery: DictationDelivery? = null,
)

sealed interface ComposerDictationPhase {
    data object Idle : ComposerDictationPhase

    /** The phone's recognizer is listening; [ComposerDictationState.liveText] streams. */
    data object Listening : ComposerDictationPhase

    /** Recording for the gateway; [level] is 0–1. */
    data class Recording(val level: Float, val elapsedMs: Long) : ComposerDictationPhase

    data object Transcribing : ComposerDictationPhase

    data class Failed(val notice: DictationFailureNotice) : ComposerDictationPhase
}

/** Dictated text handed to the composer's draft once. */
data class DictationDelivery(val id: Long, val text: String)

/** The composer mic's state and the actions it takes; [NONE] hides the mic. */
@Immutable
data class ComposerDictation(
    val state: ComposerDictationState = ComposerDictationState(),
    /** Tapping the mic; the host asks for the microphone permission first when needed. */
    val onMicTap: () -> Unit = {},
    val onDraftEdited: () -> Unit = {},
    val onSent: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onDictateOnDevice: () -> Unit = {},
    val onDismissFailure: () -> Unit = {},
    val onOpenSettings: () -> Unit = {},
    val onDraftReplaced: () -> Unit = {},
    val onDeliveryConsumed: (Long) -> Unit = {},
) {
    companion object {
        val NONE = ComposerDictation()
    }
}
