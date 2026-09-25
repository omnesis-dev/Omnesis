// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.FileTypeIcon
import dev.omnesis.android.designsystem.components.MiddleEllipsisText
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AgentTrailEvent
import dev.omnesis.android.transport.dto.AgentTrailEventDoc
import dev.omnesis.android.transport.dto.AgentTrailEventPerson
import dev.omnesis.android.transport.dto.AgentTrailEventRelated
import dev.omnesis.android.transport.dto.AgentTrailRecord
import dev.omnesis.android.transport.dto.AgentTrailRecordKeyField
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

// =====================================================================================
// Annotation-projection model — port of iOS `AgentTrailState.swift`
// =====================================================================================

/** One projected quote/note pulled from an `annotate` call onto a timeline doc. */
data class AgentQuoteEntry(
    val quote: String,
    val note: String? = null,
    val quoteAuthor: String? = null,
    val quoteIsSelf: Boolean = false,
)

/** All annotations recorded for a single document — an optional doc note plus quotes. */
data class AgentDocAnnotations(
    val note: String? = null,
    val quotes: List<AgentQuoteEntry> = emptyList(),
)

/** Annotation projection keyed by documentId; consumed by the timeline renderer. */
data class AgentTrailAnnotations(val byDoc: Map<String, AgentDocAnnotations> = emptyMap()) {
    companion object {
        val empty = AgentTrailAnnotations()

        /**
         * Fold the conversation's citations into a per-document annotation projection.
         * Each [AgentCitation] carries a doc-level note plus zero-or-more quote entries
         * (with author + self flag); we collapse them into one [AgentDocAnnotations] slot.
         */
        fun from(citations: List<AgentCitation>): AgentTrailAnnotations {
            val byDoc = LinkedHashMap<String, AgentDocAnnotations>()
            for (c in citations) {
                val quotes = c.entries.mapNotNull { e ->
                    val q = e.quote?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                    AgentQuoteEntry(
                        quote = q,
                        note = e.note?.takeIf { it.isNotBlank() },
                        quoteAuthor = e.quoteAuthor?.takeIf { it.isNotBlank() },
                        quoteIsSelf = e.quoteIsSelf,
                    )
                }
                byDoc[c.documentId] = AgentDocAnnotations(
                    note = c.docNote?.takeIf { it.isNotBlank() },
                    quotes = quotes,
                )
            }
            return AgentTrailAnnotations(byDoc)
        }
    }
}

/** Builds the flat, chronological unified event list the renderer consumes. */
object AgentTimelineBuilder {

    /**
     * The unified timeline for the drawer — built purely from what the agent explicitly
     * referenced this conversation: one row per cited document (an `annotate` call, projected by
     * [synthesiseEvent] from the citation's captured [AgentDocRef]) plus one row per directly-cited
     * analytics record (#757, projected by [synthesiseRecordEvent]). A graph walk's raw output does
     * NOT populate the timeline — only the agent's deliberate annotations and record citations do.
     * Citations are already unique per documentId and records unique per recordKey (deduped
     * upstream), so the two sets never collide. Sorted by `at` ascending with nil-`at` rows sinking
     * to the bottom in deterministic entity-id order.
     */
    fun buildUnifiedTimeline(
        citations: List<AgentCitation>,
        records: List<AgentTrailRecord> = emptyList(),
    ): List<AgentTrailEvent> {
        val docEvents = citations.map { synthesiseEvent(it) }
        val recordEvents = records.map { synthesiseRecordEvent(it) }
        return (docEvents + recordEvents).sortedWith(
            compareBy(
                { it.at == null },
                { it.at ?: "" },
                { it.entityId },
            ),
        )
    }

    /** Fabricate a bare timeline event from a citation's captured DocRef (annotate-only doc). */
    private fun synthesiseEvent(c: AgentCitation): AgentTrailEvent {
        val ref = c.ref
        return AgentTrailEvent(
            eventId = "cite:${c.documentId}",
            at = ref.ts?.let { java.time.Instant.ofEpochMilli((it * 1000).toLong()).toString() },
            kind = "annotate",
            doc = AgentTrailEventDoc(
                documentId = c.documentId,
                title = ref.title.orEmpty(),
                sourceId = ref.sourceId,
                sourceUrl = ref.url,
                appUrl = ref.appUrl,
                documentType = ref.documentType,
                mimeType = ref.mimeType,
            ),
        )
    }

    /**
     * Fabricate a record-only timeline event from a directly-cited record (#757). It carries no
     * `doc` (the renderer's [AgentTrailEvent.doc] == null branch draws the record body), keys its
     * entity on the `recordKey`, and sits at the record's `semanticTime`. Identical in shape to a
     * record-only event the `trace_connections` tool emits, so the existing renderer just works.
     */
    private fun synthesiseRecordEvent(record: AgentTrailRecord): AgentTrailEvent =
        AgentTrailEvent(
            eventId = "cite:${record.recordKey}",
            at = record.semanticTime.ifEmpty { null },
            kind = "record",
            doc = null,
            record = record,
        )
}

// =====================================================================================
// Formatting helpers — port of iOS `TrailTimelineFormat`
// =====================================================================================

object TrailTimelineFormat {
    private val duplicateLikeLinkTypes =
        setOf("duplicate-content", "same-resource", "near-duplicate")

    fun isDuplicateLikeLinkType(linkType: String): Boolean =
        linkType in duplicateLikeLinkTypes

    private val weekday = DateTimeFormatter.ofPattern("EEE", Locale.US)
    private val mdy = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US)
    private val time = DateTimeFormatter.ofPattern("HH:mm", Locale.UK)

    /** YYYY-MM-DD prefix used to detect day boundaries between consecutive events. */
    fun dayKey(iso: String?): String = iso?.take(10) ?: ""

    /** "SAT · DEC 6, 2025" header label (uppercased). "—" when unparseable. */
    fun dateHeaderLabel(iso: String?): String {
        val dt = parse(iso) ?: return "—"
        return "${weekday.format(dt)} · ${mdy.format(dt)}".uppercase(Locale.US)
    }

    /** "10:08" 24-hour time label. Empty when unparseable. */
    fun timeLabel(iso: String?): String {
        val dt = parse(iso) ?: return ""
        return time.format(dt)
    }

    /** Verb phrase for a related-edge `linkType`, direction-aware. Unknown types pass through. */
    fun phraseForLinkType(linkType: String, direction: String): String {
        if (linkType == "url" && direction == "in") return "cited by"
        return when (linkType) {
            "attachment" -> "attached to"
            "email-thread" -> "in same thread as"
            "intra-source" -> "links to"
            "calendar-event" -> "matches event"
            "url" -> "cites"
            "duplicate-content" -> "duplicate of"
            "same-resource" -> "another representation of"
            "near-duplicate" -> "near-duplicate of"
            else -> linkType
        }
    }

    /** Group people by role-bucket label, in first-seen order. Source-agnostic. */
    fun groupPeopleByBucket(people: List<AgentTrailEventPerson>): List<Pair<String, List<String>>> {
        val byBucket = LinkedHashMap<String, MutableList<String>>()
        for (p in people) {
            byBucket.getOrPut(bucketForRole(p.role)) { mutableListOf() }.add(p.name)
        }
        return byBucket.map { it.key to it.value.toList() }
    }

    /** "by X · to Y" prose line from grouped people buckets. */
    fun peopleLine(buckets: List<Pair<String, List<String>>>): String =
        buckets
            .filter { it.second.isNotEmpty() }
            .joinToString(" · ") { (label, names) -> "$label ${names.joinToString(", ")}" }

    private fun bucketForRole(role: String): String = when (role) {
        "sender", "author" -> "by"
        "owner" -> "owned by"
        "recipient", "attendee" -> "to"
        "participant" -> "with"
        "mentioned" -> "mentions"
        "contact" -> "contact"
        "editor" -> "edited by"
        else -> "involves"
    }

    private fun parse(iso: String?): OffsetDateTime? {
        if (iso.isNullOrBlank()) return null
        return runCatching { OffsetDateTime.parse(iso) }.getOrNull()
    }
}

// =====================================================================================
// Quote-author sticky color palette (matches portal QUOTE_AUTHOR_COLORS)
// =====================================================================================

private val QUOTE_AUTHOR_COLORS: List<Color> = listOf(
    Color(0xFF7AAFCB), // soft blue
    Color(0xFFC4A46C), // warm sand
    Color(0xFFCB8A72), // muted coral
    Color(0xFF8BB47A), // sage green
    Color(0xFFA78BBF), // soft purple
    Color(0xFF6BBFAE), // teal
    Color(0xFFBF8BA7), // dusty rose
    Color(0xFFA0A85C), // olive gold
)

/** Assign each author a sticky color in first-seen order across the whole timeline. */
private fun buildQuoteAuthorColorMap(
    events: List<AgentTrailEvent>,
    annotations: AgentTrailAnnotations,
): Map<String, Color> {
    val map = LinkedHashMap<String, Color>()
    fun assign(author: String?) {
        val a = author?.takeIf { it.isNotBlank() } ?: return
        if (map.containsKey(a)) return
        map[a] = QUOTE_AUTHOR_COLORS[map.size % QUOTE_AUTHOR_COLORS.size]
    }
    for (event in events) {
        event.doc?.let { annotations.byDoc[it.documentId]?.quotes?.forEach { q -> assign(q.quoteAuthor) } }
        for (att in event.attachments) {
            att.doc?.let { annotations.byDoc[it.documentId]?.quotes?.forEach { q -> assign(q.quoteAuthor) } }
        }
    }
    for (slot in annotations.byDoc.values) {
        slot.quotes.forEach { assign(it.quoteAuthor) }
    }
    return map
}

// =====================================================================================
// Layout constants — port of iOS `TrailTimelineLayout`
// =====================================================================================

private val SPINE_COLUMN_WIDTH = 28.dp
private val DOT_DIAMETER = 19.dp
private val ROW_GAP = 22.dp
private val SPINE_WIDTH = 1.5.dp
private const val SPINE_OPACITY = 0.55f
private val BUBBLE_TAIL_WIDTH = 6.dp

// =====================================================================================
// Row model
// =====================================================================================

private sealed interface TrailRowItem {
    val accent: Color
    val nextAccent: Color

    data class Header(
        val date: String?,
        override val accent: Color,
        override val nextAccent: Color,
    ) : TrailRowItem

    data class Event(
        val event: AgentTrailEvent,
        /** The event's position in the source `events` list (skipping headers) — keys
         *  per-event frame reports back to a specific event so the host's sticky-tab
         *  layer can pin one tab per event. Mirrors iOS `eventIndex`. */
        val eventIndex: Int,
        override val accent: Color,
        override val nextAccent: Color,
    ) : TrailRowItem
}

/** Build header + event rows with each row's accent + the following row's accent. */
private fun rowsForRender(
    events: List<AgentTrailEvent>,
    catalog: SourceCatalog,
    fallback: Color,
): List<TrailRowItem> {
    data class Partial(
        val isHeader: Boolean,
        val date: String?,
        val event: AgentTrailEvent?,
        val eventIndex: Int,
        val accent: Color,
    )

    val partial = mutableListOf<Partial>()
    var currentDayKey: String? = null
    for ((eventIndex, event) in events.withIndex()) {
        val accent = event.eventSourceId?.let { catalog.accentColor(it) } ?: fallback
        val dayKey = TrailTimelineFormat.dayKey(event.at)
        if (dayKey != currentDayKey) {
            partial.add(Partial(isHeader = true, date = event.at, event = null, eventIndex = -1, accent = accent))
            currentDayKey = dayKey
        }
        partial.add(Partial(isHeader = false, date = event.at, event = event, eventIndex = eventIndex, accent = accent))
    }
    return partial.mapIndexed { i, p ->
        val nextAccent = if (i + 1 < partial.size) partial[i + 1].accent else p.accent
        if (p.isHeader) {
            TrailRowItem.Header(p.date, p.accent, nextAccent)
        } else {
            TrailRowItem.Event(p.event!!, p.eventIndex, p.accent, nextAccent)
        }
    }
}

/** Doc ids actually rendered as rows (top-level events + nested attachments). */
private fun inTimelineDocIds(events: List<AgentTrailEvent>): Set<String> {
    val ids = HashSet<String>()
    for (event in events) {
        event.doc?.let { ids.add(it.documentId) }
        for (att in event.attachments) att.doc?.let { ids.add(it.documentId) }
    }
    return ids
}

// =====================================================================================
// Renderer
// =====================================================================================

/**
 * The trail timeline — a SwiftUI-parity port of the iOS `TrailTimelineView`. Renders the
 * chronological event list of the documents and records the agent referenced, with per-source accent
 * spines that cross-fade between rows, transparent source dots that "cut" the spine,
 * date-group headers, nested attachments, related-edge lines, and projected annotations
 * (vertical-bar quotes, or chat bubbles for conversation docs).
 *
 * Source-agnostic: accent + icon are resolved through [SourceCatalog]; the visual logic
 * only consumes the closed `kind` / `linkType` / role vocabularies. The host wraps this in
 * a vertically-scrolling container (the drawer's Timeline tab).
 */
@Composable
fun TrailTimeline(
    events: List<AgentTrailEvent>,
    annotations: AgentTrailAnnotations,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
    modifier: Modifier = Modifier,
    /** When non-null, each event row reports its layout coordinates so a host (the
     *  [CitationsDrawer]) can pin one sticky tab per event at the event's anchor Y.
     *  Keyed by the event's index in [events]. Mirrors iOS `TrailEventFrameKey`. */
    onEventFrame: ((Int, androidx.compose.ui.layout.LayoutCoordinates) -> Unit)? = null,
) {
    if (events.isEmpty()) {
        TrailEmptyState(modifier)
        return
    }
    val fallback = OmTheme.colors.textMuted
    val authorColors = buildQuoteAuthorColorMap(events, annotations)
    val visibleDocIds = inTimelineDocIds(events)
    val rows = rowsForRender(events, catalog, fallback)

    Column(modifier.padding(horizontal = 4.dp, vertical = 4.dp)) {
        rows.forEachIndexed { idx, row ->
            val isFirst = idx == 0
            val isLast = idx == rows.lastIndex
            when (row) {
                is TrailRowItem.Header -> TrailDateHeader(row, isFirst, isLast)
                is TrailRowItem.Event -> TrailRow(
                    row = row,
                    annotations = annotations,
                    isFirst = isFirst,
                    isLast = isLast,
                    visibleDocIds = visibleDocIds,
                    authorColors = authorColors,
                    catalog = catalog,
                    onOpenDocument = onOpenDocument,
                    onEventFrame = onEventFrame,
                )
            }
        }
    }
}

/**
 * Vertical offset from an event row's top edge to the centre of the source-icon dot —
 * the sticky-tab anchor. The dot sits with `padding(top = 2dp)` and a 19dp diameter, so
 * its centre is at `2 + 19/2 = 11.5dp`. Matches iOS `TrailTimelineLayout.tabAnchorOffset`.
 */
internal val TRAIL_TAB_ANCHOR_OFFSET = 11.5.dp

// =====================================================================================
// Spine
// =====================================================================================

/**
 * A spine segment for one row: a 1.5dp vertical line at 0.55 opacity, holding the row's
 * accent for the top 85% then cross-fading into [nextAccent] over the bottom 15%. The very
 * first/last rows fade in/out at the panel edges by ramping the line's own alpha to zero, so
 * it dissolves into whatever theme background sits behind it (white in light, near-black in
 * dark) rather than into a fixed colour.
 */
@Composable
private fun TrailSpineSegment(
    accent: Color,
    nextAccent: Color,
    isFirst: Boolean,
    isLast: Boolean,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier
            .width(SPINE_WIDTH)
            .fillMaxHeight()
            .drawWithCache {
                val a = accent.copy(alpha = SPINE_OPACITY)
                val n = nextAccent.copy(alpha = SPINE_OPACITY)
                val faded = accent.copy(alpha = 0f)
                val stops = buildList {
                    if (isFirst) {
                        add(0.0f to faded)
                        add(0.22f to a)
                    } else {
                        add(0.0f to a)
                    }
                    add(0.85f to a)
                    if (isLast) {
                        add(1.0f to faded)
                    } else {
                        add(1.0f to n)
                    }
                }
                val brush = Brush.verticalGradient(*stops.toTypedArray())
                onDrawWithContent { drawRect(brush) }
            },
    )
}

/** Spine column for an event row: the line + a bg-disc that cuts it + the source icon. */
@Composable
private fun TrailSpineColumn(
    event: AgentTrailEvent,
    accent: Color,
    nextAccent: Color,
    isFirst: Boolean,
    isLast: Boolean,
    catalog: SourceCatalog,
) {
    Box(
        Modifier.width(SPINE_COLUMN_WIDTH).fillMaxHeight(),
        contentAlignment = Alignment.TopCenter,
    ) {
        TrailSpineSegment(accent, nextAccent, isFirst, isLast)
        // bg-coloured disc (icon diameter + 4) cuts the line where the icon mounts.
        Box(
            Modifier
                .size(DOT_DIAMETER + 4.dp)
                .clip(CircleShape)
                .background(OmTheme.colors.bgPrimary),
        )
        dev.omnesis.android.designsystem.components.SourceIcon(
            model = catalog.iconModel(event.eventSourceId.orEmpty()),
            size = DOT_DIAMETER,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}

// =====================================================================================
// Date header
// =====================================================================================

@Composable
private fun TrailDateHeader(row: TrailRowItem.Header, isFirst: Boolean, isLast: Boolean) {
    Row(Modifier.height(IntrinsicSize.Min), verticalAlignment = Alignment.Top) {
        Box(Modifier.width(SPINE_COLUMN_WIDTH).fillMaxHeight()) {
            Box(Modifier.width(SPINE_COLUMN_WIDTH).fillMaxHeight(), contentAlignment = Alignment.TopCenter) {
                TrailSpineSegment(row.accent, row.nextAccent, isFirst, isLast)
            }
        }
        Text(
            TrailTimelineFormat.dateHeaderLabel(row.date),
            style = MaterialTheme.typography.labelSmall.copy(
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.6.sp,
            ),
            color = OmTheme.colors.textMuted,
            modifier = Modifier
                .weight(1f)
                .padding(top = if (isFirst) ROW_GAP else 0.dp, bottom = ROW_GAP),
        )
    }
}

// =====================================================================================
// Event row + body
// =====================================================================================

@Composable
private fun TrailRow(
    row: TrailRowItem.Event,
    annotations: AgentTrailAnnotations,
    isFirst: Boolean,
    isLast: Boolean,
    visibleDocIds: Set<String>,
    authorColors: Map<String, Color>,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
    onEventFrame: ((Int, androidx.compose.ui.layout.LayoutCoordinates) -> Unit)? = null,
) {
    val event = row.event
    val rowModifier = if (onEventFrame != null) {
        Modifier
            .height(IntrinsicSize.Min)
            .onGloballyPositioned { onEventFrame(row.eventIndex, it) }
    } else {
        Modifier.height(IntrinsicSize.Min)
    }
    Row(rowModifier, verticalAlignment = Alignment.Top) {
        TrailSpineColumn(event, row.accent, row.nextAccent, isFirst, isLast, catalog)
        Column(
            Modifier
                .weight(1f)
                .padding(bottom = ROW_GAP) // rowGap lives inside the row, below the card
                .clip(RoundedCornerShape(OmTheme.radius.medium))
                .background(OmTheme.colors.bgSecondary)
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            TrailEventBody(
                event = event,
                isAttachment = false,
                docAnnotations = event.doc?.let { annotations.byDoc[it.documentId] },
                visibleDocIds = visibleDocIds,
                authorColors = authorColors,
                catalog = catalog,
                onOpenDocument = onOpenDocument,
            )
            event.attachments.forEach { att ->
                TrailAttachment(
                    attachment = att,
                    docAnnotations = att.doc?.let { annotations.byDoc[it.documentId] },
                    visibleDocIds = visibleDocIds,
                    authorColors = authorColors,
                    catalog = catalog,
                    onOpenDocument = onOpenDocument,
                )
            }
        }
    }
}

private val FILE_LIKE_DOC_TYPES = setOf("file", "attachment")
private val CONVERSATION_DOC_TYPES = setOf("conversation")
@Composable
private fun TrailEventBody(
    event: AgentTrailEvent,
    isAttachment: Boolean,
    docAnnotations: AgentDocAnnotations?,
    visibleDocIds: Set<String>,
    authorColors: Map<String, Color>,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
) {
    val doc = event.doc
    // #757: a record-only event (a bound DuckDB row with no co-described document) has no `doc`
    // to head the row — render the record body instead. Records never nest as attachments, so
    // this only fires at top level.
    if (doc == null) {
        event.record?.let { TrailRecordBody(record = it, time = event.at, onOpenDocument = onOpenDocument) }
        return
    }

    val isFileLike = doc.documentType in FILE_LIKE_DOC_TYPES
    val showFileIcon = isAttachment || isFileLike
    val isConversation = doc.documentType in CONVERSATION_DOC_TYPES
    val buckets = TrailTimelineFormat.groupPeopleByBucket(event.people).filter { it.first != "mentions" }
    val visibleRelated = event.related.filter {
        visibleDocIds.contains(it.documentId) && it.direction != "in"
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // Title row
        Row(
            Modifier.clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = { onOpenDocument(doc.documentId) },
            ),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (isAttachment) {
                Icon(
                    Icons.Outlined.AttachFile,
                    contentDescription = null,
                    tint = OmTheme.colors.textMuted,
                    modifier = Modifier.size(11.dp).padding(top = 2.dp),
                )
            }
            if (showFileIcon) {
                FileTypeIcon(
                    mimeType = doc.mimeType,
                    filename = doc.title,
                    size = 12.dp,
                    modifier = Modifier.padding(top = 1.dp).alpha(0.7f),
                )
            }
            MiddleEllipsisText(
                text = doc.title.ifEmpty { "(untitled)" },
                style = MaterialTheme.typography.bodySmall.copy(
                    fontSize = if (isAttachment) 12.sp else 13.sp,
                    fontWeight = FontWeight.SemiBold,
                ),
                color = OmTheme.colors.textPrimary,
                modifier = Modifier.weight(1f),
            )
        }

        // Metadata (top-level) or people-only (attachment) line
        if (!isAttachment) {
            val timeStr = TrailTimelineFormat.timeLabel(event.at)
            val peopleParts = buckets
                .filter { it.second.isNotEmpty() }
                .map { (label, names) -> "$label ${names.joinToString(", ")}" }
            val parts = (if (timeStr.isEmpty()) emptyList() else listOf(timeStr)) + peopleParts
            Text(
                parts.joinToString(" · "),
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
                color = OmTheme.colors.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        } else if (buckets.any { it.second.isNotEmpty() }) {
            Text(
                TrailTimelineFormat.peopleLine(buckets),
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
                color = OmTheme.colors.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // #757: a document that deduped with its same-entity row (one timeline entity, not two)
        // carries the row's derived key fields inline. The record's title is already the doc
        // title — only the declared key columns add information, so we surface those and never
        // re-print the title. Only at top level (a record never rides on an attachment).
        if (!isAttachment) {
            event.record?.let { TrailRecordKeyFields(it.keyFields) }
        }

        // Related-edge lines ("cites X" / "attached to X" / …)
        visibleRelated.forEach { rel ->
            RelatedRow(rel, catalog, onOpenDocument)
        }

        // Annotation block
        if (docAnnotations != null && (docAnnotations.note != null || docAnnotations.quotes.isNotEmpty())) {
            Column(
                Modifier.padding(top = 2.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                docAnnotations.note?.let { note ->
                    AnnotationNoteLabel(note, fontSize = 11.sp, italic = true, color = OmTheme.colors.textSecondary)
                }
                docAnnotations.quotes.forEach { entry ->
                    if (isConversation) {
                        ChatBubbleQuote(entry, authorColors)
                    } else {
                        BarQuoteAnnotation(entry)
                    }
                }
            }
        }
    }
}

@Composable
private fun RelatedRow(
    rel: AgentTrailEventRelated,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
) {
    val phrase = TrailTimelineFormat.phraseForLinkType(rel.linkType, rel.direction)
    val isDup = TrailTimelineFormat.isDuplicateLikeLinkType(rel.linkType)
    Row(
        Modifier.clickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
            onClick = { onOpenDocument(rel.documentId) },
        ),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (isDup) {
            Icon(
                Icons.Outlined.Link,
                contentDescription = null,
                tint = OmTheme.colors.textMuted,
                modifier = Modifier.size(9.dp).padding(top = 2.dp).alpha(0.7f),
            )
        }
        Text(
            phrase,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
            color = OmTheme.colors.textMuted,
        )
        dev.omnesis.android.designsystem.components.SourceIcon(
            model = catalog.iconModel(rel.sourceId),
            size = 11.dp,
            modifier = Modifier.padding(top = 1.dp),
        )
        MiddleEllipsisText(
            text = rel.title.ifEmpty { "(untitled)" },
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, fontWeight = FontWeight.Medium),
            color = OmTheme.colors.textSecondary,
            modifier = Modifier.weight(1f),
        )
    }
}

// =====================================================================================
// Record body (#757)
// =====================================================================================

/**
 * Renders a record-only trail event (#757): a single DuckDB analytics row surfaced as a
 * point-in-time citation that binds no document. Compose port of the iOS `TrailTimelineRecordBody`
 * and the portal `RecordBody`. The source icon/colour come from the registry (resolved one level
 * up via the spine's [AgentTrailEvent.eventSourceId]); the title, table label, and key fields are
 * all derived gateway-side from the table's declared record-display contract, so this renderer
 * never learns a column name or branches on a source.
 *
 * When [AgentTrailRecord.boundDocumentId] is non-null the title taps through to that document via
 * [onOpenDocument] — the SAME nav path document citations use. When null it renders as plain text
 * with no tap target — no dead link.
 */
@Composable
private fun TrailRecordBody(
    record: AgentTrailRecord,
    time: String?,
    onOpenDocument: (String) -> Unit,
) {
    val title = record.title.ifEmpty { record.tableDisplayName.ifEmpty { "(record)" } }
    val boundDocId = record.boundDocumentId

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // Title row — database glyph + derived title. Tappable only when a bound document exists.
        val titleModifier = if (boundDocId != null) {
            Modifier.clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = { onOpenDocument(boundDocId) },
            )
        } else {
            Modifier
        }
        Row(
            titleModifier,
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                Icons.Outlined.Storage,
                contentDescription = null,
                tint = OmTheme.colors.textMuted,
                modifier = Modifier.size(11.dp).padding(top = 2.dp),
            )
            Text(
                title,
                style = MaterialTheme.typography.bodySmall.copy(
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                ),
                color = OmTheme.colors.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }

        // Time + table-display label, separated by " · ".
        val timeStr = TrailTimelineFormat.timeLabel(time)
        val parts = listOf(timeStr, record.tableDisplayName).filter { it.isNotEmpty() }
        if (parts.isNotEmpty()) {
            Text(
                parts.joinToString(" · "),
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
                color = OmTheme.colors.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        TrailRecordKeyFields(record.keyFields)
    }
}

/**
 * The declared key columns of a record citation (#757), rendered as a label/value list. Compose
 * port of the iOS `TrailTimelineRecordKeyFields` and the portal `RecordKeyFields`. The gateway
 * already redacted `sensitive` columns server-side (the value arrives as the redaction
 * placeholder), so this renderer prints values verbatim and re-exposes nothing. A null value
 * shows an em-dash.
 */
@Composable
private fun TrailRecordKeyFields(keyFields: List<AgentTrailRecordKeyField>) {
    if (keyFields.isEmpty()) return
    Column(
        Modifier.padding(top = 2.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        keyFields.forEach { field ->
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                // The label hugs its content for the common short-label case (`fill = false`),
                // but is capped at 40% of the row so an unexpectedly long label can never starve
                // the value column — past the cap it wraps onto a second line instead of pushing
                // the value to zero width.
                Text(
                    field.label,
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, fontWeight = FontWeight.Medium),
                    color = OmTheme.colors.textMuted,
                    modifier = Modifier.weight(0.4f, fill = false),
                )
                Text(
                    field.value ?: "—",
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
                    color = OmTheme.colors.textSecondary,
                    modifier = Modifier.weight(0.6f),
                )
            }
        }
    }
}

// =====================================================================================
// Attachment (nested under a parent event, same card)
// =====================================================================================

@Composable
private fun TrailAttachment(
    attachment: AgentTrailEvent,
    docAnnotations: AgentDocAnnotations?,
    visibleDocIds: Set<String>,
    authorColors: Map<String, Color>,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
) {
    Column {
        HorizontalDivider(
            color = OmTheme.colors.borderLight,
            modifier = Modifier.padding(top = 6.dp),
        )
        Box(Modifier.padding(start = 18.dp, top = 6.dp)) {
            TrailEventBody(
                event = attachment,
                isAttachment = true,
                docAnnotations = docAnnotations,
                visibleDocIds = visibleDocIds,
                authorColors = authorColors,
                catalog = catalog,
                onOpenDocument = onOpenDocument,
            )
        }
    }
}

// =====================================================================================
// Annotation quote styles
// =====================================================================================

/** Vertical-bar excerpt: muted left bar + italic quote + optional "— Author" + opt note. */
@Composable
private fun BarQuoteAnnotation(entry: AgentQuoteEntry) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            Modifier.height(IntrinsicSize.Min),
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Box(
                Modifier
                    .width(5.dp)
                    .fillMaxHeight()
                    .background(OmTheme.colors.textMuted.copy(alpha = 0.4f)),
            )
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    entry.quote,
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, fontStyle = FontStyle.Italic),
                    color = OmTheme.colors.textSecondary,
                )
                entry.quoteAuthor?.let {
                    Text(
                        "— $it",
                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, fontStyle = FontStyle.Italic),
                        color = OmTheme.colors.textSecondary,
                    )
                }
            }
        }
        entry.note?.let {
            AnnotationNoteLabel(it, fontSize = 10.5.sp, italic = true, color = OmTheme.colors.textMuted)
        }
    }
}

/** Chat-bubble quote (conversation docs): self → right tail/accent, other → left tail/bgTertiary. */
@Composable
private fun ChatBubbleQuote(entry: AgentQuoteEntry, authorColors: Map<String, Color>) {
    val isSelf = entry.quoteIsSelf
    // The bubble fills the full width of the event card and wraps its text vertically — the
    // tail side and fill colour are what mark it as self vs other (not its width). Mirrors iOS
    // `fixedSize(horizontal: false, vertical: true)`, which lets the bubble take the available
    // width rather than hugging its words.
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Box(
            Modifier
                .fillMaxWidth()
                .background(
                    if (isSelf) OmTheme.colors.accent.copy(alpha = 0.18f) else OmTheme.colors.bgTertiary,
                    ChatBubbleShape(tailSide = if (isSelf) ChatBubbleTailSide.Right else ChatBubbleTailSide.Left),
                )
                .padding(
                    start = if (isSelf) 10.dp else 10.dp + BUBBLE_TAIL_WIDTH,
                    end = if (isSelf) 10.dp + BUBBLE_TAIL_WIDTH else 10.dp,
                    top = 6.dp,
                    bottom = 6.dp,
                ),
        ) {
            BubbleBody(entry, authorColors)
        }
        entry.note?.let {
            AnnotationNoteLabel(it, fontSize = 10.5.sp, italic = true, color = OmTheme.colors.textMuted)
        }
    }
}

@Composable
private fun BubbleBody(entry: AgentQuoteEntry, authorColors: Map<String, Color>) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        entry.quoteAuthor?.let { author ->
            Text(
                author,
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                color = authorColors[author] ?: OmTheme.colors.textPrimary,
            )
        }
        Text(
            entry.quote,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
            color = OmTheme.colors.textPrimary,
        )
    }
}

/** Sparkle glyph + italic note line, reused by doc-notes and per-quote notes. */
@Composable
private fun AnnotationNoteLabel(
    text: String,
    fontSize: androidx.compose.ui.unit.TextUnit,
    italic: Boolean,
    color: Color,
) {
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        Icon(
            Icons.Outlined.AutoAwesome,
            contentDescription = null,
            tint = OmTheme.colors.textMuted,
            modifier = Modifier.size(8.dp).padding(top = 2.dp).alpha(0.5f),
        )
        Text(
            text,
            style = MaterialTheme.typography.bodySmall.copy(
                fontSize = fontSize,
                fontStyle = if (italic) FontStyle.Italic else FontStyle.Normal,
            ),
            color = color,
        )
    }
}

// =====================================================================================
// Chat-bubble shape (custom Shape with a WhatsApp-style tail)
// =====================================================================================

enum class ChatBubbleTailSide { Left, Right }

/**
 * Rounded rect (r=14dp) with a thin pointed tail at one bottom corner. `.Left` is the
 * incoming-message bubble (tail bottom-left, body inset on the left); `.Right` mirrors it
 * horizontally for sent/self bubbles. Body content adds matching padding on the tail side.
 * Geometry ported coordinate-for-coordinate from the iOS `ChatBubbleShape`.
 */
private class ChatBubbleShape(
    val cornerRadius: androidx.compose.ui.unit.Dp = 14.dp,
    val tailWidth: androidx.compose.ui.unit.Dp = BUBBLE_TAIL_WIDTH,
    val tailSide: ChatBubbleTailSide = ChatBubbleTailSide.Left,
) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val r = with(density) { cornerRadius.toPx() }
        val tw = with(density) { tailWidth.toPx() }
        val path = leftTailedPath(size, r, tw)
        if (tailSide == ChatBubbleTailSide.Right) {
            val m = Matrix().apply {
                scale(x = -1f, y = 1f)
                // translate after the mirror brings the path back into [0, width].
            }
            path.transform(m)
            path.translate(Offset(size.width, 0f))
        }
        return Outline.Generic(path)
    }

    private fun leftTailedPath(size: Size, r: Float, tw: Float): Path {
        val minX = 0f
        val maxX = size.width
        val minY = 0f
        val maxY = size.height
        val bodyLeft = minX + tw
        val blCenterX = bodyLeft + r
        val blCenterY = maxY - r
        val cos45 = 0.7071f
        val arcMidX = blCenterX - r * cos45
        val arcMidY = blCenterY + r * cos45

        return Path().apply {
            // Top-left of body
            moveTo(bodyLeft + r, minY)
            // Top edge
            lineTo(maxX - r, minY)
            // Top-right corner (-90° -> 0°)
            arcTo(
                rect = androidx.compose.ui.geometry.Rect(maxX - 2 * r, minY, maxX, minY + 2 * r),
                startAngleDegrees = -90f, sweepAngleDegrees = 90f, forceMoveTo = false,
            )
            // Right edge
            lineTo(maxX, maxY - r)
            // Bottom-right corner (0° -> 90°)
            arcTo(
                rect = androidx.compose.ui.geometry.Rect(maxX - 2 * r, maxY - 2 * r, maxX, maxY),
                startAngleDegrees = 0f, sweepAngleDegrees = 90f, forceMoveTo = false,
            )
            // Bottom edge
            lineTo(bodyLeft + r, maxY)
            // Bottom-left arc — only to the 135° midpoint
            arcTo(
                rect = androidx.compose.ui.geometry.Rect(blCenterX - r, blCenterY - r, blCenterX + r, blCenterY + r),
                startAngleDegrees = 90f, sweepAngleDegrees = 45f, forceMoveTo = false,
            )
            // Tail out to the tip
            val tipX = minX
            val tipY = arcMidY + 1f
            cubicTo(
                arcMidX - tw * 0.4f, arcMidY + 0.5f,
                tipX + tw * 0.15f, tipY + 0.3f,
                tipX, tipY,
            )
            // Concave return to the body
            cubicTo(
                tipX + tw * 0.15f, tipY - 0.5f,
                bodyLeft - tw * 0.3f, arcMidY - 1f,
                bodyLeft, maxY - r,
            )
            // Left edge
            lineTo(bodyLeft, minY + r)
            // Top-left corner (180° -> 270°)
            arcTo(
                rect = androidx.compose.ui.geometry.Rect(bodyLeft, minY, bodyLeft + 2 * r, minY + 2 * r),
                startAngleDegrees = 180f, sweepAngleDegrees = 90f, forceMoveTo = false,
            )
            close()
        }
    }
}

// =====================================================================================
// Empty state
// =====================================================================================

@Composable
private fun TrailEmptyState(modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().padding(top = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Top,
    ) {
        ConnectedTriangleGlyph(tint = OmTheme.colors.textMuted)
        Spacer(Modifier.height(8.dp))
        Text(
            "No events on this trail",
            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, fontWeight = FontWeight.Medium),
            color = OmTheme.colors.textPrimary,
        )
        Spacer(Modifier.height(2.dp))
        Text(
            "This timeline has no events to show yet.",
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
            color = OmTheme.colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 24.dp),
        )
    }
}

/**
 * The iOS `point.3.connected.trianglepath.dotted` glyph — three ring-nodes at the vertices
 * of a triangle joined by dotted connectors. Custom-drawn to match iOS rather than reaching
 * for a loose Material stand-in.
 */
@Composable
internal fun ConnectedTriangleGlyph(tint: Color, size: androidx.compose.ui.unit.Dp = 30.dp) {
    Canvas(Modifier.size(size)) {
        val s = this.size.minDimension
        val ring = s * 0.135f
        val stroke = s * 0.06f
        // Vertices: top-right, bottom-left, bottom-centre-ish — a downward triangle.
        val tl = Offset(s * 0.22f, s * 0.30f)
        val tr = Offset(s * 0.78f, s * 0.30f)
        val bottom = Offset(s * 0.50f, s * 0.82f)
        val nodes = listOf(tl, tr, bottom)
        // Dotted connectors between each pair.
        val dash = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(s * 0.05f, s * 0.05f))
        fun connect(a: Offset, b: Offset) {
            val dir = b - a
            val len = kotlin.math.hypot(dir.x, dir.y)
            val unit = Offset(dir.x / len, dir.y / len)
            val from = a + Offset(unit.x * ring, unit.y * ring)
            val to = b - Offset(unit.x * ring, unit.y * ring)
            drawLine(tint, from, to, strokeWidth = stroke, pathEffect = dash)
        }
        connect(tl, tr)
        connect(tl, bottom)
        connect(tr, bottom)
        nodes.forEach { c ->
            drawCircle(tint, radius = ring, center = c, style = Stroke(width = stroke))
        }
    }
}
