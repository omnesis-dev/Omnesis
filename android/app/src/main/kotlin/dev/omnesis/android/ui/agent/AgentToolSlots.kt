// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Loop
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.theme.OmFonts
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentLoopDetail
import dev.omnesis.android.transport.dto.AgentLoopLedgerEntry
import dev.omnesis.android.transport.dto.AgentLoopSummary
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.AgentTrailEventDoc
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// Ephemeral tool-call cards — search / open-document / run-sql / find-people /
// lookup-url / build-event-trail. Each renders as a thin left-accent-rail row
// (no surface, no border) with a one-line header and a fixed-height rolling slot
// that cycles results bottom-to-top at ~350ms/item, then the whole card fades
// out of the transcript. The underlying `AgentToolCall` payload is unchanged;
// the cards just present less of it for a shorter time. Mirrors the iOS
// `AgentEphemeralCards.swift` (primitives, pacing, per-card structure).

// MARK: - Pacing

/** Per-item cadence — also the slot's slide duration so items flow continuously. */
private const val RevealIntervalMs = 350L // PARITY:ephemeral-reveal-ms

/** Quiet pause after the last item before the card collapses. */
private const val HoldMs = 450L // PARITY:ephemeral-hold-ms

/** Fade-out duration. */
private const val FadeMs = 300L // PARITY:ephemeral-fade-ms

/** Floor before the fade may start, so a card never flashes faster than this. */
private const val MinVisibleMs = 500L // PARITY:ephemeral-min-visible-ms

// MARK: - Leading-rail container

/**
 * Inline activity chrome — a thin 2-dp accent rail down the left edge, 8-dp gap to
 * the content, no border, no bg fill. Reads as "the agent is currently doing
 * something here" without the visual weight of a bordered card. Mirrors iOS
 * `AgentInlineActivity`.
 */
@Composable
private fun AgentInlineActivity(content: @Composable ColumnScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Box(
            Modifier
                .width(2.dp)
                .fillMaxHeight()
                .background(OmTheme.colors.accent.copy(alpha = 0.5f)),
        )
        Column(
            Modifier.weight(1f).padding(vertical = 2.dp),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
            content = content,
        )
    }
}

/**
 * Tool-name + arg header common to all cards. The small glyph carries the accent;
 * the `label` is rendered in `textSecondary` semibold (no accent on the word
 * itself), and the mono arg is dimmer (`textMuted`). A small accent spinner shows
 * at the far right only while pending. Mirrors iOS `AgentInlineHeader`.
 */
@Composable
private fun AgentInlineHeader(
    glyph: ImageVector,
    label: String,
    monoArg: String? = null,
    showSpinner: Boolean,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(glyph, null, Modifier.size(11.dp), tint = OmTheme.colors.accent)
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = OmTheme.colors.textSecondary,
            maxLines = 1,
        )
        if (!monoArg.isNullOrEmpty()) {
            Text(
                monoArg,
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                color = OmTheme.colors.textMuted,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
        }
        trailing()
        Spacer(Modifier.weight(1f))
        if (showSpinner) {
            OmSpinner(Modifier.size(13.dp), strokeWidth = 1.5.dp, color = OmTheme.colors.accent)
        }
    }
}

// MARK: - Rolling slot primitive

/**
 * Fixed-height slot that scrolls a vertical stack of items upward at the cadence
 * interval. `currentIndex == null` parks the stack just below the slot (nothing
 * visible); 0…N-1 brings each item up into view in turn. Only one item is ever
 * visible (the window clips to one [slotHeight]). Mirrors iOS `AgentRollingSlot`.
 */
@Composable
private fun <T> AgentRollingSlot(
    items: List<T>,
    currentIndex: Int?,
    slotHeight: Dp,
    modifier: Modifier = Modifier,
    animate: Boolean = true,
    itemView: @Composable (T) -> Unit,
) {
    // Park one slot below the window when index is null; otherwise shift the stack
    // up by index*slotHeight so item i sits in the window.
    val targetDp = if (currentIndex == null) slotHeight else -(slotHeight * currentIndex)
    val targetPx = with(androidx.compose.ui.platform.LocalDensity.current) { targetDp.toPx() }
    // Frozen snapshots (preview / screenshot test) hold a fixed slot, so apply the
    // offset directly — an animation never settles under single-frame capture, which
    // would leave the slot showing the wrong (or no) item.
    val animatedOffset by animateFloatAsState(
        targetValue = targetPx,
        animationSpec = tween(RevealIntervalMs.toInt(), easing = LinearEasing),
        label = "slot",
    )
    val offset = if (animate) animatedOffset else targetPx
    Box(modifier.height(slotHeight).clipToBounds()) {
        // The stack must lay out all items at full height even though the window
        // shows only one — `wrapContentHeight(unbounded)` lets the column ignore the
        // box's one-slot height constraint, so items below the window still exist and
        // can scroll up into view. Without it the column is clamped to one slot and
        // only item 0 ever renders.
        Column(
            Modifier
                .wrapContentHeight(align = Alignment.Top, unbounded = true)
                .graphicsLayer { translationY = offset },
        ) {
            items.forEach { item ->
                Box(
                    Modifier.fillMaxWidth().height(slotHeight),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    itemView(item)
                }
            }
        }
    }
}

// MARK: - Rotation driver

/**
 * The shared ephemeral lifecycle: once the result lands, hold the card briefly,
 * rotate one item per [RevealIntervalMs] through [count] slots, hold, fade, then
 * fire [onFlush] exactly once. An [expedite] path (the coordinator parked tail
 * content on us) skips the rotation and dismisses after the min-visible floor.
 *
 * `setIndex` advances the visible slot. `setAlpha` drives the fade-out. The
 * load-bearing [onFlush] opens the causality gate so parked turn-extending events
 * replay in order — if it never fires, trailing tokens are lost.
 */
@Composable
private fun EphemeralRotation(
    toolCallId: String,
    hasResult: Boolean,
    expedite: Boolean,
    count: Int,
    setIndex: (Int) -> Unit,
    setAlpha: (Float) -> Unit,
    onFlush: (String) -> Unit,
) {
    val flushed = remember { mutableStateOf(false) }

    suspend fun dismissAndFlush() {
        setAlpha(0f)
        delay(FadeMs)
        if (flushed.value) return
        flushed.value = true
        onFlush(toolCallId)
    }

    LaunchedEffect(toolCallId, hasResult, expedite) {
        if (!hasResult) return@LaunchedEffect
        if (expedite) {
            // The card may already have been visible a while; only wait out the
            // remaining min-visible floor before dismissing.
            delay(MinVisibleMs)
            dismissAndFlush()
            return@LaunchedEffect
        }
        if (count == 0) {
            delay(HoldMs + RevealIntervalMs)
            dismissAndFlush()
            return@LaunchedEffect
        }
        for (i in 0 until count) {
            setIndex(i)
            delay(RevealIntervalMs)
        }
        delay(HoldMs)
        dismissAndFlush()
    }
}

// MARK: - Search

/**
 * Lifecycle-safe fallback for ephemeral actions that do not need a bespoke result layout.
 * Keeping the fallback ephemeral is important: every member of `EPHEMERAL_TOOLS` can hold
 * following answer text behind its card, so every one must eventually dismiss and flush.
 */
@Composable
fun AgentEphemeralActionCard(
    call: AgentToolCall,
    label: String,
    glyph: ImageVector,
    onFlushEphemeral: (String) -> Unit,
    freeze: Boolean = false,
) {
    val result = call.result
    val outcome = when (result) {
        is AgentToolResult.ErrorResult -> result.message.ifBlank { result.code }
        is AgentToolResult.Structured -> humanizeResultType(result.resultType)
        null -> null
        else -> "Done"
    }
    EphemeralCardFrame(
        call = call,
        itemCount = if (outcome == null) 0 else 1,
        onFlushEphemeral = onFlushEphemeral,
        freeze = freeze,
    ) { currentIndex ->
        AgentInlineHeader(
            glyph = glyph,
            label = label,
            monoArg = call.argsSummary.takeIf { it.isNotEmpty() },
            showSpinner = result == null,
        )
        if (outcome != null) {
            AgentRollingSlot(
                items = listOf(outcome),
                currentIndex = currentIndex,
                slotHeight = 18.dp,
                animate = !freeze,
            ) { line ->
                val isError = result is AgentToolResult.ErrorResult
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        if (isError) "!" else "✓",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = if (isError) MaterialTheme.colorScheme.error else OmTheme.colors.textMuted,
                    )
                    Text(
                        line,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (isError) MaterialTheme.colorScheme.error else OmTheme.colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

internal fun humanizeResultType(resultType: String): String = resultType
    .split('.', '_', '-')
    .filter(String::isNotBlank)
    .joinToString(" ")
    .replaceFirstChar { it.uppercase() }
    .ifBlank { "Done" }

/**
 * Compact lifecycle card for temporal reads and annotation mutations. The
 * temporal result remains transport-generic so new projection/annotation
 * provenance fields pass through untouched; the card only needs the item count.
 */
@Composable
fun AgentEphemeralTemporalCard(
    call: AgentToolCall,
    onFlushEphemeral: (String) -> Unit,
    freeze: Boolean = false,
) {
    val result = call.result
    val itemCount = (result as? AgentToolResult.Structured)
        ?.data
        ?.let { it as? JsonObject }
        ?.get("items")
        ?.let { it as? JsonArray }
        ?.size
    val outcome = when (result) {
        is AgentToolResult.ErrorResult -> result.message.ifBlank { result.code }
        null -> null
        else -> itemCount?.let { count -> "$count ${if (count == 1) "date" else "dates"}" } ?: "Done"
    }
    EphemeralCardFrame(
        call = call,
        itemCount = if (outcome == null) 0 else 1,
        onFlushEphemeral = onFlushEphemeral,
        freeze = freeze,
    ) { currentIndex ->
        AgentInlineHeader(
            glyph = Icons.Outlined.CalendarMonth,
            label = temporalToolLabel(call.tool),
            monoArg = call.argsSummary.takeIf { it.isNotEmpty() },
            showSpinner = result == null,
        )
        if (outcome != null) {
            AgentRollingSlot(
                items = listOf(outcome),
                currentIndex = currentIndex,
                slotHeight = 18.dp,
                animate = !freeze,
            ) { line ->
                val isError = result is AgentToolResult.ErrorResult
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        if (isError) "!" else "✓",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = if (isError) MaterialTheme.colorScheme.error else OmTheme.colors.textMuted,
                    )
                    Text(
                        line,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (isError) MaterialTheme.colorScheme.error else OmTheme.colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

internal fun temporalToolLabel(tool: String): String = when (tool) {
    "temporal_query", "time_index_query" -> "Check dates"
    "temporal_annotation_add", "time_index_add" -> "Add date note"
    "temporal_annotation_update", "time_index_update" -> "Update date note"
    "temporal_annotation_delete", "time_index_delete" -> "Remove date note"
    else -> tool
}

/**
 * Search card. Header is "Search <query>". Below it a single-line slot rotates
 * through one result at a time (source icon + title), then the card fades out.
 * Mirrors iOS `AgentEphemeralSearchCard`.
 */
@Composable
fun AgentEphemeralSearchCard(
    call: AgentToolCall,
    catalog: SourceCatalog,
    onFlushEphemeral: (String) -> Unit,
    initialIndex: Int? = null,
    freeze: Boolean = false,
) {
    val result = call.result as? AgentToolResult.SearchResults
    val results = result?.results.orEmpty().take(MaxItemsToReveal)
    EphemeralCardFrame(
        call = call,
        itemCount = results.size,
        onFlushEphemeral = onFlushEphemeral,
        initialIndex = initialIndex,
        freeze = freeze,
    ) { currentIndex ->
        AgentInlineHeader(
            glyph = Icons.Outlined.Search,
            label = "Search",
            // A batch child (`search_many`) carries only the server-rendered `argsSummary`, not raw
            // args — fall back to it so the per-child card still shows its query. Inert for a
            // singular search (its args always carry `query`).
            monoArg = (call.argString("query")).takeIf { it.isNotEmpty() }
                ?: call.argsSummary.takeIf { it.isNotEmpty() },
            showSpinner = call.result == null,
        )
        if (call.result != null && results.isNotEmpty()) {
            AgentRollingSlot(results, currentIndex, slotHeight = 18.dp, animate = !freeze) { ref ->
                SlotDocRow(ref, catalog)
            }
        }
    }
}

// MARK: - Trace connections

/**
 * `trace_connections` card. Header is "Trace connections" — seeds and depth are omitted
 * (low-level args). Below it a single-line slot rotates through the docs the trail
 * reached (source icon + title), deduped by documentId, then fades out. Mirrors
 * iOS `AgentEphemeralTrailCard`.
 */
@Composable
fun AgentEphemeralTrailCard(
    call: AgentToolCall,
    catalog: SourceCatalog,
    onFlushEphemeral: (String) -> Unit,
    initialIndex: Int? = null,
    freeze: Boolean = false,
) {
    val docs = trailDocs(call.result as? AgentToolResult.EventTrailBuilt)
    EphemeralCardFrame(
        call = call,
        itemCount = docs.size,
        onFlushEphemeral = onFlushEphemeral,
        initialIndex = initialIndex,
        freeze = freeze,
    ) { currentIndex ->
        AgentInlineHeader(
            glyph = Icons.Outlined.Hub,
            label = "Trace connections",
            showSpinner = call.result == null,
        )
        if (call.result != null && docs.isNotEmpty()) {
            AgentRollingSlot(docs, currentIndex, slotHeight = 18.dp, animate = !freeze) { doc ->
                SlotTrailDocRow(doc, catalog)
            }
        }
    }
}

/** Flatten trail events (+ nested attachments) into a deduped, capped doc list. */
private fun trailDocs(result: AgentToolResult.EventTrailBuilt?): List<AgentTrailEventDoc> {
    if (result == null) return emptyList()
    val seen = HashSet<String>()
    val out = ArrayList<AgentTrailEventDoc>()
    fun add(doc: AgentTrailEventDoc): Boolean {
        if (seen.add(doc.documentId)) {
            out.add(doc)
            if (out.size >= MaxItemsToReveal) return true
        }
        return false
    }
    for (event in result.events) {
        // A record-only event (#757) carries no doc — the ephemeral rolling-slot card only
        // reveals document refs, so skip it here.
        event.doc?.let { if (add(it)) return out }
        for (att in event.attachments) {
            att.doc?.let { if (add(it)) return out }
        }
    }
    return out
}

// MARK: - Open document

/**
 * Open-document card. The header trailing carries the doc identity (source icon +
 * middle-truncated title). Below it a single-line slot rotates the document body
 * one non-blank line at a time (proportional, not mono), then fades. Mirrors iOS
 * `AgentEphemeralDocumentCard`.
 */
@Composable
fun AgentEphemeralDocumentCard(
    call: AgentToolCall,
    catalog: SourceCatalog,
    onFlushEphemeral: (String) -> Unit,
    initialIndex: Int? = null,
    freeze: Boolean = false,
) {
    val result = call.result as? AgentToolResult.DocumentResult
    val ref = result?.ref
    val lines = result?.document?.content
        ?.split("\n")
        ?.filter { it.isNotBlank() }
        ?.take(MaxDocLinesToReveal)
        .orEmpty()
    EphemeralCardFrame(
        call = call,
        itemCount = lines.size,
        onFlushEphemeral = onFlushEphemeral,
        initialIndex = initialIndex,
        freeze = freeze,
    ) { currentIndex ->
        AgentInlineHeader(
            glyph = Icons.Outlined.Description,
            label = "Open document",
            showSpinner = call.result == null,
        ) {
            if (ref != null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.weight(1f, fill = false),
                ) {
                    SourceIcon(catalog.iconModel(ref.sourceId), size = 11.dp)
                    Text(
                        middleTruncate(ref.title?.takeIf { it.isNotBlank() } ?: "Untitled", 36),
                        style = MaterialTheme.typography.labelSmall,
                        color = OmTheme.colors.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        if (call.result != null && lines.isNotEmpty()) {
            AgentRollingSlot(lines, currentIndex, slotHeight = 16.dp, animate = !freeze) { line ->
                Text(
                    line,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = OmFonts.inter),
                    fontWeight = FontWeight.Normal,
                    color = OmTheme.colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

// MARK: - Find people

/**
 * People-lookup card. Header is "Find people <query>". Below it a single-line slot
 * rotates one candidate at a time (display name medium + primary alias mono), no
 * source icon, then fades. Empty results show header only. Mirrors iOS
 * `AgentEphemeralPeopleCard`.
 */
@Composable
fun AgentEphemeralPeopleCard(
    call: AgentToolCall,
    onFlushEphemeral: (String) -> Unit,
    initialIndex: Int? = null,
    freeze: Boolean = false,
) {
    val result = call.result as? AgentToolResult.PersonResults
    val people = result?.results.orEmpty().take(MaxItemsToReveal)
    EphemeralCardFrame(
        call = call,
        itemCount = people.size,
        onFlushEphemeral = onFlushEphemeral,
        initialIndex = initialIndex,
        freeze = freeze,
    ) { currentIndex ->
        AgentInlineHeader(
            glyph = Icons.Outlined.Group,
            label = "Find people",
            monoArg = (call.argString("query")).takeIf { it.isNotEmpty() },
            showSpinner = call.result == null,
        )
        if (call.result != null && people.isNotEmpty()) {
            AgentRollingSlot(people, currentIndex, slotHeight = 18.dp, animate = !freeze) { person ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        person.displayName.ifBlank { "Unknown" },
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Medium,
                        color = OmTheme.colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    person.aliases.firstOrNull()?.takeIf { it.isNotBlank() }?.let { alias ->
                        Text(
                            alias,
                            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                            color = OmTheme.colors.textMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

// MARK: - Lookup URL

/**
 * URL-lookup card. Header is "Lookup URL <url>" (url wraps to 2 lines). Below it a
 * single-row slot reveals either the matched document (source icon + title) or a
 * "No match in your corpus" italic placeholder, then fades. Mirrors iOS
 * `AgentEphemeralUrlLookupCard`.
 */
@Composable
fun AgentEphemeralUrlLookupCard(
    call: AgentToolCall,
    catalog: SourceCatalog,
    onFlushEphemeral: (String) -> Unit,
    initialIndex: Int? = null,
    freeze: Boolean = false,
) {
    val result = call.result as? AgentToolResult.DocumentByUrl
    val ref = result?.ref
    // One-row slot when a result has landed; pending shows the header only.
    val items: List<UrlSlotItem> =
        if (call.result != null) listOf(ref?.let { UrlSlotItem.Hit(it) } ?: UrlSlotItem.Miss)
        else emptyList()
    EphemeralCardFrame(
        call = call,
        itemCount = items.size,
        onFlushEphemeral = onFlushEphemeral,
        initialIndex = initialIndex,
        freeze = freeze,
    ) { currentIndex ->
        AgentInlineHeader(
            glyph = Icons.Outlined.Link,
            label = "Lookup URL",
            monoArg = (call.argString("url")).takeIf { it.isNotEmpty() },
            showSpinner = call.result == null,
        )
        if (items.isNotEmpty()) {
            AgentRollingSlot(items, currentIndex, slotHeight = 18.dp, animate = !freeze) { item ->
                when (item) {
                    is UrlSlotItem.Hit -> SlotDocRow(item.ref, catalog)
                    UrlSlotItem.Miss -> Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "No match in your corpus",
                            style = MaterialTheme.typography.labelSmall.copy(fontStyle = FontStyle.Italic),
                            color = OmTheme.colors.textMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

private sealed interface UrlSlotItem {
    data class Hit(val ref: AgentDocRef) : UrlSlotItem
    data object Miss : UrlSlotItem
}

// MARK: - Loops (experimental — read-only window into the Cognition Steward)

/** Recent ledger entries revealed on a fetch_loop card. */
private const val MaxLoopLedgerToReveal = 6

private val loopLedgerFormat = SimpleDateFormat("MMM d", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}

/**
 * `search_loops` card. Header is "Search loops <query>". Below it a single-line slot
 * rotates one tracked open loop at a time (title + a state pill), then the card fades
 * out. Empty results (nothing tracked matched) show the header only. Structurally
 * mirrors [AgentEphemeralSearchCard], but loops carry no source so there is no icon.
 */
@Composable
fun AgentEphemeralLoopsSearchCard(
    call: AgentToolCall,
    onFlushEphemeral: (String) -> Unit,
    initialIndex: Int? = null,
    freeze: Boolean = false,
) {
    val result = call.result as? AgentToolResult.LoopsSearched
    val loops = result?.loops.orEmpty().take(MaxItemsToReveal)
    EphemeralCardFrame(
        call = call,
        itemCount = loops.size,
        onFlushEphemeral = onFlushEphemeral,
        initialIndex = initialIndex,
        freeze = freeze,
    ) { currentIndex ->
        AgentInlineHeader(
            glyph = Icons.Outlined.Loop,
            label = "Search loops",
            monoArg = (call.argString("query")).takeIf { it.isNotEmpty() },
            showSpinner = call.result == null,
        )
        if (call.result != null && loops.isNotEmpty()) {
            AgentRollingSlot(loops, currentIndex, slotHeight = 18.dp, animate = !freeze) { loop ->
                SlotLoopRow(loop)
            }
        }
    }
}

/**
 * `fetch_loop` card. The header trailing carries the loop identity (middle-truncated
 * title + state pill). Below it a static facts line (deadline · importance) and a
 * people line (actors + involved), then a single-line slot rotates the most recent
 * ledger notes, then fades. A no-match fetch (`loop == null`) shows a muted italic
 * placeholder. Structurally mirrors [AgentEphemeralDocumentCard].
 */
@Composable
fun AgentEphemeralLoopCard(
    call: AgentToolCall,
    onFlushEphemeral: (String) -> Unit,
    initialIndex: Int? = null,
    freeze: Boolean = false,
) {
    val result = call.result as? AgentToolResult.LoopFetched
    val loop = result?.loop
    // Ledger is oldest→newest on the wire; reveal the most recent few.
    val ledger = loop?.ledger.orEmpty().takeLast(MaxLoopLedgerToReveal)
    EphemeralCardFrame(
        call = call,
        itemCount = ledger.size,
        onFlushEphemeral = onFlushEphemeral,
        initialIndex = initialIndex,
        freeze = freeze,
    ) { currentIndex ->
        AgentInlineHeader(
            glyph = Icons.Outlined.Loop,
            label = "Open loop",
            monoArg = if (loop == null) call.argString("loopId").takeIf { it.isNotEmpty() } else null,
            showSpinner = call.result == null,
        ) {
            if (loop != null) {
                Text(
                    middleTruncate(loop.title.ifBlank { "Untitled loop" }, 36),
                    style = MaterialTheme.typography.labelSmall,
                    color = OmTheme.colors.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
        }
        if (call.result != null) {
            if (loop == null) {
                Text(
                    "No matching loop",
                    style = MaterialTheme.typography.labelSmall.copy(fontStyle = FontStyle.Italic),
                    color = OmTheme.colors.textMuted,
                    maxLines = 1,
                )
            } else {
                LoopFacts(loop)
                if (ledger.isNotEmpty()) {
                    AgentRollingSlot(ledger, currentIndex, slotHeight = 16.dp, animate = !freeze) { entry ->
                        LoopLedgerRow(entry)
                    }
                }
            }
        }
    }
}

/** A search-loops result row: loop title + a trailing state pill, no source icon. */
@Composable
private fun SlotLoopRow(loop: AgentLoopSummary) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            loop.title.ifBlank { "Untitled loop" },
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Normal,
            color = OmTheme.colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        LoopStatePill(loop.state)
    }
}

/** A small state chip ("open" / "snoozed") on a faint tertiary fill. */
@Composable
private fun LoopStatePill(state: String) {
    Text(
        state.takeIf { it.isNotBlank() } ?: "open",
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Medium,
        color = OmTheme.colors.textMuted,
        maxLines = 1,
        modifier = Modifier
            .clip(RoundedCornerShape(OmRadius.small))
            .background(OmTheme.colors.bgTertiary.copy(alpha = 0.6f))
            .padding(horizontal = 5.dp, vertical = 1.dp),
    )
}

/** Static facts under a fetch_loop header: a deadline/importance line + a people line. */
@Composable
private fun LoopFacts(loop: AgentLoopDetail) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        val meta = buildList {
            loop.state.takeIf { it.isNotBlank() }?.let { add(it) }
            loop.deadline?.takeIf { it.isNotBlank() }?.let { add("due $it") }
            loop.importance?.let { add("importance ${formatImportance(it)}") }
        }
        if (meta.isNotEmpty()) {
            Text(
                meta.joinToString("  ·  "),
                style = MaterialTheme.typography.labelSmall,
                color = OmTheme.colors.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        val people = ((loop.actors ?: emptyList()) + (loop.involved ?: emptyList())).distinct()
        if (people.isNotEmpty()) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.Group, null, Modifier.size(10.dp), tint = OmTheme.colors.textMuted)
                Text(
                    people.joinToString(", "),
                    style = MaterialTheme.typography.labelSmall,
                    color = OmTheme.colors.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** One ledger line in a fetch_loop rolling slot: a UTC "MMM d" stamp + the note. */
@Composable
private fun LoopLedgerRow(entry: AgentLoopLedgerEntry) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            loopLedgerFormat.format(Date(entry.at)),
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
            color = OmTheme.colors.textMuted,
            maxLines = 1,
        )
        Text(
            entry.note,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Normal,
            color = OmTheme.colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

/** Coarse 0-1 importance → a one-decimal string, dropping a trailing `.0`. */
private fun formatImportance(v: Double): String {
    val rounded = Math.round(v * 10) / 10.0
    return if (rounded == rounded.toLong().toDouble()) rounded.toLong().toString() else rounded.toString()
}

// MARK: - Run SQL

/**
 * Run-SQL card. Two rotating slots driven sequentially: the one-line SQL query
 * (mono, muted) first, then the result rows under a static fixed-width column
 * header, all inside a horizontal scroll so wide tables clip to the viewport
 * rather than widening the transcript. Mirrors iOS `AgentEphemeralSqlCard`.
 */
@Composable
fun AgentEphemeralSqlCard(
    call: AgentToolCall,
    catalog: SourceCatalog,
    onFlushEphemeral: (String) -> Unit,
    initialSqlIndex: Int? = null,
    initialRowIndex: Int? = null,
    freeze: Boolean = false,
) {
    val result = call.result as? AgentToolResult.SqlRows
    val sqlLine = call.argString("sql").split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    val columns = result?.columns.orEmpty()
    val rows = result?.rows.orEmpty().take(MaxSqlRowsToReveal)
    val sources = result?.sources.orEmpty()
    val subjects = result?.subjects.orEmpty()

    // Frozen (after-the-fact) cards render their first SQL line + row statically
    // rather than parking both slots off-screen (#890).
    var rowIndex by remember(call.toolCallId) {
        mutableStateOf(initialRowIndex ?: if (freeze) 0 else null)
    }
    // While pending, park the query at index 0 so it shows statically (no
    // suspended rotation). Once the result lands the loop takes over from here.
    var sqlIndex by remember(call.toolCallId) {
        mutableStateOf(
            initialSqlIndex ?: if (freeze || (call.result == null && sqlLine.isNotEmpty())) 0 else initialSqlIndex,
        )
    }
    var alpha by remember(call.toolCallId) { mutableStateOf(1f) }
    val flushed = remember(call.toolCallId) { mutableStateOf(false) }

    val hasResult = call.result != null
    val expedite = call.pendingTail.isNotEmpty()

    suspend fun dismissAndFlush() {
        alpha = 0f
        if (flushed.value) return
        flushed.value = true
        delay(FadeMs)
        onFlushEphemeral(call.toolCallId)
    }

    // The rotation only runs once the result lands — while pending the card is
    // static (header + spinner + parked query line), so a snapshot of the pending
    // state has nothing suspended to wait on. When the result arrives the query
    // line rolls in (if it wasn't already shown), then the rows roll, then fade.
    if (!freeze && hasResult) {
        LaunchedEffect(call.toolCallId, expedite) {
            if (expedite) {
                delay(MinVisibleMs)
                dismissAndFlush()
                return@LaunchedEffect
            }
            if (sqlLine.isNotEmpty() && sqlIndex == null) {
                sqlIndex = 0
                delay(RevealIntervalMs)
            }
            if (rows.isEmpty()) {
                delay(HoldMs + RevealIntervalMs)
                dismissAndFlush()
                return@LaunchedEffect
            }
            for (i in rows.indices) {
                rowIndex = i
                delay(RevealIntervalMs)
            }
            delay(HoldMs)
            dismissAndFlush()
        }
    }

    EphemeralDismissContainer(visible = alpha > 0f) {
        AgentInlineActivity {
            AgentInlineHeader(
                glyph = Icons.Outlined.TableChart,
                label = "Run SQL",
                showSpinner = !hasResult,
            ) {
                if (sources.isNotEmpty() || subjects.isNotEmpty()) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.weight(1f, fill = false),
                    ) {
                        sources.forEach { s ->
                            SourceIcon(catalog.iconModel(s.sourceId), size = 11.dp)
                        }
                        if (subjects.isNotEmpty()) {
                            Text(
                                subjects.joinToString(" + "),
                                style = MaterialTheme.typography.labelSmall,
                                color = OmTheme.colors.textMuted,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
            if (sqlLine.isNotEmpty()) {
                AgentRollingSlot(listOf(sqlLine), sqlIndex, slotHeight = 16.dp, animate = !freeze) { line ->
                    Text(
                        line,
                        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                        color = OmTheme.colors.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            if (hasResult && rows.isNotEmpty() && columns.isNotEmpty()) {
                SqlTable(columns, rows, rowIndex, animate = !freeze)
            }
        }
    }
}

/** Fixed-width per cell so the header and rolling value row stay aligned. */
private val SqlColWidth = 80.dp

@Composable
private fun SqlTable(
    columns: List<String>,
    rows: List<List<JsonElement>>,
    rowIndex: Int?,
    animate: Boolean = true,
) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Column {
            Row {
                columns.forEach { col ->
                    Text(
                        col,
                        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                        fontWeight = FontWeight.SemiBold,
                        color = OmTheme.colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.width(SqlColWidth),
                    )
                }
            }
            AgentRollingSlot(
                rows,
                rowIndex,
                slotHeight = 18.dp,
                modifier = Modifier.width(SqlColWidth * columns.size),
                animate = animate,
            ) { row ->
                Row {
                    normaliseRow(row, columns.size).forEach { cell ->
                        Text(
                            formatSqlCell(cell),
                            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                            color = OmTheme.colors.textMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.width(SqlColWidth),
                        )
                    }
                }
            }
        }
    }
}

/** Pad with nulls / truncate so the row has exactly [columnCount] cells. */
private fun normaliseRow(row: List<JsonElement>, columnCount: Int): List<JsonElement> = when {
    row.size == columnCount -> row
    row.size > columnCount -> row.take(columnCount)
    else -> row + List(columnCount - row.size) { JsonNull }
}

private val sqlDateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}
private val sqlTimestampFormat = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}

/**
 * Typed cell formatting: null→"null", Bool→"true"/"false", Int→plain, whole
 * Double→dropped `.0`, `{days:n}`→`yyyy-MM-dd` (UTC), `{micros:n}`→`yyyy-MM-dd
 * HH:mm` (UTC), else the JSON string. Mirrors iOS `formatCell`.
 */
private fun formatSqlCell(cell: JsonElement): String = when (cell) {
    is JsonNull -> "null"
    is JsonPrimitive -> {
        if (cell.isString) {
            cell.content
        } else {
            cell.booleanOrNull?.let { return if (it) "true" else "false" }
            cell.longOrNull?.let { return it.toString() }
            cell.doubleOrNull?.let { d ->
                return if (d == d.toLong().toDouble()) d.toLong().toString() else d.toString()
            }
            cell.content
        }
    }
    is JsonObject -> {
        val obj = cell.jsonObject
        val days = (obj["days"] as? JsonPrimitive)?.intOrNull
        val micros = (obj["micros"] as? JsonPrimitive)?.longOrNull
        when {
            days != null && obj.size == 1 -> sqlDateFormat.format(Date(days.toLong() * 86_400_000L))
            micros != null && obj.size == 1 -> sqlTimestampFormat.format(Date(micros / 1000L))
            else -> cell.toString()
        }
    }
    else -> cell.toString()
}

// MARK: - Batch retrieval (search_many / fetch_many)

/**
 * A batch retrieval card (`search_many` / `fetch_many`): one per-child card per [AgentToolChild],
 * reusing the singular search / open-document card the child names. The cards render concurrently —
 * each shows its own glance, lights up as its child result lands, rolls its reveal, and fades on its
 * OWN lifecycle. Unlike a singular ephemeral card, a batch parent does NOT act as a causality gate
 * (see [AgentReducer.BATCH_EPHEMERAL_TOOLS]): the answer text streams as soon as the durable batch
 * result lands, alongside the settling child cards. So there is no parent flush to wire — each
 * child's flush is a no-op ({@code {}}), its fade driven by its own local alpha. [freeze] passes
 * through to the children: an after-the-fact render (a finished sub-agent transcript) shows them
 * statically; a live render animates each concurrently.
 *
 * The children are derived in [batchChildren]'s priority order so the cards render on EVERY backend.
 * Every production backend streams live `agent.tool.child.*` progress. Mirrors the iOS
 * `AgentBatchToolCards` and the portal `parts.js` search_many/fetch_many projection.
 */
@Composable
fun AgentBatchEphemeralCards(
    call: AgentToolCall,
    catalog: SourceCatalog,
    freeze: Boolean = false,
) {
    val fallbackTool = if (call.tool == "fetch_many") "fetch_document" else "search_documents"
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        batchChildren(call, fallbackTool).forEach { child ->
            // Key by the stable child index so an out-of-order arrival that re-sorts the list
            // doesn't shift a still-animating card's composition slot (matches the iOS
            // ForEach(id:) and the portal's keyed child render). The index is stable across the
            // running → settled transition too, so a pending card recomposes into its settled
            // self rather than remounting.
            key(child.index) {
                val childCall = AgentToolCall(
                    toolCallId = "${call.toolCallId}#${child.index}",
                    tool = child.tool ?: fallbackTool,
                    argsSummary = child.argsSummary,
                    argsKnown = child.result != null,
                    result = child.result,
                )
                when (child.tool ?: fallbackTool) {
                    "fetch_document" -> AgentEphemeralDocumentCard(childCall, catalog, onFlushEphemeral = {}, freeze = freeze)
                    else -> AgentEphemeralSearchCard(childCall, catalog, onFlushEphemeral = {}, freeze = freeze)
                }
            }
        }
    }
}

/**
 * Derive the per-child render list for a batch retrieval card in priority order. The durable result
 * and pending args remain reload/replay fallbacks when live child events were not retained:
 *
 *  1. [AgentToolCall.children] when non-empty — the live per-child stream. Used verbatim.
 *  2. Else the settled batch result ([AgentToolResult.SearchBatch] / [AgentToolResult.DocumentBatch])
 *     — one SETTLED pseudo-child per item, carrying that item's singular result, so a childless
 *     backend still shows one finished card per query / document once the batch result lands.
 *  3. Else the pending args (`queries` / `documents`) — one PENDING pseudo-child (null result) per
 *     input entry, so N live spinner cards show while the batch runs and the turn looks alive.
 *
 * The child index is stable across all three stages (input entry i → result item i), so a card's
 * composition identity holds as the same call transitions running → settled.
 */
private fun batchChildren(call: AgentToolCall, fallbackTool: String): List<AgentToolChild> {
    if (call.children.isNotEmpty()) return call.children

    val items = when (val result = call.result) {
        is AgentToolResult.SearchBatch -> result.items
        is AgentToolResult.DocumentBatch -> result.items
        else -> null
    }
    if (items != null) {
        return items.mapIndexed { index, item ->
            AgentToolChild(
                index = index,
                tool = fallbackTool,
                argsSummary = call.batchArgSummary(fallbackTool, index),
                result = item,
            )
        }
    }

    // Still running: no children streamed and no result yet. One pending card per input entry so
    // the batch shows N live spinners. Empty when args haven't landed yet (input_start fired,
    // tool.start hasn't) — the batch renders nothing for that brief window, like a singular card
    // whose args are still streaming.
    val argKey = if (fallbackTool == "fetch_document") "documents" else "queries"
    val entries = (call.args as? JsonObject)?.get(argKey) as? JsonArray ?: return emptyList()
    return entries.indices.map { index ->
        AgentToolChild(
            index = index,
            tool = fallbackTool,
            argsSummary = call.batchArgSummary(fallbackTool, index),
            result = null,
        )
    }
}

/**
 * The argsSummary for the i-th child of a batch call, read from the parent's raw args:
 * `queries[i].query` for search_many, `documents[i].documentId` for fetch_many. "" when the args
 * aren't present (a settled search card then falls back to its result; a settled document card
 * always shows its result's title). Mirrors the singular card's arg read.
 */
private fun AgentToolCall.batchArgSummary(childTool: String, index: Int): String {
    val obj = args as? JsonObject ?: return ""
    val (listKey, field) = if (childTool == "fetch_document") "documents" to "documentId" else "queries" to "query"
    val item = (obj[listKey] as? JsonArray)?.getOrNull(index) as? JsonObject ?: return ""
    return (item[field] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
}

// MARK: - Shared frame + rows

private const val MaxItemsToReveal = 12
private const val MaxDocLinesToReveal = 10
private const val MaxSqlRowsToReveal = 10

/**
 * The common card body: the left rail + header column, wrapped in a fade-out alpha
 * driven by the rotation. [content] receives the visible slot index. Single-stage
 * cards (search / document / people / url / trail) all share this; SQL drives its
 * own two-stage lifecycle inline.
 */
@Composable
private fun EphemeralCardFrame(
    call: AgentToolCall,
    itemCount: Int,
    onFlushEphemeral: (String) -> Unit,
    initialIndex: Int? = null,
    freeze: Boolean = false,
    content: @Composable ColumnScope.(currentIndex: Int?) -> Unit,
) {
    // Frozen (after-the-fact) cards start showing their first result immediately
    // — without this a frozen card parks the slot off-screen and renders
    // header-only (#890).
    var currentIndex by remember(call.toolCallId) {
        mutableStateOf(initialIndex ?: if (freeze) 0 else null)
    }
    var alpha by remember(call.toolCallId) { mutableStateOf(1f) }
    if (!freeze) {
        EphemeralRotation(
            toolCallId = call.toolCallId,
            hasResult = call.result != null,
            expedite = call.pendingTail.isNotEmpty(),
            count = itemCount,
            setIndex = { currentIndex = it },
            setAlpha = { alpha = it },
            onFlush = onFlushEphemeral,
        )
    }
    EphemeralDismissContainer(visible = alpha > 0f) {
        AgentInlineActivity { content(currentIndex) }
    }
}

/**
 * Wraps an ephemeral card so its dismissal both fades AND collapses its height —
 * `graphicsLayer { alpha }` alone hides the card visually but keeps its measured
 * height, leaving a blank gap above the streamed answer. The exit fade + vertical
 * shrink run over [FadeMs] (the same window the rotation waits before flushing the
 * causality gate), mirroring how iOS removes the card view on dismiss so the
 * conversation closes up behind it.
 */
@Composable
private fun EphemeralDismissContainer(visible: Boolean, content: @Composable () -> Unit) {
    AnimatedVisibility(
        visible = visible,
        enter = EnterTransition.None,
        exit = fadeOut(tween(FadeMs.toInt())) + shrinkVertically(tween(FadeMs.toInt())),
    ) {
        Box(Modifier.fillMaxWidth()) { content() }
    }
}

/**
 * A search/url result row: 11-dp source icon + 11-sp textSecondary title, and a
 * trailing "🔗 N" pill when the Cognition Steward tracks open loops this document is a
 * source for (experimental-only [AgentDocRef.openLoops]).
 */
@Composable
private fun SlotDocRow(ref: AgentDocRef, catalog: SourceCatalog) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SourceIcon(catalog.iconModel(ref.sourceId), size = 11.dp)
        Text(
            ref.title?.takeIf { it.isNotBlank() } ?: "Untitled",
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Normal,
            color = OmTheme.colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        ref.openLoops?.takeIf { it.isNotEmpty() }?.let { LoopCountChip(it.size) }
    }
}

/**
 * Inline "in N loop(s)" pill on a doc-result row — a compact accent-tinted
 * chain-link badge shown when the Cognition Steward tracks open loops this document is a
 * source for. Feeds the reader "this is part of something the agent is watching"
 * without opening the loop.
 */
@Composable
private fun LoopCountChip(count: Int) {
    Row(
        Modifier
            .clip(RoundedCornerShape(OmRadius.small))
            .background(OmTheme.colors.accent.copy(alpha = 0.12f))
            .padding(horizontal = 5.dp, vertical = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Link, null, Modifier.size(9.dp), tint = OmTheme.colors.accent)
        Text(
            "$count",
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Medium,
            color = OmTheme.colors.accent,
        )
    }
}

/** A trail-doc row — same shape as [SlotDocRow] but reading the trail doc fields. */
@Composable
private fun SlotTrailDocRow(doc: AgentTrailEventDoc, catalog: SourceCatalog) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SourceIcon(catalog.iconModel(doc.sourceId), size = 11.dp)
        Text(
            doc.title.ifBlank { "Untitled" },
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Normal,
            color = OmTheme.colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.weight(1f))
    }
}

/** Read a string arg out of the call's JSON args object, or "" when absent. */
private fun AgentToolCall.argString(key: String): String =
    (args as? JsonObject)?.get(key)?.let { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: ""

/** Compress a long string to "head…tail" so the doc-identity title fits one line. */
private fun middleTruncate(s: String, max: Int): String {
    if (s.length <= max) return s
    val keep = max - 1
    val head = (keep + 1) / 2
    val tail = keep / 2
    return s.take(head) + "…" + s.takeLast(tail)
}

// MARK: - Non-ephemeral switchboard pieces (event-trail summary / error / unknown)

/**
 * One-line fallback for `event_trail.built` results — a "trace_connections · N events"
 * badge on a faint bordered chip, hugging content width. The full typed Timeline
 * lives in the Citations drawer; this is the transcript-only summary. Mirrors iOS
 * `AgentEventTrailSummary`.
 */
@Composable
fun AgentEventTrailSummary(eventCount: Int, truncated: Boolean) {
    Row(
        Modifier
            .clip(RoundedCornerShape(OmRadius.small))
            .background(OmTheme.colors.bgTertiary.copy(alpha = 0.4f))
            .border(1.dp, OmTheme.colors.border, RoundedCornerShape(OmRadius.small))
            .padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val noun = if (eventCount == 1) "event" else "events"
        Text(
            "trace_connections · $eventCount $noun",
            style = MaterialTheme.typography.labelMedium,
            color = OmTheme.colors.textSecondary,
        )
        if (truncated) {
            Text(
                "(truncated)",
                style = MaterialTheme.typography.labelSmall.copy(fontStyle = FontStyle.Italic),
                color = OmTheme.colors.textMuted,
            )
        }
    }
}

/**
 * Collapsible tool-error notice. A one-line muted-red summary (mono code + first
 * line) on a `danger @ 0.08` chip with a 2-dp danger left rail; multi-line messages
 * expand on tap to reveal the full mono body. Mirrors iOS `AgentToolResultErrorView`.
 */
@Composable
fun AgentToolResultErrorView(code: String, message: String) {
    var expanded by remember { mutableStateOf(false) }
    val first = message.substringBefore('\n')
    val multi = message != first

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.small))
            .background(OmTheme.colors.danger.copy(alpha = 0.08f)),
    ) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(Modifier.width(2.dp).fillMaxHeight().background(OmTheme.colors.danger.copy(alpha = 0.45f)))
            Column(
                Modifier
                    .weight(1f)
                    .then(if (multi) Modifier.clickable { expanded = !expanded } else Modifier)
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        code,
                        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                        color = OmTheme.colors.danger,
                    )
                    Text(
                        first,
                        style = MaterialTheme.typography.labelMedium,
                        color = OmTheme.colors.danger,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (multi) {
                        Icon(
                            if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                            contentDescription = null,
                            tint = OmTheme.colors.danger.copy(alpha = 0.9f),
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
                if (expanded && multi) {
                    Text(
                        message,
                        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                        color = OmTheme.colors.danger.copy(alpha = 0.95f),
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }
    }
}

/**
 * Forward-compat notice for a wire result kind this client doesn't know about — a
 * one-line muted "Unknown … — update the app to view." on a faint bordered chip.
 * Mirrors iOS `AgentUnknownPartNotice`.
 */
@Composable
fun AgentUnknownPartNotice(label: String, kind: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.small))
            .background(OmTheme.colors.bgTertiary.copy(alpha = 0.4f))
            .border(1.dp, OmTheme.colors.border, RoundedCornerShape(OmRadius.small))
            .padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Outlined.HelpOutline,
            contentDescription = null,
            tint = OmTheme.colors.textMuted,
            modifier = Modifier.size(13.dp),
        )
        Text(
            "Unknown $label ($kind) — update the app to view.",
            style = MaterialTheme.typography.labelMedium,
            color = OmTheme.colors.textMuted,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
