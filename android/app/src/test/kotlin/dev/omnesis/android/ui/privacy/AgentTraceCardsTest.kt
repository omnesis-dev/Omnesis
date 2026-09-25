// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import dev.omnesis.android.transport.dto.PrivacyAnswerAgentTrace
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pairing contract for Answer agent-trace tool calls. All fixture data is invented. */
class AgentTraceCardsTest {

    private fun toolUse(id: String, tool: String, query: String = "marathon training plan") =
        buildJsonObject {
            put("kind", JsonPrimitive("tool_use"))
            put("toolCallId", JsonPrimitive(id))
            put("tool", JsonPrimitive(tool))
            put("args", buildJsonObject { put("query", JsonPrimitive(query)) })
        }

    private fun toolResult(id: String, resultType: String = "loops.listed") = buildJsonObject {
        put("kind", JsonPrimitive("tool_result"))
        put("toolCallId", JsonPrimitive(id))
        put(
            "result",
            buildJsonObject {
                put("kind", JsonPrimitive("structured"))
                put("resultType", JsonPrimitive(resultType))
                put("data", buildJsonObject { })
            },
        )
    }

    private fun trace(vararg messages: kotlinx.serialization.json.JsonElement) =
        PrivacyAnswerAgentTrace(
            attempt = 1,
            provider = "example-provider",
            model = "example-model",
            sessionId = "session_example",
            messages = messages.toList(),
        )

    private fun assistantMessage(vararg parts: kotlinx.serialization.json.JsonElement) =
        buildJsonObject {
            put("role", JsonPrimitive("assistant"))
            put("parts", buildJsonArray { parts.forEach { add(it) } })
        }

    @Test
    fun pairsToolUseWithItsResultAcrossMessages() {
        val calls = agentTraceToolCalls(
            trace(
                assistantMessage(toolUse("call_one", "list_loops")),
                assistantMessage(toolResult("call_one")),
            ),
        )
        assertEquals(1, calls.size)
        assertEquals("list_loops", calls.single().tool)
        assertNotNull(calls.single().result)
        assertEquals(
            "list_loops",
            (calls.single().rawPart as kotlinx.serialization.json.JsonObject)["tool"]?.jsonPrimitive?.contentOrNull,
        )
    }

    @Test
    fun keepsEncounterOrderAndSkipsNonToolParts() {
        val text = buildJsonObject {
            put("kind", JsonPrimitive("text"))
            put("text", JsonPrimitive("Let me look that up."))
        }
        val thinking = buildJsonObject {
            put("kind", JsonPrimitive("thinking"))
            put("text", JsonPrimitive("hmm"))
        }
        val calls = agentTraceToolCalls(
            trace(
                assistantMessage(
                    toolUse("call_b", "list_loops"),
                    text,
                    thinking,
                    toolUse("call_a", "search_many"),
                ),
                assistantMessage(toolResult("call_a"), toolResult("call_b")),
            ),
        )
        assertEquals(listOf("list_loops", "search_many"), calls.map { it.tool })
    }

    @Test
    fun resolvedCitationToolsStaySilent() {
        val calls = agentTraceToolCalls(
            trace(
                assistantMessage(
                    toolUse("cite_one", "annotate"),
                    toolUse("cite_two", "cite_record"),
                    toolUse("cite_three", "annotate_many"),
                    toolUse("keep_one", "list_loops"),
                ),
                assistantMessage(
                    toolResult("cite_one", "annotate.recorded"),
                    toolResult("cite_two", "cite_record.recorded"),
                    toolResult("cite_three", "annotate.batch"),
                    toolResult("keep_one"),
                ),
            ),
        )
        assertEquals(listOf("list_loops"), calls.map { it.tool })
    }

    @Test
    fun orphanResultsAreDroppedLikeThePortal() {
        val calls = agentTraceToolCalls(trace(assistantMessage(toolResult("ghost_one"))))
        assertTrue(calls.isEmpty())
    }

    @Test
    fun malformedPartsNeverFailTheAttempt() {
        val calls = agentTraceToolCalls(
            trace(
                assistantMessage(
                    JsonPrimitive("not an object"),
                    buildJsonObject { put("kind", JsonPrimitive("tool_use")) },
                    toolUse("keep_one", "list_loops"),
                ),
                JsonNull,
                buildJsonObject { put("role", JsonPrimitive("assistant")) },
                assistantMessage(toolResult("keep_one")),
            ),
        )
        assertEquals(listOf("list_loops"), calls.map { it.tool })
    }

    @Test
    fun pendingCallsReadNoResultUnderTheirHeader() {
        val cards = agentTraceCards(
            AgentTraceToolCall(
                tool = "lookup_people",
                args = buildJsonObject { put("name", JsonPrimitive("Maya Reeves")) },
                result = null,
                rawPart = buildJsonObject { put("tool", JsonPrimitive("lookup_people")) },
            ),
        )
        assertEquals(1, cards.size)
        assertEquals("Look up people", cards[0].content.label)
        assertTrue(cards[0].content.showsEmpty)
    }

    @Test
    fun headersNameAttemptProviderModelAndStopReason() {
        assertEquals(
            "Attempt 2 · example-provider / example-model",
            agentTraceAttemptHeader(trace().copy(attempt = 2)),
        )
        assertEquals(
            "Attempt 2 · example-provider / example-model · context_window_exceeded",
            agentTraceAttemptHeader(
                trace().copy(attempt = 2, terminalStopReason = "context_window_exceeded"),
            ),
        )
    }

    @Test
    fun truncatedNotesNameTheOmittedCount() {
        assertNull(agentTraceTruncatedNote(trace()))
        assertEquals(
            "1 observable transcript part was omitted from this stored transcript.",
            agentTraceTruncatedNote(trace().copy(truncated = true, omittedParts = 1)),
        )
        assertEquals(
            "3 observable transcript parts were omitted from this stored transcript.",
            agentTraceTruncatedNote(trace().copy(truncated = true, omittedParts = 3)),
        )
        assertEquals(
            "This stored transcript is incomplete; some activity could not be shown.",
            agentTraceTruncatedNote(trace().copy(truncated = true)),
        )
    }
}
