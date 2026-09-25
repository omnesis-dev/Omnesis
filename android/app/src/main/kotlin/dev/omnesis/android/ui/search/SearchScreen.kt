// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.search

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.R
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.ErrorView
import dev.omnesis.android.designsystem.components.FileTypePill
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.SearchResponse
import dev.omnesis.android.transport.dto.SearchResultItem
import dev.omnesis.android.transport.dto.SearchScoreBreakdown
import dev.omnesis.android.transport.dto.SearchStageReport
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.ui.common.PullToRefresh
import dev.omnesis.android.ui.document.docTypeLabel
import dev.omnesis.android.ui.document.formatTimeAgo
import dev.omnesis.android.ui.document.isFileLike
import dev.omnesis.android.ui.document.sourceTypeFromId

@Composable
fun SearchScreen(
    connection: ConnectionState,
    onOpenMenu: () -> Unit,
    onOpenDocument: (String) -> Unit,
    vm: SearchViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    SearchContent(
        state = state,
        connection = connection,
        onOpenMenu = onOpenMenu,
        onQueryChange = vm::onQueryChange,
        onSearch = vm::search,
        onOpenDocument = onOpenDocument,
        catalog = vm.catalog,
        onClear = vm::onClear,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchContent(
    state: SearchViewModel.State,
    connection: ConnectionState,
    onOpenMenu: () -> Unit,
    onQueryChange: (String) -> Unit,
    onSearch: () -> Unit,
    onOpenDocument: (String) -> Unit,
    catalog: SourceCatalog = SourceCatalog(),
    onClear: () -> Unit = {},
) {
    val c = OmTheme.colors
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = remember { FocusRequester() }
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                title = {},
                navigationIcon = {
                    IconButton(onClick = onOpenMenu) {
                        Icon(Icons.Outlined.Menu, contentDescription = "Menu", tint = c.textPrimary)
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = c.bgPrimary),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .background(c.bgPrimary),
        ) {
            LogoHeader()

            SearchField(
                query = state.query,
                onQueryChange = onQueryChange,
                onSearch = { onSearch(); keyboard?.hide() },
                onClear = { onClear(); focus.requestFocus() },
                focusRequester = focus,
            )

            when (val status = state.status) {
                SearchViewModel.Status.Idle -> TipsState(
                    onPick = { onQueryChange(it); onSearch(); keyboard?.hide() },
                )

                SearchViewModel.Status.Loading -> LoadingState()

                is SearchViewModel.Status.Failed -> ErrorView(status.message, onRetry = onSearch)

                is SearchViewModel.Status.Results ->
                    if (status.items.isEmpty()) {
                        NoResultsState(state.lastQuery)
                    } else {
                        // Pull-to-refresh re-runs the current query (iOS `.refreshable`).
                        PullToRefresh(refreshing = status.refreshing, onRefresh = onSearch) {
                            ResultsList(
                                items = status.items,
                                response = status.response,
                                catalog = catalog,
                                onOpenDocument = onOpenDocument,
                            )
                        }
                    }
            }
        }
    }
}

@Composable
private fun LogoHeader() {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = OmSpacing.md, bottom = OmSpacing.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Image(
            painter = painterResource(R.drawable.omnesis_logo),
            contentDescription = null,
            contentScale = ContentScale.Fit,
            colorFilter = ColorFilter.tint(OmTheme.colors.brandLogo),
            modifier = Modifier.height(64.dp),
        )
        Text("Search", style = MaterialTheme.typography.titleLarge, color = OmTheme.colors.textPrimary)
    }
}

@Composable
private fun SearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    onSearch: () -> Unit,
    onClear: () -> Unit,
    focusRequester: FocusRequester,
) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.sm)
            .clip(RoundedCornerShape(OmRadius.pill))
            .background(c.bgSecondary)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Outlined.Search, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(18.dp))
        Box(Modifier.weight(1f)) {
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    imeAction = ImeAction.Search,
                    autoCorrectEnabled = false,
                    capitalization = KeyboardCapitalization.None,
                ),
                keyboardActions = KeyboardActions(onSearch = { onSearch() }),
                textStyle = LocalTextStyle.current.copy(
                    color = c.textPrimary,
                    fontSize = 17.sp,
                ),
                cursorBrush = SolidColor(c.accent),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester),
            )
            if (query.isEmpty()) {
                Text(
                    "Search your data",
                    color = c.textMuted,
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = 17.sp),
                )
            }
        }
        if (query.isNotEmpty()) {
            Icon(
                Icons.Filled.Cancel,
                contentDescription = "Clear",
                tint = c.textMuted,
                modifier = Modifier
                    .size(18.dp)
                    .clickable(onClick = onClear),
            )
        }
    }
}

@Composable
private fun LoadingState() {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        OmSpinner(color = OmTheme.colors.accent)
        Text("Searching…", style = MaterialTheme.typography.bodySmall, color = OmTheme.colors.textSecondary)
    }
}

private val TIPS = listOf(
    "dinner with Alex",
    "flight confirmation",
    "type:email Northwind",
    "source:gmail invoice",
    "after:2025-01-01 meeting notes",
)

@Composable
private fun TipsState(onPick: (String) -> Unit) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxSize()
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Outlined.Search, contentDescription = null, tint = c.textPrimary, modifier = Modifier.size(17.dp))
            Text("Search across everything", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        }
        Text(
            "Try queries like:",
            style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp),
            color = c.textSecondary,
        )
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            TIPS.forEach { tip ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onPick(tip) },
                ) {
                    Row(
                        Modifier.padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(Icons.Outlined.Search, contentDescription = null, tint = c.accent, modifier = Modifier.size(18.dp))
                        Text(tip, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = c.textPrimary)
                    }
                    HorizontalDivider(thickness = 1.dp, color = c.borderLight)
                }
            }
        }
    }
}

@Composable
private fun NoResultsState(lastQuery: String) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxSize()
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Outlined.Search, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(36.dp))
        Text("No results", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        Text(
            "Nothing matched “$lastQuery”.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

@Composable
private fun ResultsList(
    items: List<SearchResultItem>,
    response: SearchResponse?,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = OmSpacing.lg, vertical = OmSpacing.sm),
    ) {
        itemsIndexed(items, key = { _, item -> item.documentId }) { idx, item ->
            SearchResultRow(
                item = item,
                catalog = catalog,
                onClick = { onOpenDocument(item.documentId) },
                modifier = Modifier.padding(horizontal = OmSpacing.md, vertical = 10.dp),
            )
            if (idx < items.lastIndex) {
                HorizontalDivider(
                    thickness = 1.dp,
                    color = OmTheme.colors.borderLight,
                    modifier = Modifier.padding(start = 44.dp),
                )
            }
        }
        if (response != null) {
            item {
                Spacer(Modifier.height(OmSpacing.md))
                SearchPipelineFooter(response)
            }
        }
    }
}

@Composable
private fun SearchResultRow(
    item: SearchResultItem,
    catalog: SourceCatalog,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SourceIcon(
            model = catalog.iconModel(item.sourceId),
            size = 22.dp,
            modifier = Modifier.padding(top = 2.dp),
        )
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                item.title.ifBlank { "(untitled)" },
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                color = c.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            MetaRow(item, catalog)
            if (item.chunkText.isNotBlank()) {
                Text(
                    snippet(item.chunkText),
                    fontSize = 12.sp,
                    color = c.textSecondary,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            item.scoreBreakdown?.let {
                ScoreBreakdownStrip(it, Modifier.padding(top = 2.dp))
            }
        }
    }
}

@Composable
private fun MetaRow(item: SearchResultItem, catalog: SourceCatalog) {
    val c = OmTheme.colors
    val sourceName = catalog.label(item.sourceId).ifBlank { sourceTypeFromId(item.sourceId) }
    if (isFileLike(item.documentType)) {
        val parts = listOfNotNull(
            sourceName,
            formatTimeAgo(item.sourceCreatedAt),
            item.author?.takeIf { it.isNotBlank() },
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FileTypePill(mimeType = null, filename = item.title)
            if (parts.isNotEmpty()) {
                Text(
                    parts.joinToString(" · "),
                    fontSize = 11.sp,
                    color = c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    } else {
        val parts = listOfNotNull(
            sourceName,
            docTypeLabel(item.documentType),
            formatTimeAgo(item.sourceCreatedAt),
            item.author?.takeIf { it.isNotBlank() },
        )
        if (parts.isNotEmpty()) {
            Text(
                parts.joinToString(" · "),
                fontSize = 11.sp,
                color = c.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Collapse whitespace runs and cap chunk text at 240 chars. Mirrors iOS `snippet`. */
private fun snippet(text: String): String {
    val collapsed = text.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    return if (collapsed.length <= 240) collapsed else collapsed.take(240) + "…"
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ScoreBreakdownStrip(breakdown: SearchScoreBreakdown, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    val chips = buildList {
        breakdown.bm25Rank?.let { add("bm25" to ChipValue("#$it", false)) }
        breakdown.vectorRank?.let { add("vec" to ChipValue("#$it", false)) }
        breakdown.rrfScore?.let { add("rrf" to ChipValue(fmt(it, 4), false)) }
        breakdown.rankBonus?.takeIf { it != 0.0 }?.let { add("rankBonus" to ChipValue(fmt(it, 3, signed = true), false)) }
        breakdown.typeBoost?.takeIf { it != 0.0 }?.let { add("typeBoost" to ChipValue(fmt(it, 3, signed = true), false)) }
        breakdown.relevanceBoost?.takeIf { it != 0.0 }?.let { add("relBoost" to ChipValue(fmt(it, 3, signed = true), false)) }
        breakdown.sourcePrior?.takeIf { it != 0.0 }?.let { add("srcPrior" to ChipValue(fmt(it, 3, signed = true), false)) }
        breakdown.finalScore?.let { add("final" to ChipValue(fmt(it, 4), true)) }
    }
    if (chips.isEmpty()) return
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        chips.forEach { (label, value) ->
            Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(label, fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = c.textMuted)
                Text(
                    value.text,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    color = if (value.emphasised) c.accent else c.textSecondary,
                )
            }
        }
    }
}

private data class ChipValue(val text: String, val emphasised: Boolean)

private fun fmt(value: Double, places: Int, signed: Boolean = false): String {
    val sign = if (signed && value > 0) "+" else ""
    return sign + String.format(java.util.Locale.US, "%.${places}f", value)
}

/**
 * Flat "search pipeline" footer rendered below the results list — query / per-stage
 * status + timing / debug. Ported from the iOS `SearchPipelineFooter`. Always visible after a
 * verbose search; no card chrome, just typography on `bgPrimary`.
 */
@Composable
private fun SearchPipelineFooter(response: SearchResponse) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        // Header
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            // Nearest Material equivalent to the iOS SF Symbol
            // "gauge.with.dots.needle.bottom.50percent" (a half-sweep dotted gauge), sized to
            // the iOS 11pt glyph.
            Icon(Icons.Outlined.Speed, contentDescription = null, tint = c.accent, modifier = Modifier.size(12.dp))
            Text(
                "SEARCH PIPELINE",
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.6.sp,
                color = c.textSecondary,
            )
            Spacer(Modifier.weight(1f))
            response.timing?.totalMs?.let {
                Text(
                    "${it.toInt()}ms",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textSecondary,
                )
            }
        }

        // QUERY
        response.query?.let { query ->
            Section("QUERY") {
                query.original?.takeIf { it.isNotEmpty() }?.let { Kv("original", it, mono = true) }
                query.effectiveText
                    ?.takeIf { it.isNotEmpty() && it != query.original }
                    ?.let { Kv("effective", it, mono = true) }
            }
        }

        // STAGES
        response.stages?.let { stages ->
            Section("STAGES") {
                stages.bm25?.let { StageRow("bm25", it) }
                stages.vector?.let { StageRow("vector", it) }
                stages.fusion?.let { StageRow("fusion", it) }
                stages.boost?.let { StageRow("boost", it) }
                stages.refCount?.let { StageRow("refCount", it) }
            }
        }

        // DEBUG
        response.debug?.let { debug ->
            Section("DEBUG") {
                debug.modelState?.vector?.let {
                    Kv("vector", it, valueColor = if (it == "ready") c.success else c.warning, mono = true)
                }
                debug.query?.inputLength?.let { Kv("inputLen", "$it chars") }
                response.models?.embedding?.let { Kv("embedding", it, mono = true) }
            }
        }

        // Footer
        response.timing?.let { timing ->
            Row(
                Modifier.padding(top = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                timing.bm25Candidates?.let {
                    Text("bm25 $it", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = c.textMuted)
                }
                timing.vectorCandidates?.let {
                    Text("vec $it", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = c.textMuted)
                }
                Spacer(Modifier.weight(1f))
                val count = response.results.size
                Text(
                    "$count result${if (count == 1) "" else "s"}",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    color = c.textSecondary,
                )
            }
        }
    }
}

@Composable
private fun Section(label: String, body: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            label,
            fontSize = 9.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.5.sp,
            color = OmTheme.colors.textMuted,
        )
        body()
    }
}

@Composable
private fun Kv(
    label: String,
    value: String,
    valueColor: androidx.compose.ui.graphics.Color = OmTheme.colors.textPrimary,
    mono: Boolean = false,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            label,
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp,
            color = OmTheme.colors.textMuted,
            modifier = Modifier.width(60.dp),
        )
        Text(
            value,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
            fontSize = 10.sp,
            color = valueColor,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun StageRow(name: String, report: SearchStageReport) {
    val c = OmTheme.colors
    val nameColor = when (report.status) {
        "ran" -> c.accent
        "skipped" -> c.warning
        else -> c.textSecondary
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(name, fontFamily = FontFamily.Monospace, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = nameColor)
            report.status?.takeIf { it != "ran" }?.let {
                Text(it, fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = c.warning)
            }
            Spacer(Modifier.weight(1f))
            report.durationMs?.let {
                Text("${it.toInt()}ms", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = c.textSecondary)
            }
        }
        val metrics = stageMetrics(name, report)
        if (metrics.isNotEmpty()) {
            Text(
                metrics.joinToString(" · "),
                fontFamily = FontFamily.Monospace,
                fontSize = 10.sp,
                color = c.textMuted,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
        report.reason?.takeIf { it.isNotEmpty() }?.let {
            Text(it, fontSize = 10.sp, color = c.textMuted, modifier = Modifier.padding(start = 8.dp))
        }
    }
}

private fun stageMetrics(name: String, report: SearchStageReport): List<String> = buildList {
    report.candidates?.let { add("$it cand") }
    if (name == "fusion") {
        report.method?.let { add(it) }
        report.resultCount?.let { add("→$it") }
        report.rrfK?.let { add("k=$it") }
    }
    if (name == "vector") {
        report.quantization?.let { add(it) }
        report.rescore?.takeIf { it }?.let { add("rescore") }
        report.effectiveK?.let { add("k=$it") }
        report.embedMs?.let { add("embed ${it.toInt()}ms") }
        report.sqlMs?.let { add("sql ${it.toInt()}ms") }
    }
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

private fun previewResults(): List<SearchResultItem> = listOf(
    SearchResultItem(
        documentId = "doc-1", sourceId = "gmail:maya@example.com", documentType = "email",
        title = "Re: Q4 budget review", sourceCreatedAt = "2026-06-08T07:00:00Z",
        author = "Maya Reeves",
        chunkText = "Projected spend is tracking under plan for the quarter; headcount stays flat into January.",
        score = 0.91,
        scoreBreakdown = SearchScoreBreakdown(
            bm25Rank = 1, vectorRank = 3, rrfScore = 0.0312,
            typeBoost = 0.08, finalScore = 0.9123,
        ),
    ),
    SearchResultItem(
        documentId = "doc-2", sourceId = "files:local", documentType = "file",
        title = "marathon-training-plan.pdf", sourceCreatedAt = "2026-06-06T08:30:00Z",
        author = null,
        chunkText = "Week 6 adds a tempo run and a long run of 18 km on Sunday.",
        score = 0.74,
    ),
    SearchResultItem(
        documentId = "doc-3", sourceId = "notes:local", documentType = "note",
        title = "Studio Northstar booking", sourceCreatedAt = "2026-06-01T18:00:00Z",
        author = "Jamie Lopez",
        chunkText = "Hold the room from 14:00, confirm the deposit with the venue by Friday.",
        score = 0.55,
    ),
)

private fun previewResponse(): SearchResponse = SearchResponse(
    results = previewResults(),
    models = dev.omnesis.android.transport.dto.SearchModels(
        embedding = "nomic-embed-text-v1.5.Q8_0.gguf",
    ),
    query = dev.omnesis.android.transport.dto.SearchQueryReport(
        original = "budget review",
        effectiveText = "budget review",
    ),
    timing = dev.omnesis.android.transport.dto.SearchTiming(
        totalMs = 187.0,
        bm25Candidates = 50, vectorCandidates = 50,
    ),
    stages = dev.omnesis.android.transport.dto.SearchStages(
        bm25 = SearchStageReport(status = "ran", durationMs = 8.0, candidates = 50),
        vector = SearchStageReport(
            status = "ran", durationMs = 92.0, candidates = 50,
            quantization = "int8", rescore = true, effectiveK = 200, embedMs = 38.0, sqlMs = 54.0,
        ),
        fusion = SearchStageReport(status = "ran", durationMs = 2.0, method = "rrf", resultCount = 30, rrfK = 60),
        boost = SearchStageReport(status = "ran", durationMs = 1.0),
    ),
    debug = dev.omnesis.android.transport.dto.SearchDebugInfo(
        modelState = dev.omnesis.android.transport.dto.SearchDebugInfo.ModelState(vector = "ready"),
        query = dev.omnesis.android.transport.dto.SearchDebugInfo.QueryLengths(inputLength = 14),
    ),
)

private val previewConnection =
    ConnectionState.Connected("d1", "Studio Northstar", listOf("read", "write"))

@Preview(name = "Search · tips · dark")
@Composable
private fun SearchTipsPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        SearchContent(
            state = SearchViewModel.State(),
            connection = previewConnection,
            onOpenMenu = {}, onQueryChange = {}, onSearch = {}, onOpenDocument = {},
        )
    }
}

@Preview(name = "Search · tips · light")
@Composable
private fun SearchTipsPreviewLight() {
    OmnesisTheme(darkTheme = false) {
        SearchContent(
            state = SearchViewModel.State(),
            connection = previewConnection,
            onOpenMenu = {}, onQueryChange = {}, onSearch = {}, onOpenDocument = {},
        )
    }
}

@Preview(name = "Search · results · dark")
@Composable
private fun SearchResultsPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        SearchContent(
            state = SearchViewModel.State(
                query = "budget review",
                lastQuery = "budget review",
                hasSearched = true,
                status = SearchViewModel.Status.Results(previewResults(), 187.0, previewResponse()),
            ),
            connection = previewConnection,
            onOpenMenu = {}, onQueryChange = {}, onSearch = {}, onOpenDocument = {},
        )
    }
}

@Preview(name = "Search · no results · dark")
@Composable
private fun SearchNoResultsPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        SearchContent(
            state = SearchViewModel.State(
                query = "zzz",
                lastQuery = "zzz",
                hasSearched = true,
                status = SearchViewModel.Status.Results(emptyList(), 12.0, previewResponse().copy(results = emptyList())),
            ),
            connection = previewConnection,
            onOpenMenu = {}, onQueryChange = {}, onSearch = {}, onOpenDocument = {},
        )
    }
}
