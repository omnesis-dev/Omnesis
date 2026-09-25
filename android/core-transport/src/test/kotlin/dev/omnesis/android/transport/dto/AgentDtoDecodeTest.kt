// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Decode tests for the agent SSE event + tool-result + chat-message unions. */
class AgentDtoDecodeTest {

    @Test
    fun text_delta_event_decodes_from_envelope() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.text.delta","payload":{"sessionId":"s","messageId":"m","delta":"hi"}}""",
        )
        assertTrue(e is AgentEvent.TextDelta)
        e as AgentEvent.TextDelta
        assertEquals("s", e.sessionId)
        assertEquals("hi", e.delta)
    }

    @Test
    fun tool_result_search_results_decodes() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","durationMs":12.5,"result":{"kind":"search.results","query":"budget","durationMs":12.5,"results":[{"documentId":"d1","title":"Q4"}]}}}""",
        )
        assertTrue(e is AgentEvent.ToolResult)
        val result = (e as AgentEvent.ToolResult).result
        assertTrue(result is AgentToolResult.SearchResults)
        result as AgentToolResult.SearchResults
        assertEquals("budget", result.query)
        assertEquals(1, result.results.size)
        assertEquals("d1", result.results[0].documentId)
    }

    @Test
    fun tool_result_unknown_kind_degrades() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","result":{"kind":"future.kind","whatever":true}}}""",
        )
        assertTrue((e as AgentEvent.ToolResult).result is AgentToolResult.Unknown)
    }

    @Test
    fun temporal_structured_result_preserves_projection_and_annotation_provenance() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","result":{"kind":"structured","resultType":"temporal.results","data":{"items":[{"id":"projection:visit-1","origin":"projection","projection":{"sourceId":"core-location-visits:phone","slot":"visit","documentId":"doc-visit"}},{"id":"annotation:deadline-1","origin":"annotation","annotation":{"documentIds":["doc-note"],"projectionIds":["projection:visit-1"],"revision":2}}]}}}}""",
        )
        val result = (e as AgentEvent.ToolResult).result as AgentToolResult.Structured
        assertEquals("temporal.results", result.resultType)
        val items = result.data.jsonObject["items"]!!.jsonArray
        assertEquals("projection", items[0].jsonObject["origin"]!!.jsonPrimitive.content)
        assertEquals(
            "core-location-visits:phone",
            items[0].jsonObject["projection"]!!.jsonObject["sourceId"]!!.jsonPrimitive.content,
        )
        assertEquals(
            "projection:visit-1",
            items[1].jsonObject["annotation"]!!.jsonObject["projectionIds"]!!.jsonArray[0].jsonPrimitive.content,
        )
    }

    @Test
    fun unknown_event_type_degrades() {
        val e = OmnesisJson.decodeFromString<AgentEvent>("""{"type":"agent.future.thing","payload":{}}""")
        assertTrue(e is AgentEvent.Unknown)
        assertEquals("agent.future.thing", (e as AgentEvent.Unknown).type)
    }

    @Test
    fun citation_event_decodes() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.citation","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","ref":{"documentId":"d"},"quote":"hello","quoteIsSelf":true}}""",
        )
        assertTrue(e is AgentEvent.Citation)
        e as AgentEvent.Citation
        assertEquals("hello", e.quote)
        assertTrue(e.quoteIsSelf)
    }

    @Test
    fun event_trail_record_only_event_decodes() {
        // A bound DuckDB row reached from the seed that binds no document (#757): `doc` is absent,
        // `record` carries the derived display strings, key fields coerce mixed wire types.
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","durationMs":3.0,"result":{"kind":"event_trail.built","seeds":["d1"],"truncated":false,"events":[{"eventId":"rec:health_workout|wk-1","at":"2026-05-02T07:14:00.000Z","kind":"record","record":{"recordKey":"health_workout|wk-1","table":"health_workout","tableDisplayName":"Workouts","title":"Morning run","keyFields":[{"label":"Distance","value":5.2},{"label":"Active","value":true},{"label":"Notes","value":null}],"semanticTime":"2026-05-02T07:14:00.000Z","sourceId":"demo-fitness:device","sourceType":"demo-fitness","boundDocumentId":null}}]}}}""",
        )
        val result = (e as AgentEvent.ToolResult).result as AgentToolResult.EventTrailBuilt
        assertEquals(1, result.events.size)
        val ev = result.events[0]
        assertEquals(null, ev.doc)
        val rec = ev.record!!
        assertEquals("health_workout|wk-1", rec.recordKey)
        assertEquals("Morning run", rec.title)
        assertEquals("health_workout|wk-1", ev.entityId)
        assertEquals("demo-fitness:device", ev.eventSourceId)
        assertEquals(null, rec.boundDocumentId)
        // Mixed wire types coerce to display strings: integral-vs-fractional double, bool stays,
        // explicit null becomes a null display value (an em-dash at the renderer).
        assertEquals("5.2", rec.keyFields[0].value)
        assertEquals("true", rec.keyFields[1].value)
        assertEquals(null, rec.keyFields[2].value)
    }

    @Test
    fun event_trail_deduped_doc_plus_record_event_decodes() {
        // A document and its same-entity row collapsed into ONE event (#757): both `doc` and
        // `record` present; the event keys (entityId) on the doc, and the bound doc deep-links.
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","durationMs":3.0,"result":{"kind":"event_trail.built","seeds":["doc-run"],"truncated":false,"events":[{"eventId":"doc-run","at":"2026-05-02T07:14:00.000Z","kind":"document","doc":{"documentId":"doc-run","title":"Morning run","sourceId":"demo-fitness:device","documentType":"event"},"record":{"recordKey":"health_workout|wk-1","table":"health_workout","tableDisplayName":"Workouts","title":"Morning run","keyFields":[{"label":"Distance","value":"5.2 km"}],"semanticTime":"2026-05-02T07:14:00.000Z","sourceId":"demo-fitness:device","sourceType":"demo-fitness","boundDocumentId":"doc-run"}}]}}}""",
        )
        val result = (e as AgentEvent.ToolResult).result as AgentToolResult.EventTrailBuilt
        val ev = result.events[0]
        assertEquals("doc-run", ev.doc?.documentId)
        assertEquals("doc-run", ev.entityId) // the doc wins the entity identity over the record key
        assertEquals("doc-run", ev.record?.boundDocumentId)
        assertEquals("5.2 km", ev.record?.keyFields?.get(0)?.value)
    }

    @Test
    fun cite_record_recorded_result_decodes() {
        // A directly-cited DuckDB row (#757): `cite_record.recorded` carries the derived display
        // strings; key fields coerce mixed wire types; the bound document deep-links.
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","durationMs":4.0,"result":{"kind":"cite_record.recorded","table":"demo_fitness.workouts","recordKey":"demo_fitness.workouts|wk-1","primaryKeyColumns":[{"name":"id","value":"wk-1"}],"title":"Morning run","keyFields":[{"label":"Distance","value":5.2},{"label":"Active","value":true},{"label":"Notes","value":null}],"semanticTime":"2026-05-02T07:14:00.000Z","snapshot":{"id":"wk-1","distance_km":5.2},"sourceId":"demo-fitness:device","sourceType":"demo-fitness","tableDisplayName":"Workouts","boundDocumentId":"doc-run"}}}""",
        )
        assertTrue(e is AgentEvent.ToolResult)
        val result = (e as AgentEvent.ToolResult).result
        assertTrue(result is AgentToolResult.CiteRecord)
        result as AgentToolResult.CiteRecord
        assertEquals("demo_fitness.workouts", result.table)
        assertEquals("demo_fitness.workouts|wk-1", result.recordKey)
        assertEquals("Morning run", result.title)
        assertEquals("Workouts", result.tableDisplayName)
        assertEquals("2026-05-02T07:14:00.000Z", result.semanticTime)
        assertEquals("demo-fitness:device", result.sourceId)
        assertEquals("doc-run", result.boundDocumentId)
        // Mixed wire types coerce to display strings, matching the shared key-field serializer.
        assertEquals("5.2", result.keyFields[0].value)
        assertEquals("true", result.keyFields[1].value)
        assertEquals(null, result.keyFields[2].value)
        // Projects onto the shared timeline-record payload the renderer consumes.
        val record = result.toTrailRecord()
        assertEquals("demo_fitness.workouts|wk-1", record.recordKey)
        assertEquals("Morning run", record.title)
        assertEquals("doc-run", record.boundDocumentId)
    }

    @Test
    fun tool_result_loops_searched_decodes() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","durationMs":6.0,"result":{"kind":"loops.searched","query":"deposit refund","durationMs":6.0,"loops":[{"loopId":"l1","title":"Chase Riverside Estate deposit refund","state":"open","importance":0.8,"deadline":"2026-07-20"},{"loopId":"l2","title":"Confirm caterer headcount","state":"snoozed"}]}}}""",
        )
        val result = (e as AgentEvent.ToolResult).result
        assertTrue(result is AgentToolResult.LoopsSearched)
        result as AgentToolResult.LoopsSearched
        assertEquals("deposit refund", result.query)
        assertEquals(2, result.loops.size)
        assertEquals("l1", result.loops[0].loopId)
        assertEquals("Chase Riverside Estate deposit refund", result.loops[0].title)
        assertEquals("open", result.loops[0].state)
        assertEquals(0.8, result.loops[0].importance!!, 0.001)
        assertEquals("2026-07-20", result.loops[0].deadline)
        assertEquals("snoozed", result.loops[1].state)
        assertNull(result.loops[1].deadline)
    }

    @Test
    fun tool_result_loop_fetched_decodes() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","result":{"kind":"loop.fetched","loop":{"loopId":"l1","title":"Chase deposit refund","state":"open","importance":0.8,"deadline":"2026-07-20","actors":["Maya Reeves"],"involved":["David Lin"],"docIds":["d1","d2"],"ledger":[{"at":1716000000000,"note":"Opened after the booking thread."},{"at":1716400000000,"note":"Maya emailed the venue."}]}}}}""",
        )
        val result = (e as AgentEvent.ToolResult).result as AgentToolResult.LoopFetched
        val loop = result.loop!!
        assertEquals("l1", loop.loopId)
        assertEquals("open", loop.state)
        assertEquals(0.8, loop.importance!!, 0.001)
        assertEquals(listOf("Maya Reeves"), loop.actors)
        assertEquals(listOf("David Lin"), loop.involved)
        assertEquals(listOf("d1", "d2"), loop.docIds)
        assertEquals(2, loop.ledger!!.size)
        assertEquals(1_716_000_000_000L, loop.ledger!![0].at)
        assertEquals("Maya emailed the venue.", loop.ledger!![1].note)
    }

    @Test
    fun tool_result_loop_fetched_no_match_decodes_null_loop() {
        // A clean no-match: the `loop` field is absent (not an error kind).
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","result":{"kind":"loop.fetched"}}}""",
        )
        val result = (e as AgentEvent.ToolResult).result as AgentToolResult.LoopFetched
        assertNull(result.loop)
    }

    @Test
    fun doc_ref_open_loops_and_annotations_decode() {
        // A search hit whose DocRef carries the experimental inline loop + annotation hints.
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","result":{"kind":"search.results","query":"refund","durationMs":5.0,"results":[{"documentId":"d1","title":"Refund request","openLoops":[{"loopId":"l1","title":"Chase deposit refund","state":"open","importance":0.8}],"annotations":[{"claimType":"commitment-status","claim":"Refund still pending","confidence":0.7}]}]}}}""",
        )
        val ref = ((e as AgentEvent.ToolResult).result as AgentToolResult.SearchResults).results[0]
        assertEquals(1, ref.openLoops!!.size)
        assertEquals("l1", ref.openLoops!![0].loopId)
        assertEquals("open", ref.openLoops!![0].state)
        assertEquals(0.8, ref.openLoops!![0].importance!!, 0.001)
        assertEquals(1, ref.annotations!!.size)
        assertEquals("commitment-status", ref.annotations!![0].claimType)
        assertEquals("Refund still pending", ref.annotations!![0].claim)
        assertEquals(0.7, ref.annotations!![0].confidence, 0.001)
    }

    @Test
    fun doc_ref_without_loops_decodes_null() {
        // Forward/back-compat: a DocRef with no loop fields decodes to null lists (not empty),
        // so a non-experimental gateway's payloads keep decoding unchanged.
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"t","result":{"kind":"search.results","query":"q","durationMs":1.0,"results":[{"documentId":"d1","title":"Plain"}]}}}""",
        )
        val ref = ((e as AgentEvent.ToolResult).result as AgentToolResult.SearchResults).results[0]
        assertNull(ref.openLoops)
        assertNull(ref.annotations)
    }

    // --- batch tools: search_many / fetch_many / annotate_many ---

    @Test
    fun tool_result_search_batch_decodes_items_reusing_singular_shapes() {
        // One batch tool_result whose items reuse the SINGULAR result shape — a search.results and
        // a per-child error in its slot (one failed child never discards the batch).
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"tc","durationMs":9.0,"result":{"kind":"search.batch","items":[{"kind":"search.results","query":"budget","durationMs":4.0,"results":[{"documentId":"d1","title":"Q4 budget"}]},{"kind":"error","code":"timeout","message":"child 1 timed out"}]}}}""",
        )
        val result = (e as AgentEvent.ToolResult).result
        assertTrue(result is AgentToolResult.SearchBatch)
        result as AgentToolResult.SearchBatch
        assertEquals(2, result.items.size)
        val first = result.items[0] as AgentToolResult.SearchResults
        assertEquals("budget", first.query)
        assertEquals("d1", first.results[0].documentId)
        assertEquals("timeout", (result.items[1] as AgentToolResult.ErrorResult).code)
    }

    @Test
    fun tool_result_document_batch_decodes_items() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"tc","result":{"kind":"document.batch","items":[{"kind":"document","ref":{"documentId":"d1","title":"Contract"}},{"kind":"document","ref":{"documentId":"d2","title":"Invoice"}}]}}}""",
        )
        val result = (e as AgentEvent.ToolResult).result as AgentToolResult.DocumentBatch
        assertEquals(2, result.items.size)
        assertEquals("d1", (result.items[0] as AgentToolResult.DocumentResult).ref.documentId)
        assertEquals("Invoice", (result.items[1] as AgentToolResult.DocumentResult).ref.title)
    }

    @Test
    fun tool_result_annotate_batch_decodes_items() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"tc","result":{"kind":"annotate.batch","items":[{"kind":"annotate.recorded","documentId":"d1","ref":{"documentId":"d1","title":"Lease"},"quote":"rent is due monthly"},{"kind":"annotate.recorded","documentId":"d2","ref":{"documentId":"d2","title":"Note"},"note":"context"}]}}}""",
        )
        val result = (e as AgentEvent.ToolResult).result as AgentToolResult.AnnotateBatch
        assertEquals(2, result.items.size)
        val first = result.items[0] as AgentToolResult.AnnotateRecorded
        assertEquals("d1", first.documentId)
        assertEquals("rent is due monthly", first.quote)
        val second = result.items[1] as AgentToolResult.AnnotateRecorded
        assertEquals("context", second.note)
        assertNull(second.quote)
    }

    @Test
    fun tool_child_start_event_decodes() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.child.start","payload":{"sessionId":"s","messageId":"m","toolCallId":"tc","childIndex":2,"tool":"search_documents","argsSummary":"budget review"}}""",
        )
        assertTrue(e is AgentEvent.ToolChildStart)
        e as AgentEvent.ToolChildStart
        assertEquals("tc", e.toolCallId)
        assertEquals(2, e.childIndex)
        assertEquals("search_documents", e.tool)
        assertEquals("budget review", e.argsSummary)
    }

    @Test
    fun tool_child_result_event_decodes_singular_result() {
        // The child result reuses the SINGULAR result shape (a document here), keyed to the parent
        // batch call by (toolCallId, childIndex).
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.tool.child.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"tc","childIndex":0,"result":{"kind":"document","ref":{"documentId":"d1","title":"Contract"}}}}""",
        )
        assertTrue(e is AgentEvent.ToolChildResult)
        e as AgentEvent.ToolChildResult
        assertEquals("tc", e.toolCallId)
        assertEquals(0, e.childIndex)
        assertEquals("d1", (e.result as AgentToolResult.DocumentResult).ref.documentId)
    }

    @Test
    fun chat_message_user_with_text_and_tool_result() {
        val m = OmnesisJson.decodeFromString<ChatMessage>(
            """{"role":"user","parts":[{"kind":"text","text":"hi"},{"kind":"tool_result","toolCallId":"t","result":{"kind":"error","code":"x","message":"y"}}]}""",
        )
        assertTrue(m is ChatMessage.User)
        m as ChatMessage.User
        assertEquals(2, m.parts.size)
        assertTrue(m.parts[0] is UserPart.Text)
        assertTrue(m.parts[1] is UserPart.ToolResultPart)
    }

    @Test
    fun chat_message_assistant_with_tool_use_and_thinking() {
        val m = OmnesisJson.decodeFromString<ChatMessage>(
            """{"role":"assistant","parts":[{"kind":"thinking","text":"hmm"},{"kind":"tool_use","toolCallId":"t","tool":"search_documents","args":{"query":"q"}}]}""",
        )
        assertTrue(m is ChatMessage.Assistant)
        m as ChatMessage.Assistant
        assertTrue(m.parts[0] is AssistantPart.Thinking)
        assertTrue(m.parts[1] is AssistantPart.ToolUse)
        assertEquals("search_documents", (m.parts[1] as AssistantPart.ToolUse).tool)
    }

    @Test
    fun chat_message_assistant_with_report_artifact_part_decodes() {
        // The persisted Deep Research write-back part (#748) — structured facts + the merged
        // citation set — decodes from the literal wire string the gateway writes. A strict/
        // non-tolerant decode would discard the part, so a reloaded conversation would silently
        // lose its verified-report card. Mirrors the iOS testReportArtifactPartDecodesFromWire.
        val m = OmnesisJson.decodeFromString<ChatMessage>(
            """{"role":"assistant","parts":[{"kind":"text","text":"It was a hotel booking."},{"kind":"report_artifact","stoppedReason":"answer_complete","plan":[{"specialist":"history-sweep","task":"Find the charge"}],"treeUsage":{"inputTokens":7200,"outputTokens":2100},"verification":{"quotesChecked":3,"quotesVerified":3},"citations":[{"documentId":"d1","sourceType":"enable-banking-accounts","sourceId":"enable-banking-accounts:self","title":"Tokyo Riverside Hotel"}]}]}""",
        )
        assertTrue(m is ChatMessage.Assistant)
        m as ChatMessage.Assistant
        assertEquals(2, m.parts.size)
        assertTrue(m.parts[0] is AssistantPart.Text)
        assertTrue(m.parts[1] is AssistantPart.ReportArtifact)
        val artifact = m.parts[1] as AssistantPart.ReportArtifact
        assertEquals("answer_complete", artifact.stoppedReason)
        assertEquals(1, artifact.plan.size)
        assertEquals("history-sweep", artifact.plan[0].specialist)
        assertEquals(9300, artifact.treeUsage?.total)
        assertEquals(3, artifact.verification.quotesChecked)
        assertEquals(3, artifact.verification.quotesVerified)
        assertEquals(1, artifact.citations.size)
        assertEquals("d1", artifact.citations[0].documentId)
    }

    @Test
    fun create_session_response_decodes_history() {
        val resp = OmnesisJson.decodeFromString<CreateSessionResponse>(
            """{"sessionId":"s","model":"m","backend":"b","title":"T","messageCount":1,"messages":[{"role":"user","parts":[{"kind":"text","text":"hi"}]}],"origin":{"kind":"watch_firing","watchId":"watch_example","runId":"run_example","watch":{"name":"Quarterly budget changed","condition":"the approved quarterly budget changes","firedAt":1789344600000},"seedMessageCount":1}}""",
        )
        assertEquals("s", resp.sessionId)
        assertEquals(1, resp.messages.size)
        assertEquals("watch_example", resp.origin?.watchId)
    }

    @Test
    fun message_end_decodes_authoritative_context_failure() {
        val event = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.message.end","payload":{"sessionId":"s","messageId":"m","stopReason":"error","failure":{"code":"context_window_exceeded","message":"This conversation no longer fits in the selected model's context window. Start a new conversation to continue.","retryable":false,"backend":"openai-compatible","model":"fictional-model"},"context":{"inputTokens":130000,"maxInputTokens":128000,"measurement":"provider_reported","limitSource":"provider","requestIteration":1}}}""",
        )

        assertTrue(event is AgentEvent.MessageEnd)
        event as AgentEvent.MessageEnd
        assertEquals("context_window_exceeded", event.failure?.code)
        assertEquals(130_000, event.context?.inputTokens)
        assertEquals(128_000, event.context?.maxInputTokens)
        assertEquals(null, event.context?.contextWindowTokens)
    }

    @Test
    fun message_end_decodes_authoritative_output_truncation() {
        val event = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.message.end","payload":{"sessionId":"s","messageId":"m","stopReason":"max_tokens","failure":{"code":"output_truncated","message":"The model reached its output limit before completing this response.","retryable":false,"backend":"openai-compatible","model":"fictional-model"}}}""",
        )

        assertTrue(event is AgentEvent.MessageEnd)
        event as AgentEvent.MessageEnd
        assertEquals("max_tokens", event.stopReason)
        assertEquals("output_truncated", event.failure?.code)
    }

    @Test
    fun create_session_response_decodes_terminal_context_failure() {
        val response = OmnesisJson.decodeFromString<CreateSessionResponse>(
            """{"sessionId":"s","model":"fictional-model","backend":"openai-compatible","terminalFailure":{"code":"context_window_exceeded","message":"This conversation no longer fits in the selected model's context window. Start a new conversation to continue.","retryable":false,"backend":"openai-compatible","model":"fictional-model","failedAt":"2026-07-29T12:00:00.000Z","context":{"measurement":"provider_reported","limitSource":"provider","requestIteration":1}}}""",
        )

        assertEquals("context_window_exceeded", response.terminalFailure?.code)
        assertEquals("provider_reported", response.terminalFailure?.context?.measurement)
    }

    @Test
    fun create_session_response_decodes_durable_output_truncation() {
        val response = OmnesisJson.decodeFromString<CreateSessionResponse>(
            """{"sessionId":"s","model":"fictional-model","backend":"openai-compatible","messages":[],"lastTurnFailure":{"code":"output_truncated","message":"The model reached its output limit before completing this response.","retryable":false,"backend":"openai-compatible","model":"fictional-model"}}""",
        )

        assertEquals("output_truncated", response.lastTurnFailure?.code)
        assertNull(response.terminalFailure)
    }

    // --- Sub-agent events (#748) ---

    @Test
    fun subagent_spawned_event_decodes() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.subagent.spawned","payload":{"sessionId":"s","subagentId":"s.sub.a1","specialist":"history-sweep","task":"Find prior decisions about the budget","parentToolCallId":"tc1"}}""",
        )
        assertTrue(e is AgentEvent.SubagentSpawned)
        e as AgentEvent.SubagentSpawned
        assertEquals("s.sub.a1", e.subagentId)
        assertEquals("history-sweep", e.specialist)
        assertEquals("Find prior decisions about the budget", e.task)
        assertEquals("tc1", e.parentToolCallId)
    }

    @Test
    fun subagent_event_wraps_inner_event_one_level_of_recursion() {
        // The wrapped child event is itself an { type, payload } envelope — decoded one
        // level of recursion through the same serializer.
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.subagent.event","payload":{"sessionId":"s","subagentId":"s.sub.a1","specialist":"history-sweep","event":{"type":"agent.text.delta","payload":{"sessionId":"s.sub.a1","messageId":"m","delta":"working"}}}}""",
        )
        assertTrue(e is AgentEvent.SubagentEvent)
        e as AgentEvent.SubagentEvent
        assertEquals("s.sub.a1", e.subagentId)
        val inner = e.event
        assertTrue(inner is AgentEvent.TextDelta)
        assertEquals("working", (inner as AgentEvent.TextDelta).delta)
    }

    @Test
    fun subagent_event_with_thin_child_search_result_decodes_not_dropped() {
        // Regression net (#748): a wrapped `agent.tool.result` carrying a `search.results`
        // payload, with NO sessionId/messageId on the child (the parent envelope already names
        // the session). A strict child payload would throw and discard the whole sub-agent event,
        // so the researcher silently loses its nested search results. The decode must keep the doc.
        // Mirrors the iOS testSubagentEventWithThinChildSearchResultDecodesNotDropped.
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.subagent.event","payload":{"sessionId":"s","subagentId":"s.sub.bank","specialist":"history-sweep","event":{"type":"agent.tool.result","payload":{"toolCallId":"tc","durationMs":210,"result":{"kind":"search.results","query":"q","candidates":1,"results":[{"documentId":"d1","sourceType":"enable-banking-accounts","sourceId":"enable-banking-accounts:self","documentType":"transaction","title":"Tokyo Riverside Hotel","snippet":"...","ts":1775000000000}]}}}}}""",
        )
        assertTrue(e is AgentEvent.SubagentEvent)
        e as AgentEvent.SubagentEvent
        assertEquals("s.sub.bank", e.subagentId)
        val inner = e.event
        assertTrue(inner is AgentEvent.ToolResult)
        inner as AgentEvent.ToolResult
        assertEquals("tc", inner.toolCallId)
        val result = inner.result
        assertTrue(result is AgentToolResult.SearchResults)
        result as AgentToolResult.SearchResults
        // The doc survived — NOT dropped to an empty set.
        assertEquals(1, result.results.size)
        assertEquals("d1", result.results[0].documentId)
        assertEquals("enable-banking-accounts:self", result.results[0].sourceId)
        assertEquals("Tokyo Riverside Hotel", result.results[0].title)
    }

    @Test
    fun subagent_event_with_unknown_inner_kind_degrades_to_unknown() {
        // An inner event kind this build doesn't recognise lands on AgentEvent.Unknown
        // (graceful degrade — the AgentPart.Unknown twin) rather than throwing.
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.subagent.event","payload":{"sessionId":"s","subagentId":"s.sub.a1","specialist":"history-sweep","event":{"type":"agent.future.thing","payload":{}}}}""",
        )
        assertTrue(e is AgentEvent.SubagentEvent)
        val inner = (e as AgentEvent.SubagentEvent).event
        assertTrue(inner is AgentEvent.Unknown)
        assertEquals("agent.future.thing", (inner as AgentEvent.Unknown).type)
    }

    @Test
    fun subagent_result_event_decodes_with_usage_and_tree_usage() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.subagent.result","payload":{"sessionId":"s","subagentId":"s.sub.a1","specialist":"history-sweep","status":"complete","summary":"Found three prior threads.","citations":[{"documentId":"d1","sourceId":"notes:local","title":"Budget note"}],"usage":{"inputTokens":900,"outputTokens":340},"treeUsage":{"inputTokens":4200,"outputTokens":1100}}}""",
        )
        assertTrue(e is AgentEvent.SubagentResult)
        e as AgentEvent.SubagentResult
        assertEquals("complete", e.status)
        assertEquals("Found three prior threads.", e.summary)
        assertEquals(1, e.citations.size)
        assertEquals(1240, e.usage!!.total)
        assertEquals(5300, e.treeUsage!!.total)
    }

    @Test
    fun child_message_end_decodes_usage_for_live_researcher_tokens() {
        val event = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.subagent.event","payload":{"sessionId":"s","subagentId":"s.sub.a","specialist":"history-sweep","event":{"type":"agent.message.end","payload":{"sessionId":"s.sub.a","messageId":"m","stopReason":"tool_use","usage":{"inputTokens":800,"outputTokens":200}}}}}""",
        ) as AgentEvent.SubagentEvent
        val child = event.event as AgentEvent.MessageEnd
        assertEquals(1_000, child.usage?.total)
    }

    @Test
    fun subagent_result_event_decodes_without_optional_usage() {
        // A run that never reported tokens omits usage/treeUsage; the card still finalises.
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.subagent.result","payload":{"sessionId":"s","subagentId":"s.sub.a1","specialist":"source-digest","status":"failed","summary":"No matches."}}""",
        )
        e as AgentEvent.SubagentResult
        assertEquals("failed", e.status)
        assertEquals(null, e.usage)
        assertEquals(null, e.treeUsage)
        assertTrue(e.citations.isEmpty())
    }

    // --- verified-report artifact: agent.deep_research.summary (#748) ---

    @Test
    fun deep_research_summary_event_decodes() {
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.deep_research.summary","payload":{"sessionId":"s","messageId":"a1","stoppedReason":"answer_complete","plan":[{"specialist":"history-sweep","task":"Find prior decisions"},{"specialist":"source-digest","task":"Summarize the tracker"}],"treeUsage":{"inputTokens":7200,"outputTokens":2100},"verification":{"quotesChecked":4,"quotesVerified":4}}}""",
        )
        e as AgentEvent.DeepResearchSummary
        assertEquals("a1", e.messageId)
        assertEquals("answer_complete", e.stoppedReason)
        assertEquals(2, e.plan.size)
        assertEquals("history-sweep", e.plan[0].specialist)
        assertEquals(9300, e.treeUsage?.total)
        assertEquals(4, e.verification.quotesChecked)
        assertEquals(4, e.verification.quotesVerified)
    }

    @Test
    fun deep_research_summary_with_unknown_stopped_reason_decodes_as_open_string() {
        // A stoppedReason the gateway adds after this build shipped still decodes — the
        // badge label falls back to the raw value rather than dropping the artifact.
        val e = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.deep_research.summary","payload":{"sessionId":"s","messageId":"a1","stoppedReason":"some_future_reason","verification":{"quotesChecked":0,"quotesVerified":0}}}""",
        )
        e as AgentEvent.DeepResearchSummary
        assertEquals("some_future_reason", e.stoppedReason)
        assertTrue(e.plan.isEmpty())
        assertEquals(null, e.treeUsage)
        assertEquals(0, e.verification.quotesChecked)
    }

    @Test
    fun resync_control_event_decodes() {
        // The gateway's out-of-band reload signal — payload is `{}`, no sessionId.
        val e = OmnesisJson.decodeFromString<AgentEvent>("""{"type":"agent.resync","payload":{}}""")
        assertTrue(e is AgentEvent.Resync)
    }

    @Test
    fun create_session_response_decodes_busy_flag() {
        val r = OmnesisJson.decodeFromString<CreateSessionResponse>(
            """{"sessionId":"s","model":"m","backend":"b","title":"t","messageCount":2,"busy":true,"messages":[]}""",
        )
        assertTrue(r.busy)
    }

    @Test
    fun create_session_response_busy_defaults_false_when_omitted() {
        // An older gateway omits `busy`; the client must treat the session as idle.
        val r = OmnesisJson.decodeFromString<CreateSessionResponse>(
            """{"sessionId":"s","model":"m","backend":"b"}""",
        )
        assertFalse(r.busy)
    }
}
