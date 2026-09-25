// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.DeleteDocumentDialog
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.designsystem.theme.docTypeAccent
import dev.omnesis.android.transport.dto.RecentDocument
import dev.omnesis.android.transport.dto.RecentItemsResponse
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.isReloading
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.ListPagingFooter
import dev.omnesis.android.ui.common.PullToRefresh
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

@Composable
fun SourceRecentScreen(
    onBack: () -> Unit,
    onOpenDocument: (String) -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: SourceRecentViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val paging by vm.paging.collectAsStateWithLifecycle()
    val deleteError by vm.deleteError.collectAsStateWithLifecycle()
    val isInternal by vm.isInternal.collectAsStateWithLifecycle()
    val context = LocalContext.current
    SourceRecentContent(
        title = vm.label,
        state = state,
        isInternal = isInternal,
        onBack = onBack,
        onRetry = vm::load,
        onRefresh = vm::load,
        onOpenDocument = onOpenDocument,
        onOpenSettings = onOpenSettings,
        iconFor = vm::iconFor,
        onDeleteDocument = vm::delete,
        manageNotesUrlFor = vm::manageNotesUrlFor,
        onOpenManageNotes = { url ->
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        },
        deleteError = deleteError,
        onClearDeleteError = vm::clearDeleteError,
        paging = paging,
        onLoadMore = vm::loadMore,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SourceRecentContent(
    title: String,
    state: Loadable<RecentItemsResponse>,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onOpenDocument: (String) -> Unit,
    onRefresh: () -> Unit = onRetry,
    onOpenSettings: () -> Unit = {},
    iconFor: (String) -> SourceIconModel = { SourceIconModel() },
    onDeleteDocument: (RecentDocument, keepCopy: Boolean) -> Unit = { _, _ -> },
    manageNotesUrlFor: (RecentDocument) -> String? = { null },
    onOpenManageNotes: (String) -> Unit = {},
    deleteError: String? = null,
    onClearDeleteError: () -> Unit = {},
    isInternal: Boolean = false,
    paging: CursorPagingState = CursorPagingState(),
    onLoadMore: () -> Unit = {},
) {
    val c = OmTheme.colors
    val documentListState = rememberLazyListState()
    var pendingDelete by remember { mutableStateOf<RecentDocument?>(null) }
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back", tint = c.accent)
                    }
                },
                title = { Text("Recent", style = MaterialTheme.typography.titleMedium, color = c.textPrimary) },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = c.bgPrimary,
                    navigationIconContentColor = c.accent,
                    titleContentColor = c.textPrimary,
                ),
            )
        },
    ) { padding ->
        when (state) {
            Loadable.Loading -> LoadingView(Modifier.padding(padding))
            is Loadable.Error -> GatewayErrorView(
                context = "load recent items",
                error = state.throwable,
                onRetry = onRetry,
                onOpenSettings = onOpenSettings,
                modifier = Modifier.padding(padding),
            )
            is Loadable.Content -> when (val r = state.value) {
                is RecentItemsResponse.Documents ->
                    if (!shouldShowRecentDocumentsList(r.documents, paging)) {
                        RecentEmptyState(
                            isInternal = isInternal,
                            modifier = Modifier.padding(padding),
                        )
                    } else {
                        PullToRefresh(
                            refreshing = state.isReloading,
                            onRefresh = onRefresh,
                            modifier = Modifier.padding(padding),
                        ) {
                            LazyColumn(
                                Modifier
                                    .fillMaxSize()
                                    .background(c.bgPrimary)
                                    .padding(OmSpacing.lg),
                                state = documentListState,
                            ) {
                                itemsIndexed(r.documents, key = { _, d -> d.id }) { i, doc ->
                                    RecentDocRow(
                                        doc,
                                        iconFor(doc.sourceId),
                                        onClick = { onOpenDocument(doc.id) },
                                        onDelete = { pendingDelete = doc },
                                        // Generated Notes day documents are read-only:
                                        // a Manage-notes link instead of a delete button.
                                        // Null (non-Notes source, or unpaired with no
                                        // token) hides the button instead of leaving
                                        // a dead one.
                                        onManageNotes = if (isInternal) {
                                            manageNotesUrlFor(doc)?.let { url ->
                                                { onOpenManageNotes(url) }
                                            }
                                        } else {
                                            null
                                        },
                                    )
                                    if (i < r.documents.lastIndex) {
                                        HorizontalDivider(color = c.borderLight, modifier = Modifier.padding(start = 44.dp))
                                    }
                                }
                                item("paging") {
                                    ListPagingFooter(
                                        listState = documentListState,
                                        boundaryKey = "paging",
                                        paging = paging,
                                        onLoadMore = onLoadMore,
                                        loadAction = "more recent documents",
                                    )
                                }
                            }
                        }
                    }

                is RecentItemsResponse.Analytics ->
                    AnalyticsRows(
                        displayName = r.displayName.ifBlank { r.table },
                        table = r.table,
                        columns = r.columns,
                        rows = r.rows,
                        onRefresh = onRefresh,
                        paging = paging,
                        onLoadMore = onLoadMore,
                        modifier = Modifier.padding(padding),
                    )

                is RecentItemsResponse.Empty -> RecentEmptyState(isInternal, Modifier.padding(padding))
            }
        }
    }

    // Only reachable for mutable sources: internal rows offer Manage
    // notes instead of setting pendingDelete.
    pendingDelete?.let { doc ->
        DeleteDocumentDialog(
            title = "Delete \u201c${doc.title?.takeIf { it.isNotBlank() } ?: "(untitled)"}\u201d?",
            onDismiss = { pendingDelete = null },
            onDelete = { keepCopy ->
                pendingDelete = null
                onDeleteDocument(doc, keepCopy)
            },
        )
    }

    if (deleteError != null) {
        AlertDialog(
            containerColor = c.bgSecondary,
            onDismissRequest = onClearDeleteError,
            title = { Text("Couldn't delete", color = c.textPrimary) },
            text = { Text(deleteError, color = c.textSecondary) },
            confirmButton = {
                TextButton(onClick = onClearDeleteError) {
                    Text("OK", color = c.accent)
                }
            },
        )
    }
}

@Composable
private fun RecentDocRow(
    doc: RecentDocument,
    icon: SourceIconModel,
    onClick: () -> Unit,
    onDelete: () -> Unit = {},
    onManageNotes: (() -> Unit)? = null,
) {
    val c = OmTheme.colors
    Box(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = OmSpacing.md, vertical = 10.dp),
    ) {
        // Leading doc-type accent stripe
        Box(
            Modifier
                .align(Alignment.CenterStart)
                .width(3.dp)
                .fillMaxHeight()
                .clip(RoundedCornerShape(1.5.dp))
                .background(c.docTypeAccent(doc.documentType)),
        )
        Row(
            modifier = Modifier.padding(start = 13.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            SourceIcon(icon, size = 22.dp, modifier = Modifier.padding(top = 2.dp))
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    doc.title.ifBlank { "(untitled)" },
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                val metaParts = listOfNotNull(docTypeLabel(doc.documentType), formatTimeAgo(doc.sourceCreatedAt))
                if (metaParts.isNotEmpty()) {
                    Text(
                        metaParts.joinToString(" · "),
                        fontSize = 11.sp,
                        color = c.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                // Only show a preview that carries real text — some sources emit a bare "…"
                // placeholder for bodyless messages (e.g. media-only), which is just noise.
                doc.contentPreview?.takeIf { p -> p.any(Char::isLetterOrDigit) }?.let {
                    Text(it, fontSize = 12.sp, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            // Per-row privacy delete (#1065). The IconButton consumes the tap,
            // so it never triggers the row's navigate-on-click. Read-only
            // generated documents get a Manage-notes action instead.
            if (onManageNotes != null) {
                TextButton(onClick = onManageNotes) {
                    Text("Manage notes", fontSize = 12.sp, color = c.accent)
                }
            } else {
                IconButton(onClick = onDelete, modifier = Modifier.size(32.dp)) {
                    Icon(
                        Icons.Outlined.Delete,
                        contentDescription = "Delete document",
                        tint = c.textMuted,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}

private val AnalyticsColumnWidth = 144.dp

@Composable
private fun AnalyticsRows(
    displayName: String,
    table: String,
    columns: List<String>,
    rows: List<List<JsonElement>>,
    onRefresh: () -> Unit,
    paging: CursorPagingState = CursorPagingState(),
    onLoadMore: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    val horizontalScroll = rememberScrollState()
    val listState = rememberLazyListState()
    PullToRefresh(refreshing = paging.isRefreshing, onRefresh = onRefresh, modifier = modifier) {
        LazyColumn(
            Modifier
                .fillMaxSize()
                .background(c.bgPrimary),
            state = listState,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(OmSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
        ) {
            item("analytics-heading") {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(displayName, style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
                    Text(
                        "$table · ${rows.size}${if (paging.countIsPartial) "+" else ""} recent " +
                            if (rows.size == 1) "row" else "rows",
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                        color = c.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            if (columns.isEmpty() || rows.isEmpty()) {
                item("analytics-empty") {
                    Text(
                        "No recent rows returned.",
                        fontSize = 13.sp,
                        color = c.textSecondary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 80.dp),
                    )
                }
            } else {
                item("analytics-columns") {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .horizontalScroll(horizontalScroll)
                            .border(1.dp, c.borderLight, RoundedCornerShape(OmTheme.radius.small)),
                    ) {
                        AnalyticsTableRow(columns, columnLabels = null, header = true)
                    }
                }
                itemsIndexed(rows, key = { index, _ -> "analytics-row:$index" }) { index, row ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .horizontalScroll(horizontalScroll)
                            .border(1.dp, c.borderLight),
                    ) {
                        AnalyticsTableRow(
                            normaliseRecentAnalyticsRow(row, columns.size).map(::formatRecentAnalyticsCell),
                            columnLabels = columns,
                            header = false,
                            modifier = Modifier.background(if (index % 2 == 0) c.bgSecondary else c.bgPrimary),
                        )
                    }
                }
            }
            item("analytics-paging") {
                ListPagingFooter(
                    listState = listState,
                    boundaryKey = "analytics-paging",
                    paging = paging,
                    onLoadMore = onLoadMore,
                    loadAction = "more recent analytics rows",
                )
            }
        }
    }
}

@Composable
private fun AnalyticsTableRow(
    values: List<String>,
    columnLabels: List<String>?,
    header: Boolean,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    Row(modifier) {
        values.forEachIndexed { index, value ->
            Box {
                Text(
                    value,
                    fontSize = if (header) 11.sp else 12.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (header) c.textSecondary else c.textPrimary,
                    maxLines = if (header) 1 else 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .width(AnalyticsColumnWidth)
                        .clearAndSetSemantics {
                            contentDescription = recentAnalyticsCellAccessibilityLabel(
                                column = columnLabels?.getOrNull(index),
                                value = value,
                            )
                        }
                        .padding(horizontal = OmSpacing.sm, vertical = if (header) 10.dp else 8.dp),
                )
                if (index < values.lastIndex) {
                    Box(
                        Modifier
                            .align(Alignment.CenterEnd)
                            .width(1.dp)
                            .fillMaxHeight()
                            .background(c.borderLight),
                    )
                }
            }
        }
    }
    HorizontalDivider(color = c.borderLight)
}

/** Pad or truncate a wire row so every rendered row stays aligned with [columnCount]. */
internal fun normaliseRecentAnalyticsRow(row: List<JsonElement>, columnCount: Int): List<JsonElement> = when {
    row.size == columnCount -> row
    row.size > columnCount -> row.take(columnCount)
    else -> row + List(columnCount - row.size) { JsonNull }
}

/** Human-readable, bounded rendering for arbitrary recent-item table cells. */
internal fun formatRecentAnalyticsCell(cell: JsonElement): String {
    val rendered = when (cell) {
        JsonNull -> "—"
        is JsonPrimitive -> when {
            cell.isString -> cell.content
            cell.booleanOrNull != null -> cell.booleanOrNull.toString()
            cell.longOrNull != null -> cell.longOrNull.toString()
            cell.doubleOrNull != null -> {
                val value = cell.doubleOrNull!!
                if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString()
            }
            else -> cell.content
        }
        is JsonArray -> "[${cell.size} items]"
        is JsonObject -> "{${cell.size} fields}"
    }
    return if (rendered.length > 200) rendered.take(200) + "…" else rendered
}

internal fun recentAnalyticsCellAccessibilityLabel(column: String?, value: String): String =
    if (column == null) value else "$column: $value"

internal fun shouldShowRecentDocumentsList(
    documents: List<RecentDocument>,
    paging: CursorPagingState,
): Boolean =
    documents.isNotEmpty() ||
        paging.canLoadMore ||
        paging.isLoadingMore ||
        paging.paginationError != null

@Composable
private fun RecentEmptyState(isInternal: Boolean = false, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    Column(
        modifier.fillMaxSize().padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Outlined.Inbox, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(36.dp))
        Text("No recent items yet", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        Text(
            // Internal sources have no sync and no collector: never promise one.
            if (isInternal) "Nothing here yet — new items will appear as they are captured."
            else "Once this source syncs, recent items will show up here.",
            fontSize = 13.sp,
            color = c.textSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

// MARK: - Previews

private fun sampleDocs() = RecentItemsResponse.Documents(
    listOf(
        RecentDocument(
            id = "d1", sourceId = "gmail:user@example.com", title = "Re: Northwind invoice for March",
            documentType = "email", contentPreview = "Your invoice for the period of Mar 1–31 is now available.",
            sourceCreatedAt = "2026-01-05T08:30:00Z",
        ),
        RecentDocument(
            id = "d2", sourceId = "gmail:user@example.com", title = "Welcome to your weekly summary",
            documentType = "email", contentPreview = "This week you sent 47 emails and received 312.",
            sourceCreatedAt = "2026-01-05T08:00:00Z",
        ),
    ),
)

private fun sampleAnalytics() = RecentItemsResponse.Analytics(
    table = "strava_activities",
    displayName = "Strava activities",
    columns = listOf("activity_id", "started_at", "distance_km", "active"),
    rows = listOf(
        listOf(
            JsonPrimitive("run-001"),
            JsonPrimitive("2026-01-05T08:30:00Z"),
            JsonPrimitive(8.4),
            JsonPrimitive(true),
        ),
        listOf(
            JsonPrimitive("ride-002"),
            JsonPrimitive("2026-01-03T14:10:00Z"),
            JsonPrimitive(24.75),
            JsonPrimitive(false),
        ),
    ),
)

private fun sampleNotesDocs() = RecentItemsResponse.Documents(
    listOf(
        RecentDocument(
            id = "n1", sourceId = NOTES_SOURCE_ID, externalId = "2026-03-01",
            title = "Notes for March 1",
            contentPreview = "Tell the team the studio booking moved to Friday.",
            sourceCreatedAt = "2026-03-01T10:00:00Z",
        ),
    ),
    isInternal = true,
)

private val emailIcon: (String) -> SourceIconModel = { SourceIconModel(fallbackInitial = "G") }

@Preview(name = "Recent · documents · dark")
@Composable
private fun RecentDocumentsDark() {
    OmnesisTheme(darkTheme = true) {
        SourceRecentContent(
            title = "Gmail", state = Loadable.Content(sampleDocs()),
            onBack = {}, onRetry = {}, onOpenDocument = {}, iconFor = emailIcon,
        )
    }
}

@Preview(name = "Recent · documents · light")
@Composable
private fun RecentDocumentsLight() {
    OmnesisTheme(darkTheme = false) {
        SourceRecentContent(
            title = "Gmail", state = Loadable.Content(sampleDocs()),
            onBack = {}, onRetry = {}, onOpenDocument = {}, iconFor = emailIcon,
        )
    }
}

@Preview(name = "Recent · analytics · dark")
@Composable
private fun RecentAnalyticsDark() {
    OmnesisTheme(darkTheme = true) {
        SourceRecentContent(
            title = "Strava",
            state = Loadable.Content(sampleAnalytics()),
            onBack = {}, onRetry = {}, onOpenDocument = {},
        )
    }
}

@Preview(name = "Recent · analytics · light")
@Composable
private fun RecentAnalyticsLight() {
    OmnesisTheme(darkTheme = false) {
        SourceRecentContent(
            title = "Strava",
            state = Loadable.Content(sampleAnalytics()),
            onBack = {}, onRetry = {}, onOpenDocument = {},
        )
    }
}

@Preview(name = "Recent · empty · dark")
@Composable
private fun RecentEmptyDark() {
    OmnesisTheme(darkTheme = true) {
        SourceRecentContent(
            title = "Files", state = Loadable.Content(RecentItemsResponse.Empty()),
            onBack = {}, onRetry = {}, onOpenDocument = {},
        )
    }
}

@Preview(name = "Recent · notes internal · dark")
@Composable
private fun RecentNotesInternal() {
    OmnesisTheme(darkTheme = true) {
        SourceRecentContent(
            title = "Notes", state = Loadable.Content(sampleNotesDocs()),
            onBack = {}, onRetry = {}, onOpenDocument = {}, isInternal = true,
            manageNotesUrlFor = { "https://gateway.example:7942/portal/capture?day=2026-03-01&token=preview" },
        )
    }
}
