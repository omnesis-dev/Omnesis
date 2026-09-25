// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentTerminalFailure
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.AgentUsage
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Spec for the sub-agent card reduction (#748), the Android twin of the iOS
 * AgentCoordinatorSubagentTests + the portal agent-reducer subagent tests. The three
 * `agent.subagent.*` events fold into an [AgentPart.Subagent] card on the parent's
 * assistant turn: `spawned` seeds the card, each wrapped `event` advances the card's
 * own bookkeeping (steps, tokens, reached documents), `result` finalises status/
 * summary/tokens. An unrecognised wrapped child event leaves the card untouched (the
 * graceful-degrade arm — Android's `AgentPart.Unknown` analogue).
 */
class AgentReducerSubagentTest {

    private val S = "s"
    private val M = "m"
    private val SUB = "s.sub.a1"

    private fun reduce(state: AgentChatState, vararg events: AgentEvent): AgentChatState {
        var s = state
        for (e in events) s = AgentReducer.reduce(s, e)
        return s
    }

    /** A parent assistant turn already exists so the card has somewhere to attach. */
    private fun seeded() = reduce(AgentChatState(), AgentEvent.MessageStart(S, M))

    private fun spawn() = AgentEvent.SubagentSpawned(
        sessionId = S,
        subagentId = SUB,
        specialist = "history-sweep",
        title = "Budget decisions",
        task = "Find the budget decisions",
        parentToolCallId = "tc1",
    )

    private fun wrap(inner: AgentEvent) = AgentEvent.SubagentEvent(S, SUB, "history-sweep", inner)

    private fun AgentChatState.card(): AgentSubagentCard {
        val a = turns.filterIsInstance<AgentTurn.Assistant>().last()
        return a.parts.filterIsInstance<AgentPart.Subagent>().single().card
    }

    @Test
    fun spawn_opens_a_collapsible_card_on_the_parent_turn() {
        val s = reduce(seeded(), spawn())
        val card = s.card()
        assertEquals(SUB, card.subagentId)
        assertEquals("history-sweep", card.specialist)
        assertEquals("Find the budget decisions", card.task)
        assertEquals("tc1", card.parentToolCallId)
        assertNull(card.status)
        assertEquals(0, card.stepCount)
        assertEquals(0, card.tokens)
    }

    @Test
    fun re_delivered_spawn_is_idempotent() {
        val s = reduce(seeded(), spawn(), spawn())
        val a = s.turns.filterIsInstance<AgentTurn.Assistant>().last()
        assertEquals(1, a.parts.filterIsInstance<AgentPart.Subagent>().size)
    }

    @Test
    fun spawn_tool_card_is_replaced_by_stable_worker_card() {
        val s = reduce(
            seeded(),
            AgentEvent.ToolInputStart(S, M, "tc1", "spawn_subagent"),
            AgentEvent.ToolStart(S, M, "tc1", "spawn_subagent", JsonNull, "Compare two periods"),
            spawn(),
        )
        val parts = s.turns.filterIsInstance<AgentTurn.Assistant>().last().parts
        assertEquals(1, parts.filterIsInstance<AgentPart.Subagent>().size)
        assertFalse(parts.filterIsInstance<AgentPart.Tool>().any { it.call.tool == "spawn_subagent" })
    }

    @Test
    fun join_tool_never_appears_in_transcript() {
        val s = reduce(
            seeded(),
            AgentEvent.ToolInputStart(S, M, "join1", "join_subagents"),
            AgentEvent.ToolStart(S, M, "join1", "join_subagents", JsonNull, "1 worker"),
            AgentEvent.ToolResult(S, M, "join1", AgentToolResult.ErrorResult("ok", ""), 1.0),
        )
        val parts = s.turns.filterIsInstance<AgentTurn.Assistant>().last().parts
        assertFalse(parts.filterIsInstance<AgentPart.Tool>().any { it.call.tool == "join_subagents" })
    }

    @Test
    fun message_end_drains_queued_worker_then_removes_launch_tool() {
        val s = reduce(
            seeded(),
            AgentEvent.ToolStart(S, M, "tc1", "spawn_subagent", JsonNull, "Inspect evidence"),
            AgentEvent.ToolResult(S, M, "tc1", AgentToolResult.ErrorResult("ok", ""), 1.0),
            spawn(),
            AgentEvent.MessageEnd(S, M, "end_turn"),
        )
        val parts = s.turns.filterIsInstance<AgentTurn.Assistant>().last().parts
        assertEquals(1, parts.filterIsInstance<AgentPart.Subagent>().size)
        assertFalse(parts.filterIsInstance<AgentPart.Tool>().any {
            it.call.tool in AgentReducer.ORCHESTRATION_TOOLS
        })
    }

    @Test
    fun wrapped_child_tool_events_pair_up_and_count_steps() {
        val s = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.MessageStart(SUB, "cm")),
            wrap(AgentEvent.ToolStart(SUB, "cm", "ct1", "search_documents", JsonNull, "budget")),
            wrap(AgentEvent.ToolResult(SUB, "cm", "ct1", AgentToolResult.SearchResults(query = "budget"), 5.0)),
        )
        val card = s.card()
        // The call is paired and settled, so nothing of it is held: a result payload is
        // a document body, a SQL page or a trail, and the card reads none of them.
        assertTrue(card.childTurns.single().parts.isEmpty())
        // one tool call → one step
        assertEquals(1, card.stepCount)
    }

    @Test
    fun a_pending_tool_call_is_held_only_until_its_result_pairs_with_it() {
        val opened = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.MessageStart(SUB, "cm")),
            wrap(AgentEvent.ToolStart(SUB, "cm", "ct1", "search_documents", JsonNull, "budget")),
        )
        val pending = opened.card().childTurns.single().parts.filterIsInstance<AgentPart.Tool>().single()
        assertEquals("ct1", pending.call.toolCallId)

        val settled = reduce(
            opened,
            wrap(AgentEvent.ToolResult(SUB, "cm", "ct1", AgentToolResult.SearchResults(query = "budget"), 5.0)),
        )
        assertTrue(settled.card().childTurns.single().parts.isEmpty())
    }

    @Test
    fun a_finished_child_request_leaves_no_scratch_state() {
        val s = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.MessageStart(SUB, "cm")),
            wrap(AgentEvent.ToolStart(SUB, "cm", "ct1", "search_documents", JsonNull, "budget")),
            wrap(AgentEvent.MessageEnd(SUB, "cm")),
        )
        // A reader runs many requests; a finished one has nothing left to pair.
        assertTrue(s.card().childTurns.isEmpty())
        // What the request actually produced still stands.
        assertEquals(1, s.card().stepCount)
    }

    @Test
    fun a_child_s_prose_and_reasoning_are_not_kept() {
        val s = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.MessageStart(SUB, "cm")),
            wrap(AgentEvent.ThinkingDelta(SUB, "cm", "weighing the options… ")),
            wrap(AgentEvent.TextDelta(SUB, "cm", "Looking… ")),
            wrap(AgentEvent.TextDelta(SUB, "cm", "found it.")),
        )
        // Nothing on the card or the working-set surface renders a researcher's own
        // words, so none are retained. Matches iOS and the portal.
        assertTrue(s.card().childTurns.single().parts.isEmpty())
        assertEquals(0, s.card().stepCount)
    }

    @Test
    fun a_new_child_request_replaces_the_previous_request_s_scratch_state() {
        val s = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.MessageStart(SUB, "cm1")),
            wrap(AgentEvent.ToolStart(SUB, "cm1", "ct1", "search_documents", JsonNull, "budget")),
            wrap(AgentEvent.MessageStart(SUB, "cm2")),
            wrap(AgentEvent.ToolStart(SUB, "cm2", "ct2", "fetch_document", JsonNull, "d1")),
        )
        val card = s.card()
        // A reader issues many sequential requests; only the one in flight is scratch
        // worth holding, so the list does not grow with the run.
        assertEquals(1, card.childTurns.size)
        assertEquals("cm2", card.childTurns.single().id)
        assertEquals(
            listOf("ct2"),
            card.childTurns.single().parts.filterIsInstance<AgentPart.Tool>().map { it.call.toolCallId },
        )
        // Steps are counted across the whole run, not just the request in flight.
        assertEquals(2, card.stepCount)
    }

    @Test
    fun child_plan_tool_is_not_counted_as_a_step() {
        val s = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.MessageStart(SUB, "cm")),
            wrap(AgentEvent.ToolStart(SUB, "cm", "pl", "plan", JsonNull, null)),
        )
        assertEquals(0, s.card().stepCount)
        assertTrue(s.card().childTurns.single().parts.isEmpty())
    }

    @Test
    fun result_finalises_status_summary_and_adopts_authoritative_tokens() {
        val s = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.MessageStart(SUB, "cm")),
            wrap(AgentEvent.ToolStart(SUB, "cm", "ct1", "search_documents", JsonNull, "budget")),
            AgentEvent.SubagentResult(
                S, SUB, "history-sweep", "complete", "Found three prior threads.",
                citations = listOf(AgentDocRef(documentId = "d1", sourceId = "notes:local", title = "Budget note")),
                usage = AgentUsage(inputTokens = 900, outputTokens = 340),
                treeUsage = AgentUsage(inputTokens = 4200, outputTokens = 1100),
            ),
        )
        val card = s.card()
        assertEquals("complete", card.status)
        assertEquals("Found three prior threads.", card.summary)
        assertEquals(1240, card.tokens) // authoritative per-child total
        assertEquals(1, card.stepCount)
        assertEquals(1, card.retainedCitationCount)
    }

    @Test
    fun failed_result_retains_deliberate_citations_for_partial_result_state() {
        val s = reduce(
            seeded(), spawn(),
            AgentEvent.SubagentResult(
                S, SUB, "generic", "failed",
                "Partial evidence collected before the worker reached its output limit:\n- Project note: Approved.",
                citations = listOf(AgentDocRef(documentId = "d1", sourceId = "notes:local", title = "Project note")),
                failure = AgentTerminalFailure(
                    code = "output_truncated",
                    message = "The model reached its output limit.",
                    backend = "http",
                    model = "fictional-model",
                ),
            ),
        )

        val card = s.card()
        assertEquals("failed", card.status)
        assertEquals(1, card.retainedCitationCount)
        assertEquals("output_truncated", card.failureCode)
        assertTrue(card.hasPartialResult)
        assertEquals(listOf("d1"), card.docs.map { it.documentId })
    }

    @Test
    fun cited_non_truncation_failure_remains_an_ordinary_failure() {
        val s = reduce(
            seeded(), spawn(),
            AgentEvent.SubagentResult(
                S, SUB, "generic", "failed", "HTTP model request failed.",
                citations = listOf(AgentDocRef(documentId = "d1", sourceId = "notes:local", title = "Project note")),
                failure = AgentTerminalFailure(
                    code = "http_api_error",
                    message = "HTTP model request failed.",
                    retryable = true,
                    backend = "http",
                    model = "fictional-model",
                ),
            ),
        )

        assertEquals(1, s.card().retainedCitationCount)
        assertEquals("http_api_error", s.card().failureCode)
        assertFalse(s.card().hasPartialResult)
    }

    @Test
    fun result_without_token_usage_keeps_running_tally() {
        val s = reduce(
            seeded(), spawn(),
            AgentEvent.SubagentResult(S, SUB, "source-digest", "failed", "No matches."),
        )
        val card = s.card()
        assertEquals("failed", card.status)
        assertEquals(0, card.retainedCitationCount)
        assertEquals(0, card.tokens) // no usage on the wire → unchanged
    }

    @Test
    fun child_message_end_accrues_usage_before_the_researcher_finishes() {
        val s = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.MessageEnd(SUB, "cm", "tool_use", usage = AgentUsage(inputTokens = 800, outputTokens = 200))),
        )
        assertEquals(1000, s.card().tokens)
    }

    @Test
    fun live_usage_is_replaced_by_terminal_usage_without_double_counting() {
        val s = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.UsageUpdate(SUB, "cm1", AgentUsage(inputTokens = 800, outputTokens = 200))),
            wrap(AgentEvent.MessageEnd(SUB, "cm1", "tool_use", usage = AgentUsage(inputTokens = 800, outputTokens = 200))),
            wrap(AgentEvent.UsageUpdate(SUB, "cm2", AgentUsage(inputTokens = 500, outputTokens = 100))),
        )
        assertEquals(1600, s.card().tokens)
    }

    @Test
    fun partial_live_usage_merges_and_duplicate_terminal_event_is_ignored() {
        val end = AgentEvent.MessageEnd(SUB, "cm", "tool_use", usage = AgentUsage(outputTokens = 20))
        val s = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.UsageUpdate(SUB, "cm", AgentUsage(inputTokens = 100))),
            wrap(AgentEvent.UsageUpdate(SUB, "cm", AgentUsage(outputTokens = 10))),
            wrap(end),
            wrap(end),
        )
        assertEquals(120, s.card().tokens)
    }

    @Test
    fun batch_child_result_adds_documents_before_the_batch_finishes() {
        val s = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.ToolChildResult(
                sessionId = SUB, messageId = "cm", toolCallId = "batch1", childIndex = 0,
                result = AgentToolResult.SearchResults(
                    query = "ledger",
                    results = listOf(AgentDocRef(documentId = "d1", title = "Ledger", sourceId = "drive:acct")),
                ),
            )),
        )
        assertEquals(listOf("d1"), s.card().docs.map { it.documentId })
    }

    @Test
    fun terminal_batch_result_adds_documents_when_live_child_events_are_unavailable() {
        val s = reduce(
            seeded(), spawn(),
            wrap(AgentEvent.ToolResult(
                sessionId = SUB, messageId = "cm", toolCallId = "batch1",
                result = AgentToolResult.SearchBatch(listOf(
                    AgentToolResult.SearchResults(
                        query = "ledger",
                        results = listOf(AgentDocRef(documentId = "d1", title = "Ledger", sourceId = "drive:acct")),
                    ),
                )),
                durationMs = 1.0,
            )),
        )
        assertEquals(listOf("d1"), s.card().docs.map { it.documentId })
    }

    @Test
    fun unknown_wrapped_child_event_leaves_the_card_untouched() {
        // The Android graceful-degrade arm: an inner event the build doesn't render
        // (here a citation, plus a truly unknown kind) leaves childTurns/stepCount as-is.
        val before = reduce(seeded(), spawn(), wrap(AgentEvent.MessageStart(SUB, "cm")))
        val after = reduce(
            before,
            wrap(AgentEvent.Citation(SUB, "cm", "ct1", AgentDocRef(documentId = "d1"))),
            wrap(AgentEvent.Unknown("agent.future.thing", SUB)),
        )
        assertEquals(before.card().stepCount, after.card().stepCount)
        assertEquals(before.card().childTurns, after.card().childTurns)
        assertNull(after.card().status)
    }

    @Test
    fun event_for_unknown_subagent_id_is_a_safe_no_op() {
        val s = reduce(
            seeded(), spawn(),
            AgentEvent.SubagentEvent(S, "s.sub.NOPE", "x", AgentEvent.TextDelta("s.sub.NOPE", "cm", "ghost")),
        )
        // The known card is untouched; the stray event produced no new card.
        val a = s.turns.filterIsInstance<AgentTurn.Assistant>().last()
        assertEquals(1, a.parts.filterIsInstance<AgentPart.Subagent>().size)
        assertTrue(s.card().childTurns.isEmpty())
    }

    @Test
    fun card_is_located_across_later_parent_parts() {
        // A subagent.result can arrive after the parent appended more text — the card
        // is found by id across the whole assistant turn, not only as the last part.
        val s = reduce(
            seeded(), spawn(),
            AgentEvent.TextDelta(S, M, "Meanwhile the parent keeps talking."),
            AgentEvent.SubagentResult(S, SUB, "history-sweep", "complete", "Done."),
        )
        assertEquals("complete", s.card().status)
    }
}
