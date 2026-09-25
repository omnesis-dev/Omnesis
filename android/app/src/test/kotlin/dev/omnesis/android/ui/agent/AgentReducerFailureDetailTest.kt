// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentProviderFailureDetail
import dev.omnesis.android.transport.dto.AgentTerminalFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A failed turn keeps its three pieces apart: the humanized sentence, the failure code, and
 * the provider's disposition. The code must never be spliced into the prose — the transcript
 * prints it on its own quiet line, and a gateway that reports no provider detail must still
 * produce a readable failure. All fixture data is invented (privacy rule).
 */
class AgentReducerFailureDetailTest {

    private fun startedTurn(): AgentChatState =
        AgentReducer.reduce(
            AgentChatState(),
            AgentEvent.MessageStart(sessionId = "s1", messageId = "m1"),
        )

    private fun lastAssistant(state: AgentChatState) = state.turns.last() as AgentTurn.Assistant

    @Test
    fun error_event_keeps_the_code_out_of_the_sentence() {
        val message = "The model provider does not have the assigned model — check the model " +
            "assignment (HTTP 404)."
        val state = AgentReducer.reduce(
            startedTurn(),
            AgentEvent.ErrorEvent(
                sessionId = "s1",
                messageId = "m1",
                code = "http_api_error",
                message = message,
                provider = AgentProviderFailureDetail(status = 404, code = "NOT_FOUND", param = "model"),
            ),
        )

        val failure = lastAssistant(state).failure
        assertEquals(message, failure?.message)
        assertEquals("http_api_error", failure?.code)
        assertEquals("HTTP 404 · NOT_FOUND · param=model", failure?.providerDetail)
        assertFalse("the code must not be spliced into the prose", failure!!.message.contains("http_api_error"))
        assertFalse(state.busy)
    }

    @Test
    fun error_event_without_a_provider_still_carries_the_code() {
        val state = AgentReducer.reduce(
            startedTurn(),
            AgentEvent.ErrorEvent(
                sessionId = "s1",
                messageId = "m1",
                code = "agent_failed",
                message = "The run stopped before an answer was written.",
            ),
        )

        val failure = lastAssistant(state).failure
        assertEquals("The run stopped before an answer was written.", failure?.message)
        assertEquals("agent_failed", failure?.code)
        assertNull(failure?.providerDetail)
    }

    @Test
    fun a_message_free_error_falls_back_to_the_code_as_the_sentence() {
        val state = AgentReducer.reduce(
            startedTurn(),
            AgentEvent.ErrorEvent(sessionId = "s1", messageId = "m1", code = "backend_unreachable"),
        )
        assertEquals("backend_unreachable", lastAssistant(state).failure?.message)
    }

    @Test
    fun output_truncation_keeps_its_code_and_provider_detail() {
        val message = "The model reached its output limit before completing this response."
        val state = AgentReducer.reduce(
            startedTurn(),
            AgentEvent.MessageEnd(
                sessionId = "s1",
                messageId = "m1",
                stopReason = "max_tokens",
                failure = AgentTerminalFailure(
                    code = "output_truncated",
                    message = message,
                    backend = "openai-compatible",
                    model = "fictional-model",
                    provider = AgentProviderFailureDetail(status = 200, code = "length"),
                ),
            ),
        )

        val turn = lastAssistant(state)
        assertEquals("max_tokens", turn.stopReason)
        assertEquals(message, turn.failure?.message)
        assertEquals("output_truncated", turn.failure?.code)
        assertEquals("HTTP 200 · length", turn.failure?.providerDetail)
    }

    @Test
    fun a_clean_end_leaves_the_turn_without_a_failure() {
        val state = AgentReducer.reduce(
            startedTurn(),
            AgentEvent.MessageEnd(sessionId = "s1", messageId = "m1", stopReason = "end_turn"),
        )
        assertNull(lastAssistant(state).failure)
    }

    @Test
    fun a_failed_subagent_keeps_its_provider_detail_beside_its_code() {
        val spawned = AgentReducer.reduce(
            startedTurn(),
            AgentEvent.SubagentSpawned(
                sessionId = "s1",
                subagentId = "sub-1",
                specialist = "history-sweep",
                title = "Permit history",
                task = "Trace the permit decision",
            ),
        )
        val state = AgentReducer.reduce(
            spawned,
            AgentEvent.SubagentResult(
                sessionId = "s1",
                subagentId = "sub-1",
                specialist = "history-sweep",
                status = "failed",
                summary = "The worker could not reach the model provider.",
                failure = AgentTerminalFailure(
                    code = "http_api_error",
                    message = "The model provider rejected the request.",
                    provider = AgentProviderFailureDetail(status = 401, code = "UNAUTHORIZED"),
                ),
            ),
        )

        val card = (lastAssistant(state).parts.last() as AgentPart.Subagent).card
        assertEquals("failed", card.status)
        assertEquals("http_api_error", card.failureCode)
        assertEquals("HTTP 401 · UNAUTHORIZED", card.failureProviderDetail)
    }

    @Test
    fun a_subagent_result_without_a_provider_leaves_the_detail_empty() {
        val spawned = AgentReducer.reduce(
            startedTurn(),
            AgentEvent.SubagentSpawned(
                sessionId = "s1",
                subagentId = "sub-2",
                specialist = "history-sweep",
                title = "Permit history",
                task = "Trace the permit decision",
            ),
        )
        val state = AgentReducer.reduce(
            spawned,
            AgentEvent.SubagentResult(
                sessionId = "s1",
                subagentId = "sub-2",
                specialist = "history-sweep",
                status = "budget_exhausted",
                summary = "The worker ran out of budget.",
                failure = AgentTerminalFailure(code = "budget_exhausted", message = "Out of budget."),
            ),
        )

        val card = (lastAssistant(state).parts.last() as AgentPart.Subagent).card
        assertEquals("budget_exhausted", card.failureCode)
        assertNull(card.failureProviderDetail)
    }
}
