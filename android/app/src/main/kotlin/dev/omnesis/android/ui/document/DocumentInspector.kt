// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.BlurCircular
import androidx.compose.material.icons.outlined.Timeline
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.FileTypeIcon
import dev.omnesis.android.designsystem.components.PersonAvatar
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.DocumentAttachment
import dev.omnesis.android.transport.dto.DocumentEventTrail
import dev.omnesis.android.transport.dto.InboundRef
import dev.omnesis.android.transport.dto.NearDupEdge
import dev.omnesis.android.transport.dto.OutboundRef
import dev.omnesis.android.transport.dto.PersonMention
import dev.omnesis.android.transport.dto.displayName
import dev.omnesis.android.transport.dto.stableId
import dev.omnesis.android.ui.agent.AgentTrailAnnotations
import dev.omnesis.android.ui.agent.TrailTimeline
import dev.omnesis.android.ui.common.annotationsSectionItems
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.ListPagingFooter
import dev.omnesis.android.transport.dto.Annotation
import dev.omnesis.android.ui.document.DocumentDetailViewModel.DocumentBundle
import dev.omnesis.android.ui.document.DocumentDetailViewModel.SourceDisplayLookup
import kotlin.math.roundToInt

/** The three inspector tabs, in iOS order. Note the lowercase "graph". */
enum class InspectorTab(val title: String) {
    Metadata("Metadata"),
    Graph("Omnesis graph"),
    Timeline("Timeline"),
}

/**
 * The "i" inspector half-sheet reached from the document toolbar. Ported from the iOS
 * `DocumentInspectorSheet`: a detented bottom sheet hosting three tabs — Metadata,
 * Omnesis graph, Timeline. Metadata + Graph share a scroll; Timeline fetches its trail
 * lazily on first open and owns its own scroll.
 *
 * Graph/Timeline row taps navigate: document rows call [onOpenDocument], person rows call
 * [onOpenPerson], and external-link rows fire an `ACTION_VIEW` intent at the raw URL.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DocumentInspectorSheet(
    bundle: DocumentBundle,
    onDismiss: () -> Unit,
    loadTrail: suspend () -> DocumentEventTrail = { DocumentEventTrail() },
    catalog: SourceCatalog = SourceCatalog(),
    onOpenDocument: (String) -> Unit = {},
    onOpenPerson: (String) -> Unit = {},
    onLoadMoreOutboundRefs: () -> Unit = {},
    onLoadMoreInboundRefs: () -> Unit = {},
    onLoadMoreNearDupes: () -> Unit = {},
    onLoadMoreAnnotations: () -> Unit = {},
    onToggleAnnotationDependents: (Annotation) -> Unit = {},
    onLoadMoreAnnotationDependents: (Annotation) -> Unit = {},
) {
    val c = OmTheme.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false),
        containerColor = c.bgPrimary,
    ) {
        InspectorContent(
            bundle = bundle,
            onDone = onDismiss,
            loadTrail = loadTrail,
            catalog = catalog,
            onOpenDocument = onOpenDocument,
            onOpenPerson = onOpenPerson,
            onLoadMoreOutboundRefs = onLoadMoreOutboundRefs,
            onLoadMoreInboundRefs = onLoadMoreInboundRefs,
            onLoadMoreNearDupes = onLoadMoreNearDupes,
            onLoadMoreAnnotations = onLoadMoreAnnotations,
            onToggleAnnotationDependents = onToggleAnnotationDependents,
            onLoadMoreAnnotationDependents = onLoadMoreAnnotationDependents,
        )
    }
}

/**
 * Sheet body extracted so it renders directly in previews/snapshots without the sheet
 * host. [trailOverride], when non-null, renders the Timeline tab from a fixed state
 * instead of running the [loadTrail] coroutine — the snapshot seam so the populated /
 * empty / loading Timeline render deterministically under Roborazzi.
 */
@Composable
fun InspectorContent(
    bundle: DocumentBundle,
    onDone: () -> Unit,
    loadTrail: suspend () -> DocumentEventTrail = { DocumentEventTrail() },
    initialTab: InspectorTab = InspectorTab.Metadata,
    trailOverride: Loadable<DocumentEventTrail>? = null,
    catalog: SourceCatalog = SourceCatalog(),
    onOpenDocument: (String) -> Unit = {},
    onOpenPerson: (String) -> Unit = {},
    onLoadMoreOutboundRefs: () -> Unit = {},
    onLoadMoreInboundRefs: () -> Unit = {},
    onLoadMoreNearDupes: () -> Unit = {},
    onLoadMoreAnnotations: () -> Unit = {},
    onToggleAnnotationDependents: (Annotation) -> Unit = {},
    onLoadMoreAnnotationDependents: (Annotation) -> Unit = {},
) {
    val c = OmTheme.colors
    var tab by remember { mutableStateOf(initialTab) }
    val listState = rememberLazyListState()
    Column(Modifier.fillMaxWidth().background(c.bgPrimary)) {
        // Inline nav bar: centered title, trailing Done — mirrors the iOS sheet's
        // NavigationStack inline title.
        Box(
            Modifier.fillMaxWidth().padding(horizontal = OmSpacing.lg, vertical = OmSpacing.sm),
            contentAlignment = Alignment.Center,
        ) {
            Text(tab.title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
            TextButton(onClick = onDone, modifier = Modifier.align(Alignment.CenterEnd)) {
                Text("Done", color = c.accent, fontSize = 17.sp)
            }
        }
        InspectorTabBar(tab = tab, onSelect = { tab = it })
        when (tab) {
            InspectorTab.Timeline -> TimelinePane(catalog, loadTrail, trailOverride, onOpenDocument)
            InspectorTab.Metadata, InspectorTab.Graph -> LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = OmSpacing.lg,
                    end = OmSpacing.lg,
                    bottom = OmSpacing.lg,
                ),
            ) {
                if (tab == InspectorTab.Metadata) {
                    item("metadata-static") {
                        MetadataPane(bundle)
                    }
                    annotationsSectionItems(
                        listState = listState,
                        keyPrefix = "document-annotations",
                        title = "Enriched by Omnesis",
                        annotations = bundle.annotations,
                        paging = bundle.annotationsPaging,
                        onLoadMore = onLoadMoreAnnotations,
                        dependents = bundle.annotationDependents,
                        onToggleDependents = onToggleAnnotationDependents,
                        onLoadMoreDependents = onLoadMoreAnnotationDependents,
                    )
                } else {
                    graphPaneItems(
                        bundle,
                        listState,
                        onOpenDocument,
                        onOpenPerson,
                        onLoadMoreOutboundRefs,
                        onLoadMoreInboundRefs,
                        onLoadMoreNearDupes,
                    )
                }
            }
        }
    }
}

@Composable
private fun InspectorTabBar(tab: InspectorTab, onSelect: (InspectorTab) -> Unit) {
    val c = OmTheme.colors
    // Mirror the iOS native .segmented Picker: a single continuous filled track
    // (bgSecondary) with the selected segment rendered as the LIGHTEST surface — white
    // in light mode, a lifted grey thumb in dark — and no per-segment borders.
    val trackColor = c.bgSecondary
    val selectedColor = if (c.isDark) c.bgTertiary else c.bgPrimary
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.lg)
            .padding(top = OmSpacing.sm, bottom = OmSpacing.sm)
            .height(32.dp)
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(trackColor)
            .padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        InspectorTab.entries.forEach { t ->
            val selected = tab == t
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(OmRadius.small))
                    .background(if (selected) selectedColor else Color.Transparent)
                    .clickable { onSelect(t) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    t.title,
                    fontSize = 13.sp,
                    color = if (selected) c.textPrimary else c.textSecondary,
                )
            }
        }
    }
}

// MARK: - Metadata tab

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MetadataPane(
    bundle: DocumentBundle,
) {
    val doc = bundle.doc
    val display = bundle.sourceDisplay

    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
        FlatSection("Document") {
            Kv("Type", docTypeLabel(doc.documentType) ?: "—")
            Kv("Source", display[doc.sourceId].label)
            doc.sourceUrl?.takeIf { it.isNotBlank() }?.let { Kv("URL", it, mono = true) }
        }

        val tags = doc.tags
        if (tags.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                FlatSectionHeader("Tags")
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    tags.forEach { tag -> TagChip(tag) }
                }
            }
        }

        val extras = doc.extras()
        if (extras.isNotEmpty()) {
            FlatSection("Extras") {
                extras.forEach { (key, value) -> Kv(key, value, mono = true) }
            }
        }

        FlatSection("Timestamps") {
            Kv("Created", doc.sourceCreatedAt, mono = true)
            doc.sourceUpdatedAt?.let { Kv("Updated", it, mono = true) }
            doc.ingestedAt?.let { Kv("Ingested", it, mono = true) }
        }

        FlatSection("Identifiers") {
            Kv("Document ID", doc.id, mono = true)
            Kv("External ID", doc.externalId, mono = true)
            Kv("Source ID", doc.sourceId, mono = true)
            Kv("Provider ID", doc.providerId, mono = true)
        }
    }
}

@Composable
private fun TagChip(tag: String) {
    val c = OmTheme.colors
    Surface(color = c.accent.copy(alpha = 0.12f), shape = RoundedCornerShape(OmRadius.medium)) {
        Text(
            "#$tag",
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = c.accent,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
        )
    }
}

// MARK: - Omnesis-graph tab

private fun LazyListScope.graphPaneItems(
    bundle: DocumentBundle,
    listState: LazyListState,
    onOpenDocument: (String) -> Unit,
    onOpenPerson: (String) -> Unit,
    onLoadMoreOutboundRefs: () -> Unit,
    onLoadMoreInboundRefs: () -> Unit,
    onLoadMoreNearDupes: () -> Unit,
) {
    val people = bundle.people
    val attachments = bundle.attachments
    val outboundDocs = bundle.refs?.outbound.orEmpty().filter { it.targetDocId != null }
    val externalLinks = bundle.refs?.outbound.orEmpty().filter { it.targetDocId == null }
    val inboundDocs = bundle.refs?.inbound.orEmpty()
    val similar = bundle.nearDupes?.edges.orEmpty()
    val total = people.size + attachments.size + outboundDocs.size + inboundDocs.size + externalLinks.size + similar.size
    val partial =
        bundle.outboundRefsPaging.countIsPartial ||
            bundle.inboundRefsPaging.countIsPartial ||
            bundle.nearDupesPaging.countIsPartial

    if (total == 0) {
        val graphIsDefinitivelyEmpty =
            !bundle.graphLoading &&
                bundle.graphError == null &&
                bundle.outboundRefsPaging.canShowDefinitiveEmpty &&
                bundle.inboundRefsPaging.canShowDefinitiveEmpty &&
                bundle.nearDupesPaging.canShowDefinitiveEmpty
        if (graphIsDefinitivelyEmpty) {
            item("graph-empty") { GraphEmptyState() }
        }
        item("graph-outbound-paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "graph-outbound-paging",
                paging = bundle.outboundRefsPaging,
                onLoadMore = onLoadMoreOutboundRefs,
                loadAction = "more outgoing references",
            )
        }
        item("graph-inbound-paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "graph-inbound-paging",
                paging = bundle.inboundRefsPaging,
                onLoadMore = onLoadMoreInboundRefs,
                loadAction = "more inbound references",
            )
        }
        item("graph-similar-paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "graph-similar-paging",
                paging = bundle.nearDupesPaging,
                onLoadMore = onLoadMoreNearDupes,
                loadAction = "more similar documents",
            )
        }
        return
    }
    item("graph-summary") { SummaryHeader(total, partial) }
    if (people.isNotEmpty()) {
        item("graph-people-header") { GraphSectionHeader("People", people.size, "connected by role") }
        items(people, key = { "graph-person:${it.personId}" }) {
            PersonGraphRow(it, onOpenPerson)
        }
    }
    if (attachments.isNotEmpty()) {
        item("graph-attachments-header") { GraphSectionHeader("Contains", attachments.size, "attachments") }
        items(attachments, key = { "graph-attachment:${it.id}" }) {
            AttachmentGraphRow(it, onOpenDocument)
        }
    }
    if (outboundDocs.isNotEmpty()) {
        item("graph-outbound-header") {
            GraphSectionHeader(
                "References",
                outboundDocs.size,
                "this doc → others",
                bundle.outboundRefsPaging.countIsPartial,
            )
        }
        items(outboundDocs, key = { "graph-outbound:${it.stableId}" }) {
            OutboundDocGraphRow(it, bundle.sourceDisplay, onOpenDocument)
        }
        if (externalLinks.isEmpty()) {
            item("graph-outbound-paging") {
                ListPagingFooter(
                    listState = listState,
                    boundaryKey = "graph-outbound-paging",
                    paging = bundle.outboundRefsPaging,
                    onLoadMore = onLoadMoreOutboundRefs,
                    loadAction = "more outgoing references",
                )
            }
        }
    }
    if (externalLinks.isNotEmpty()) {
        item("graph-external-header") {
            GraphSectionHeader(
                "External links",
                externalLinks.size,
                "targets not in your index",
                bundle.outboundRefsPaging.countIsPartial,
            )
        }
        items(externalLinks, key = { "graph-external:${it.stableId}" }) {
            ExternalLinkGraphRow(it)
        }
        item("graph-outbound-paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "graph-outbound-paging",
                paging = bundle.outboundRefsPaging,
                onLoadMore = onLoadMoreOutboundRefs,
                loadAction = "more outgoing references",
            )
        }
    }
    if (outboundDocs.isEmpty() && externalLinks.isEmpty()) {
        item("graph-outbound-paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "graph-outbound-paging",
                paging = bundle.outboundRefsPaging,
                onLoadMore = onLoadMoreOutboundRefs,
                loadAction = "more outgoing references",
            )
        }
    }
    if (inboundDocs.isNotEmpty()) {
        item("graph-inbound-header") {
            GraphSectionHeader(
                "Referenced by",
                inboundDocs.size,
                "others → this doc",
                bundle.inboundRefsPaging.countIsPartial,
            )
        }
        items(inboundDocs, key = { "graph-inbound:${it.stableId}" }) {
            InboundDocGraphRow(it, bundle.sourceDisplay, onOpenDocument)
        }
        item("graph-inbound-paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "graph-inbound-paging",
                paging = bundle.inboundRefsPaging,
                onLoadMore = onLoadMoreInboundRefs,
                loadAction = "more inbound references",
            )
        }
    } else {
        item("graph-inbound-paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "graph-inbound-paging",
                paging = bundle.inboundRefsPaging,
                onLoadMore = onLoadMoreInboundRefs,
                loadAction = "more inbound references",
            )
        }
    }
    if (similar.isNotEmpty()) {
        item("graph-similar-header") {
            GraphSectionHeader(
                "Similar",
                similar.size,
                "near-duplicates",
                bundle.nearDupesPaging.countIsPartial,
            )
        }
        items(similar, key = { "graph-similar:${it.otherDocId}" }) {
            NearDupGraphRow(it, bundle.sourceDisplay, onOpenDocument)
        }
        item("graph-similar-paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "graph-similar-paging",
                paging = bundle.nearDupesPaging,
                onLoadMore = onLoadMoreNearDupes,
                loadAction = "more similar documents",
            )
        }
    } else {
        item("graph-similar-paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "graph-similar-paging",
                paging = bundle.nearDupesPaging,
                onLoadMore = onLoadMoreNearDupes,
                loadAction = "more similar documents",
            )
        }
    }
}

@Composable
private fun GraphEmptyState() {
    val c = OmTheme.colors
    Row(
        Modifier.padding(vertical = OmSpacing.md),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(Icons.Outlined.BlurCircular, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(18.dp))
        Text(
            "No graph neighbors yet. People, attachments, and references will appear here as they're indexed.",
            fontSize = 12.sp,
            color = c.textSecondary,
        )
    }
}

@Composable
private fun SummaryHeader(total: Int, partial: Boolean) {
    val c = OmTheme.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("Vertices & edges connected to this document", fontSize = 11.sp, color = c.textMuted)
        Spacer(Modifier.weight(1f))
        Text(
            "$total${if (partial) "+" else ""} ${if (total == 1) "edge" else "edges"}",
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = c.textSecondary,
        )
    }
}

// MARK: - Graph row variants

@Composable
private fun PersonGraphRow(person: PersonMention, onOpenPerson: (String) -> Unit) {
    val c = OmTheme.colors
    val name = person.displayName
    GraphRow(onClick = { onOpenPerson(person.personId) }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PersonAvatar(name = name, isSelf = person.isSelf, size = 30.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(name, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (person.isSelf) Text("(you)", fontSize = 10.sp, color = c.accent)
                }
                if (person.role.isNotBlank()) {
                    Text(person.role.uppercase(), fontSize = 9.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp, color = c.textMuted)
                }
            }
            Chevron()
        }
    }
}

@Composable
private fun AttachmentGraphRow(att: DocumentAttachment, onOpenDocument: (String) -> Unit) {
    val c = OmTheme.colors
    val meta = buildList {
        att.mimeType?.takeIf { it.isNotBlank() }?.let { add(it) }
        att.sizeBytes?.takeIf { it > 0 }?.let { add(formatBytes(it)) }
        att.pages?.takeIf { it > 0 }?.let { add("$it pages") }
        if (att.truncated == true) add("truncated")
    }
    GraphRow(onClick = { onOpenDocument(att.id) }) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FileTypeIcon(mimeType = att.mimeType, filename = att.title, size = 14.dp)
                Text(att.title.ifBlank { att.attachmentId }, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Chevron()
            }
            if (meta.isNotEmpty()) {
                Text(meta.joinToString(" · "), fontSize = 10.sp, color = c.textMuted, modifier = Modifier.padding(start = 22.dp))
            }
        }
    }
}

@Composable
private fun OutboundDocGraphRow(ref: OutboundRef, display: SourceDisplayLookup, onOpenDocument: (String) -> Unit) {
    val c = OmTheme.colors
    val parts = buildList {
        ref.targetSourceId?.let { add(display[it].label) }
        if (ref.linkType != "references" && ref.linkType != "url") add(ref.linkType)
    }
    GraphRow(onClick = ref.targetDocId?.let { id -> { onOpenDocument(id) } }) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(ref.targetTitle?.takeIf { it.isNotBlank() } ?: "(untitled)", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Chevron()
            }
            if (parts.isNotEmpty()) {
                Text(parts.joinToString(" · "), fontSize = 10.sp, color = c.textMuted)
            }
        }
    }
}

@Composable
private fun InboundDocGraphRow(ref: InboundRef, display: SourceDisplayLookup, onOpenDocument: (String) -> Unit) {
    val c = OmTheme.colors
    GraphRow(onClick = { onOpenDocument(ref.sourceDocId) }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SourceIcon(model = display[ref.sourceSourceId].icon, size = 20.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(ref.sourceTitle.ifBlank { "(untitled)" }, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(display[ref.sourceSourceId].label, fontSize = 10.sp, color = c.textMuted)
            }
            Chevron()
        }
    }
}

@Composable
private fun NearDupGraphRow(edge: NearDupEdge, display: SourceDisplayLookup, onOpenDocument: (String) -> Unit) {
    val c = OmTheme.colors
    GraphRow(onClick = { onOpenDocument(edge.otherDocId) }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SourceIcon(model = display[edge.otherSourceId].icon, size = 20.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(edge.otherTitle.ifBlank { "(untitled)" }, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(display[edge.otherSourceId].label, fontSize = 10.sp, color = c.textMuted)
            }
            Text("${(edge.jaccard * 100).roundToInt()}%", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = c.accent)
            Chevron()
        }
    }
}

@Composable
private fun ExternalLinkGraphRow(ref: OutboundRef) {
    val c = OmTheme.colors
    val context = LocalContext.current
    val isHttp = ref.rawTarget.startsWith("http://") || ref.rawTarget.startsWith("https://")
    GraphRow(
        onClick = if (isHttp) {
            {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ref.rawTarget))) }
            }
        } else {
            null
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    ref.rawTarget,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = if (isHttp) c.accent else c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (isHttp) {
                    Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(12.dp))
                }
            }
            if (ref.linkType != "url") {
                Text("${ref.linkType} · not yet indexed", fontSize = 10.sp, color = c.textMuted)
            }
        }
    }
}

// MARK: - Timeline tab

@Composable
private fun TimelinePane(
    catalog: SourceCatalog,
    loadTrail: suspend () -> DocumentEventTrail,
    trailOverride: Loadable<DocumentEventTrail>?,
    onOpenDocument: (String) -> Unit,
) {
    val fetched by produceState<Loadable<DocumentEventTrail>>(Loadable.Loading, trailOverride) {
        if (trailOverride != null) {
            value = trailOverride
            return@produceState
        }
        value = runCatching { loadTrail() }.fold(
            onSuccess = { Loadable.Content(it) },
            onFailure = { Loadable.Error(it) },
        )
    }
    val trail = trailOverride ?: fetched
    Column(
        Modifier
            .verticalScroll(rememberScrollState())
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.lg),
    ) {
        when (val t = trail) {
            Loadable.Loading -> TimelineLoading()
            is Loadable.Error -> TimelineEmpty() // an empty trail and a fetch miss both read "nothing to thread"
            is Loadable.Content -> if (t.value.events.isEmpty()) {
                TimelineEmpty()
            } else {
                // Full-fidelity renderer shared with the agent Citations drawer: it draws
                // nested attachments + related-edge lines the inspector needs. The inspector
                // trail carries no annotation projection, so pass the empty annotations.
                TrailTimeline(
                    events = t.value.events,
                    annotations = AgentTrailAnnotations.empty,
                    catalog = catalog,
                    onOpenDocument = onOpenDocument,
                )
            }
        }
    }
}

@Composable
private fun TimelineLoading() {
    val c = OmTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(top = OmSpacing.xl),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OmSpinner(Modifier.size(18.dp), color = c.accent, strokeWidth = 2.dp)
        Spacer(Modifier.width(10.dp))
        Text("Building timeline…", fontSize = 13.sp, color = c.textSecondary)
    }
}

@Composable
private fun TimelineEmpty() {
    val c = OmTheme.colors
    Column(
        Modifier.fillMaxWidth().padding(top = OmSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Icon(Icons.Outlined.Timeline, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(28.dp))
        Text("No timeline yet", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = c.textPrimary)
        Text(
            "This document isn't linked to any others, so there's nothing to thread together.",
            fontSize = 11.sp,
            color = c.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = OmSpacing.lg),
        )
    }
}

// MARK: - Shared section + row primitives

/** The uppercased section label + horizontal rule, optional trailing mono count. */
@Composable
fun FlatSectionHeader(title: String, trailing: String? = null, showRule: Boolean = true) {
    val c = OmTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth().padding(top = OmSpacing.md),
    ) {
        Text(title.uppercase(), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp, color = c.textSecondary)
        if (showRule) Box(Modifier.weight(1f).height(1.dp).background(c.border))
        trailing?.let { Text(it, fontSize = 11.sp, color = c.textMuted, fontFamily = FontFamily.Monospace) }
    }
}

/** Header + an 8dp-spaced content column. */
@Composable
private fun FlatSection(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        FlatSectionHeader(title)
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { content() }
    }
}

/** A key/value row: grey key left, value right-aligned (mono for IDs/URLs), selectable. */
@Composable
private fun Kv(key: String, value: String, mono: Boolean = false) {
    val c = OmTheme.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(key, fontSize = 12.sp, color = c.textSecondary)
        Spacer(Modifier.width(12.dp))
        SelectionContainer(Modifier.weight(1f)) {
            Text(
                value,
                fontSize = if (mono) 11.sp else 12.sp,
                fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
                color = c.textPrimary,
                textAlign = TextAlign.End,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** The per-bucket header (label + count + rule + hint) over its rows. Ported from SectionCard. */
@Composable
private fun GraphSectionHeader(label: String, count: Int, hint: String?, partial: Boolean = false) {
    val c = OmTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth().padding(top = OmSpacing.md),
    ) {
        Text(label.uppercase(), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp, color = c.textSecondary)
        Text(
            "$count${if (partial) "+" else ""}",
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = c.textMuted,
            style = TextStyle(fontFeatureSettings = "tnum"),
        )
        Box(Modifier.weight(1f).height(1.dp).background(c.border))
        hint?.let { Text(it, fontSize = 10.sp, color = c.textMuted) }
    }
}

/**
 * One graph row body with an 8dp vertical pad and a bottom hairline divider. When [onClick]
 * is non-null the whole row is tappable (mirrors the iOS `NavigationLink` + `.contentShape`).
 */
@Composable
private fun GraphRow(onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val c = OmTheme.colors
    val rowModifier = Modifier
        .fillMaxWidth()
        .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
    Column(rowModifier) {
        Box(Modifier.fillMaxWidth().padding(vertical = 8.dp)) { content() }
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderLight))
    }
}

@Composable
private fun Chevron() {
    Icon(
        Icons.AutoMirrored.Outlined.KeyboardArrowRight,
        contentDescription = null,
        tint = OmTheme.colors.textMuted,
        modifier = Modifier.size(14.dp),
    )
}

/** "132 KB" / "1.3 MB" — file-size formatting matching the iOS ByteCountFormatter file style. */
private fun formatBytes(n: Long): String {
    if (n < 1000) return "$n bytes"
    val units = listOf("KB", "MB", "GB", "TB")
    var value = n.toDouble() / 1000.0
    var unit = 0
    while (value >= 1000.0 && unit < units.lastIndex) {
        value /= 1000.0
        unit++
    }
    return if (value >= 100) "${value.roundToInt()} ${units[unit]}" else "%.1f %s".format(value, units[unit])
}
