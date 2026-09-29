// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import android.content.Intent
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.notes.CaptureOutcome
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notes.QueueReason
import dev.omnesis.android.ui.capture.CaptureSurface
import dev.omnesis.android.ui.voice.DictationFailureNotice
import dev.omnesis.android.voice.Endpointing
import dev.omnesis.android.voice.VoiceInput
import dev.omnesis.android.voice.VoiceInputEnd
import dev.omnesis.android.voice.VoiceInputs
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Owns exactly one foreground App Action request across Activity recreation. */
@HiltViewModel
class AssistantActionViewModel @Inject constructor(
    private val askRunner: VoiceAskRunner,
    private val notes: NotesRepository,
    private val voiceInputs: VoiceInputs,
    private val savedState: SavedStateHandle,
) : ViewModel() {
    private val _state = MutableStateFlow<AssistantActionUiState>(
        AssistantActionUiState.Listening(AssistantActionKind.ASK),
    )
    val state = _state.asStateFlow()

    private var request: AssistantActionRequest? = null
    private var finalTranscript = ""
    private var deliveredInThisProcess = false
    private var requestGeneration = 0L

    /** The running dictation, or a failed gateway one whose recording awaits a retry. */
    private var voice: VoiceInput? = null

    /** Set when the person chose the phone's recognizer after a gateway failure, for this request. */
    private var dictateOnDevice = false

    /** Whether the Activity is in front; a transcript that lands while it is hidden waits for the person. */
    private var foreground = true

    init {
        voiceInputs.refreshStatus(viewModelScope)
    }

    /** The Activity came to the front or left it. */
    fun onForegroundChanged(visible: Boolean) {
        foreground = visible
    }

    fun handle(intent: Intent, freshDelivery: Boolean, trustedDelivery: Boolean = false) {
        if (!freshDelivery && savedState.get<Boolean>(KEY_HANDLED) == true) {
            if (!deliveredInThisProcess) {
                finish(
                    "Omnesis",
                    "This action was already handled. Start it again to run a new request.",
                    successful = false,
                )
            }
            return
        }
        // Every fresh OS delivery supersedes the prior one, even when malformed. Otherwise a
        // slow valid request can overwrite the visible rejection for a newer invalid intent.
        requestGeneration++
        request = null
        finalTranscript = ""
        dictateOnDevice = false
        cancelRecognition()
        val parsed = AssistantActionRequest.from(intent) ?: run {
            finish("Couldn't start", "That Omnesis action isn't supported.", successful = false)
            return
        }
        request = parsed
        deliveredInThisProcess = true
        savedState[KEY_HANDLED] = true
        parsed.text?.let {
            if (trustedDelivery) execute(parsed.kind, it)
            else _state.value = AssistantActionUiState.Confirming(parsed.kind, it)
        } ?: run {
            _state.value = if (trustedDelivery) {
                AssistantActionUiState.Listening(parsed.kind, deliveryId = requestGeneration)
            } else {
                AssistantActionUiState.ReadyToListen(parsed.kind)
            }
        }
    }

    /** Explicit user boundary for intents from callers Android cannot authenticate. */
    fun confirm() {
        when (val state = _state.value) {
            is AssistantActionUiState.Confirming -> execute(state.kind, state.text)
            is AssistantActionUiState.ReadyToListen -> {
                _state.value = AssistantActionUiState.Listening(
                    state.kind,
                    deliveryId = requestGeneration,
                )
            }
            else -> Unit
        }
    }

    fun startListening() {
        if (request == null || _state.value !is AssistantActionUiState.Listening) return
        val input = if (dictateOnDevice) voiceInputs.onDevice() else voiceInputs.preferred(viewModelScope)
        if (!input.isAvailable()) {
            finish("Speech unavailable", "Type your request in Omnesis instead.", successful = false)
            return
        }
        beginRecognition(input)
    }

    /** The person is done speaking before the silence detector noticed. */
    fun finishRecording() {
        if (_state.value is AssistantActionUiState.Recording) voice?.stop()
    }

    /** Sends the kept recording to the gateway again. */
    fun retryTranscription() {
        val state = _state.value as? AssistantActionUiState.DictationFailed ?: return
        if (!state.notice.canRetry) return
        voice?.retry()
    }

    /** Abandons the failed recording and listens again on the phone's own recognizer. */
    fun dictateOnDevice() {
        val state = _state.value as? AssistantActionUiState.DictationFailed ?: return
        cancelRecognition()
        finalTranscript = ""
        dictateOnDevice = true
        _state.value = AssistantActionUiState.Listening(state.kind, deliveryId = requestGeneration)
    }

    fun awaitMicrophonePermission() {
        val state = _state.value as? AssistantActionUiState.Listening ?: return
        cancelRecognition()
        _state.value = AssistantActionUiState.AwaitingMicrophonePermission(
            state.kind,
            state.deliveryId,
        )
    }

    fun microphonePermissionGranted() {
        val state = _state.value as? AssistantActionUiState.AwaitingMicrophonePermission ?: return
        _state.value = AssistantActionUiState.Listening(state.kind, deliveryId = state.deliveryId)
    }

    /**
     * A voice action may capture audio only while its foreground Activity remains
     * visible. A recording already handed to the gateway is not capture, so its
     * transcription carries on.
     */
    fun stopListening() {
        val kind = when (val state = _state.value) {
            is AssistantActionUiState.Listening -> state.kind
            is AssistantActionUiState.Recording -> state.kind
            else -> return
        }
        cancelRecognition()
        finalTranscript = ""
        _state.value = AssistantActionUiState.ReadyToListen(kind)
    }

    fun microphoneDenied() {
        if (
            _state.value !is AssistantActionUiState.Listening &&
            _state.value !is AssistantActionUiState.Recording &&
            _state.value !is AssistantActionUiState.AwaitingMicrophonePermission
        ) return
        cancelRecognition()
        finish("Microphone is off", "Allow microphone access to use hands-free Omnesis actions.", successful = false)
    }

    private fun execute(kind: AssistantActionKind, rawText: String) {
        val text = rawText.trim()
        if (text.isEmpty()) {
            _state.value = AssistantActionUiState.Listening(kind, deliveryId = requestGeneration)
            return
        }
        cancelRecognition()
        _state.value = AssistantActionUiState.Working(kind, text)
        val generation = requestGeneration
        viewModelScope.launch {
            when (kind) {
                AssistantActionKind.ASK -> {
                    val outcome = askRunner.run(text)
                    finishIfCurrent(
                        generation,
                        title = if (outcome is VoiceAskOutcome.Answered) "Answer from Omnesis" else "Omnesis",
                        message = VoiceAskDialog.text(outcome),
                        successful = outcome is VoiceAskOutcome.Answered || outcome == VoiceAskOutcome.StillWorking,
                    )
                }
                AssistantActionKind.CAPTURE -> runCatching {
                    notes.capture(text, CaptureSurface.ASSISTANT)
                }.fold(
                    onSuccess = { outcome ->
                        val message = when (outcome) {
                            is CaptureOutcome.Posted -> "Saved to Omnesis."
                            is CaptureOutcome.Queued -> queuedCaptureMessage(outcome.reason)
                        }
                        finishIfCurrent(generation, "Note captured", message)
                    },
                    onFailure = { error ->
                        finishIfCurrent(
                            generation,
                            "Couldn't save note",
                            error.message?.takeIf { it.isNotBlank() }
                                ?: "Open Omnesis and try again.",
                            successful = false,
                        )
                    },
                )
            }
        }
    }

    private fun finish(title: String, message: String, successful: Boolean = true) {
        _state.value = AssistantActionUiState.Finished(title, message, successful)
    }

    private fun finishIfCurrent(
        generation: Long,
        title: String,
        message: String,
        successful: Boolean = true,
    ) {
        if (generation == requestGeneration) finish(title, message, successful)
    }

    override fun onCleared() {
        cancelRecognition()
    }

    private fun beginRecognition(input: VoiceInput) {
        voice?.cancel()
        voice = input
        input.start(Endpointing.SPEECH_END, speechListener(requestGeneration, input))
    }

    private fun cancelRecognition() {
        voice?.cancel()
        voice = null
    }

    private fun recognitionIsCurrent(delivery: Long, input: VoiceInput): Boolean =
        delivery == requestGeneration &&
            input === voice &&
            (
                _state.value is AssistantActionUiState.Listening ||
                    _state.value is AssistantActionUiState.Recording ||
                    _state.value is AssistantActionUiState.Transcribing ||
                    _state.value is AssistantActionUiState.DictationFailed
                )

    private fun speechListener(
        delivery: Long,
        input: VoiceInput,
    ) = object : VoiceInput.Listener {
        override fun onPartial(text: String) {
            if (!recognitionIsCurrent(delivery, input)) return
            val kind = request?.kind ?: return
            _state.value = AssistantActionUiState.Listening(
                kind,
                joinSpeech(finalTranscript, text),
                delivery,
            )
        }

        override fun onText(text: String) {
            if (!recognitionIsCurrent(delivery, input)) return
            finalTranscript = joinSpeech(finalTranscript, text)
        }

        override fun onRecording(level: Float, elapsedMs: Long) {
            if (!recognitionIsCurrent(delivery, input)) return
            val kind = request?.kind ?: return
            _state.value = AssistantActionUiState.Recording(kind, level, elapsedMs, delivery)
        }

        override fun onTranscribing() {
            if (!recognitionIsCurrent(delivery, input)) return
            val kind = request?.kind ?: return
            _state.value = AssistantActionUiState.Transcribing(kind)
        }

        override fun onEnded(end: VoiceInputEnd) {
            if (!recognitionIsCurrent(delivery, input)) return
            val current = request ?: return
            if (end !is VoiceInputEnd.Failed || !end.failure.retryable) voice = null
            when (end) {
                VoiceInputEnd.Finished -> when {
                    finalTranscript.isBlank() ->
                        finish("Didn't catch that", "Nothing was heard. Start the action again to retry.", false)
                    // A gateway transcript can arrive after the person switched away. Acting on
                    // it (and speaking the answer) unseen would be a surprise; it waits for them.
                    !foreground -> _state.value = AssistantActionUiState.Confirming(current.kind, finalTranscript.trim())
                    else -> execute(current.kind, finalTranscript)
                }
                VoiceInputEnd.NoSpeech ->
                    finish("Didn't catch that", "Nothing was heard. Start the action again to retry.", false)
                VoiceInputEnd.Fault ->
                    finish("Speech stopped", "Tap the microphone and try again.", successful = false)
                VoiceInputEnd.Denied -> microphoneDenied()
                VoiceInputEnd.LanguageNotDownloaded ->
                    finish("Speech model missing", "Install this language in Speech Services by Google.", false)
                VoiceInputEnd.LanguageNotSupported ->
                    finish("Speech unavailable", "This language isn't available for offline dictation.", false)
                VoiceInputEnd.Unavailable ->
                    finish("Speech unavailable", "Type your request in Omnesis instead.", successful = false)
                is VoiceInputEnd.Failed -> _state.value = AssistantActionUiState.DictationFailed(
                    current.kind,
                    DictationFailureNotice.of(end.failure, voiceInputs.onDeviceAvailable()),
                )
            }
        }
    }

    private companion object {
        const val KEY_HANDLED = "assistant_action_handled"
    }
}

sealed interface AssistantActionRequest {
    val kind: AssistantActionKind
    val text: String?

    data class Ask(override val text: String?) : AssistantActionRequest {
        override val kind = AssistantActionKind.ASK
    }

    data class Capture(override val text: String?) : AssistantActionRequest {
        override val kind = AssistantActionKind.CAPTURE
    }

    companion object {
        fun from(intent: Intent): AssistantActionRequest? = when (intent.action) {
            AssistantActionActivity.ACTION_ASK -> Ask(intent.cleanExtra(AssistantActionActivity.EXTRA_QUESTION))
            AssistantActionActivity.ACTION_CAPTURE -> Capture(intent.cleanExtra(AssistantActionActivity.EXTRA_NOTE))
            AssistantActionActivity.ACTION_OPEN_FEATURE -> when (
                intent.cleanExtra(AssistantActionActivity.EXTRA_FEATURE)?.lowercase()
            ) {
                "ask omnesis", "ask_omnesis", "ask" -> Ask(null)
                "tell omnesis", "tell_brain", "capture", "capture note" -> Capture(null)
                else -> null
            }
            else -> null
        }

        private fun Intent.cleanExtra(key: String): String? =
            getStringExtra(key)?.trim()?.takeIf(String::isNotEmpty)
    }
}

private fun joinSpeech(committed: String, partial: String): String =
    listOf(committed.trim(), partial.trim()).filter(String::isNotEmpty).joinToString(" ")

internal fun queuedCaptureMessage(reason: QueueReason): String = when (reason) {
    QueueReason.UNPAIRED -> "Saved on this phone. Pair Omnesis with your gateway to sync it."
    QueueReason.FEATURE_OFF -> "Saved on this phone. Update your gateway to sync it."
    QueueReason.UNREACHABLE -> "Saved on this phone. It will sync when the gateway is reachable."
    QueueReason.UNAUTHORIZED -> "Saved on this phone. Pair Omnesis again to sync it."
}
