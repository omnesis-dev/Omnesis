// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.AssistantPart
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.UserPart
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Port of the iOS `AgentTurnBuilderTests` — the canonical history → render-shape
 * conversion. The interesting edges are how a `user` message folds into the assistant
 * turn being built: tool_result-only folds in place; text-only starts a fresh turn; BOTH
 * folds the tool_results AND then starts a new user turn with the text.
 */
class AgentTurnBuilderTest {

    @Test
    fun interactive_memory_toolset_is_ephemeral() {
        val memoryTools = setOf(
            "conversation_memory_evidence", "annotation_search", "annotate_durable",
            "annotation_revise", "annotation_retract", "annotation_supersede",
            "annotate_person", "person_annotation_revise", "person_annotation_retract",
            "person_annotation_supersede",
        )
        assertTrue(AgentReducer.EPHEMERAL_TOOLS.containsAll(memoryTools))
    }

    private fun args(vararg pairs: Pair<String, Any>) = JsonObject(
        pairs.associate { (k, v) ->
            k to when (v) {
                is Boolean -> JsonPrimitive(v)
                is Int -> JsonPrimitive(v)
                else -> JsonPrimitive(v.toString())
            }
        },
    )

    private fun err(code: String, msg: String): AgentToolResult = AgentToolResult.ErrorResult(code, msg)

    private fun citeRecord(key: String, boundDoc: String? = null): AgentToolResult =
        AgentToolResult.CiteRecord(
            table = "demo_fitness.workouts",
            recordKey = key,
            title = "Morning run",
            tableDisplayName = "Workouts",
            semanticTime = "2026-05-02T07:14:00.000Z",
            sourceId = "demo-fitness:device",
            sourceType = "demo-fitness",
            boundDocumentId = boundDoc,
        )

    private fun user(vararg parts: UserPart) = ChatMessage.User(parts.toList())
    private fun assistant(vararg parts: AssistantPart) = ChatMessage.Assistant(parts.toList())

    @Test
    fun thinking_parts_dropped_from_history() {
        // Thinking blocks are a transient live-stream indicator (like the
        // ephemeral tool cards) — they must never reappear when a past
        // conversation is reopened. The builder drops them on rebuild.
        val messages = listOf(
            user(UserPart.Text("who handled the Q4 audit?")),
            assistant(
                AssistantPart.Thinking("Let me search the engagement letter, then check the invoice dates."),
                AssistantPart.Text("Studio Northstar handled it."),
            ),
        )

        val turns = AgentTurnBuilder.turns(messages)

        assertEquals(2, turns.size)
        val a = turns[1] as AgentTurn.Assistant
        assertFalse("thinking parts must be dropped", a.parts.any { it is AgentPart.Thinking })
        assertTrue(
            "the answer text must survive the rebuild",
            a.parts.any { it is AgentPart.Text && it.text == "Studio Northstar handled it." },
        )
    }

    @Test
    fun user_message_with_both_tool_result_and_text_folds_and_starts_new_turn() {
        val messages = listOf(
            user(UserPart.Text("how has my HR been?")),
            assistant(
                AssistantPart.Text("Let me check."),
                AssistantPart.ToolUse("tu_1", "triggers_list", args("enabledOnly" to true)),
            ),
            user(
                UserPart.ToolResultPart("tu_1", err("oops", "boom")),
                UserPart.Text("nevermind, also what about resting HR?"),
            ),
        )

        val turns = AgentTurnBuilder.turns(messages)

        assertEquals(3, turns.size)
        assertEquals("how has my HR been?", (turns[0] as AgentTurn.User).text)

        val a = turns[1] as AgentTurn.Assistant
        assertEquals(2, a.parts.size)
        val tool = (a.parts.last() as AgentPart.Tool).call
        assertEquals("tu_1", tool.toolCallId)
        assertNotNull("tool_result must fold into the assistant turn", tool.result)
        assertEquals("oops", (tool.result as AgentToolResult.ErrorResult).code)

        assertEquals("nevermind, also what about resting HR?", (turns[2] as AgentTurn.User).text)
    }

    @Test
    fun user_message_with_only_tool_result_folds_in_place() {
        val messages = listOf(
            user(UserPart.Text("find the contract")),
            assistant(AssistantPart.ToolUse("tu_list", "triggers_list", args("enabledOnly" to true))),
            user(UserPart.ToolResultPart("tu_list", err("not_found", "no docs"))),
            assistant(AssistantPart.Text("Nothing matched.")),
        )

        val turns = AgentTurnBuilder.turns(messages)

        assertEquals(2, turns.size)
        val a = turns[1] as AgentTurn.Assistant
        assertEquals(2, a.parts.size)
        assertNotNull((a.parts.first() as AgentPart.Tool).call.result)
        assertEquals("Nothing matched.", (a.parts.last() as AgentPart.Text).text)
    }

    @Test
    fun user_message_with_only_text_starts_fresh_turn() {
        val messages = listOf(
            user(UserPart.Text("first")),
            assistant(AssistantPart.Text("ack")),
            user(UserPart.Text("second")),
            assistant(AssistantPart.Text("ack 2")),
        )

        val turns = AgentTurnBuilder.turns(messages)

        assertEquals(4, turns.size)
        assertEquals("first", (turns[0] as AgentTurn.User).text)
        assertEquals("second", (turns[2] as AgentTurn.User).text)
        assertEquals(1, (turns[1] as AgentTurn.Assistant).parts.size)
        assertEquals(1, (turns[3] as AgentTurn.Assistant).parts.size)
    }

    @Test
    fun resumed_tool_use_has_known_args_and_summary() {
        val messages = listOf(
            user(UserPart.Text("which triggers are on?")),
            assistant(AssistantPart.ToolUse("tu_list", "triggers_list", args("enabledOnly" to true))),
            user(UserPart.ToolResultPart("tu_list", err("ok", "done"))),
        )

        val turns = AgentTurnBuilder.turns(messages)

        val call = ((turns[1] as AgentTurn.Assistant).parts.first() as AgentPart.Tool).call
        assertTrue("resumed tool_use must not appear pending", call.argsKnown)
        assertFalse("argsSummary must be populated on resume", call.argsSummary.isEmpty())
    }

    @Test
    fun plan_tool_use_dropped_from_history() {
        val messages = listOf(
            user(UserPart.Text("birthday gifts")),
            assistant(
                AssistantPart.ToolUse("tu_plan", "plan", args("note" to "x")),
                AssistantPart.Text("Working on a plan."),
            ),
            user(UserPart.ToolResultPart("tu_plan", err("ok", ""))),
            assistant(AssistantPart.Text("Here's what I found.")),
        )

        val turns = AgentTurnBuilder.turns(messages)

        assertEquals(2, turns.size)
        val a = turns[1] as AgentTurn.Assistant
        assertEquals(2, a.parts.size)
        assertTrue("plan tool calls must be dropped", a.parts.none { it is AgentPart.Tool })
    }

    @Test
    fun ephemeral_tool_uses_dropped_from_history() {
        val messages = listOf(
            user(UserPart.Text("birthday gifts")),
            assistant(
                AssistantPart.Text("On it."),
                AssistantPart.ToolUse("tu_search", "search_documents", args("query" to "gifts")),
                AssistantPart.ToolUse("tu_fetch", "fetch_document", args("documentId" to "doc-1")),
                AssistantPart.ToolUse("tu_sql", "run_sql", args("sql" to "SELECT 1")),
                AssistantPart.ToolUse("tu_temporal", "temporal_query", args("from" to "2026-06")),
                AssistantPart.ToolUse("tu_list_loops", "list_loops", args()),
                AssistantPart.ToolUse("tu_spawn", "spawn_subagent", args("task" to "Compare two periods")),
                AssistantPart.ToolUse("tu_join", "join_subagents", args("subagentIds" to "sub-1")),
            ),
            user(
                UserPart.ToolResultPart("tu_search", err("ok", "")),
                UserPart.ToolResultPart("tu_fetch", err("ok", "")),
                UserPart.ToolResultPart("tu_sql", err("ok", "")),
                UserPart.ToolResultPart(
                    "tu_temporal",
                    AgentToolResult.Structured("temporal.results", JsonObject(emptyMap())),
                ),
                UserPart.ToolResultPart(
                    "tu_list_loops",
                    AgentToolResult.Structured("loops.listed", JsonObject(emptyMap())),
                ),
                UserPart.ToolResultPart("tu_spawn", err("ok", "")),
                UserPart.ToolResultPart("tu_join", err("ok", "")),
            ),
            assistant(AssistantPart.Text("Here's what I found.")),
        )

        val turns = AgentTurnBuilder.turns(messages)

        assertEquals(2, turns.size)
        val a = turns[1] as AgentTurn.Assistant
        assertEquals(2, a.parts.size)
        assertTrue("ephemeral tool calls must be dropped", a.parts.none { it is AgentPart.Tool })
        assertTrue(AgentReducer.EPHEMERAL_TOOLS.contains("temporal_query"))
        assertTrue(AgentReducer.EPHEMERAL_TOOLS.contains("time_index_query"))
        assertTrue(AgentReducer.EPHEMERAL_TOOLS.contains("list_loops"))
        assertTrue(
            AgentReducer.EPHEMERAL_TOOLS.containsAll(
                setOf(
                    "entity_context",
                    "open_loop_search", "open_loop_fetch", "open_loop_create",
                    "open_loop_update", "open_loop_delete", "open_loop_ledger_append",
                    "brief_list", "brief_fetch", "brief_create", "brief_update", "brief_delete",
                    "notes_append", "notes_rewrite", "annotate_durable", "schedule_agent_run",
                ),
            ),
        )
    }

    @Test
    fun multiple_tool_calls_folded_from_one_user_message() {
        val messages = listOf(
            user(UserPart.Text("dig in")),
            assistant(
                AssistantPart.ToolUse("tu_a", "triggers_list", args("enabledOnly" to true)),
                AssistantPart.ToolUse("tu_b", "trigger_get", args("triggerId" to "tr-b")),
            ),
            user(
                UserPart.ToolResultPart("tu_a", err("a", "msg_a")),
                UserPart.ToolResultPart("tu_b", err("b", "msg_b")),
            ),
        )

        val turns = AgentTurnBuilder.turns(messages)

        val a = turns[1] as AgentTurn.Assistant
        assertEquals(2, a.parts.size)
        a.parts.forEach { assertNotNull((it as AgentPart.Tool).call.result) }
    }

    // --- directly-cited records ---

    @Test
    fun state_from_rebuilds_records_from_cite_record_results() {
        val messages = listOf(
            user(UserPart.Text("how was my run?")),
            assistant(AssistantPart.ToolUse("tu_cite", "cite_record", args("recordKey" to "demo_fitness.workouts|wk-1"))),
            user(UserPart.ToolResultPart("tu_cite", citeRecord("demo_fitness.workouts|wk-1", boundDoc = "doc-run"))),
        )

        val state = AgentTurnBuilder.stateFrom(messages)

        assertEquals(1, state.records.size)
        assertEquals("demo_fitness.workouts|wk-1", state.records[0].recordKey)
        assertEquals("Morning run", state.records[0].title)
        assertEquals("doc-run", state.records[0].boundDocumentId)
    }

    @Test
    fun state_from_dedups_records_by_record_key_last_wins() {
        val messages = listOf(
            user(UserPart.Text("dig in")),
            assistant(
                AssistantPart.ToolUse("tu_a", "cite_record", args("recordKey" to "demo_fitness.workouts|wk-1")),
                AssistantPart.ToolUse("tu_b", "cite_record", args("recordKey" to "demo_fitness.workouts|wk-1")),
            ),
            user(
                UserPart.ToolResultPart("tu_a", citeRecord("demo_fitness.workouts|wk-1", boundDoc = null)),
                UserPart.ToolResultPart("tu_b", citeRecord("demo_fitness.workouts|wk-1", boundDoc = "doc-run")),
            ),
        )

        val state = AgentTurnBuilder.stateFrom(messages)

        assertEquals(1, state.records.size)
        assertEquals("doc-run", state.records[0].boundDocumentId) // the second result's metadata wins
    }

    @Test
    fun citation_count_includes_cite_record() {
        val messages = listOf(
            user(UserPart.Text("how was my run?")),
            assistant(
                AssistantPart.ToolUse("tu_cite", "cite_record", args("recordKey" to "demo_fitness.workouts|wk-1")),
                AssistantPart.Text("You ran 5.2 km."),
            ),
            user(UserPart.ToolResultPart("tu_cite", citeRecord("demo_fitness.workouts|wk-1"))),
        )

        val turns = AgentTurnBuilder.turns(messages)

        val a = turns[1] as AgentTurn.Assistant
        assertEquals(1, a.citationCount)
    }

    // --- batch citation tool (annotate_many) reload fan-out ---

    private fun ref(id: String) = AgentDocRef(documentId = id, sourceType = "demo-mail", sourceId = "demo-mail:me", title = id)

    private fun annotateRecorded(id: String, quote: String? = null, note: String? = null): AgentToolResult =
        AgentToolResult.AnnotateRecorded(documentId = id, ref = ref(id), quote = quote, note = note)

    private fun annotateBatch(vararg items: AgentToolResult): AgentToolResult =
        AgentToolResult.AnnotateBatch(items = items.toList())

    /** An `annotate_many` tool_use whose args carry the given per-child annotation count. */
    private fun annotateManyUse(toolCallId: String, count: Int): AssistantPart.ToolUse {
        val annotations = List(count) { """{"documentId":"d$it"}""" }.joinToString(",")
        return AssistantPart.ToolUse(
            toolCallId,
            "annotate_many",
            OmnesisJson.parseToJsonElement("""{"annotations":[$annotations]}"""),
        )
    }

    @Test
    fun state_from_fans_annotate_batch_into_one_citation_per_child_with_stable_ids() {
        // Reopening a conversation must rebuild the SAME per-child citations the live agent.citation
        // events produced — one per child, with the stable "<toolCallId>#<idx>" ids — so the
        // Timeline is byte-identical live vs reloaded.
        val messages = listOf(
            user(UserPart.Text("where did I live?")),
            assistant(annotateManyUse("tc", count = 2)),
            user(
                UserPart.ToolResultPart(
                    "tc",
                    annotateBatch(
                        annotateRecorded("d1", quote = "q1"),
                        annotateRecorded("d2", note = "n2"),
                    ),
                ),
            ),
            assistant(AssistantPart.Text("here.")),
        )

        val state = AgentTurnBuilder.stateFrom(messages)

        // One citation per child, in document order.
        assertEquals(listOf("d1", "d2"), state.citations.map { it.documentId }.sorted())
        val d1 = state.citations.first { it.documentId == "d1" }
        assertEquals("q1", d1.entries[0].quote)
        // Per-child stable id (matches the live agent.citation events' "<toolCallId>#<idx>").
        assertEquals("tc#0", d1.entries[0].toolCallId)
        // Note-only child routes to a doc-level note, not a quote entry.
        val d2 = state.citations.first { it.documentId == "d2" }
        assertEquals("n2", d2.docNote)
        assertTrue(d2.entries.isEmpty())

        // The reloaded Timeline fans out to one row per child document (built from citations).
        val timeline = AgentTimelineBuilder.buildUnifiedTimeline(state.citations)
        assertEquals(listOf("d1", "d2"), timeline.mapNotNull { it.doc?.documentId }.sorted())

        // The turn's reference count includes one per child.
        val a = AgentTurnBuilder.turns(messages).filterIsInstance<AgentTurn.Assistant>().first()
        assertEquals(2, a.citationCount)
    }

    @Test
    fun state_from_singular_annotate_keeps_bare_tool_call_id() {
        // A one-child path (singular annotate) must NOT gain a "#idx" suffix — only a real batch
        // (>1 child) fans out, so a plain annotate's citation id stays the bare toolCallId.
        val messages = listOf(
            user(UserPart.Text("who signed it?")),
            assistant(AssistantPart.ToolUse("tc", "annotate", args("documentId" to "d1"))),
            user(UserPart.ToolResultPart("tc", annotateRecorded("d1", quote = "signed by Maya Reeves"))),
        )

        val state = AgentTurnBuilder.stateFrom(messages)

        assertEquals(1, state.citations.size)
        assertEquals("tc", state.citations[0].entries[0].toolCallId)
    }

    @Test
    fun state_from_single_child_annotate_batch_keeps_bare_tool_call_id() {
        // Defensive: an annotate.batch that happens to carry a single item is a 1-child batch — the
        // id stays bare (the "#idx" suffix appears only when the batch really has >1 child).
        val messages = listOf(
            user(UserPart.Text("q")),
            assistant(annotateManyUse("tc", count = 1)),
            user(UserPart.ToolResultPart("tc", annotateBatch(annotateRecorded("d1", quote = "q1")))),
        )

        val state = AgentTurnBuilder.stateFrom(messages)

        assertEquals(1, state.citations.size)
        assertEquals("tc", state.citations[0].entries[0].toolCallId)
    }

    @Test
    fun ephemeral_batch_retrieval_tools_dropped_from_history() {
        // search_many / fetch_many are ephemeral like the singular cards they wrap — dropped from a
        // rebuilt transcript (their visual is a live-stream glance, not resumed history).
        val messages = listOf(
            user(UserPart.Text("dig in")),
            assistant(
                AssistantPart.Text("On it."),
                AssistantPart.ToolUse("tu_s", "search_many", args("_" to "x")),
                AssistantPart.ToolUse("tu_f", "fetch_many", args("_" to "x")),
            ),
            user(
                UserPart.ToolResultPart("tu_s", AgentToolResult.SearchBatch()),
                UserPart.ToolResultPart("tu_f", AgentToolResult.DocumentBatch()),
            ),
            assistant(AssistantPart.Text("Here's what I found.")),
        )

        val turns = AgentTurnBuilder.turns(messages)

        val a = turns[1] as AgentTurn.Assistant
        assertTrue("batch retrieval tool calls must be dropped", a.parts.none { it is AgentPart.Tool })
        assertTrue(AgentReducer.EPHEMERAL_TOOLS.contains("search_many"))
        assertTrue(AgentReducer.EPHEMERAL_TOOLS.contains("fetch_many"))
    }

    // --- forward-compat (decode from raw JSON, the canonical newer-gateway case) ---

    @Test
    fun unknown_tool_result_kind_folds_as_unknown() {
        val json = """
            [
              {"role":"user","parts":[{"kind":"text","text":"q"}]},
              {"role":"assistant","parts":[{"kind":"tool_use","toolCallId":"tu_1","tool":"future_tool","args":{}}]},
              {"role":"user","parts":[{"kind":"tool_result","toolCallId":"tu_1","result":{"kind":"future.kind","extra":"hi"}}]}
            ]
        """.trimIndent()
        val messages = OmnesisJson.decodeFromString<List<ChatMessage>>(json)
        val turns = AgentTurnBuilder.turns(messages)

        assertEquals(2, turns.size)
        val call = ((turns[1] as AgentTurn.Assistant).parts.first() as AgentPart.Tool).call
        assertEquals("future_tool", call.tool)
        assertEquals("future.kind", (call.result as AgentToolResult.Unknown).kind)
    }

    @Test
    fun unknown_assistant_part_kind_surfaces_as_placeholder() {
        val json = """
            [
              {"role":"user","parts":[{"kind":"text","text":"hi"}]},
              {"role":"assistant","parts":[{"kind":"text","text":"sure"},{"kind":"image","src":"https://example.com/x.png"}]}
            ]
        """.trimIndent()
        val messages = OmnesisJson.decodeFromString<List<ChatMessage>>(json)
        val turns = AgentTurnBuilder.turns(messages)

        val unknowns = (turns[1] as AgentTurn.Assistant).parts.filterIsInstance<AgentPart.Unknown>()
        assertEquals(1, unknowns.size)
        assertEquals("image", unknowns.first().kind)
    }

    @Test
    fun unknown_chat_message_role_surfaces_as_synthetic_turn() {
        val json = """
            [
              {"role":"user","parts":[{"kind":"text","text":"hi"}]},
              {"role":"system","note":"something new"},
              {"role":"assistant","parts":[{"kind":"text","text":"ok"}]}
            ]
        """.trimIndent()
        val messages = OmnesisJson.decodeFromString<List<ChatMessage>>(json)
        val turns = AgentTurnBuilder.turns(messages)

        assertEquals(3, turns.size)
        val placeholder = turns[1] as AgentTurn.Assistant
        assertEquals(1, placeholder.parts.size)
        assertEquals("system", (placeholder.parts.first() as AgentPart.Unknown).kind)
    }

    @Test
    fun summarize_args_trace_connections_format() {
        val summary = AgentReducer.summarizeArgs(
            "trace_connections",
            args("depth" to 2).let { base ->
                JsonObject(
                    base.toMutableMap().apply {
                        put("seedIds", OmnesisJson.parseToJsonElement("""["doc-abcdef12"]"""))
                    },
                )
            },
        )
        assertEquals("doc-abcd depth=2", summary)
    }

    @Test
    fun fold_tests_tool_stays_non_ephemeral() {
        assertTrue(AgentReducer.EPHEMERAL_TOOLS.contains("trace_connections"))
        assertFalse(AgentReducer.EPHEMERAL_TOOLS.contains("triggers_list"))
        assertFalse(AgentReducer.EPHEMERAL_TOOLS.contains("trigger_get"))
    }
}
