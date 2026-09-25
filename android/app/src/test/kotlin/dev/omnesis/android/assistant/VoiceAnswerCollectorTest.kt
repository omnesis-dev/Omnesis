// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentTerminalFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceAnswerCollectorTest {
    @Test
    fun folds_only_the_watched_session_and_message() {
        var collector = VoiceAnswerCollector("session-a", "message-a")
        collector = collector.continueWith(AgentEvent.TextDelta("session-b", "message-a", "wrong session"))
        collector = collector.continueWith(AgentEvent.TextDelta("session-a", "message-b", "wrong message"))
        collector = collector.continueWith(AgentEvent.TextDelta("session-a", "message-a", "The answer"))

        val result = collector.consume(AgentEvent.MessageEnd("session-a", "message-a"))
        assertEquals(VoiceAnswerCollector.Result.Answered("The answer"), result)
    }

    @Test
    fun authoritative_message_end_failure_wins_over_partial_text() {
        val collector = VoiceAnswerCollector("session-a", "message-a", "partial")
        val failure = AgentTerminalFailure(code = "output_truncated", message = "The answer was truncated.")

        val result = collector.consume(AgentEvent.MessageEnd("session-a", "message-a", failure = failure))

        assertEquals(VoiceAnswerCollector.Result.Failed(failure.code, failure.message), result)
    }

    @Test
    fun canceled_or_error_terminal_never_promotes_partial_text() {
        val collector = VoiceAnswerCollector("session-a", "message-a", "private partial")

        assertEquals(
            VoiceAnswerCollector.Result.Failed("canceled", "The answer was canceled."),
            collector.consume(AgentEvent.MessageEnd("session-a", "message-a", "canceled")),
        )
        assertEquals(
            VoiceAnswerCollector.Result.Failed("agent_error", "The answer could not be completed."),
            collector.consume(AgentEvent.MessageEnd("session-a", "message-a", "error")),
        )
    }

    @Test
    fun tool_boundary_is_not_a_terminal_answer() {
        val collector = VoiceAnswerCollector("session-a", "message-a", "before tool")

        assertTrue(
            collector.consume(AgentEvent.MessageEnd("session-a", "message-a", "tool_use"))
                is VoiceAnswerCollector.Result.Continue,
        )
    }

    @Test
    fun transient_context_error_waits_for_message_end() {
        val collector = VoiceAnswerCollector("session-a", "message-a")
        val result = collector.consume(
            AgentEvent.ErrorEvent("session-a", "message-a", "context_window_exceeded", "live hint"),
        )
        assertTrue(result is VoiceAnswerCollector.Result.Continue)
    }

    @Test
    fun generic_error_is_only_a_hint_and_message_end_remains_authoritative() {
        var collector = VoiceAnswerCollector("session-a", "message-a", "partial")
        collector = collector.continueWith(
            AgentEvent.ErrorEvent("session-a", "message-a", "provider_error", "internal detail"),
        )
        val failure = AgentTerminalFailure("stable_failure", "The model is unavailable.")

        assertEquals(
            VoiceAnswerCollector.Result.Failed(failure.code, failure.message),
            collector.consume(AgentEvent.MessageEnd("session-a", "message-a", failure = failure)),
        )
    }

    private fun VoiceAnswerCollector.continueWith(event: AgentEvent): VoiceAnswerCollector =
        (consume(event) as VoiceAnswerCollector.Result.Continue).collector
}
