// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentToolResult
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ClarificationPresentationTest {
    @Test fun onlyMatchingVisibleQuestionReplacesItsNarration() {
        val question = AgentPart.Tool(AgentToolCall("tool", "ask_clarification", result =
            AgentToolResult.Structured("conversation.clarification", kotlinx.serialization.json.Json.parseToJsonElement("""{"id":"question","question":"Which period?","choices":[{"label":"Quarter"},{"label":"Year"}]}"""))))
        val error = AgentPart.Tool(AgentToolCall("error", "ask_clarification", result = AgentToolResult.ErrorResult("invalid", "Try again")))
        val turn = AgentTurn.Assistant("answer", listOf(AgentPart.Text("Before"), question, AgentPart.Text("Which period?"), error))
        assertEquals(listOf(AgentPart.Text("Before"), question, error), clarificationPresentation(turn, "question").parts)
        assertEquals(turn, clarificationPresentation(turn, "different"))
        assertEquals(turn, clarificationPresentation(turn, null))
        assertFalse(isClarificationResult(error.call))
        val malformed = question.call.copy(result = AgentToolResult.Structured("conversation.clarification", JsonObject(mapOf("id" to JsonPrimitive("question")))))
        assertFalse(isClarificationResult(malformed))
        assertEquals(turn.copy(parts = listOf(AgentPart.Tool(malformed), AgentPart.Text("Fallback"))),
            clarificationPresentation(turn.copy(parts = listOf(AgentPart.Tool(malformed), AgentPart.Text("Fallback"))), "question"))
    }
}
