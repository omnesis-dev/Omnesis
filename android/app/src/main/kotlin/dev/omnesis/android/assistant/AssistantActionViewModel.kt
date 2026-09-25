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
import dev.omnesis.android.ui.capture.SpeechTranscriber
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Owns exactly one foreground App Action request across Activity recreation. */
@HiltViewModel
class AssistantActionViewModel @Inject constructor(
    private val askRunner: VoiceAskRunner,
    private val notes: NotesRepository,
    private val transcriber: SpeechTranscriber,
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
    private var recognitionGeneration = 0L

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
        if (!transcriber.isAvailable()) {
            finish("Speech unavailable", "Type your request in Omnesis instead.", successful = false)
            return
        }
        beginRecognition()
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

    /** A voice action may listen only while its foreground Activity remains visible. */
    fun stopListening() {
        val state = _state.value as? AssistantActionUiState.Listening ?: return
        cancelRecognition()
        finalTranscript = ""
        _state.value = AssistantActionUiState.ReadyToListen(state.kind)
    }

    fun microphoneDenied() {
        if (
            _state.value !is AssistantActionUiState.Listening &&
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

    private fun beginRecognition() {
        val delivery = requestGeneration
        recognitionGeneration++
        val recognition = recognitionGeneration
        transcriber.start(speechListener(delivery, recognition))
    }

    private fun cancelRecognition() {
        recognitionGeneration++
        transcriber.cancel()
    }

    private fun recognitionIsCurrent(delivery: Long, recognition: Long): Boolean =
        delivery == requestGeneration &&
            recognition == recognitionGeneration &&
            _state.value is AssistantActionUiState.Listening

    private fun speechListener(
        delivery: Long,
        recognition: Long,
    ) = object : SpeechTranscriber.Listener {
        override fun onPartial(text: String) {
            if (!recognitionIsCurrent(delivery, recognition)) return
            val kind = request?.kind ?: return
            _state.value = AssistantActionUiState.Listening(
                kind,
                joinSpeech(finalTranscript, text),
                delivery,
            )
        }

        override fun onFinal(text: String) {
            if (!recognitionIsCurrent(delivery, recognition)) return
            finalTranscript = joinSpeech(finalTranscript, text)
        }

        override fun onEnded(reason: SpeechTranscriber.EndReason) {
            if (!recognitionIsCurrent(delivery, recognition)) return
            val current = request ?: return
            when (reason) {
                SpeechTranscriber.EndReason.NORMAL -> {
                    if (finalTranscript.isNotBlank()) execute(current.kind, finalTranscript)
                    else beginRecognition()
                }
                SpeechTranscriber.EndReason.FAULT ->
                    finish("Speech stopped", "Tap the microphone and try again.", successful = false)
                SpeechTranscriber.EndReason.DENIED -> microphoneDenied()
                SpeechTranscriber.EndReason.LANGUAGE_NOT_DOWNLOADED ->
                    finish("Speech model missing", "Install this language in Speech Services by Google.", false)
                SpeechTranscriber.EndReason.LANGUAGE_NOT_SUPPORTED ->
                    finish("Speech unavailable", "This language isn't available for offline dictation.", false)
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
