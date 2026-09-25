// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentToolResult
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Live reduction for the batch retrieval tools (`search_many` / `fetch_many`): the
 * `agent.tool.child.*` events attach one child per index onto the parent batch tool part (kept
 * sorted). Unlike a singular ephemeral card, a batch parent does NOT act as a causality gate — its
 * N children each animate on their own lifecycle, so the answer text streams as soon as the durable
 * batch result lands rather than parking behind a parent flush. Mirrors the portal reducer's
 * `part.children` + `BATCH_EPHEMERAL_TOOLS` semantics and the iOS `agentBatchTools`.
 */
class AgentReducerBatchTest {

    private val S = "s"
    private val M = "m"

    private fun start() = AgentEvent.MessageStart(S, M)
    private fun text(d: String) = AgentEvent.TextDelta(S, M, d)
    private fun toolStart(id: String, tool: String) = AgentEvent.ToolStart(S, M, id, tool, JsonNull, null)
    private fun childStart(id: String, idx: Int, tool: String, summary: String?) =
        AgentEvent.ToolChildStart(S, M, id, idx, tool, summary)

    private fun searchResult(docId: String) =
        AgentToolResult.SearchResults(results = listOf(AgentDocRef(documentId = docId, title = docId)))

    private fun childResult(id: String, idx: Int, result: AgentToolResult) =
        AgentEvent.ToolChildResult(S, M, id, idx, result)

    private fun batchResult(id: String) =
        AgentEvent.ToolResult(S, M, id, AgentToolResult.SearchBatch(items = listOf(searchResult("d0"), searchResult("d1"))), 5.0)

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
    fun child_events_attach_to_parent_part_keyed_and_sorted_by_index() {
        val s = reduce(
            AgentChatState(), start(),
            toolStart("tc", "search_many"),
            childStart("tc", 1, "search_documents", "invoices"),
            childStart("tc", 0, "search_documents", "budget"),
            childResult("tc", 0, searchResult("d0")),
            childResult("tc", 1, searchResult("d1")),
        )

        val children = s.tool("tc").children
        // Sorted by index regardless of arrival order.
        assertEquals(listOf(0, 1), children.map { it.index })
        assertEquals("budget", children[0].argsSummary)
        assertEquals("search_documents", children[0].tool)
        // start + result on the same index upsert onto one child (result folded in).
        assertEquals("d0", (children[0].result as AgentToolResult.SearchResults).results[0].documentId)
        assertEquals("d1", (children[1].result as AgentToolResult.SearchResults).results[0].documentId)
        // Only the parent part exists in the transcript — children are projected, not parts.
        assertEquals(1, s.parts().size)
    }

    @Test
    fun child_result_without_prior_start_seeds_a_child() {
        val s = reduce(
            AgentChatState(), start(),
            toolStart("tc", "fetch_many"),
            childResult("tc", 2, searchResult("d2")),
        )
        val children = s.tool("tc").children
        assertEquals(1, children.size)
        assertEquals(2, children[0].index)
        assertNull(children[0].tool)
        assertEquals("d2", (children[0].result as AgentToolResult.SearchResults).results[0].documentId)
    }

    @Test
    fun batch_parent_does_not_gate_text_streams_immediately() {
        // A batch parent (search_many / fetch_many) does NOT act as a causality gate: it renders as
        // N independent per-child cards, so text after the durable batch result streams straight
        // onto the turn rather than parking on the parent (iOS / portal parity).
        val s = reduce(
            AgentChatState(), start(),
            toolStart("tc", "search_many"),
            childStart("tc", 0, "search_documents", "budget"),
            childResult("tc", 0, searchResult("d0")),
            batchResult("tc"),
            text("here is the answer"),
        )
        // Text appended immediately; nothing parked on the parent.
        assertEquals("here is the answer", s.texts().first().text)
        assertTrue(s.tool("tc").pendingTail.isEmpty())
    }

    @Test
    fun batch_never_gates_even_with_a_late_child() {
        // A batch parent never gates, so a run reads chronologically end-to-end: text after the
        // batch result streams straight through, and a late out-of-order child event still folds
        // onto the part directly (a part-internal update, never a turn-extending event).
        val s = reduce(
            AgentChatState(), start(),
            toolStart("tc", "search_many"),
            batchResult("tc"),
            text("here is the answer"),
            childResult("tc", 0, searchResult("d0")),
        )
        // Text streamed straight onto the turn; nothing parked.
        assertEquals("here is the answer", s.texts().first().text)
        assertTrue(s.tool("tc").pendingTail.isEmpty())
        // The late child still upserts onto the batch part's children.
        assertEquals(1, s.tool("tc").children.size)
        assertEquals("d0", (s.tool("tc").children[0].result as AgentToolResult.SearchResults).results[0].documentId)
    }

    @Test
    fun batch_result_lands_on_the_call_result() {
        // The durable batch result (SearchBatch / DocumentBatch) is NOT dropped for batch tools — it
        // is stored on the call's `result` exactly like any other tool result. This is load-bearing:
        // backends that emit no `agent.tool.child.*` progress (Anthropic, the `http` DeepSeek path)
        // leave `children` empty, so the batch card reconstructs its per-child cards from this stored
        // result. If the reducer ever dropped it, those backends would render nothing.
        val s = reduce(
            AgentChatState(), start(),
            toolStart("tc", "search_many"),
            batchResult("tc"),
        )
        val call = s.tool("tc")
        assertTrue(call.children.isEmpty())
        val result = call.result as AgentToolResult.SearchBatch
        assertEquals(2, result.items.size)
        assertEquals("d0", (result.items[0] as AgentToolResult.SearchResults).results[0].documentId)
        assertEquals("d1", (result.items[1] as AgentToolResult.SearchResults).results[0].documentId)
    }
}
