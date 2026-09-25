// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentToolResult
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Formal spec for the ephemeral-causality gate, ported 1:1 from the iOS
 * AgentCoordinatorGateTests. The gate is the trickiest agent logic: turn-extending
 * events that arrive after an ephemeral tool's result must be parked until the card's
 * dismiss animation flushes them, and flushing one gate must promote the next.
 */
class AgentReducerGateTest {

    private val S = "s"
    private val M = "m"

    private fun start() = AgentEvent.MessageStart(S, M)
    private fun text(d: String) = AgentEvent.TextDelta(S, M, d)
    private fun toolStart(id: String, tool: String) = AgentEvent.ToolStart(S, M, id, tool, JsonNull, null)
    private fun toolResult(id: String) = AgentEvent.ToolResult(S, M, id, AgentToolResult.SearchResults(), 1.0)

    private fun reduce(state: AgentChatState, vararg events: AgentEvent): AgentChatState {
        var s = state
        for (e in events) s = AgentReducer.reduce(s, e)
        return s
    }

    private fun AgentChatState.assistant() = turns.filterIsInstance<AgentTurn.Assistant>().last()
    private fun AgentChatState.parts() = assistant().parts
    private fun AgentChatState.tool(id: String) =
        parts().filterIsInstance<AgentPart.Tool>().first { it.call.toolCallId == id }.call
    private fun AgentChatState.texts() = parts().filterIsInstance<AgentPart.Text>()

    @Test
    fun message_start_claims_the_busy_turn_and_clears_stale_action_error() {
        val state = AgentChatState(busy = false, lastTurnError = "Stop failed: offline")

        val reduced = reduce(state, start())

        assertTrue(reduced.busy)
        assertNull(reduced.lastTurnError)
        assertEquals(M, reduced.assistant().id)
    }

    @Test
    fun text_deltas_after_ephemeral_result_are_buffered_not_appended() {
        val s = reduce(AgentChatState(), start(), toolStart("t1", "search_documents"), toolResult("t1"), text("hi"))
        assertEquals(1, s.parts().size) // only the tool part; text was buffered
        assertTrue(s.texts().isEmpty())
        assertEquals(1, s.tool("t1").pendingTail.size)
    }

    @Test
    fun ephemeral_tool_with_error_result_still_flushes_gate() {
        var s = reduce(
            AgentChatState(), start(),
            toolStart("t1", "search_documents"),
            AgentEvent.ToolResult(S, M, "t1", AgentToolResult.ErrorResult("denied", "quota exceeded"), 1.0),
            text("message after"),
        )
        assertTrue(s.texts().isEmpty())
        assertEquals(1, s.tool("t1").pendingTail.size)

        s = AgentReducer.flushEphemeralTail(s, "t1")
        assertTrue(s.tool("t1").tailDismissed)
        assertEquals("message after", s.texts().first().text)
    }

    @Test
    fun temporal_query_uses_the_ephemeral_causality_gate() {
        var s = reduce(
            AgentChatState(), start(),
            toolStart("t1", "temporal_query"),
            AgentEvent.ToolResult(
                S,
                M,
                "t1",
                AgentToolResult.Structured("temporal.results", JsonNull),
                1.0,
            ),
            text("Your dates are ready."),
        )
        assertTrue(s.texts().isEmpty())
        assertEquals(1, s.tool("t1").pendingTail.size)

        s = AgentReducer.flushEphemeralTail(s, "t1")
        assertEquals("Your dates are ready.", s.texts().first().text)
    }

    @Test
    fun interactive_memory_tool_uses_the_ephemeral_causality_gate() {
        var s = reduce(
            AgentChatState(), start(),
            toolStart("t1", "annotate_person"),
            AgentEvent.ToolResult(
                S,
                M,
                "t1",
                AgentToolResult.Structured("person_annotation.created", JsonNull),
                1.0,
            ),
            text("Remembered."),
        )
        assertTrue(s.texts().isEmpty())
        assertEquals(1, s.tool("t1").pendingTail.size)

        s = AgentReducer.flushEphemeralTail(s, "t1")
        assertEquals("Remembered.", s.texts().first().text)
    }

    @Test
    fun list_loops_uses_the_ephemeral_causality_gate() {
        var s = reduce(
            AgentChatState(), start(),
            toolStart("t1", "list_loops"),
            AgentEvent.ToolResult(
                S,
                M,
                "t1",
                AgentToolResult.Structured("loops.listed", JsonNull),
                1.0,
            ),
            text("Here are the active loops."),
        )
        assertTrue(s.texts().isEmpty())
        assertEquals(1, s.tool("t1").pendingTail.size)

        s = AgentReducer.flushEphemeralTail(s, "t1")
        assertEquals("Here are the active loops.", s.texts().first().text)
    }

    @Test
    fun flush_drains_queue_in_order() {
        var s = reduce(AgentChatState(), start(), toolStart("t1", "search_documents"), toolResult("t1"), text("a"), text("b"))
        assertEquals(2, s.tool("t1").pendingTail.size)
        s = AgentReducer.flushEphemeralTail(s, "t1")
        assertTrue(s.tool("t1").tailDismissed)
        assertEquals(1, s.texts().size)
        assertEquals("ab", s.texts().first().text)
    }

    @Test
    fun second_ephemeral_tool_while_gate_active_is_also_buffered() {
        val s = reduce(
            AgentChatState(), start(),
            toolStart("t1", "search_documents"), toolResult("t1"),
            toolStart("t2", "fetch_document"),
        )
        assertEquals(1, s.parts().size) // t2 buffered, not yet a part
        assertEquals(1, s.tool("t1").pendingTail.size)
    }

    @Test
    fun flushing_first_gate_promotes_second_tool_to_new_gate() {
        var s = reduce(
            AgentChatState(), start(),
            toolStart("t1", "search_documents"), toolResult("t1"),
            toolStart("t2", "fetch_document"), toolResult("t2"),
        )
        // both t2 events buffered on t1
        assertEquals(2, s.tool("t1").pendingTail.size)
        s = AgentReducer.flushEphemeralTail(s, "t1")
        // t2 now materialized with a result → it is the new active gate
        assertEquals(2, s.parts().filterIsInstance<AgentPart.Tool>().size)
        assertTrue(s.tool("t1").tailDismissed)
        assertFalse(s.tool("t2").tailDismissed)
        // a new text now buffers on t2
        s = AgentReducer.reduce(s, text("x"))
        assertEquals(1, s.tool("t2").pendingTail.size)
        assertTrue(s.texts().isEmpty())
    }

    @Test
    fun flushing_second_gate_completes_the_chain() {
        var s = reduce(
            AgentChatState(), start(),
            toolStart("t1", "search_documents"), toolResult("t1"),
            toolStart("t2", "fetch_document"), toolResult("t2"),
        )
        s = AgentReducer.flushEphemeralTail(s, "t1")
        s = AgentReducer.reduce(s, text("x"))
        s = AgentReducer.flushEphemeralTail(s, "t2")
        assertTrue(s.tool("t2").tailDismissed)
        assertEquals("x", s.texts().first().text)
    }

    @Test
    fun non_ephemeral_tool_never_acts_as_gate() {
        val s = reduce(AgentChatState(), start(), toolStart("t1", "some_other_tool"), toolResult("t1"), text("hi"))
        assertEquals(1, s.texts().size) // text appended normally
        assertTrue(s.tool("t1").pendingTail.isEmpty())
    }

    @Test
    fun text_before_result_lands_normally() {
        val s = reduce(AgentChatState(), start(), toolStart("t1", "search_documents"), text("hi"))
        assertEquals(1, s.texts().size)
        assertTrue(s.tool("t1").pendingTail.isEmpty())
    }

    @Test
    fun stale_flush_is_safe_no_op() {
        val s = reduce(AgentChatState(), start(), text("hi"))
        val after = AgentReducer.flushEphemeralTail(s, "does-not-exist")
        assertEquals(s, after)
    }

    @Test
    fun cite_record_result_folds_into_records_and_bumps_count() {
        // A directly-cited record is non-ephemeral, so it lands as a normal tool result:
        // its record folds into state.records and the citing turn's citationCount bumps (no SSE
        // Citation event exists for a record, so the count is bumped here).
        val citeResult = AgentToolResult.CiteRecord(
            table = "demo_fitness.workouts",
            recordKey = "demo_fitness.workouts|wk-1",
            title = "Morning run",
            tableDisplayName = "Workouts",
            semanticTime = "2026-05-02T07:14:00.000Z",
            sourceId = "demo-fitness:device",
            sourceType = "demo-fitness",
            boundDocumentId = "doc-run",
        )
        val s = reduce(
            AgentChatState(), start(),
            toolStart("t1", "cite_record"),
            AgentEvent.ToolResult(S, M, "t1", citeResult, 1.0),
        )
        assertEquals(1, s.records.size)
        assertEquals("demo_fitness.workouts|wk-1", s.records[0].recordKey)
        assertEquals("doc-run", s.records[0].boundDocumentId)
        assertEquals(1, s.assistant().citationCount)
    }

    @Test
    fun repeated_cite_record_dedups_by_record_key() {
        fun cite(boundDoc: String?) = AgentToolResult.CiteRecord(
            table = "demo_fitness.workouts",
            recordKey = "demo_fitness.workouts|wk-1",
            title = "Morning run",
            tableDisplayName = "Workouts",
            semanticTime = "2026-05-02T07:14:00.000Z",
            sourceId = "demo-fitness:device",
            sourceType = "demo-fitness",
            boundDocumentId = boundDoc,
        )
        val s = reduce(
            AgentChatState(), start(),
            toolStart("t1", "cite_record"),
            AgentEvent.ToolResult(S, M, "t1", cite(null), 1.0),
            toolStart("t2", "cite_record"),
            AgentEvent.ToolResult(S, M, "t2", cite("doc-run"), 1.0),
        )
        assertEquals(1, s.records.size) // deduped by recordKey
        assertEquals("doc-run", s.records[0].boundDocumentId) // last write wins
    }

    @Test
    fun message_end_force_drains_active_gate() {
        var s = reduce(
            AgentChatState(), start(),
            toolStart("t1", "search_documents"), toolResult("t1"),
            text("after"),
        )
        // text buffered on t1
        assertTrue(s.texts().isEmpty())
        s = AgentReducer.reduce(s, AgentEvent.MessageEnd(S, M, "end_turn"))
        // force-flushed: text now visible, busy cleared
        assertEquals("after", s.texts().first().text)
        assertFalse(s.busy)
        assertNull(s.assistant().failure)
        assertEquals("end_turn", s.assistant().stopReason)
    }
}
