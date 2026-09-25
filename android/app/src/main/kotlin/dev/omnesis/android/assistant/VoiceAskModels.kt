// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

/** The terminal result of one Google Assistant/Gemini-launched Omnesis ask. */
sealed interface VoiceAskOutcome {
    data class Answered(val text: String) : VoiceAskOutcome
    data class Failed(val reason: String? = null) : VoiceAskOutcome
    data object EmptyAnswer : VoiceAskOutcome
    data object StillWorking : VoiceAskOutcome
    data object PreviousTurnRunning : VoiceAskOutcome
    data object NotPaired : VoiceAskOutcome
    data object Unauthorized : VoiceAskOutcome
    data object Unreachable : VoiceAskOutcome
    data object SendFailed : VoiceAskOutcome
    data object DeliveryUncertain : VoiceAskOutcome
}

/** One source of truth for the short text shown and spoken by the voice surface. */
object VoiceAskDialog {
    fun text(outcome: VoiceAskOutcome): String = when (outcome) {
        is VoiceAskOutcome.Answered -> outcome.text
        is VoiceAskOutcome.Failed -> spokenFailure(outcome.reason)
        VoiceAskOutcome.EmptyAnswer -> "Omnesis finished, but didn't return an answer."
        VoiceAskOutcome.StillWorking ->
            "Omnesis is still working. Open the conversation in Omnesis to check the answer."
        VoiceAskOutcome.PreviousTurnRunning -> "Omnesis is still answering your previous question."
        VoiceAskOutcome.NotPaired -> "Open Omnesis and pair it with your gateway first."
        VoiceAskOutcome.Unauthorized -> "Omnesis needs to be paired again before it can answer."
        VoiceAskOutcome.Unreachable -> "Omnesis couldn't reach your gateway."
        VoiceAskOutcome.SendFailed -> "Omnesis reached your gateway, but couldn't send the question."
        VoiceAskOutcome.DeliveryUncertain ->
            "The connection dropped while sending. Check the conversation in Omnesis before asking again."
    }

    private const val MAX_SPOKEN_REASON_LENGTH = 160
    private const val UNEXPLAINED_FAILURE =
        "Sorry, something went wrong while answering. Check the conversation in Omnesis."

    internal fun spokenFailure(reason: String?): String {
        val firstLine = reason
            ?.lineSequence()
            ?.firstOrNull()
            ?.trim()
            ?.takeIf { it.isNotEmpty() && it.length <= MAX_SPOKEN_REASON_LENGTH }
            ?: return UNEXPLAINED_FAILURE
        val sentence = if (firstLine.last() in ".!?") firstLine else "$firstLine."
        return "Sorry — $sentence"
    }
}

/** Visible progress states shared by the Activity and its screenshot tests. */
sealed interface AssistantActionUiState {
    data class ReadyToListen(val kind: AssistantActionKind) : AssistantActionUiState
    data class AwaitingMicrophonePermission(
        val kind: AssistantActionKind,
        val deliveryId: Long,
    ) : AssistantActionUiState
    data class Listening(
        val kind: AssistantActionKind,
        val partialText: String = "",
        val deliveryId: Long = 0,
    ) : AssistantActionUiState
    data class Confirming(val kind: AssistantActionKind, val text: String) : AssistantActionUiState
    data class Working(val kind: AssistantActionKind, val text: String) : AssistantActionUiState
    data class Finished(val title: String, val message: String, val successful: Boolean = true) : AssistantActionUiState
}

enum class AssistantActionKind { ASK, CAPTURE }
