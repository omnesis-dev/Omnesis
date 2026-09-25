// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.AgentTrailEvent
import dev.omnesis.android.transport.dto.AgentTrailEventDoc
import dev.omnesis.android.transport.dto.AgentTrailRecord
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit cover for [AgentTimelineBuilder]. The timeline is built PURELY from what the agent
 * explicitly referenced — `annotate` citations (→ document rows) and `cite_record` records
 * (#757, → record-only rows); a graph walk's raw output never populates it. All fixtures are
 * invented (privacy rule): the `demo-fitness` Morning-run workout the portal and iOS renderers
 * use, never corpus data.
 */
class TrailTimelineBuilderTest {

    @Test
    fun same_resource_uses_representation_vocabulary() {
        assertEquals(
            "another representation of",
            TrailTimelineFormat.phraseForLinkType("same-resource", "out"),
        )
        assertTrue(TrailTimelineFormat.isDuplicateLikeLinkType("same-resource"))
    }

    private fun doc(id: String, source: String = "gmail:demo") =
        AgentTrailEventDoc(documentId = id, title = id, sourceId = source)

    /** Epoch seconds for an ISO instant — the shape a citation ref's `ts` carries. */
    private fun tsOf(iso: String): Double = java.time.Instant.parse(iso).epochSecond.toDouble()

    private fun citation(id: String, ts: Double? = null, source: String = "gmail:demo") =
        AgentCitation(
            documentId = id,
            ref = AgentDocRef(documentId = id, sourceId = source, title = id, ts = ts),
            entries = listOf(
                AgentCitationEntry(
                    toolCallId = "tc-$id", messageId = "m-$id",
                    quote = "quote for $id", note = null, quoteAuthor = null,
                ),
            ),
        )

    private fun record(key: String, boundDoc: String? = null) = AgentTrailRecord(
        recordKey = key,
        table = "health_workout",
        tableDisplayName = "Workouts",
        title = "Morning run",
        semanticTime = "2026-05-02T07:14:00.000Z",
        sourceId = "demo-fitness:device",
        sourceType = "demo-fitness",
        boundDocumentId = boundDoc,
    )

    /** Drive a chain of SSE events through the pure reducer, as the live agent stream does. */
    private fun reduce(state: AgentChatState, vararg events: AgentEvent): AgentChatState {
        var s = state
        for (e in events) s = AgentReducer.reduce(s, e)
        return s
    }

    @Test
    fun citation_synthesises_a_document_event() {
        // An `annotate` citation becomes one document row keyed on its documentId, at the ref's ts.
        val out = AgentTimelineBuilder.buildUnifiedTimeline(
            citations = listOf(citation("b1", tsOf("2026-05-02T09:00:00Z"))),
            records = emptyList(),
        )
        assertEquals(1, out.size)
        assertEquals("b1", out[0].entityId)
        assertEquals("b1", out[0].doc?.documentId)
        assertEquals("annotate", out[0].kind)
        assertEquals("cite:b1", out[0].eventId)
        assertEquals("2026-05-02T09:00:00Z", out[0].at)
    }

    @Test
    fun directly_cited_record_synthesises_a_record_only_event() {
        // A record reached via `cite_record` (#757) appears as a record-only event keyed on its
        // recordKey, carrying no doc, at its semanticTime.
        val out = AgentTimelineBuilder.buildUnifiedTimeline(
            citations = emptyList(),
            records = listOf(record("health_workout|wk-9")),
        )
        assertEquals(1, out.size)
        assertEquals("health_workout|wk-9", out[0].entityId)
        assertEquals(null, out[0].doc)
        assertEquals("health_workout|wk-9", out[0].record?.recordKey)
        assertEquals("cite:health_workout|wk-9", out[0].eventId)
        assertEquals("2026-05-02T07:14:00.000Z", out[0].at)
    }

    @Test
    fun citations_and_records_interleave_chronologically() {
        val out = AgentTimelineBuilder.buildUnifiedTimeline(
            citations = listOf(
                citation("late", tsOf("2026-05-03T18:00:00Z")),
                citation("early", tsOf("2026-05-01T09:00:00Z")),
            ),
            records = listOf(record("health_workout|wk-mid")), // semanticTime sits between the two
        )
        assertEquals(listOf("early", "health_workout|wk-mid", "late"), out.map { it.entityId })
    }

    @Test
    fun nil_time_rows_sink_to_bottom_in_entity_id_order() {
        val out = AgentTimelineBuilder.buildUnifiedTimeline(
            citations = listOf(
                citation("z-undated"),
                citation("a-undated"),
                citation("timed", tsOf("2026-05-01T09:00:00Z")),
            ),
            records = emptyList(),
        )
        assertEquals(listOf("timed", "a-undated", "z-undated"), out.map { it.entityId })
    }

    @Test
    fun graph_walk_result_contributes_nothing_to_the_timeline() {
        // Drive a `trace_connections` (graph-walk) result through the reducer — as the live agent
        // stream does — and confirm it feeds NEITHER of the two channels the drawer's Timeline
        // renders: `citations` (annotate) and `records` (cite_record) both stay empty. The walk's
        // docs surface only in the live ephemeral card, never the Timeline. Mirrors portal + iOS,
        // which likewise dropped the walk → Timeline path.
        val walk = AgentToolResult.EventTrailBuilt(
            seeds = listOf("seed-1"),
            events = listOf(
                AgentTrailEvent(eventId = "w1", kind = "document", doc = doc("walked-1")),
                AgentTrailEvent(eventId = "w2", kind = "document", doc = doc("walked-2")),
            ),
        )
        val state = reduce(
            AgentChatState(),
            AgentEvent.MessageStart("s", "m"),
            AgentEvent.ToolStart("s", "m", "tc1", "trace_connections", JsonNull, "seed-1"),
            AgentEvent.ToolResult("s", "m", "tc1", walk, 3.0),
        )
        assertTrue(state.citations.isEmpty())
        assertTrue(state.records.isEmpty())
        // …so the Timeline built from that state is empty — the walk contributed nothing.
        assertTrue(AgentTimelineBuilder.buildUnifiedTimeline(state.citations, state.records).isEmpty())
    }

    @Test
    fun empty_inputs_yield_an_empty_timeline() {
        assertEquals(
            emptyList<AgentTrailEvent>(),
            AgentTimelineBuilder.buildUnifiedTimeline(citations = emptyList(), records = emptyList()),
        )
    }
}
