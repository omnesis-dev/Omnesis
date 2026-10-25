// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Loop
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.StickyNote2
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material.icons.outlined.WbTwilight
import androidx.compose.ui.graphics.vector.ImageVector
import dev.omnesis.android.transport.dto.AgentToolResult

/**
 * How a tool call reads in a transcript: whether its card dismisses itself, stays, is a
 * "Citing…" pill, is replaced by the researcher row, or is never drawn.
 */
enum class AgentToolPresentation(val wire: String) {
    Ephemeral("ephemeral"),
    Persistent("persistent"),
    Citation("citation"),
    Subagent("subagent"),
    Silent("silent"),
}

/** One tool's card: presentation, header label, glyph (by meaning) and whether it scrolls a body of text. */
data class AgentToolCard(
    val presentation: AgentToolPresentation,
    val label: String? = null,
    val icon: String? = null,
    val scrollsContent: Boolean = false,
)

/**
 * The Android copy of the table every client follows. `AgentToolCardsTest` checks it against
 * `wire-fixtures/agent-tool-cards.json`, which the gateway generates from `@omnesis/core`'s
 * `AGENT_TOOL_CARDS`.
 */
object AgentToolCards {
    private fun ephemeral(label: String, icon: String, scrolls: Boolean = false) =
        AgentToolCard(AgentToolPresentation.Ephemeral, label, icon, scrolls)

    private fun persistent(label: String?, icon: String) =
        AgentToolCard(AgentToolPresentation.Persistent, label, icon)

    val table: Map<String, AgentToolCard> = mapOf(
        "search_many" to ephemeral("Search", "search"),
        "search_documents" to ephemeral("Search", "search"),
        "fetch_many" to ephemeral("Open document", "document", scrolls = true),
        "fetch_document" to ephemeral("Open document", "document", scrolls = true),
        "knowledge_fetch" to ephemeral("Read wiki page", "wiki", scrolls = true),
        "run_sql" to ephemeral("Run SQL", "sql"),
        "trace_connections" to ephemeral("Trace connections", "trail"),
        "entity_context" to ephemeral("Gather context", "trail"),
        "lookup_people" to ephemeral("Find people", "people"),
        "count_messages" to ephemeral("Count messages", "people"),
        "lookup_document_by_url" to ephemeral("Look up URL", "link"),
        "search_loops" to ephemeral("Search loops", "loop"),
        "fetch_loop" to ephemeral("Open loop", "loop"),
        "list_loops" to ephemeral("List loops", "loop"),
        "temporal_query" to ephemeral("Check dates", "date"),
        "annotate" to AgentToolCard(AgentToolPresentation.Citation),
        "annotate_many" to AgentToolCard(AgentToolPresentation.Citation),
        "cite_record" to AgentToolCard(AgentToolPresentation.Citation),
        "spawn_subagent" to AgentToolCard(AgentToolPresentation.Subagent),
        "join_subagents" to AgentToolCard(AgentToolPresentation.Silent),
        "plan" to AgentToolCard(AgentToolPresentation.Silent),
        "watches_list" to AgentToolCard(AgentToolPresentation.Silent),
        "watch_get" to AgentToolCard(AgentToolPresentation.Silent),
        "watch_probe" to ephemeral("Test watch", "watch"),
        "watch_create" to persistent(null, "watch"),
        "watch_update" to persistent(null, "watch"),
        "watch_delete" to persistent("Delete watch", "watch"),
        "task_list" to ephemeral("Check tasks", "task"),
        "task_create" to ephemeral("Add a task", "task"),
        "task_update" to ephemeral("Update a task", "task"),
        "task_undo" to ephemeral("Undo a task change", "task"),
        "conversation_memory_evidence" to ephemeral("Prepare memory", "memory"),
        "annotation_search" to ephemeral("Search memory", "memory"),
        "annotate_durable" to ephemeral("Remember document", "memory"),
        "annotation_revise" to ephemeral("Update document memory", "memory"),
        "annotation_retract" to ephemeral("Forget document memory", "memory"),
        "annotation_supersede" to ephemeral("Replace document memory", "memory"),
        "annotate_person" to ephemeral("Remember person", "memory"),
        "person_annotation_revise" to ephemeral("Update person memory", "memory"),
        "person_annotation_retract" to ephemeral("Forget person memory", "memory"),
        "person_annotation_supersede" to ephemeral("Replace person memory", "memory"),
        "open_loop_search" to ephemeral("Search loops", "loop"),
        "open_loop_fetch" to ephemeral("Open loop", "loop"),
        "open_loop_create" to ephemeral("Create loop", "loop"),
        "open_loop_update" to ephemeral("Update loop", "loop"),
        "open_loop_delete" to ephemeral("Delete loop", "loop"),
        "open_loop_ledger_append" to ephemeral("Note on loop", "loop"),
        "observation_list" to ephemeral("List brief items", "observation"),
        "observation_note" to ephemeral("Note brief item", "observation"),
        "observation_withdraw" to ephemeral("Withdraw brief item", "observation"),
        "observation_suppress" to ephemeral("Mute brief item", "observation"),
        "temporal_annotation_add" to ephemeral("Add date note", "date"),
        "temporal_annotation_update" to ephemeral("Update date note", "date"),
        "temporal_annotation_delete" to ephemeral("Remove date note", "date"),
        "notes_append" to ephemeral("Append notes", "notes"),
        "notes_edit" to ephemeral("Edit notes", "notes"),
        "notes_rewrite" to ephemeral("Rewrite notes", "notes"),
        "schedule_agent_run" to ephemeral("Schedule follow-up", "schedule"),
        "knowledge_list" to ephemeral("List wiki pages", "wiki"),
        "knowledge_links" to ephemeral("Read wiki links", "wiki"),
        "knowledge_link" to ephemeral("Link wiki pages", "wiki"),
        "knowledge_history" to ephemeral("Read wiki history", "wiki"),
        "knowledge_reference" to ephemeral("Check references", "wiki"),
        "knowledge_evidence" to ephemeral("Record evidence", "wiki"),
        "knowledge_candidates" to ephemeral("Review page ideas", "wiki"),
        "knowledge_candidate_decide" to ephemeral("Decide on a page idea", "wiki"),
        "knowledge_propose_page" to ephemeral("Propose wiki page", "wiki"),
        "knowledge_save" to ephemeral("Save wiki page", "wiki"),
        "knowledge_edit" to ephemeral("Edit wiki page", "wiki"),
        "knowledge_retire" to ephemeral("Retire wiki page", "wiki"),
    )

    /** Names older conversations still carry for a renamed tool; they read as the tool they became. */
    val renamed: Map<String, String> = mapOf(
        "time_index_query" to "temporal_query",
        "time_index_add" to "temporal_annotation_add",
        "time_index_update" to "temporal_annotation_update",
        "time_index_delete" to "temporal_annotation_delete",
    )

    /** Material icon for each icon the table names. */
    val icons: Map<String, ImageVector> = mapOf(
        "search" to Icons.Outlined.Search,
        "document" to Icons.Outlined.Description,
        "wiki" to Icons.AutoMirrored.Outlined.MenuBook,
        "sql" to Icons.Outlined.TableChart,
        "trail" to Icons.Outlined.Hub,
        "people" to Icons.Outlined.People,
        "link" to Icons.Outlined.Link,
        "loop" to Icons.Outlined.Loop,
        "observation" to Icons.Outlined.WbTwilight,
        "date" to Icons.Outlined.CalendarMonth,
        "schedule" to Icons.Outlined.Schedule,
        "memory" to Icons.Outlined.Psychology,
        "notes" to Icons.Outlined.StickyNote2,
        "task" to Icons.Outlined.Checklist,
        "watch" to Icons.Outlined.Bolt,
    )

    fun card(tool: String): AgentToolCard? = table[renamed[tool] ?: tool]

    /** The card header's words; an unknown tool reads as its own name. */
    fun label(tool: String): String = card(tool)?.label ?: tool

    /** The card's glyph; a wrench for a tool this build does not know. */
    fun icon(tool: String): ImageVector = card(tool)?.icon?.let { icons[it] } ?: Icons.Outlined.Build

    /** Tools whose live card dismisses itself, renamed names included. */
    val ephemeralTools: Set<String> =
        (table.keys + renamed.keys).filter { card(it)?.presentation == AgentToolPresentation.Ephemeral }.toSet()

    /** Tools never drawn in a transcript. */
    val silentTools: Set<String> =
        table.filterValues { it.presentation == AgentToolPresentation.Silent }.keys
}

/**
 * The document a read returned: a `document` result, or the first document of a `document.batch`
 * (a wiki read returns the batch shape `fetch_many` does).
 */
fun agentDocumentRead(result: AgentToolResult?): AgentToolResult.DocumentResult? = when (result) {
    is AgentToolResult.DocumentResult -> result
    is AgentToolResult.DocumentBatch -> result.items.firstNotNullOfOrNull { it as? AgentToolResult.DocumentResult }
    else -> null
}

