// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.WbSunny
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.WbSunny
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.DailyBriefItemDto
import dev.omnesis.android.transport.dto.DailyBriefItemsDto
import dev.omnesis.android.transport.dto.DailyBriefMessageRef
import dev.omnesis.android.transport.dto.DailyBriefSourceDto
import dev.omnesis.android.transport.dto.DailyBriefTaskDto
import kotlinx.coroutines.CancellationException

/** Reads what one day's brief was based on. */
fun interface DailyBriefItemsLoader {
    suspend fun items(conversationId: String, day: String): DailyBriefItemsDto
}

/**
 * The Morning brief conversation's [DailyBriefViewState] as Compose state, with the fetches
 * that fill it. One per conversation on screen.
 */
@Stable
class DailyBriefHolder(
    val conversationId: String,
    private val loader: DailyBriefItemsLoader?,
    preloaded: List<DailyBriefItemsDto> = emptyList(),
) {
    var view: DailyBriefViewState by mutableStateOf(
        DailyBriefViewState(items = preloaded.associate { it.day to DailyBriefItemsState.Loaded(it) }),
    )
        private set

    fun observeLatest(latest: DailyBriefMessageRef?) {
        view = view.observeLatest(latest)
    }

    fun toggleDay(brief: DailyBriefMessageRef) {
        view = view.toggleDay(brief)
    }

    fun toggleFooter(brief: DailyBriefMessageRef) {
        view = view.toggleFooter(brief)
    }

    /** Fetch a day's items unless they are loaded, on their way, or failed (which waits for [retry]). */
    suspend fun load(day: String) {
        if (view.needsFetch(day)) fetch(day)
    }

    suspend fun retry(day: String) {
        if (view.items[day] == DailyBriefItemsState.Failed) fetch(day)
    }

    private suspend fun fetch(day: String) {
        val source = loader ?: return
        view = view.withItems(day, DailyBriefItemsState.Loading)
        val next = try {
            DailyBriefItemsState.Loaded(source.items(conversationId, day))
        } catch (cancellation: CancellationException) {
            // Left the screen mid-read: the next visit asks again.
            view = view.copy(items = view.items - day)
            throw cancellation
        } catch (_: Throwable) {
            DailyBriefItemsState.Failed
        }
        view = view.withItems(day, next)
    }
}

/**
 * The thin rule and centred day name above each morning brief. An earlier day's separator also
 * folds and opens the day; the latest day's does not.
 */
@Composable
fun DailyBriefDaySeparator(
    brief: DailyBriefMessageRef,
    label: String,
    spokenLabel: String,
    /** Null for the latest day, which does not fold. */
    open: Boolean?,
    onToggle: () -> Unit = {},
) {
    val c = OmTheme.colors
    val base = Modifier
        .fillMaxWidth()
        .heightIn(min = 32.dp)
        .testTag("dailyBrief.separator.${brief.day}")
    val modifier = if (open == null) {
        base.clearAndSetSemantics {
            contentDescription = spokenLabel
            heading()
        }
    } else {
        base
            .clickable(role = Role.Button, onClickLabel = if (open) "Fold this day" else "Show this day", onClick = onToggle)
            .semantics(mergeDescendants = true) {
                contentDescription = spokenLabel
                stateDescription = if (open) "Expanded" else "Collapsed"
                heading()
            }
    }
    Row(modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = c.border)
        Row(
            Modifier.padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = c.textSecondary,
            )
            if (open != null) {
                Spacer(Modifier.width(4.dp))
                Icon(
                    if (open) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown,
                    contentDescription = null,
                    tint = c.textSecondary,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
        HorizontalDivider(Modifier.weight(1f), color = c.border)
    }
}

/** An earlier day folded to one line: "Morning brief · 5 things · 2 replies". */
@Composable
fun DailyBriefFoldedRow(day: String, summary: String, onOpen: () -> Unit) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(OmRadius.large)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .clip(shape)
            .background(c.bgSecondary)
            .border(1.dp, c.borderLight, shape)
            .clickable(role = Role.Button, onClickLabel = "Show this day's brief and replies", onClick = onOpen)
            .padding(horizontal = OmSpacing.md, vertical = 10.dp)
            .testTag("dailyBrief.folded.$day"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.WbSunny, contentDescription = null, tint = c.warning, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            summary,
            style = MaterialTheme.typography.bodyMedium,
            color = c.textSecondary,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(4.dp))
        Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(18.dp))
    }
}

/** The line over a morning brief: a sun, "Morning brief" and the local time it was sent, when known. */
@Composable
fun DailyBriefHeader(time: String?) {
    val c = OmTheme.colors
    Row(
        Modifier
            .clearAndSetSemantics {
                contentDescription = time?.let { "${DailyBriefCopy.TITLE}, sent at $it" } ?: DailyBriefCopy.TITLE
            }
            .testTag("dailyBrief.header"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.WbSunny, contentDescription = null, tint = c.warning, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Text(
            DailyBriefCopy.TITLE,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            color = c.textPrimary,
        )
        if (time != null) {
            Spacer(Modifier.width(6.dp))
            Text(time, style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
        }
    }
}

/**
 * Under a brief: "Based on N things", which opens to the ranked items it was written from, each
 * with its documents and tasks. Quiet while loading, a Retry line when the read failed, and
 * nothing at all with no items.
 */
@Composable
fun DailyBriefFooter(
    day: String,
    state: DailyBriefItemsState?,
    open: Boolean,
    catalog: SourceCatalog,
    onToggle: () -> Unit,
    onRetry: () -> Unit,
    onOpenDocument: (String) -> Unit,
    onOpenTask: (String) -> Unit,
) {
    val c = OmTheme.colors
    when (state) {
        DailyBriefItemsState.Loading -> Row(verticalAlignment = Alignment.CenterVertically) {
            OmSpinner(Modifier.size(12.dp), color = c.textMuted, strokeWidth = 1.5.dp)
            Spacer(Modifier.width(8.dp))
            Text(
                "Loading what this brief was based on…",
                style = MaterialTheme.typography.bodySmall,
                color = c.textMuted,
            )
        }
        DailyBriefItemsState.Failed -> Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Couldn't load —", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            Spacer(Modifier.width(4.dp))
            Text(
                "Retry",
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.SemiBold,
                color = c.accent,
                modifier = Modifier
                    .heightIn(min = 32.dp)
                    .clickable(role = Role.Button, onClick = onRetry)
                    .padding(vertical = 8.dp)
                    .testTag("dailyBrief.retry.$day"),
            )
        }
        is DailyBriefItemsState.Loaded -> {
            val items = state.page.items.sortedBy { it.rank }
            if (items.isNotEmpty()) {
                LoadedFooter(day, items, open, catalog, onToggle, onOpenDocument, onOpenTask)
            }
        }
        null -> Unit
    }
}

@Composable
private fun LoadedFooter(
    day: String,
    items: List<DailyBriefItemDto>,
    open: Boolean,
    catalog: SourceCatalog,
    onToggle: () -> Unit,
    onOpenDocument: (String) -> Unit,
    onOpenTask: (String) -> Unit,
) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(OmRadius.large)
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        Row(
            Modifier
                .heightIn(min = 32.dp)
                .clickable(
                    role = Role.Button,
                    onClickLabel = if (open) "Hide the list" else "List what this brief was based on",
                    onClick = onToggle,
                )
                .semantics(mergeDescendants = true) { stateDescription = if (open) "Expanded" else "Collapsed" }
                .testTag("dailyBrief.footer.$day"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                DailyBriefCopy.basedOn(items.size),
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.SemiBold,
                color = c.accent,
            )
            Spacer(Modifier.width(4.dp))
            Icon(
                Icons.Outlined.KeyboardArrowDown,
                contentDescription = null,
                tint = c.accent,
                modifier = Modifier.size(16.dp).rotate(if (open) 180f else 0f),
            )
        }
        if (open) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(shape)
                    .background(c.bgSecondary)
                    .border(1.dp, c.borderLight, shape)
                    .padding(OmSpacing.md)
                    .testTag("dailyBrief.items.$day"),
                verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
            ) {
                items.forEach { item -> ItemRow(item, catalog, onOpenDocument, onOpenTask) }
            }
        }
    }
}

/** One ranked item: its sentence, then a chip for each document and task. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ItemRow(
    item: DailyBriefItemDto,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
    onOpenTask: (String) -> Unit,
) {
    val c = OmTheme.colors
    Row(verticalAlignment = Alignment.Top) {
        Text(
            "${item.rank}",
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold,
            color = c.textMuted,
            modifier = Modifier.widthIn(min = 14.dp).padding(top = 1.dp).clearAndSetSemantics { },
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            Text(
                item.summary,
                style = MaterialTheme.typography.bodyMedium,
                color = c.textPrimary,
                modifier = Modifier.semantics { contentDescription = "${item.rank}. ${item.summary}" },
            )
            if (item.sources.isNotEmpty() || item.tasks.isNotEmpty()) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    item.sources.forEach { source -> SourceChip(source, catalog, onOpenDocument) }
                    item.tasks.forEach { task -> TaskChip(task, onOpenTask) }
                }
            }
        }
    }
}

@Composable
private fun SourceChip(source: DailyBriefSourceDto, catalog: SourceCatalog, onOpen: (String) -> Unit) {
    val title = source.title?.takeIf(String::isNotBlank) ?: "Untitled document"
    BriefChip(
        title = title,
        spoken = "$title, document",
        clickLabel = "Open the document",
        tag = "dailyBrief.source.${source.id}",
        onClick = { onOpen(source.id) },
    ) {
        SourceIcon(catalog.iconModel(source.sourceType.orEmpty()), size = 13.dp)
    }
}

@Composable
private fun TaskChip(task: DailyBriefTaskDto, onOpen: (String) -> Unit) {
    val c = OmTheme.colors
    val title = task.label.ifBlank { "Untitled task" }
    BriefChip(
        title = title,
        spoken = "$title, task, ${if (task.isResolved) "done" else "open"}",
        clickLabel = "Open the task in Tasks",
        tag = "dailyBrief.task.${task.id}",
        onClick = { onOpen(task.id) },
    ) {
        Icon(
            if (task.isResolved) Icons.Filled.CheckCircle else Icons.Outlined.Circle,
            contentDescription = null,
            tint = if (task.isResolved) c.success else c.accent,
            modifier = Modifier.size(13.dp),
        )
    }
}

/** A rounded chip: a small icon, then its title, on two lines at most. */
@Composable
private fun BriefChip(
    title: String,
    spoken: String,
    clickLabel: String,
    tag: String,
    onClick: () -> Unit,
    icon: @Composable () -> Unit,
) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(50)
    Row(
        Modifier
            .heightIn(min = 32.dp)
            .clip(shape)
            .background(c.bgPrimary)
            .border(1.dp, c.border, shape)
            .clickable(role = Role.Button, onClickLabel = clickLabel, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = spoken }
            .padding(horizontal = 9.dp, vertical = 6.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(14.dp), contentAlignment = Alignment.Center) { icon() }
        Spacer(Modifier.width(5.dp))
        Text(
            title,
            style = MaterialTheme.typography.labelMedium,
            color = c.textPrimary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** The holder for [conversationId], kept while that conversation is on screen. */
@Composable
fun rememberDailyBriefHolder(
    conversationId: String,
    loader: DailyBriefItemsLoader?,
    preloaded: List<DailyBriefItemsDto> = emptyList(),
): DailyBriefHolder = remember(conversationId, loader != null) { DailyBriefHolder(conversationId, loader, preloaded) }

/** Spacing the brief's header keeps above its bubble. */
internal val DAILY_BRIEF_HEADER_GAP = 8.dp

/** The brief's own row: its header, then the brief as an ordinary assistant bubble. */
@Composable
fun DailyBriefBriefRow(time: String?, bubble: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        DailyBriefHeader(time)
        Spacer(Modifier.height(DAILY_BRIEF_HEADER_GAP))
        bubble()
    }
}

/**
 * Where the Morning brief conversation reads its items from, and what "now" is for its day
 * labels. The app derives it from the paired agent client; screenshots supply their own.
 */
data class DailyBriefContext(
    val loader: DailyBriefItemsLoader? = null,
    val now: () -> java.time.Instant = { java.time.Instant.now() },
    val zone: () -> java.time.ZoneId = { java.time.ZoneId.systemDefault() },
    /** Items already in hand, so a screenshot renders without a fetch. */
    val preloaded: List<DailyBriefItemsDto> = emptyList(),
)

/** One row of the Morning brief conversation. */
@Composable
internal fun DailyBriefRowContent(
    row: DailyBriefRow,
    holder: DailyBriefHolder,
    context: DailyBriefContext,
    catalog: SourceCatalog,
    onToggleDay: (DailyBriefMessageRef) -> Unit,
    onRetry: (String) -> Unit,
    onOpenDocument: (String) -> Unit,
    onOpenTask: (String) -> Unit,
    bubble: @Composable (AgentTurn) -> Unit,
) {
    val view = holder.view
    when (row) {
        is DailyBriefRow.Turn -> bubble(row.turn)
        is DailyBriefRow.Separator -> {
            val day = row.brief.day
            // Every day on screen reads what its brief was based on: an open day for its list,
            // a folded one for the count its line names.
            androidx.compose.runtime.LaunchedEffect(holder, day) { holder.load(day) }
            val now = context.now()
            val zone = context.zone()
            DailyBriefDaySeparator(
                brief = row.brief,
                label = DailyBriefCopy.dayLabel(day, now, zone) ?: day,
                spokenLabel = DailyBriefCopy.spokenDayLabel(day, now, zone) ?: day,
                open = if (row.foldable) row.open else null,
                onToggle = { onToggleDay(row.brief) },
            )
        }
        is DailyBriefRow.Folded -> DailyBriefFoldedRow(
            day = row.day.brief.day,
            summary = DailyBriefCopy.foldedSummary(view.itemCount(row.day.brief.day), row.day.replyCount),
            onOpen = { onToggleDay(row.day.brief) },
        )
        is DailyBriefRow.Brief -> DailyBriefBriefRow(
            time = DailyBriefCopy.sentTime(row.brief.sentAt ?: view.sentAt(row.brief.day), context.zone()),
        ) { bubble(row.turn) }
        is DailyBriefRow.Footer -> DailyBriefFooter(
            day = row.brief.day,
            state = view.items[row.brief.day],
            open = view.isFooterOpen(row.brief),
            catalog = catalog,
            onToggle = { holder.toggleFooter(row.brief) },
            onRetry = { onRetry(row.brief.day) },
            onOpenDocument = onOpenDocument,
            onOpenTask = onOpenTask,
        )
    }
}
