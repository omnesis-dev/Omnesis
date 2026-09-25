// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.AgentTrailEvent
import dev.omnesis.android.transport.dto.AgentTrailEventDoc
import dev.omnesis.android.transport.dto.AgentUsage
import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Spec for the research working-set surface reduction (#748) — the Android twin of the iOS
 * AgentCoordinatorResearchWorkspaceTests + the portal docs-accumulator/selector tests. A
 * per-card `docs[]` accumulates LIVE off the wrapped child `agent.subagent.*` tool results
 * (deduped by documentId, generic over the document-bearing kinds, NO source-name branching);
 * `researchPanels` projects the latest assistant turn's cards into panel descriptors in spawn
 * order; `isResearchWorkspaceActive` gates the surface to a live Deep Research run with ≥1
 * researcher and the reducer collapses it (clears `deepResearch`) on `MessageEnd`/`ErrorEvent`.
 * All fixture data is invented (privacy rule), never sourced from the corpus.
 */
class AgentReducerResearchWorkspaceTest {

    private val S = "s"
    private val M = "m"

    private fun reduce(state: AgentChatState, vararg events: AgentEvent): AgentChatState {
        var s = state
        for (e in events) s = AgentReducer.reduce(s, e)
        return s
    }

    private fun ref(id: String, sourceId: String, title: String? = null) =
        AgentDocRef(documentId = id, sourceType = sourceId.substringBefore(':'), sourceId = sourceId, title = title)

    /** A parent assistant turn already exists so cards have somewhere to attach. */
    private fun seeded() = reduce(AgentChatState(), AgentEvent.MessageStart(S, M))

    /**
     * Bound by name, never by position: [AgentEvent.SubagentSpawned] carries a short display
     * `title` between `specialist` and `task`, and every field is a defaulted [String], so a
     * positional call silently binds the task text to `title` and the tool-call id to `task`
     * without a compile error.
     */
    private fun spawn(sub: String, specialist: String, task: String) =
        AgentEvent.SubagentSpawned(
            sessionId = S,
            subagentId = sub,
            specialist = specialist,
            title = task,
            task = task,
            parentToolCallId = "tc_$sub",
        )

    /** Feed a child tool result into [sub]'s nested stream (start → tool → result). */
    private fun childResult(state: AgentChatState, sub: String, toolCallId: String, result: AgentToolResult): AgentChatState =
        reduce(
            state,
            AgentEvent.SubagentEvent(S, sub, "x", AgentEvent.MessageStart(sub, "$sub.m")),
            AgentEvent.SubagentEvent(S, sub, "x", AgentEvent.ToolStart(sub, "$sub.m", toolCallId, "search_documents", JsonNull, "q")),
            AgentEvent.SubagentEvent(S, sub, "x", AgentEvent.ToolResult(sub, "$sub.m", toolCallId, result, 3.0)),
        )

    // --- docsFromChildToolResult (pure, generic, no source-name branching) ---

    @Test
    fun docs_extracted_from_search_document_url_and_trail() {
        val search = AgentToolResult.SearchResults(
            query = "q",
            results = listOf(ref("d1", "gmail:me"), ref("d2", "google-drive:me")),
        )
        assertEquals(listOf("d1", "d2"), AgentReducer.docsFromChildToolResult(search).map { it.documentId })
        // Source identity rides the ref — never branched on a name.
        assertEquals("gmail:me", AgentReducer.docsFromChildToolResult(search).first().sourceId)

        val doc = AgentToolResult.DocumentResult(ref = ref("d3", "notes:local"))
        assertEquals(listOf("d3"), AgentReducer.docsFromChildToolResult(doc).map { it.documentId })

        val url = AgentToolResult.DocumentByUrl(url = "https://example.com/x", ref = ref("d4", "google-drive:me"))
        assertEquals(listOf("d4"), AgentReducer.docsFromChildToolResult(url).map { it.documentId })

        val trail = AgentToolResult.EventTrailBuilt(
            events = listOf(
                AgentTrailEvent(
                    eventId = "e1",
                    doc = AgentTrailEventDoc("td1", "Top", "gmail:me"),
                    attachments = listOf(AgentTrailEvent(eventId = "e1a", doc = AgentTrailEventDoc("td1a", "Att", "gmail:me"))),
                ),
            ),
        )
        assertEquals(listOf("td1", "td1a"), AgentReducer.docsFromChildToolResult(trail).map { it.documentId })
    }

    @Test
    fun docs_empty_for_non_document_results() {
        assertTrue(AgentReducer.docsFromChildToolResult(AgentToolResult.SqlRows(sql = "SELECT 1")).isEmpty())
        assertTrue(AgentReducer.docsFromChildToolResult(AgentToolResult.PlanUpdated()).isEmpty())
        assertTrue(AgentReducer.docsFromChildToolResult(AgentToolResult.ErrorResult("x", "y")).isEmpty())
        assertTrue(AgentReducer.docsFromChildToolResult(AgentToolResult.Unknown()).isEmpty())
    }

    // --- Live accumulation + dedup, per-researcher (no cross-leak) ---

    @Test
    fun each_researcher_accumulates_its_own_docs_no_cross_leak() {
        var s = reduce(seeded(), spawn("s.sub.a", "history-sweep", "A"), spawn("s.sub.b", "source-digest", "B"))
        s = childResult(s, "s.sub.a", "ca", AgentToolResult.SearchResults(results = listOf(ref("d1", "gmail:me"), ref("d2", "google-drive:me"))))
        s = childResult(s, "s.sub.b", "cb", AgentToolResult.DocumentResult(ref = ref("d3", "notes:local")))

        val panels = AgentReducer.researchPanels(s)
        assertEquals(2, panels.size)
        assertEquals(listOf("d1", "d2"), panels[0].docs.map { it.documentId })
        assertEquals(listOf("d3"), panels[1].docs.map { it.documentId })
    }

    @Test
    fun docs_deduped_by_document_id() {
        var s = reduce(seeded(), spawn("s.sub.a", "history-sweep", "A"))
        s = childResult(s, "s.sub.a", "c1", AgentToolResult.SearchResults(results = listOf(ref("dup", "gmail:me"), ref("d2", "gmail:me"))))
        s = childResult(s, "s.sub.a", "c2", AgentToolResult.DocumentResult(ref = ref("dup", "gmail:me")))
        assertEquals(listOf("dup", "d2"), AgentReducer.researchPanels(s).first().docs.map { it.documentId })
    }

    /** A bare result event (no preceding message.start / tool.start) still feeds the surface. */
    @Test
    fun docs_accrue_even_without_a_matching_transcript_part() {
        var s = reduce(seeded(), spawn("s.sub.a", "history-sweep", "A"))
        s = reduce(
            s,
            AgentEvent.SubagentEvent(
                S, "s.sub.a", "x",
                AgentEvent.ToolResult("s.sub.a", "m", "orphan", AgentToolResult.DocumentResult(ref = ref("dX", "gmail:me")), 1.0),
            ),
        )
        assertEquals(listOf("dX"), AgentReducer.researchPanels(s).first().docs.map { it.documentId })
    }

    // --- Gating + collapse ---

    @Test
    fun workspace_active_only_with_deep_research_and_a_researcher() {
        // Marker off, no researcher.
        assertFalse(AgentReducer.isResearchWorkspaceActive(AgentChatState()))
        // Marker on but still no panels.
        val markerOnly = AgentChatState(deepResearch = true)
        assertFalse(AgentReducer.isResearchWorkspaceActive(markerOnly))
        // Marker on + a researcher → active.
        val live = reduce(seeded().copy(deepResearch = true), spawn("s.sub.a", "history-sweep", "A"))
        assertTrue(AgentReducer.isResearchWorkspaceActive(live))
    }

    @Test
    fun spawned_card_activates_surface_even_without_marker() {
        // A sub-agent spawn IS the research signal — a replay demo cassette (or
        // an agent that fans out mid-turn) activates the working-set without the
        // slash pill. Still collapses on message.end (see the collapse test).
        val s = reduce(seeded(), spawn("s.sub.a", "history-sweep", "A"))
        assertFalse(AgentReducer.researchPanels(s).isEmpty())
        assertTrue(AgentReducer.isResearchWorkspaceActive(s))
        assertTrue(s.deepResearch)
    }

    @Test
    fun generic_worker_stays_in_ordinary_transcript() {
        val s = reduce(seeded(), spawn("s.sub.generic", "generic", "Compare periods"))

        assertFalse(AgentReducer.researchPanels(s).isEmpty())
        assertFalse(AgentReducer.isResearchWorkspaceActive(s))
        assertFalse(s.deepResearch)
    }

    @Test
    fun message_end_collapses_surface_but_keeps_cards() {
        val live = reduce(seeded().copy(deepResearch = true), spawn("s.sub.a", "history-sweep", "A"))
        assertTrue(AgentReducer.isResearchWorkspaceActive(live))
        val ended = reduce(live, AgentEvent.MessageEnd(S, M, "end_turn"))
        assertFalse(AgentReducer.isResearchWorkspaceActive(ended))
        assertFalse(AgentReducer.researchPanels(ended).isEmpty())
        assertFalse(ended.deepResearch)
    }

    @Test
    fun error_collapses_surface() {
        val live = reduce(seeded().copy(deepResearch = true), spawn("s.sub.a", "history-sweep", "A"))
        val errored = reduce(live, AgentEvent.ErrorEvent(S, M, "x", "boom"))
        assertFalse(AgentReducer.isResearchWorkspaceActive(errored))
        assertFalse(errored.deepResearch)
    }

    // --- Panel projection fidelity ---

    @Test
    fun panels_project_counters_and_finalised_tokens() {
        var s = reduce(seeded().copy(deepResearch = true), spawn("s.sub.a", "history-sweep", "Find docs"))
        s = childResult(s, "s.sub.a", "c1", AgentToolResult.SearchResults(results = listOf(ref("d1", "gmail:me", title = "Hit"))))
        s = reduce(
            s,
            AgentEvent.SubagentResult(
                S, "s.sub.a", "history-sweep", status = "complete", summary = "done",
                usage = AgentUsage(inputTokens = 100, outputTokens = 50),
            ),
        )
        val p = AgentReducer.researchPanels(s).first()
        assertEquals("history-sweep", p.specialist)
        assertEquals("Find docs", p.task)
        assertEquals("Hit", p.docs.first().title)
        assertEquals(1, p.stepCount)
        assertEquals(150, p.tokens)
        assertEquals("complete", p.status)
        assertEquals("done", p.summary)
    }

    // --- JSON-decode round-trip into the surface (#748 regression net) ---

    @Test
    fun decoded_subagent_search_result_reaches_research_panel_docs() {
        // Closes the in-memory-bypass gap: the earlier subagent reducer tests built `AgentEvent`
        // values in-hand and never crossed the JSON decoder, so a child-payload decode regression
        // (a thin wrapped event with NO sessionId/messageId dropping the whole event) slipped
        // through. Here the event is DECODED from the literal wire string the gateway sends, THEN
        // reduced — proving a faithfully-decoded sub-agent search hit reaches the surface's docs.
        var s = reduce(seeded(), spawn("s.sub.bank", "history-sweep", "Find the charge"))
        val event = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.subagent.event","payload":{"sessionId":"s","subagentId":"s.sub.bank","specialist":"history-sweep","event":{"type":"agent.tool.result","payload":{"toolCallId":"tc","durationMs":210,"result":{"kind":"search.results","query":"q","candidates":1,"results":[{"documentId":"d1","sourceType":"enable-banking-accounts","sourceId":"enable-banking-accounts:self","documentType":"transaction","title":"Tokyo Riverside Hotel","snippet":"...","ts":1775000000000}]}}}}}""",
        )
        s = reduce(s, event)

        val panel = AgentReducer.researchPanels(s).single()
        assertEquals("s.sub.bank", panel.subagentId)
        assertEquals(1, panel.docs.size)
        assertEquals("d1", panel.docs.first().documentId)
    }
}
