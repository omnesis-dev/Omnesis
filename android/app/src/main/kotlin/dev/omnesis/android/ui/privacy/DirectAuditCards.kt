// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Static content model for one Direct transcript call: the portal's
 * `StaticToolCard` (`parts.js`), minus the DOM. A Direct payload's `result`
 * is the same wire `ToolResult` the agent path decodes as [AgentToolResult],
 * so the typed kinds render the same rows the portal shows — search/fetch
 * rows with titles, SQL rowblocks, trail/people/loop rows — and every row
 * that names a document, person or loop carries its link target.
 *
 * Pure Kotlin (no Compose) so the mapping is unit testable in the logic lane.
 * Screens map [DirectCardDestination] onto navigation; nothing here knows
 * what navigation is.
 */

/** Where a card row leads. Loops have no native screen, so a loop row carries its id and renders plain. */
sealed interface DirectCardDestination {
    data class Document(val id: String, val sourceId: String? = null, val title: String? = null) : DirectCardDestination
    data class Person(val canonicalId: String, val name: String? = null) : DirectCardDestination
    data class Loop(val id: String) : DirectCardDestination
    data class External(val url: String) : DirectCardDestination
}

data class DirectCardRow(
    val title: String,
    val subtitle: String? = null,
    val destination: DirectCardDestination? = null,
)

data class DirectCardError(val code: String, val message: String)

data class DirectSqlBlock(
    val columns: List<String>,
    val rows: List<List<String>>,
    val totalRows: Int,
)

/**
 * One child card of a batch call (`search_many` / `fetch_many`): the portal
 * projects one static singular card per settled item, index-aligned to the
 * call's args, so a failed child never discards its siblings.
 */
data class DirectCardSection(
    val heading: String? = null,
    val rows: List<DirectCardRow> = emptyList(),
    val sql: DirectSqlBlock? = null,
    val error: DirectCardError? = null,
    val showsEmpty: Boolean = false,
)

/** Icon leading a header argument: a seed document's source icon, or the person/loop glyph. */
sealed interface DirectArgIcon {
    data class Document(val sourceId: String?) : DirectArgIcon
    data object Person : DirectArgIcon
    data object Loop : DirectArgIcon
}

/** A header seed: resolved title plus icon, or the raw id when the result names nothing for it. */
data class DirectSeedDisplay(val icon: DirectArgIcon?, val text: String)

data class DirectCardContent(
    val label: String,
    val arg: String = "",
    /** Icon leading the header argument, when the argument names entities the result resolves. */
    val argIcon: DirectArgIcon? = null,
    /** When the header arg itself is a link (the looked-up URL). */
    val argLink: DirectCardDestination? = null,
    val sections: List<DirectCardSection>? = null,
    val rows: List<DirectCardRow> = emptyList(),
    val sql: DirectSqlBlock? = null,
    val note: String? = null,
    val error: DirectCardError? = null,
    /**
     * A matched-but-empty result reads "No result" instead of rendering
     * nothing. A result whose kind this tool does not render leaves the
     * header standing alone — the call still happened.
     */
    val showsEmpty: Boolean = false,
)

/** Mirrors the portal's `EPHEMERAL_SEARCH_RESULTS_MAX`: a card is a glance, not an exhaustive replay. */
internal const val DIRECT_CARD_MAX_ROWS = 12
/** Mirrors the portal's `EPHEMERAL_SQL_ROWS_MAX`. */
internal const val DIRECT_CARD_MAX_SQL_ROWS = 10

/* ── Record decoding ─────────────────────────────────────────────────── */

sealed interface DirectDecodedResult {
    data class Typed(val result: AgentToolResult) : DirectDecodedResult
    /** `{kind:"structured", resultType, data}` — the steward loop/memory tools. Parsed from raw JSON. */
    data class Structured(val resultType: String, val data: JsonElement) : DirectDecodedResult
    data object Missing : DirectDecodedResult
    data object Undecodable : DirectDecodedResult
}

internal fun directDecodeResult(payload: JsonElement?): DirectDecodedResult {
    val record = payload as? JsonObject ?: return DirectDecodedResult.Missing
    val result = record["result"]?.takeUnless { it is JsonNull } ?: return DirectDecodedResult.Missing
    val resultObject = result as? JsonObject
    // `as? JsonPrimitive` (never `.jsonPrimitive`): a novel `kind` shape must
    // fall through to the generic header, never throw during composition.
    if ((resultObject?.get("kind") as? JsonPrimitive)?.contentOrNull == "structured") {
        return DirectDecodedResult.Structured(
            resultType = (resultObject["resultType"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
            data = resultObject["data"] ?: JsonNull,
        )
    }
    return runCatching { OmnesisJson.decodeFromJsonElement(AgentToolResult.serializer(), result) }
        .map { DirectDecodedResult.Typed(it) }
        .getOrElse { DirectDecodedResult.Undecodable }
}

/** Whether the record carries a result: refused/failed calls record no result and read "No result recorded." */
internal fun directRecordHasResult(payload: JsonElement?): Boolean {
    val record = payload as? JsonObject ?: return false
    val result = record["result"] ?: return false
    return result !is JsonNull
}

/* ── Card mapping ────────────────────────────────────────────────────── */

/** One rendered card: the singular tool name the portal's batch splitter projects plus its content. */
data class TranscriptCard(val tool: String, val content: DirectCardContent)

/**
 * One card per transcript record — except `search_many` / `fetch_many`,
 * which the portal's `deriveBatchChildren` projects into one singular card
 * per settled item ("Search <query>", "Open document"), index-aligned to
 * the call's args. A batch that never decoded to items keeps its single
 * generic header card, exactly as [directCardContent] renders it.
 */
fun directTranscriptCards(tool: String, record: JsonElement?): List<TranscriptCard> {
    val fields = record as? JsonObject
    val args = fields?.get("args")
    val decoded = directDecodeResult(record)
    val batch = (decoded as? DirectDecodedResult.Typed)?.result
    if (tool == "search_many" && batch is AgentToolResult.SearchBatch) {
        val queries = directArgQueries(args)
        return batch.items.mapIndexed { index, item ->
            TranscriptCard(
                "search_documents",
                directSingularSearchCard(queries.getOrNull(index).orEmpty(), item),
            )
        }
    }
    if (tool == "fetch_many" && batch is AgentToolResult.DocumentBatch) {
        val ids = directArgDocumentIds(args)
        return batch.items.mapIndexed { index, item ->
            TranscriptCard(
                "fetch_document",
                directSingularFetchCard(item, ids.getOrNull(index)),
            )
        }
    }
    return listOf(TranscriptCard(tool, directCardContent(tool, record)))
}

/**
 * The static card for one transcript record. Unknown tools and unknown
 * result kinds render a generic header card — never a dropped row — and a
 * result whose kind this tool does not render leaves the header standing
 * alone, mirroring the portal.
 */
fun directCardContent(tool: String, record: JsonElement?): DirectCardContent {
    val fields = record as? JsonObject
    val args = fields?.get("args")
    val decoded = directDecodeResult(record)
    return when (tool) {
        "search_many" -> directSearchBatchCard(args, decoded)
        "fetch_many" -> directFetchBatchCard(args, decoded)
        "lookup_document_by_url" -> directUrlLookupCard(args, decoded)
        "lookup_people" -> directPeopleCard(args, decoded)
        "trace_connections" -> directTrailCard(args, decoded)
        "run_sql" -> directSqlCard(args, decoded)
        "search_loops" -> directLoopsSearchedCard(args, decoded)
        "fetch_loop" -> directLoopFetchedCard(decoded)
        "list_loops", "open_loop_search", "open_loop_fetch", "entity_context", "temporal_query" ->
            directStructuredCard(tool, args, decoded)
        else -> directGenericCard(tool, args, decoded)
    }
}

/* ── Batch tools ─────────────────────────────────────────────────────── */

private fun directSearchBatchCard(args: JsonElement?, decoded: DirectDecodedResult): DirectCardContent {
    val batch = (decoded as? DirectDecodedResult.Typed)?.result as? AgentToolResult.SearchBatch
        ?: return directGenericCard("search_many", args, decoded)
    val queries = directArgQueries(args)
    val sections = batch.items.mapIndexed { index, item ->
        val heading = queries.getOrNull(index)
        when (item) {
            is AgentToolResult.SearchResults -> {
                val rows = item.results.take(DIRECT_CARD_MAX_ROWS).map { directDocumentRow(it) }
                DirectCardSection(heading = heading, rows = rows, showsEmpty = rows.isEmpty())
            }
            is AgentToolResult.ErrorResult -> DirectCardSection(
                heading = heading,
                error = DirectCardError(item.code, item.message),
            )
            else -> DirectCardSection(heading = heading)
        }
    }
    return DirectCardContent(label = "Search", sections = sections)
}

private fun directFetchBatchCard(args: JsonElement?, decoded: DirectDecodedResult): DirectCardContent {
    val batch = (decoded as? DirectDecodedResult.Typed)?.result as? AgentToolResult.DocumentBatch
        ?: return directGenericCard("fetch_many", args, decoded)
    val ids = directArgDocumentIds(args)
    val sections = batch.items.mapIndexed { index, item ->
        val heading = ids.getOrNull(index)
        when (item) {
            is AgentToolResult.DocumentResult -> DirectCardSection(
                rows = listOf(directDocumentRow(item.ref, fallbackTitle = heading)),
            )
            is AgentToolResult.ErrorResult -> DirectCardSection(
                heading = heading,
                error = DirectCardError(item.code, item.message),
            )
            else -> DirectCardSection(heading = heading)
        }
    }
    return DirectCardContent(label = "Open documents", sections = sections)
}

/* ── Singular children ───────────────────────────────────────────────── */

/**
 * One batch child as its own singular card — the portal dispatches each
 * `deriveBatchChildren` entry back through its singular card, so a search
 * child reads "Search <query>" and a fetch child "Open document".
 */
private fun directSingularSearchCard(query: String, item: AgentToolResult): DirectCardContent {
    if (item is AgentToolResult.ErrorResult) {
        return DirectCardContent(
            label = "Search",
            arg = query,
            error = DirectCardError(item.code, item.message),
        )
    }
    if (item !is AgentToolResult.SearchResults) {
        return DirectCardContent(label = "Search", arg = query)
    }
    val rows = item.results.take(DIRECT_CARD_MAX_ROWS).map { directDocumentRow(it) }
    return DirectCardContent(label = "Search", arg = query, rows = rows, showsEmpty = rows.isEmpty())
}

private fun directSingularFetchCard(item: AgentToolResult, fallbackTitle: String?): DirectCardContent {
    if (item is AgentToolResult.ErrorResult) {
        return DirectCardContent(
            label = "Open document",
            error = DirectCardError(item.code, item.message),
        )
    }
    if (item !is AgentToolResult.DocumentResult) {
        return DirectCardContent(label = "Open document")
    }
    return DirectCardContent(
        label = "Open document",
        rows = listOf(directDocumentRow(item.ref, fallbackTitle = fallbackTitle)),
    )
}

/* ── Singular tools ──────────────────────────────────────────────────── */

private fun directUrlLookupCard(args: JsonElement?, decoded: DirectDecodedResult): DirectCardContent {
    val url = args.stringField("url")
    val argLink = directExternalDestination(url)
    val typed = (decoded as? DirectDecodedResult.Typed)?.result
    if (typed is AgentToolResult.ErrorResult) {
        return DirectCardContent(
            label = "Look up URL",
            arg = url,
            argLink = argLink,
            error = DirectCardError(typed.code, typed.message),
        )
    }
    if (typed !is AgentToolResult.DocumentByUrl) {
        return directGenericCard("lookup_document_by_url", args, decoded)
    }
    // A null ref is a successful "no match", not an error — the portal reads
    // "No result" here rather than rendering nothing.
    val ref = typed.ref
    return DirectCardContent(
        label = "Look up URL",
        arg = url,
        argLink = argLink,
        rows = ref?.let { listOf(directDocumentRow(it)) }.orEmpty(),
        showsEmpty = ref == null,
    )
}

private fun directPeopleCard(args: JsonElement?, decoded: DirectDecodedResult): DirectCardContent {
    val query = args.stringField("name").ifEmpty { args.stringField("query") }
    val typed = (decoded as? DirectDecodedResult.Typed)?.result
    if (typed is AgentToolResult.ErrorResult) {
        return DirectCardContent(
            label = "Look up people",
            arg = query,
            error = DirectCardError(typed.code, typed.message),
        )
    }
    if (typed !is AgentToolResult.PersonResults) {
        return directGenericCard("lookup_people", args, decoded)
    }
    val rows = typed.results.take(DIRECT_CARD_MAX_ROWS).map { person ->
        DirectCardRow(
            title = person.displayName.ifBlank { "Unnamed person" },
            subtitle = person.aliases.firstOrNull(),
            destination = DirectCardDestination.Person(person.canonicalId, person.displayName),
        )
    }
    return DirectCardContent(
        label = "Look up people",
        arg = query,
        rows = rows,
        showsEmpty = rows.isEmpty(),
    )
}

private fun directTrailCard(args: JsonElement?, decoded: DirectDecodedResult): DirectCardContent {
    val seeds = directTrailSeedsDisplay(args, decoded)
    val typed = (decoded as? DirectDecodedResult.Typed)?.result
    if (typed is AgentToolResult.ErrorResult) {
        return DirectCardContent(
            label = "Trace connections",
            arg = seeds.text,
            argIcon = seeds.icon,
            error = DirectCardError(typed.code, typed.message),
        )
    }
    if (typed !is AgentToolResult.EventTrailBuilt) {
        return directGenericCard("trace_connections", args, decoded)
    }
    // Chronological like the portal's `flattenTrailDocs`: each event's doc,
    // then its attachments' docs, deduplicated by document id.
    val seen = HashSet<String>()
    val rows = ArrayList<DirectCardRow>()
    fun push(documentId: String, title: String, sourceId: String) {
        if (documentId.isEmpty() || !seen.add(documentId)) return
        rows.add(
            DirectCardRow(
                title = title.ifBlank { "Untitled" },
                destination = DirectCardDestination.Document(
                    id = documentId,
                    sourceId = sourceId.ifBlank { null },
                    title = title,
                ),
            ),
        )
    }
    for (event in typed.events) {
        event.doc?.let { push(it.documentId, it.title, it.sourceId) }
        for (attachment in event.attachments) {
            attachment.doc?.let { push(it.documentId, it.title, it.sourceId) }
        }
    }
    return DirectCardContent(
        label = "Trace connections",
        arg = seeds.text,
        argIcon = seeds.icon,
        rows = rows.take(DIRECT_CARD_MAX_ROWS),
        showsEmpty = rows.isEmpty(),
    )
}

/** The walked seed ids, comma-joined, read on the card's header line — mirroring the portal. */
internal fun directTraceSeedsArg(args: JsonElement?): String {
    val seeds = (args as? JsonObject)?.get("seedIds") as? JsonArray ?: return ""
    return seeds.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim() }
        .filter { it.isNotEmpty() }
        .joinToString(", ")
}

private fun directSqlCard(args: JsonElement?, decoded: DirectDecodedResult): DirectCardContent {
    val sql = args.stringField("sql").split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    val typed = (decoded as? DirectDecodedResult.Typed)?.result
    if (typed is AgentToolResult.ErrorResult) {
        return DirectCardContent(
            label = "Run SQL",
            arg = sql,
            error = DirectCardError(typed.code, typed.message),
        )
    }
    if (typed !is AgentToolResult.SqlRows) {
        return directGenericCard("run_sql", args, decoded)
    }
    val normalised = typed.rows.map { directNormaliseSqlRow(it, typed.columns.size) }
    return DirectCardContent(
        label = "Run SQL",
        arg = sql,
        sql = DirectSqlBlock(
            columns = typed.columns,
            rows = normalised.take(DIRECT_CARD_MAX_SQL_ROWS),
            totalRows = typed.rowCount.takeIf { it > 0 } ?: typed.rows.size,
        ),
        showsEmpty = typed.rows.isEmpty(),
    )
}

private fun directLoopsSearchedCard(args: JsonElement?, decoded: DirectDecodedResult): DirectCardContent {
    val query = args.stringField("query")
    val typed = (decoded as? DirectDecodedResult.Typed)?.result
    if (typed is AgentToolResult.ErrorResult) {
        return DirectCardContent(
            label = "Search loops",
            arg = query,
            error = DirectCardError(typed.code, typed.message),
        )
    }
    if (typed !is AgentToolResult.LoopsSearched) {
        return directGenericCard("search_loops", args, decoded)
    }
    val rows = typed.loops.take(DIRECT_CARD_MAX_ROWS).map {
        directLoopRow(loopId = it.loopId, state = it.state, title = it.title)
    }
    return DirectCardContent(
        label = "Search loops",
        arg = query,
        rows = rows,
        showsEmpty = rows.isEmpty(),
    )
}

private fun directLoopFetchedCard(decoded: DirectDecodedResult): DirectCardContent {
    val typed = (decoded as? DirectDecodedResult.Typed)?.result
    if (typed is AgentToolResult.ErrorResult) {
        return DirectCardContent(
            label = "Open loop",
            error = DirectCardError(typed.code, typed.message),
        )
    }
    if (typed !is AgentToolResult.LoopFetched) {
        return directGenericCard("fetch_loop", null, decoded)
    }
    // A null loop is a clean no-match, not an error.
    val rows = typed.loop?.let {
        listOf(directLoopRow(loopId = it.loopId, state = it.state, title = it.title))
    }.orEmpty()
    return DirectCardContent(
        label = "Open loop",
        rows = rows,
        showsEmpty = rows.isEmpty(),
    )
}

/* ── Structured steward tools ────────────────────────────────────────── */

private fun directStructuredCard(
    tool: String,
    args: JsonElement?,
    decoded: DirectDecodedResult,
): DirectCardContent {
    val label = directToolLabel(tool)
    val arg = when (tool) {
        "open_loop_search" -> args.stringField("query")
        "entity_context" -> directEntityContextArg(args)
        "temporal_query" -> directTemporalRange(args)
        else -> ""
    }
    val typed = (decoded as? DirectDecodedResult.Typed)?.result
    if (typed is AgentToolResult.ErrorResult) {
        return DirectCardContent(label = label, arg = arg, error = DirectCardError(typed.code, typed.message))
    }
    val structured = decoded as? DirectDecodedResult.Structured
        ?: return directGenericCard(tool, args, decoded)
    val data = structured.data as? JsonObject ?: return directGenericCard(tool, args, decoded)
    return when (tool to structured.resultType) {
        "list_loops" to "loops.listed" -> {
            val rows = directLoopList(data["loops"]).take(DIRECT_CARD_MAX_ROWS).map {
                directLoopRow(loopId = it.id, state = it.state, title = it.title)
            }
            DirectCardContent(label = label, arg = arg, rows = rows, showsEmpty = rows.isEmpty())
        }
        "open_loop_search" to "open_loop.search_results" -> {
            val rows = directLoopList(data["loops"]).take(DIRECT_CARD_MAX_ROWS).map {
                directLoopRow(loopId = it.id, state = it.state, title = it.title)
            }
            val retired = directRetiredCount(data["retired"])
            DirectCardContent(
                label = label,
                arg = arg,
                rows = rows,
                note = retired.takeIf { it > 0 }?.let { "$it retired" },
                showsEmpty = rows.isEmpty() && retired == 0,
            )
        }
        "open_loop_fetch" to "open_loop.fetched" -> {
            val rows = directSingleLoop(data)?.let {
                listOf(directLoopRow(loopId = it.id, state = it.state, title = it.title))
            }.orEmpty()
            DirectCardContent(label = label, arg = arg, rows = rows, showsEmpty = rows.isEmpty())
        }
        "entity_context" to "entity_context.reaped" -> {
            val seed = directEntitySeedDisplay(args, data)
            val rows = directNeighborhoodRows(data)
            DirectCardContent(
                label = label,
                arg = seed.text,
                argIcon = seed.icon,
                rows = rows,
                showsEmpty = rows.isEmpty(),
            )
        }
        "temporal_query" to "temporal.results" -> {
            val items = (data["items"] as? JsonArray).orEmpty()
            val rows = items.take(DIRECT_CARD_MAX_ROWS).map { entry ->
                DirectCardRow(title = entry.stringField("label").ifBlank { "Untitled moment" })
            }
            DirectCardContent(label = label, arg = arg, rows = rows, showsEmpty = rows.isEmpty())
        }
        else -> directGenericCard(tool, args, decoded)
    }
}

/* ── Generic fallback ────────────────────────────────────────────────── */

/** Any tool this client does not render keeps its header. The screen owns the raw-JSON affordance. */
private fun directGenericCard(tool: String, args: JsonElement?, decoded: DirectDecodedResult): DirectCardContent {
    val typed = (decoded as? DirectDecodedResult.Typed)?.result
    if (typed is AgentToolResult.ErrorResult) {
        return DirectCardContent(
            label = directToolLabel(tool),
            arg = directGenericArg(tool, args),
            error = DirectCardError(typed.code, typed.message),
        )
    }
    return DirectCardContent(label = directToolLabel(tool), arg = directGenericArg(tool, args))
}

internal fun directToolLabel(tool: String): String = when (tool) {
    "" -> "Unknown tool"
    "search_many" -> "Search"
    "fetch_many" -> "Open documents"
    "lookup_document_by_url" -> "Look up URL"
    "lookup_people" -> "Look up people"
    "trace_connections" -> "Trace connections"
    "run_sql" -> "Run SQL"
    "search_loops", "open_loop_search" -> "Search loops"
    "list_loops" -> "List loops"
    "fetch_loop", "open_loop_fetch" -> "Open loop"
    "entity_context" -> "Entity context"
    "temporal_query" -> "Temporal query"
    else -> tool
}

private fun directGenericArg(tool: String, args: JsonElement?): String = when (tool) {
    "lookup_document_by_url" -> args.stringField("url")
    "lookup_people" -> args.stringField("name").ifEmpty { args.stringField("query") }
    "run_sql" -> args.stringField("sql").split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    "trace_connections" -> directTraceSeedsArg(args)
    "search_loops", "open_loop_search" -> args.stringField("query")
    "temporal_query" -> directTemporalRange(args)
    else -> ""
}

private fun directTemporalRange(args: JsonElement?): String {
    val from = args.stringField("from")
    val to = args.stringField("to")
    if (from.isEmpty() && to.isEmpty()) return ""
    return "${from.ifEmpty { "now" }} … ${to.ifEmpty { from.ifEmpty { "now" } }}"
}

/** The reaped entity's kind and id read on the card's header line — mirroring the portal. */
internal fun directEntityContextArg(args: JsonElement?): String =
    listOf(args.stringField("kind").trim(), args.stringField("id").trim())
        .filter { it.isNotEmpty() }
        .joinToString(" ")

/**
 * The reaped entity as a header seed: `data.seed` carries kind, id and
 * label, so the header reads the source icon plus title — never a bare id.
 * A document seed resolves its source icon from the reaped documents.
 * Without a seed the call's own kind/id stand in, as before.
 */
internal fun directEntitySeedDisplay(args: JsonElement?, data: JsonObject): DirectSeedDisplay {
    val kind = args.stringField("kind").trim()
    val id = args.stringField("id").trim()
    val fallback = listOf(kind, id).filter { it.isNotEmpty() }.joinToString(" ")
    val seed = data["seed"] as? JsonObject
    val seedKind = seed.stringField("kind").ifEmpty { kind }
    val seedId = seed.stringField("id").ifEmpty { id }
    val label = seed.stringField("label").trim()
    if (label.isEmpty()) return DirectSeedDisplay(null, fallback)
    val icon = when (seedKind) {
        "document" -> DirectArgIcon.Document(
            (data["documents"] as? JsonArray).orEmpty()
                .firstOrNull { (it as? JsonObject).stringField("documentId") == seedId }
                .stringField("sourceId").ifEmpty { null },
        )
        "loop" -> DirectArgIcon.Loop
        "person" -> DirectArgIcon.Person
        else -> null
    }
    return DirectSeedDisplay(icon, label)
}

/**
 * Walk seeds as a header seed: each seed id resolves to its trail event's
 * document title with the first resolved seed's source icon; unresolved
 * seeds keep their ids.
 */
internal fun directTrailSeedsDisplay(args: JsonElement?, decoded: DirectDecodedResult): DirectSeedDisplay {
    val trail = (decoded as? DirectDecodedResult.Typed)?.result as? AgentToolResult.EventTrailBuilt
    var ids = trail?.seeds.orEmpty()
    if (ids.isEmpty()) {
        ids = ((args as? JsonObject)?.get("seedIds") as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    }
    if (ids.isEmpty()) return DirectSeedDisplay(null, "")
    val events = trail?.events.orEmpty()
    var icon: DirectArgIcon? = null
    val titles = ids.map { id ->
        val doc = events.asSequence().mapNotNull { it.doc }.firstOrNull { it.documentId == id }
        if (doc == null) {
            id
        } else {
            if (icon == null) icon = DirectArgIcon.Document(doc.sourceId.ifEmpty { null })
            doc.title.ifEmpty { id }
        }
    }
    return DirectSeedDisplay(icon, titles.joinToString(", "))
}

/**
 * External targets open out-of-app per portal convention — and only http(s)
 * becomes a link. Anything else stays plain text, never a lively href.
 */
fun directExternalDestination(raw: String): DirectCardDestination? {
    val trimmed = raw.trim()
    if (!trimmed.startsWith("http://", ignoreCase = true) && !trimmed.startsWith("https://", ignoreCase = true)) {
        return null
    }
    return DirectCardDestination.External(trimmed)
}

/* ── Row builders ────────────────────────────────────────────────────── */

private fun directDocumentRow(ref: AgentDocRef, fallbackTitle: String? = null): DirectCardRow {
    val title = ref.title?.takeIf { it.isNotBlank() } ?: fallbackTitle ?: "Untitled"
    return DirectCardRow(
        title = title,
        destination = DirectCardDestination.Document(
            id = ref.documentId,
            sourceId = ref.sourceId.ifBlank { null },
            title = title,
        ),
    )
}

private fun directLoopRow(loopId: String, state: String, title: String): DirectCardRow =
    DirectCardRow(
        title = title.ifBlank { "Untitled loop" },
        subtitle = state.ifBlank { null },
        destination = loopId.ifBlank { null }?.let { DirectCardDestination.Loop(it) },
    )

private data class DirectLoopFields(val id: String, val state: String, val title: String)

private fun directLoopList(value: JsonElement?): List<DirectLoopFields> {
    val items = (value as? JsonArray).orEmpty()
    return items.mapNotNull { entry ->
        val fields = entry as? JsonObject ?: return@mapNotNull null
        DirectLoopFields(
            id = fields.stringField("loopId").ifEmpty { fields.stringField("id") },
            state = fields.stringField("state"),
            title = fields.stringField("title").ifBlank { "Untitled loop" },
        )
    }
}

private fun directSingleLoop(data: JsonObject): DirectLoopFields? {
    val id = data.stringField("loopId").ifEmpty { data.stringField("id") }
    val title = data.stringField("title")
    if (id.isEmpty() && title.isEmpty()) return null
    return DirectLoopFields(id = id, state = data.stringField("state"), title = title.ifBlank { "Untitled loop" })
}

private fun directRetiredCount(value: JsonElement?): Int =
    (value as? JsonPrimitive)?.intOrNull?.coerceAtLeast(0)
        ?: (value as? JsonArray)?.size
        ?: 0

private fun directNeighborhoodRows(data: JsonObject): List<DirectCardRow> {
    val rows = ArrayList<DirectCardRow>()
    for (doc in (data["documents"] as? JsonArray).orEmpty()) {
        val fields = doc as? JsonObject ?: continue
        val id = fields.stringField("documentId")
        val title = fields.stringField("title").ifBlank { "Untitled" }
        val sourceId = fields.stringField("sourceId").ifBlank { null }
        rows.add(
            DirectCardRow(
                title = title,
                destination = id.ifBlank { null }?.let {
                    DirectCardDestination.Document(id = it, sourceId = sourceId, title = title)
                },
            ),
        )
    }
    for (person in (data["people"] as? JsonArray).orEmpty()) {
        val fields = person as? JsonObject ?: continue
        val name = fields.stringField("name").ifBlank { "Unnamed person" }
        val id = fields.stringField("personId").ifEmpty { fields.stringField("canonicalId") }
        rows.add(
            DirectCardRow(
                title = name,
                destination = id.ifBlank { null }?.let { DirectCardDestination.Person(it, name) },
            ),
        )
    }
    for (loop in directLoopList(data["loops"])) {
        rows.add(directLoopRow(loopId = loop.id, state = loop.state, title = loop.title))
    }
    for (annotation in (data["temporalAnnotations"] as? JsonArray).orEmpty()) {
        rows.add(
            DirectCardRow(
                title = (annotation as? JsonObject).stringField("sentence").ifBlank { "Untitled moment" },
            ),
        )
    }
    return rows.take(DIRECT_CARD_MAX_ROWS)
}

/* ── Args helpers ────────────────────────────────────────────────────── */

private fun directArgQueries(args: JsonElement?): List<String> =
    ((args as? JsonObject)?.get("queries") as? JsonArray).orEmpty().map {
        (it as? JsonObject).stringField("query")
    }

private fun directArgDocumentIds(args: JsonElement?): List<String> =
    ((args as? JsonObject)?.get("documents") as? JsonArray).orEmpty().map {
        (it as? JsonObject).stringField("documentId")
    }

/* ── SQL formatting ──────────────────────────────────────────────────── */

/** Pad or trim a row to the column count, mirroring the portal's `normaliseRow`. */
internal fun directNormaliseSqlRow(row: List<JsonElement>, columns: Int): List<String> {
    val cells = row.take(columns).map { directSqlCell(it) }
    return cells + List(maxOf(0, columns - cells.size)) { "null" }
}

internal fun directSqlCell(value: JsonElement): String = when (value) {
    is JsonNull -> "null"
    is JsonPrimitive -> when {
        value.isString -> value.contentOrNull.orEmpty()
        value.booleanOrNull != null -> value.booleanOrNull.toString()
        value.longOrNull != null -> value.longOrNull.toString()
        value.doubleOrNull != null -> value.doubleOrNull.toString()
        else -> value.contentOrNull.orEmpty()
    }
    else -> value.toString()
}

/* ── JsonElement conveniences ────────────────────────────────────────── */

private fun JsonElement?.stringField(name: String): String =
    ((this as? JsonObject)?.get(name) as? JsonPrimitive)?.contentOrNull.orEmpty()
