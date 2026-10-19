// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentEvent
import org.junit.Assert.assertEquals
import org.junit.Test

class EphemeralDismissalTimingTest {
    @Test fun waiting_answer_text_accelerates_dismissal_threefold() {
        assertEquals(true, hasPendingAnswerText(listOf(AgentEvent.TextDelta(delta = "Answer"))))
    }

    @Test fun queued_tool_and_thinking_events_preserve_existing_timing() {
        assertEquals(false, hasPendingAnswerText(listOf(
            AgentEvent.ThinkingDelta(delta = "Thinking"),
            AgentEvent.ToolInputStart(toolCallId = "next-tool", tool = "search"),
        )))
    }

    @Test fun empty_and_whitespace_text_do_not_accelerate_dismissal() {
        assertEquals(false, hasPendingAnswerText(emptyList()))
        assertEquals(false, hasPendingAnswerText(listOf(AgentEvent.TextDelta(delta = " \n"))))
    }

    @Test fun answer_text_after_another_queued_event_also_accelerates_dismissal() {
        assertEquals(true, hasPendingAnswerText(listOf(
            AgentEvent.ThinkingDelta(delta = "Thinking"),
            AgentEvent.TextDelta(delta = "Answer"),
        )))
    }
}
