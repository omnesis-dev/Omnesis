// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentToolResult
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Eligibility spec for the turn-level working indicator ([AgentReducer.workingIndicatorActive]) —
 * the pure rule deciding WHEN the dots may show. Mirrors the iOS `workingIndicatorActive` cases.
 * The reveal DEBOUNCE (the "wait for a quiet gap" half) is a Compose concern, verified separately
 * in `AgentWorkingIndicatorRevealTest`.
 */
class AgentWorkingIndicatorTest {

    private fun assistant(vararg parts: AgentPart, stopReason: String? = null) =
        AgentTurn.Assistant(id = "a", parts = parts.toList(), stopReason = stopReason)

    private fun tool(
        name: String,
        result: AgentToolResult? = null,
        children: List<AgentToolChild> = emptyList(),
    ) = AgentPart.Tool(AgentToolCall(toolCallId = "t", tool = name, result = result, children = children))

    private fun state(busy: Boolean, vararg turns: AgentTurn) =
        AgentChatState(turns = turns.toList(), busy = busy)

    private fun active(state: AgentChatState) = AgentReducer.workingIndicatorActive(state)

    @Test fun inactive_when_not_busy() {
        assertFalse(active(state(busy = false, assistant(AgentPart.Text("hi")))))
    }

    @Test fun inactive_on_a_trailing_user_turn_once_idle() {
        assertFalse(active(state(busy = false, AgentTurn.User("u", "question"))))
    }

    @Test fun inactive_with_no_turns_at_all() {
        assertFalse(active(state(busy = true)))
    }

    @Test fun active_on_a_trailing_finished_text_block_in_flight() {
        assertTrue(active(state(busy = true, assistant(AgentPart.Text("Let me look…")))))
    }

    @Test fun active_on_a_trailing_unknown_part() {
        // Forward-compat part the client doesn't recognise renders nothing, so it reads as a gap.
        assertTrue(active(state(busy = true, assistant(AgentPart.Unknown("message part", "future_kind")))))
    }

    @Test fun active_on_a_trailing_user_turn_awaiting_message_start() {
        // Sent, awaiting the first `message.start` — the assistant turn doesn't exist yet, so
        // the debounced working dots are the only "still working" signal. Mirrors the iOS `.user`
        // arm (there is deliberately no separate pre-token indicator that could impersonate the
        // expandable Thinking trace).
        assertTrue(active(state(busy = true, AgentTurn.User("u", "question"))))
    }

    @Test fun active_on_an_empty_assistant_turn_awaiting_the_first_delta() {
        assertTrue(active(state(busy = true, assistant())))
    }

    @Test fun inactive_once_the_turn_has_ended() {
        assertFalse(active(state(busy = true, assistant(AgentPart.Text("done"), stopReason = "end_turn"))))
    }

    @Test fun inactive_on_a_live_trailing_thinking_part() {
        assertFalse(active(state(busy = true, assistant(AgentPart.Thinking("reasoning…")))))
    }

    @Test fun inactive_on_a_pending_singular_tool_with_its_own_spinner() {
        assertFalse(active(state(busy = true, assistant(tool("search_documents", result = null)))))
    }

    @Test fun active_on_a_completed_singular_tool_before_the_next_step() {
        assertTrue(active(state(busy = true, assistant(tool("search_documents", result = AgentToolResult.SearchResults())))))
    }

    @Test fun active_on_a_batch_tool_with_no_rendered_child_cards() {
        // search_many / fetch_many on a non-Codex backend stream no child progress, so the batch
        // shows nothing on screen — the dots are the only "still working" signal.
        assertTrue(active(state(busy = true, assistant(tool("search_many", children = emptyList())))))
    }

    @Test fun inactive_on_a_batch_tool_that_is_rendering_child_cards() {
        assertFalse(
            active(state(busy = true, assistant(tool("search_many", children = listOf(AgentToolChild(index = 0)))))),
        )
    }

    @Test fun inactive_on_a_running_sub_agent_card() {
        assertFalse(
            active(state(busy = true, assistant(AgentPart.Subagent(AgentSubagentCard("s", "spec", "task", status = null))))),
        )
    }

    @Test fun active_on_a_finished_sub_agent_card() {
        assertTrue(
            active(state(busy = true, assistant(AgentPart.Subagent(AgentSubagentCard("s", "spec", "task", status = "complete"))))),
        )
    }
}
