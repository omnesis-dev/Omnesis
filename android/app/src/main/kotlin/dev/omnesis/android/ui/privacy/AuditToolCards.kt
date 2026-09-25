// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Loop
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * The shared flat static tool card both audit halves render — the native twin
 * of the portal's `StaticToolCard` (`parts.js`), used by Direct transcript
 * calls and Answer agent-trace calls alike.
 *
 * Flat like the portal: NO outer collapsible, NO grey background (the view
 * background shows through), NO leading bar, a header (glyph + label + mono
 * arg + time text + `<>` raw button), and a body (result rows / SQL block /
 * error card / "No result"). There is deliberately no success chip: only
 * failures speak, through the shared error card. A refused or missing result
 * is rendered by the caller as "No result recorded." — the card itself only
 * ever says "No result" for a matched-but-empty result, mirroring the portal.
 *
 * The `<>` button opens a [ModalBottomSheet] with the scrollable mono
 * pretty-printed JSON (sorted keys, FULL exact bytes, never truncated),
 * titled "{label} — raw JSON". This replaces the old inline JSON expander,
 * which broke on large batch payloads.
 */

@OptIn(ExperimentalSerializationApi::class)
private val AuditRawJson = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
}

/** Sort object keys recursively so the raw sheet reads deterministically. Pure; unit tested. */
internal fun auditSortedJson(element: JsonElement): JsonElement = when (element) {
    is JsonObject -> JsonObject(
        element.entries.sortedBy { it.key }.associate { (key, value) -> key to auditSortedJson(value) },
    )
    is JsonArray -> JsonArray(element.map(::auditSortedJson))
    else -> element
}

/** Pretty-printed raw JSON with sorted keys and full bytes. Null reads "null". Pure; unit tested. */
internal fun auditRawJsonText(payload: JsonElement?): String =
    AuditRawJson.encodeToString(JsonElement.serializer(), auditSortedJson(payload ?: JsonNull))

@Composable
fun AuditToolCard(
    tool: String,
    content: DirectCardContent,
    rawPayload: JsonElement?,
    timeText: String?,
    onOpenDocument: (String) -> Unit = {},
    onOpenPerson: (canonicalId: String, name: String?) -> Unit = { _, _ -> },
    onOpenUrl: (String) -> Unit = {},
    catalog: SourceCatalog = SourceCatalog(),
) {
    val c = OmTheme.colors
    var rawOpen by remember(tool, rawPayload) { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = 8.dp, top = 4.dp, bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
    ) {
        AuditCardHeader(
            tool = tool,
            content = content,
            timeText = timeText,
            showRaw = rawPayload != null,
            onShowRaw = { rawOpen = true },
            onOpenUrl = onOpenUrl,
            catalog = catalog,
        )
        content.sections?.let { sections ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 140.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                sections.forEach { section ->
                    AuditCardSectionView(
                        section = section,
                        onOpenDocument = onOpenDocument,
                        onOpenPerson = onOpenPerson,
                        onOpenUrl = onOpenUrl,
                        catalog = catalog,
                    )
                }
            }
        } ?: AuditCardSectionView(
            section = DirectCardSection(
                rows = content.rows,
                sql = content.sql,
                error = content.error,
                showsEmpty = content.showsEmpty,
            ),
            onOpenDocument = onOpenDocument,
            onOpenPerson = onOpenPerson,
            onOpenUrl = onOpenUrl,
            catalog = catalog,
        )
        content.note?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = c.textMuted)
        }
    }
    if (rawOpen && rawPayload != null) {
        AuditRawJsonSheet(
            title = "${content.label} — raw JSON",
            jsonText = auditRawJsonText(rawPayload),
            onDismiss = { rawOpen = false },
        )
    }
}

@Composable
private fun AuditCardHeader(
    tool: String,
    content: DirectCardContent,
    timeText: String?,
    showRaw: Boolean,
    onShowRaw: () -> Unit,
    onOpenUrl: (String) -> Unit,
    catalog: SourceCatalog,
) {
    val c = OmTheme.colors
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            auditCardGlyph(tool),
            contentDescription = null,
            // Portal parity: .agent-ephemeral-glyph is the accent tone.
            tint = c.accent,
            modifier = Modifier.size(12.dp),
        )
        Text(
            content.label,
            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
            color = c.textSecondary,
        )
        if (content.arg.isNotEmpty()) {
            // A seed argument leads with its icon — the walked document's
            // source icon, the person glyph, the loop glyph — same imagery
            // as the result rows.
            when (val icon = content.argIcon) {
                is DirectArgIcon.Document -> icon.sourceId?.let {
                    SourceIcon(catalog.iconModel(it), size = 10.dp)
                } ?: Icon(
                    Icons.Outlined.Description,
                    contentDescription = null,
                    tint = c.textMuted,
                    modifier = Modifier.size(10.dp),
                )
                DirectArgIcon.Person -> Icon(
                    Icons.Outlined.Group,
                    contentDescription = null,
                    tint = c.textMuted,
                    modifier = Modifier.size(10.dp),
                )
                DirectArgIcon.Loop -> Icon(
                    Icons.Outlined.Loop,
                    contentDescription = null,
                    tint = c.textMuted,
                    modifier = Modifier.size(10.dp),
                )
                null -> { }
            }
            // The argument reads as plain argument text — grey mono on one
            // line, truncated, never link-blue — per the portal's
            // `.agent-ephemeral-arg` rule. Even a looked-up URL opens
            // out-of-app but renders like the rest. The argument fills the
            // remaining width so the time and `<>` pin to the very right
            // edge on every card, with or without an argument.
            val argModifier = Modifier.weight(1f, fill = true)
            when (val link = content.argLink) {
                is DirectCardDestination.External -> Text(
                    content.arg,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    softWrap = false,
                    modifier = argModifier.clickable { onOpenUrl(link.url) },
                )
                else -> Text(
                    content.arg,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = argModifier,
                )
            }
        } else {
            // The trailing time/raw pair sits at the row's end; without an
            // arg to absorb the slack the spacer below would collapse.
            Spacer(Modifier.weight(1f))
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            timeText?.let {
                Text(it, fontSize = 11.sp, color = c.textMuted, maxLines = 1)
            }
            if (showRaw) {
                IconButton(onClick = onShowRaw, modifier = Modifier.size(18.dp)) {
                    RawJsonGlyph()
                }
            }
        }
    }
}

/**
 * The portal's `<>` raw affordance (paths M6 3.5 L2.5 8 L6 12.5 /
 * M10 3.5 L13.5 8 L10 12.5), drawn at 11dp in the muted tone.
 */
@Composable
private fun RawJsonGlyph() {
    val color = OmTheme.colors.textMuted
    Canvas(Modifier.size(11.dp)) {
        val s = size.width / 16f
        val stroke = 1.5f * s
        fun point(x: Float, y: Float) = Offset(x * s, y * s)
        drawLine(color, point(6f, 3.5f), point(2.5f, 8f), strokeWidth = stroke)
        drawLine(color, point(2.5f, 8f), point(6f, 12.5f), strokeWidth = stroke)
        drawLine(color, point(10f, 3.5f), point(13.5f, 8f), strokeWidth = stroke)
        drawLine(color, point(13.5f, 8f), point(10f, 12.5f), strokeWidth = stroke)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AuditRawJsonSheet(
    title: String,
    jsonText: String,
    onDismiss: () -> Unit,
) {
    val c = OmTheme.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = c.bgPrimary,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = OmSpacing.lg)
                .padding(bottom = OmSpacing.xl),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            Text(
                title,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                color = c.textPrimary,
            )
            SelectionContainer {
                Text(
                    jsonText,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = c.textSecondary,
                    // Exact bytes: never soft-wrap (a wrap would read as a
                    // line break that is not there) — scroll both axes like
                    // the portal's `white-space: pre` raw block.
                    softWrap = false,
                    modifier = Modifier
                        .verticalScroll(rememberScrollState())
                        .horizontalScroll(rememberScrollState()),
                )
            }
        }
    }
}

private fun auditCardGlyph(tool: String): ImageVector = when (tool) {
    "search_many" -> Icons.Outlined.Search
    "fetch_many" -> Icons.Outlined.Description
    "lookup_document_by_url" -> Icons.Outlined.Link
    "lookup_people" -> Icons.Outlined.Group
    "trace_connections" -> Icons.Outlined.Hub
    "run_sql" -> Icons.Outlined.TableChart
    "search_loops", "list_loops", "fetch_loop", "open_loop_search", "open_loop_fetch" -> Icons.Outlined.Loop
    "temporal_query" -> Icons.Outlined.Schedule
    else -> Icons.Outlined.Description
}

@Composable
private fun AuditCardSectionView(
    section: DirectCardSection,
    onOpenDocument: (String) -> Unit,
    onOpenPerson: (canonicalId: String, name: String?) -> Unit,
    onOpenUrl: (String) -> Unit,
    catalog: SourceCatalog,
) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        section.heading?.takeIf { it.isNotEmpty() }?.let {
            Text(
                it,
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                color = OmTheme.colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        section.error?.let { AuditToolErrorCard(it) }
        section.rows.forEach { row ->
            AuditCardRowView(
                row = row,
                onOpenDocument = onOpenDocument,
                onOpenPerson = onOpenPerson,
                onOpenUrl = onOpenUrl,
                catalog = catalog,
            )
        }
        section.sql?.let { AuditSqlBlockView(it) }
        if (section.showsEmpty) {
            Text(
                "No result",
                style = MaterialTheme.typography.bodySmall,
                color = OmTheme.colors.textMuted,
            )
        }
    }
}

@Composable
private fun AuditCardRowView(
    row: DirectCardRow,
    onOpenDocument: (String) -> Unit,
    onOpenPerson: (canonicalId: String, name: String?) -> Unit,
    onOpenUrl: (String) -> Unit,
    catalog: SourceCatalog,
) {
    val c = OmTheme.colors
    val body: @Composable () -> Unit = {
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (val target = row.destination) {
                is DirectCardDestination.Document -> target.sourceId?.let {
                    SourceIcon(catalog.iconModel(it), size = 11.dp)
                } ?: Icon(
                    Icons.Outlined.Description,
                    contentDescription = null,
                    tint = c.textMuted,
                    modifier = Modifier.size(11.dp),
                )
                is DirectCardDestination.Person -> Icon(
                    Icons.Outlined.Group,
                    contentDescription = null,
                    tint = c.textMuted,
                    modifier = Modifier.size(11.dp),
                )
                else -> Icon(
                    Icons.Outlined.Description,
                    contentDescription = null,
                    tint = c.textMuted,
                    modifier = Modifier.size(11.dp),
                )
            }
            Column(Modifier.weight(1f)) {
                Text(
                    row.title.ifBlank { "Untitled" },
                    style = MaterialTheme.typography.labelSmall,
                    color = c.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                row.subtitle?.takeIf { it.isNotEmpty() }?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.labelSmall,
                        color = c.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
    when (val target = row.destination) {
        is DirectCardDestination.Document -> Box(
            Modifier
                .fillMaxWidth()
                .clickable { onOpenDocument(target.id) },
        ) { body() }
        is DirectCardDestination.Person -> Box(
            Modifier
                .fillMaxWidth()
                .clickable { onOpenPerson(target.canonicalId, target.name) },
        ) { body() }
        is DirectCardDestination.External -> Box(
            Modifier
                .fillMaxWidth()
                .clickable { onOpenUrl(target.url) },
        ) { body() }
        else -> Box(Modifier.fillMaxWidth()) { body() }
    }
}

/**
 * Collapsed error card mirroring the portal's `ToolErrorCard`: a muted-red
 * one-line summary (mono code + first-line message), tappable only when the
 * message is multi-line, expanding to the full mono body (240dp scroll cap).
 */
@Composable
internal fun AuditToolErrorCard(error: DirectCardError) {
    val c = OmTheme.colors
    var open by remember(error) { mutableStateOf(false) }
    val first = error.message.lineSequence().firstOrNull().orEmpty()
    val multi = error.message != first
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Box(
            Modifier
                .width(2.dp)
                .fillMaxHeight()
                .background(c.danger.copy(alpha = 0.45f)),
        )
        Column(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(topEnd = 4.dp, bottomEnd = 4.dp))
                .background(c.danger.copy(alpha = 0.08f))
                .then(if (multi) Modifier.clickable { open = !open } else Modifier)
                .padding(horizontal = 8.dp, vertical = 4.dp),
        ) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    error.code,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = c.danger,
                )
                Text(
                    first,
                    style = MaterialTheme.typography.labelSmall,
                    color = c.danger,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (multi) {
                    Icon(
                        Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                        contentDescription = if (open) "Collapse error" else "Expand error",
                        tint = c.danger.copy(alpha = 0.7f),
                        modifier = Modifier.size(10.dp),
                    )
                }
            }
            if (open && multi) {
                Text(
                    error.message,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = c.danger,
                    modifier = Modifier
                        .padding(top = 6.dp)
                        .heightIn(max = 240.dp)
                        .verticalScroll(rememberScrollState()),
                )
            }
        }
    }
}

@Composable
private fun AuditSqlBlockView(block: DirectSqlBlock) {
    val c = OmTheme.colors
    val mono = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (block.columns.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                block.columns.forEach {
                    Text(
                        it,
                        style = mono,
                        color = c.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        block.rows.forEach { cells ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                cells.forEach {
                    Text(
                        it,
                        style = mono,
                        color = c.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        val extra = block.totalRows - block.rows.size
        if (extra > 0) {
            Text("+$extra more rows", style = MaterialTheme.typography.labelSmall, color = c.textMuted)
        }
    }
}
