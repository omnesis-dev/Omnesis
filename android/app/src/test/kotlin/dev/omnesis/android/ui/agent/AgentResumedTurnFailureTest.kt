// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentProviderFailureDetail
import dev.omnesis.android.transport.dto.AgentTerminalFailure
import dev.omnesis.android.transport.dto.AssistantPart
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.CreateSessionResponse
import dev.omnesis.android.transport.dto.UserPart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The marker half, on its own: [AgentTurnBuilder] lifts the failure marker the agent session
 * leaves in model-visible history out of the rendered text, and does so only where the session
 * actually writes it — so an answer that quotes the phrase survives a reopen whole.
 *
 * All fixture data is invented.
 */
class AgentTerminalFailureMarkerTest {

    @Test
    fun a_marker_alone_becomes_a_failure_with_no_body() {
        val split = AgentTurnBuilder.splitTerminalFailureMarker(
            "Model request failed: http_api_error: The model provider does not have the assigned model.",
        )
        assertEquals("", split?.first)
        assertEquals("http_api_error", split?.second?.code)
        assertEquals("The model provider does not have the assigned model.", split?.second?.message)
        assertNull(split?.second?.providerDetail)
    }

    @Test
    fun a_marker_after_a_blank_line_keeps_the_preceding_body() {
        val split = AgentTurnBuilder.splitTerminalFailureMarker(
            "Here are the two invoices I found so far.\n\n" +
                "Model request failed: backend_unavailable: The model backend closed the stream.",
        )
        assertEquals("Here are the two invoices I found so far.", split?.first)
        assertEquals("backend_unavailable", split?.second?.code)
        assertEquals("The model backend closed the stream.", split?.second?.message)
    }

    @Test
    fun a_mid_sentence_mention_is_not_a_failure() {
        assertNull(
            AgentTurnBuilder.splitTerminalFailureMarker(
                "The line in your log reads Model request failed: http_api_error: no such model, " +
                    "which means the model assignment points at something the provider doesn't serve.",
            ),
        )
        assertNull(
            "one newline is not the blank line the session writes before the marker",
            AgentTurnBuilder.splitTerminalFailureMarker(
                "The log line is:\nModel request failed: http_api_error: no such model",
            ),
        )
    }

    @Test
    fun a_malformed_marker_is_left_alone() {
        assertNull(AgentTurnBuilder.splitTerminalFailureMarker("Model request failed: "))
        assertNull(AgentTurnBuilder.splitTerminalFailureMarker("Model request failed: cancelled"))
        assertNull(AgentTurnBuilder.splitTerminalFailureMarker("Model request failed: :  "))
    }

    @Test
    fun a_rebuilt_turn_renders_the_failure_instead_of_the_marker_prose() {
        val turns = AgentTurnBuilder.turns(
            listOf(
                ChatMessage.User(listOf(UserPart.Text("summarise the quarterly invoices"))),
                ChatMessage.Assistant(
                    listOf(
                        AssistantPart.Text(
                            "Model request failed: http_api_error: The model provider rejected the request.",
                        ),
                    ),
                ),
            ),
        )
        val assistant = turns.filterIsInstance<AgentTurn.Assistant>().last()
        assertEquals(emptyList<String>(), assistant.parts.filterIsInstance<AgentPart.Text>().map { it.text })
        assertEquals("http_api_error", assistant.failure?.code)
        assertEquals("The model provider rejected the request.", assistant.failure?.message)
    }

    /**
     * A stopped reply is an outcome, not a failure: the live view ends such a turn with no error
     * affordance, so a reopened one says only that it stopped, keeping whatever the turn had written.
     */
    @Test
    fun a_rebuilt_canceled_marker_is_a_stop_not_a_failure() {
        val turns = AgentTurnBuilder.turns(
            listOf(
                ChatMessage.User(listOf(UserPart.Text("summarise the quarterly invoices"))),
                ChatMessage.Assistant(
                    listOf(
                        AssistantPart.Text(
                            "I found two invoices so far.\n\nModel request failed: canceled: You stopped this reply.",
                        ),
                    ),
                ),
            ),
        )
        val assistant = turns.filterIsInstance<AgentTurn.Assistant>().last()
        assertEquals(listOf("I found two invoices so far."), assistant.parts.filterIsInstance<AgentPart.Text>().map { it.text })
        assertEquals("canceled", assistant.stopReason)
        assertEquals("You stopped this reply.", assistant.stopped)
        assertNull("a stop must not render as a failure", assistant.failure)
    }

    /** Every other code still takes the failure path, and carries no stop note. */
    @Test
    fun a_rebuilt_non_canceled_marker_still_fails() {
        val turns = AgentTurnBuilder.turns(
            listOf(
                ChatMessage.User(listOf(UserPart.Text("summarise the quarterly invoices"))),
                ChatMessage.Assistant(
                    listOf(
                        AssistantPart.Text(
                            "Model request failed: backend_unavailable: The model backend closed the stream.",
                        ),
                    ),
                ),
            ),
        )
        val assistant = turns.filterIsInstance<AgentTurn.Assistant>().last()
        assertEquals("backend_unavailable", assistant.failure?.code)
        assertNull(assistant.stopReason)
        assertNull(assistant.stopped)
    }

    @Test
    fun a_rebuilt_turn_keeps_an_answer_that_quotes_the_marker() {
        val quoted = "Your log line Model request failed: http_api_error: no such model means " +
            "the assigned model is not one the provider serves."
        val turns = AgentTurnBuilder.turns(
            listOf(
                ChatMessage.User(listOf(UserPart.Text("what does this log line mean?"))),
                ChatMessage.Assistant(listOf(AssistantPart.Text(quoted))),
            ),
        )
        val assistant = turns.filterIsInstance<AgentTurn.Assistant>().last()
        assertEquals(listOf(quoted), assistant.parts.filterIsInstance<AgentPart.Text>().map { it.text })
        assertNull(assistant.failure)
    }
}

/**
 * Reopening a conversation whose last turn died must look like watching it die: the same
 * sentence, the same code, the same provider disposition, rendered by the same error row the
 * live stream drives. The conversation record's own `lastTurnFailure` is folded onto the last
 * assistant turn for every failure code, and it is the better source where the history marker
 * also exists — only it carries what the provider reported.
 *
 * All fixture data is invented. The Android twin of the iOS `ResumedTurnFailureTests`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class AgentResumedTurnFailureTest {

    @Before fun setUp() = Dispatchers.setMain(Dispatchers.Unconfined)

    @After fun tearDown() = Dispatchers.resetMain()

    private fun resume(assistantText: String, lastTurnFailure: AgentTerminalFailure?): AgentTurn.Assistant {
        val coord = AgentCoordinator()
        coord.applySnapshotForTesting(
            CreateSessionResponse(
                sessionId = "s_resumed",
                model = "fictional-model",
                backend = "openai-compatible",
                title = "Quarterly invoices",
                messages = listOf(
                    ChatMessage.User(listOf(UserPart.Text("summarise the quarterly invoices"))),
                    ChatMessage.Assistant(listOf(AssistantPart.Text(assistantText))),
                ),
                messagesAreVisible = true,
                lastTurnFailure = lastTurnFailure,
            ),
            emptyList(),
        )
        return coord.state.value.chat.turns.filterIsInstance<AgentTurn.Assistant>().last()
    }

    private fun AgentTurn.Assistant.texts() = parts.filterIsInstance<AgentPart.Text>().map { it.text }

    /** The case the record now carries for every code, not only a truncation. */
    @Test
    fun a_resumed_non_truncation_failure_renders_structurally_with_provider_detail() {
        val assistant = resume(
            assistantText =
            "Model request failed: http_api_error: The model provider does not have the assigned model.",
            lastTurnFailure = AgentTerminalFailure(
                code = "http_api_error",
                message = "The model provider does not have the assigned model.",
                backend = "openai-compatible",
                model = "fictional-model",
                provider = AgentProviderFailureDetail(status = 404, code = "NOT_FOUND", param = "model"),
            ),
        )

        assertEquals("the marker must not render as assistant prose", emptyList<String>(), assistant.texts())
        assertEquals("http_api_error", assistant.failure?.code)
        assertEquals("The model provider does not have the assigned model.", assistant.failure?.message)
        assertEquals("HTTP 404 · NOT_FOUND · param=model", assistant.failure?.providerDetail)
        assertNull("only a truncation ended mid-answer", assistant.stopReason)
    }

    /** Whatever the turn managed to write before it died is still its answer. */
    @Test
    fun a_resumed_failure_keeps_the_partial_answer_above_it() {
        val assistant = resume(
            assistantText = "I found two invoices in the quarterly folder.\n\n" +
                "Model request failed: backend_unavailable: The model backend closed the stream.",
            lastTurnFailure = AgentTerminalFailure(
                code = "backend_unavailable",
                message = "The model backend closed the stream.",
                retryable = true,
                backend = "openai-compatible",
                model = "fictional-model",
            ),
        )

        assertEquals(listOf("I found two invoices in the quarterly folder."), assistant.texts())
        assertEquals("backend_unavailable", assistant.failure?.code)
        assertNull(assistant.failure?.providerDetail)
    }

    /** An answer that merely quotes the phrase is an answer; nothing about it changes on reopen. */
    @Test
    fun a_resumed_answer_quoting_the_marker_survives_intact() {
        val quoted = "Your log line Model request failed: http_api_error: no such model means " +
            "the assigned model is not one the provider serves."
        val assistant = resume(assistantText = quoted, lastTurnFailure = null)

        assertEquals(listOf(quoted), assistant.texts())
        assertNull(assistant.failure)
        assertNull(assistant.stopReason)
    }

    /**
     * A stopped reply reopens the way it ended live — as a canceled turn, not a failed one — with
     * the marker's sentence as its only trace. The record keeps no `lastTurnFailure` for a stop, so
     * nothing folds on top.
     */
    @Test
    fun a_resumed_stopped_reply_reads_as_stopped() {
        val assistant = resume(
            assistantText = "Model request failed: canceled: This reply was stopped.",
            lastTurnFailure = null,
        )

        assertEquals("the marker must not render as assistant prose", emptyList<String>(), assistant.texts())
        assertEquals("canceled", assistant.stopReason)
        assertEquals("This reply was stopped.", assistant.stopped)
        assertNull(assistant.failure)
    }

    /** The truncation path is unchanged: it alone reports a `max_tokens` stop. */
    @Test
    fun a_resumed_truncation_still_reports_the_output_limit() {
        val assistant = resume(
            assistantText = "The first two invoices are",
            lastTurnFailure = AgentTerminalFailure(
                code = "output_truncated",
                message = "The model reached its output limit before completing this response.",
                backend = "anthropic",
                model = "fictional-model",
                provider = AgentProviderFailureDetail(status = 200, code = "length"),
            ),
        )

        assertEquals(listOf("The first two invoices are"), assistant.texts())
        assertEquals("max_tokens", assistant.stopReason)
        assertEquals("output_truncated", assistant.failure?.code)
        assertEquals(
            "The model reached its output limit before completing this response.",
            assistant.failure?.message,
        )
        assertEquals("HTTP 200 · length", assistant.failure?.providerDetail)
    }

    /** A record with no sentence still has to say something — an error row with no words explains nothing. */
    @Test
    fun a_resumed_failure_without_a_sentence_falls_back_per_code() {
        val truncated = resume(
            assistantText = "The first two invoices are",
            lastTurnFailure = AgentTerminalFailure(
                code = "output_truncated",
                message = "  ",
                backend = "anthropic",
                model = "fictional-model",
            ),
        )
        assertEquals(
            "The model reached its output limit before completing this response.",
            truncated.failure?.message,
        )

        val other = resume(
            assistantText = "The first two invoices are",
            lastTurnFailure = AgentTerminalFailure(
                code = "agent_failed",
                message = "",
                backend = "anthropic",
                model = "fictional-model",
            ),
        )
        assertEquals("The turn failed.", other.failure?.message)
        assertNull(other.stopReason)
    }
}
