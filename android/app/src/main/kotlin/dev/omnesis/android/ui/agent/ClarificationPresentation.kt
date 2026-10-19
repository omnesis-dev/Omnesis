// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.client.ConversationClarification
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.serialization.json.decodeFromJsonElement

/** Keep canonical narration in history; only the visible question panel replaces its own tail. */
internal fun clarificationPresentation(turn: AgentTurn.Assistant, pendingId: String?): AgentTurn.Assistant {
    if (pendingId == null) return turn
    val questionIndex = turn.parts.indexOfFirst { part ->
        part is AgentPart.Tool && clarificationResult(part.call)?.id == pendingId
    }
    if (questionIndex < 0) return turn
    return turn.copy(parts = turn.parts.filterIndexed { index, part -> index <= questionIndex || part !is AgentPart.Text })
}

internal fun clarificationResult(call: AgentToolCall): ConversationClarification? {
    if (call.tool != "ask_clarification") return null
    val result = call.result as? AgentToolResult.Structured ?: return null
    if (result.resultType != "conversation.clarification") return null
    return runCatching { OmnesisJson.decodeFromJsonElement<ConversationClarification>(result.data) }.getOrNull()
        ?.takeIf { it.id.isNotBlank() && it.question.isNotBlank() && it.choices.size in 2..6 && it.choices.all { choice -> choice.label.isNotBlank() } }
}

internal fun isClarificationResult(call: AgentToolCall): Boolean = clarificationResult(call) != null

/** Expected cancellation is not an actionable failure of an interrupted operation. */
internal fun genuineToolFailure(result: AgentToolResult?): Boolean = when (result) {
    is AgentToolResult.ErrorResult -> result.code !in setOf("turn_aborted", "canceled")
    is AgentToolResult.SearchBatch -> result.items.any(::genuineToolFailure)
    is AgentToolResult.DocumentBatch -> result.items.any(::genuineToolFailure)
    is AgentToolResult.AnnotateBatch -> result.items.any(::genuineToolFailure)
    else -> false
}

internal fun interruptedToolVisible(call: AgentToolCall): Boolean =
    !call.interrupted || genuineToolFailure(call.result) || call.children.any { genuineToolFailure(it.result) }
