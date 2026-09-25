// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cross-surface tool-result contract — Android half.
 *
 * Loads the SAME canonical, invented fixture the TS round-trip test and the iOS
 * decode test load (`tool-result-contract.json` on the test classpath, a
 * byte-identical mirror of `packages/agent/src/__fixtures__/`), and asserts the
 * Kotlin `AgentToolResult` decoder reads every field this surface models off each
 * payload. The bug class guarded here is a field the server projects that a client
 * silently drops: the TS half proves the server emits it; this half proves Android
 * doesn't drop the ones it renders.
 *
 * Android deliberately does not model a few wire fields (a DocRef's `refCount` /
 * `breadcrumb`, a record citation's `primaryKeyColumns` / `snapshot`, a run_sql
 * result's `rowIdentities`); the contract for those is forward-compatibility (the
 * union's `ignoreUnknownKeys` decode-and-drops them), proven by a clean decode of
 * the full payload.
 */
class AgentToolResultContractDecodeTest {

    @Serializable
    private data class Fixture(val cases: List<Case>) {
        @Serializable
        data class Case(val kind: String, val wire: AgentToolResult)
    }

    private fun loadFixture(): Fixture {
        val raw = checkNotNull(
            javaClass.classLoader?.getResource("tool-result-contract.json")?.readText(),
        ) { "tool-result-contract.json not found on the test classpath" }
        return OmnesisJson.decodeFromString<Fixture>(raw)
    }

    private fun wire(kind: String, fixture: Fixture): AgentToolResult =
        fixture.cases.first { it.kind == kind }.wire

    @Test
    fun fixture_decodes_every_case_without_falling_to_unknown() {
        val fixture = loadFixture()
        assertTrue("fixture should carry every modelled kind", fixture.cases.size >= 7)
        for (c in fixture.cases) {
            assertTrue(
                "case '${c.kind}' decoded to Unknown — a modelled kind was dropped",
                c.wire !is AgentToolResult.Unknown,
            )
        }
    }

    @Test
    fun search_results_fields_decode() {
        val r = wire("search.results", loadFixture()) as AgentToolResult.SearchResults
        assertEquals("quarterly budget review", r.query)
        assertEquals(18.5, r.durationMs, 0.001)
        assertEquals(42, r.candidates)
        assertEquals(2, r.results.size)
        val top = r.results[0]
        assertEquals("doc-budget-001", top.documentId)
        assertEquals("demo-mail", top.sourceType)
        assertEquals("Q4 budget review agenda", top.title)
        assertEquals("text/plain", top.mimeType)
        assertEquals(listOf("Maya Reeves", "Jamie Lopez"), top.people)
        assertEquals("emails", top.unitName)
        assertEquals("demomail://message/doc-budget-001", top.appUrl)
        assertEquals(1_717_200_000_000.0, top.ts!!, 1.0)
    }

    @Test
    fun document_fields_decode() {
        val r = wire("document", loadFixture()) as AgentToolResult.DocumentResult
        assertEquals("doc-budget-001", r.ref.documentId)
        assertEquals(
            "Hi Jamie, here is the agenda for the quarterly budget review.",
            r.document?.content,
        )
        assertEquals(1, r.neighbors.size)
        assertEquals("doc-budget-002", r.neighbors[0].documentId)
        assertEquals("application/vnd.ms-excel", r.neighbors[0].mimeType)
    }

    @Test
    fun person_results_fields_decode() {
        val r = wire("person.results", loadFixture()) as AgentToolResult.PersonResults
        assertEquals("maya", r.query)
        assertEquals(4.25, r.durationMs, 0.001)
        assertEquals(1, r.results.size)
        val p = r.results[0]
        assertEquals("person-maya-reeves", p.canonicalId)
        assertEquals("Maya Reeves", p.displayName)
        assertEquals(3, p.aliases.size)
        assertEquals(31, p.emailCount)
        assertEquals(0.84, p.interactionScore!!, 0.001)
    }

    @Test
    fun annotate_recorded_fields_decode() {
        val r = wire("annotate.recorded", loadFixture()) as AgentToolResult.AnnotateRecorded
        assertEquals("doc-budget-001", r.documentId)
        assertEquals("doc-budget-001", r.ref.documentId)
        assertEquals("We agreed to revisit the travel line item.", r.quote)
        assertEquals("Key decision on the travel budget.", r.note)
        assertEquals("You", r.quoteAuthor)
        assertTrue("self-authored quote orientation must decode", r.quoteIsSelf)
    }

    @Test
    fun cite_record_recorded_fields_decode() {
        val r = wire("cite_record.recorded", loadFixture()) as AgentToolResult.CiteRecord
        assertEquals("demo_transactions", r.table)
        assertEquals("row:demo_transactions:txn-7781", r.recordKey)
        assertEquals("Stellar Sound — 42.00", r.title)
        assertEquals("Demo Transactions", r.tableDisplayName)
        assertEquals("2026-05-23T10:00:00.000Z", r.semanticTime)
        assertEquals("demo-bank:checking", r.sourceId)
        assertEquals("demo-bank", r.sourceType)
        assertEquals("doc-receipt-7781", r.boundDocumentId)
        // Mixed-type key field values coerce to display strings; explicit null → null.
        assertEquals(4, r.keyFields.size)
        assertEquals("Stellar Sound", r.keyFields[0].value)
        assertEquals("true", r.keyFields[2].value)
        assertNull(r.keyFields[3].value)
        // Projects onto the shared timeline-record render payload.
        assertEquals("row:demo_transactions:txn-7781", r.toTrailRecord().recordKey)
    }

    @Test
    fun event_trail_built_deduped_doc_plus_record_decodes() {
        val r = wire("event_trail.built", loadFixture()) as AgentToolResult.EventTrailBuilt
        assertEquals(listOf("doc-receipt-7781"), r.seeds)
        assertTrue(!r.truncated)
        assertEquals(1, r.events.size)
        val ev = r.events[0]
        assertEquals("doc-receipt-7781", ev.doc?.documentId)
        assertEquals("row:demo_transactions:txn-7781", ev.record?.recordKey)
        assertEquals("doc-receipt-7781", ev.entityId)
        assertEquals(1, ev.people.size)
        assertEquals("Maya Reeves", ev.people[0].name)
        assertEquals(1, ev.related.size)
        assertEquals("near-duplicate", ev.related[0].linkType)
        assertEquals("peer", ev.related[0].direction)
    }

    @Test
    fun sql_rows_fields_decode() {
        val r = wire("sql.rows", loadFixture()) as AgentToolResult.SqlRows
        assertTrue(r.sql.contains("demo_transactions"))
        assertEquals(listOf("id", "merchant", "amount"), r.columns)
        assertEquals(2, r.rows.size)
        assertEquals(2, r.rowCount)
        assertTrue(!r.truncated)
        assertEquals(2.75, r.durationMs, 0.001)
        assertEquals(1, r.sources.size)
        assertEquals("demo-bank:checking", r.sources[0].sourceId)
        assertEquals("Demo Bank", r.sources[0].displayName)
        assertEquals(listOf("Demo Transactions"), r.subjects)
        // rowIdentities is decode-and-dropped by the union (forward-compat) — a
        // clean decode of the full payload with rows intact is the contract here.
    }
}
