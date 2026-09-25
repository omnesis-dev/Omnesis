// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import dev.omnesis.android.transport.dto.AgentEvent

/** Folds only the watched assistant message from the caller-wide agent event stream. */
data class VoiceAnswerCollector(
    val sessionId: String,
    val messageId: String,
    val text: String = "",
) {
    sealed interface Result {
        data class Continue(val collector: VoiceAnswerCollector) : Result
        data class Answered(val text: String) : Result
        data class Failed(val code: String, val message: String) : Result
    }

    fun consume(event: AgentEvent): Result {
        if (event.sessionId != sessionId) return Result.Continue(this)
        return when (event) {
            is AgentEvent.TextDelta -> if (event.messageId == messageId) {
                Result.Continue(copy(text = text + event.delta))
            } else {
                Result.Continue(this)
            }
            is AgentEvent.MessageEnd -> if (event.messageId == messageId) {
                event.failure?.let { Result.Failed(it.code, it.message) } ?: when (event.stopReason) {
                    "end_turn" -> Result.Answered(text)
                    // Tool iterations share the turn's message id. Only the final end_turn is
                    // authoritative; stopping here would speak an answer before tool results land.
                    "tool_use" -> Result.Continue(this)
                    "canceled" -> Result.Failed("canceled", "The answer was canceled.")
                    "max_tokens" -> Result.Failed(
                        "output_truncated",
                        "The answer was cut off before it completed.",
                    )
                    else -> Result.Failed("agent_error", "The answer could not be completed.")
                }
            } else {
                Result.Continue(this)
            }
            // Presentation-only hint. MessageEnd.failure is the authoritative terminal result.
            is AgentEvent.ErrorEvent -> Result.Continue(this)
            else -> Result.Continue(this)
        }
    }
}
