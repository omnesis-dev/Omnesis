// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The result of an agent tool call — a tagged union keyed on `kind`. Mirrors the iOS
 * `AgentToolResult`. Unknown kinds decode to [Unknown] (forward-compatible). We never
 * re-encode these (history is server-authoritative), so [Unknown] needn't be lossless.
 */
@Serializable(with = AgentToolResultSerializer::class)
sealed interface AgentToolResult {

    @Serializable
    data class SearchResults(
        val query: String = "",
        val durationMs: Double = 0.0,
        val candidates: Int? = null,
        val results: List<AgentDocRef> = emptyList(),
    ) : AgentToolResult

    @Serializable
    data class DocumentResult(
        val ref: AgentDocRef,
        val document: DocBody? = null,
        val neighbors: List<AgentDocRef> = emptyList(),
    ) : AgentToolResult {
        @Serializable
        data class DocBody(val content: String? = null)
    }

    @Serializable
    data class SqlRows(
        val sql: String = "",
        val columns: List<String> = emptyList(),
        val rows: List<List<JsonElement>> = emptyList(),
        val rowCount: Int = 0,
        val truncated: Boolean = false,
        val durationMs: Double = 0.0,
        val sources: List<AgentSqlSource> = emptyList(),
        val subjects: List<String> = emptyList(),
    ) : AgentToolResult

    @Serializable
    data class PersonResults(
        val query: String = "",
        val durationMs: Double = 0.0,
        val results: List<AgentPersonSummary> = emptyList(),
    ) : AgentToolResult

    @Serializable
    data class DocumentByUrl(
        val url: String = "",
        val durationMs: Double = 0.0,
        val ref: AgentDocRef? = null,
    ) : AgentToolResult

    @Serializable
    data class EventTrailBuilt(
        val seeds: List<String> = emptyList(),
        val events: List<AgentTrailEvent> = emptyList(),
        val truncated: Boolean = false,
    ) : AgentToolResult

    @Serializable
    data class AnnotateRecorded(
        val documentId: String = "",
        val ref: AgentDocRef,
        val quote: String? = null,
        val note: String? = null,
        val quoteAuthor: String? = null,
        val quoteIsSelf: Boolean = false,
    ) : AgentToolResult

    /**
     * Result of a successful `cite_record` tool call — the structured twin of
     * [AnnotateRecorded]: the agent recorded that a single DuckDB analytics row materially
     * informed its answer. The gateway has already derived every display string from the
     * table's declared record-display contract, so a client renders these verbatim and never
     * learns a column name or branches on a source. The fields map one-to-one onto
     * [AgentTrailRecord], which the timeline drawer renders. The wire's `primaryKeyColumns` and
     * `snapshot` are unused by the renderer and intentionally not modelled — they decode-and-drop
     * via the union's `ignoreUnknownKeys`. Mirrors `cite_record.recorded` in
     * `@omnesis/core/agent-protocol.ts`.
     */
    @Serializable
    data class CiteRecord(
        val table: String = "",
        val recordKey: String = "",
        val title: String = "",
        val keyFields: List<AgentTrailRecordKeyField> = emptyList(),
        /** Always present — a timeless row is refused server-side, never recorded. */
        val semanticTime: String = "",
        val sourceId: String = "",
        val sourceType: String = "",
        val tableDisplayName: String = "",
        /** Co-described document id when the row binds one, else `null` (renders no tap target). */
        val boundDocumentId: String? = null,
    ) : AgentToolResult {
        /** Project onto the shared record render payload the timeline already consumes. */
        fun toTrailRecord(): AgentTrailRecord = AgentTrailRecord(
            recordKey = recordKey,
            table = table,
            tableDisplayName = tableDisplayName,
            title = title,
            keyFields = keyFields,
            semanticTime = semanticTime,
            sourceId = sourceId,
            sourceType = sourceType,
            boundDocumentId = boundDocumentId,
        )
    }

    @Serializable
    data class PlanUpdated(val items: List<AgentPlanItem> = emptyList()) : AgentToolResult

    @Serializable
    data class TriggersListed(val triggers: List<AgentTriggerSummary> = emptyList()) : AgentToolResult

    @Serializable
    data class TriggerFetched(val trigger: AgentTriggerRecord) : AgentToolResult

    @Serializable
    data class TriggerFirings(
        val triggerId: String = "",
        val firings: List<AgentTriggerFiring> = emptyList(),
    ) : AgentToolResult

    /** A watch the agent installed or rewrote. */
    @Serializable
    data class WatchUpserted(
        val watchId: String = "",
        val name: String = "",
        val action: String = "",
        val enabled: Boolean = false,
        val summary: String? = null,
    ) : AgentToolResult

    /**
     * The same card from a conversation stored before the result was renamed.
     * Decoded so an older transcript still opens; nothing emits it.
     */
    @Serializable
    data class TriggerUpserted(
        val triggerId: String = "",
        val name: String = "",
        val action: String = "",
        val enabled: Boolean = false,
        val summary: String? = null,
    ) : AgentToolResult

    @Serializable
    data class TriggerToggled(
        val triggerId: String = "",
        val name: String = "",
        val enabled: Boolean = false,
    ) : AgentToolResult

    /**
     * Result of an interactive `search_loops` call (experimental) — the chat agent
     * reading the Cognition Steward's tracked obligations. Read-only; mirrors the
     * `search.results` / `person.results` rolling-slot shape. Empty [loops] is a
     * successful "nothing matched". Mirrors `loops.searched` in
     * `@omnesis/core/agent-protocol.ts`.
     */
    @Serializable
    data class LoopsSearched(
        val query: String = "",
        val durationMs: Double = 0.0,
        val loops: List<AgentLoopSummary> = emptyList(),
    ) : AgentToolResult

    /**
     * Result of an interactive `fetch_loop` call (experimental) — one loop's full
     * read-only detail. [loop] is `null` when the id matched nothing (a clean
     * no-match, not an error). Mirrors `loop.fetched`.
     */
    @Serializable
    data class LoopFetched(val loop: AgentLoopDetail? = null) : AgentToolResult

    @Serializable
    data class ErrorResult(val code: String = "", val message: String = "") : AgentToolResult

    /**
     * The one `tool_result` a batch retrieval/citation tool (`search_many` / `fetch_many` /
     * `annotate_many`) maps to: the ordered per-child outcomes, one model round-trip, N
     * operations. Each child reuses the SINGULAR result shape so every renderer projects it into
     * the same per-item card (search / document) or citation (annotate) it already shows for a
     * singular call; a failed child is an [ErrorResult] in its slot, so one failure never discards
     * the batch. [items] follows input order even when execution finished out of order. This
     * durable result is what the transcript persists and what a resumed conversation re-projects
     * from — live per-child progress streams separately via `agent.tool.child.*`. Mirrors
     * `searchBatchResult` / `documentBatchResult` / `annotateBatchResult` in
     * `@omnesis/core/agent-protocol.ts`.
     */
    @Serializable
    data class SearchBatch(val items: List<AgentToolResult> = emptyList()) : AgentToolResult

    @Serializable
    data class DocumentBatch(val items: List<AgentToolResult> = emptyList()) : AgentToolResult

    @Serializable
    data class AnnotateBatch(val items: List<AgentToolResult> = emptyList()) : AgentToolResult

    /**
     * Generic structured payload used by feature-scoped tools such as
     * `temporal_query`. Keeping the payload preserves additive provenance fields
     * without teaching the transport union every experimental result schema.
     */
    @Serializable
    data class Structured(
        val resultType: String = "",
        val data: JsonElement,
    ) : AgentToolResult

    @Serializable
    data class Unknown(val kind: String = "unknown") : AgentToolResult
}

object AgentToolResultSerializer :
    JsonContentPolymorphicSerializer<AgentToolResult>(AgentToolResult::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<AgentToolResult> =
        when (element.jsonObject["kind"]?.jsonPrimitive?.contentOrNull) {
            "search.results" -> AgentToolResult.SearchResults.serializer()
            "document" -> AgentToolResult.DocumentResult.serializer()
            "sql.rows" -> AgentToolResult.SqlRows.serializer()
            "person.results" -> AgentToolResult.PersonResults.serializer()
            "document.byUrl" -> AgentToolResult.DocumentByUrl.serializer()
            "event_trail.built" -> AgentToolResult.EventTrailBuilt.serializer()
            "annotate.recorded" -> AgentToolResult.AnnotateRecorded.serializer()
            "cite_record.recorded" -> AgentToolResult.CiteRecord.serializer()
            "plan.updated" -> AgentToolResult.PlanUpdated.serializer()
            "triggers.listed" -> AgentToolResult.TriggersListed.serializer()
            "trigger.fetched" -> AgentToolResult.TriggerFetched.serializer()
            "trigger.firings" -> AgentToolResult.TriggerFirings.serializer()
            "watch.upserted" -> AgentToolResult.WatchUpserted.serializer()
            "trigger.upserted" -> AgentToolResult.TriggerUpserted.serializer()
            "trigger.toggled" -> AgentToolResult.TriggerToggled.serializer()
            "loops.searched" -> AgentToolResult.LoopsSearched.serializer()
            "loop.fetched" -> AgentToolResult.LoopFetched.serializer()
            "error" -> AgentToolResult.ErrorResult.serializer()
            "search.batch" -> AgentToolResult.SearchBatch.serializer()
            "document.batch" -> AgentToolResult.DocumentBatch.serializer()
            "annotate.batch" -> AgentToolResult.AnnotateBatch.serializer()
            "structured" -> AgentToolResult.Structured.serializer()
            else -> AgentToolResult.Unknown.serializer()
        }
}
