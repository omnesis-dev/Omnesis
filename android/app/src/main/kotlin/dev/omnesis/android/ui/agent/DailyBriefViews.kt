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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ThumbDown
import androidx.compose.material.icons.filled.ThumbUp
import androidx.compose.material.icons.filled.WbSunny
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.ThumbDown
import androidx.compose.material.icons.outlined.ThumbUp
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.outlined.WbSunny
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.vector.ImageVector
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
import dev.omnesis.android.transport.dto.DailyBriefReactionDto
import dev.omnesis.android.transport.dto.DailyBriefReactionKind
import dev.omnesis.android.transport.dto.DailyBriefReactionReceiptDto
import dev.omnesis.android.transport.dto.DailyBriefSourceDto
import dev.omnesis.android.transport.dto.DailyBriefTaskDto
import dev.omnesis.android.ui.capture.TaskCompletionCapture
import dev.omnesis.android.ui.capture.TaskNoteKind
import dev.omnesis.android.ui.common.classifyGatewayError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Reads what one day's brief was based on. */
fun interface DailyBriefItemsLoader {
    suspend fun items(conversationId: String, day: String): DailyBriefItemsDto
}

/** Tells the gateway what the reader thinks of one brief item; a null [reaction] clears it. */
fun interface DailyBriefReactionSender {
    suspend fun react(
        conversationId: String,
        day: String,
        observationId: String,
        reaction: DailyBriefReactionKind?,
        note: String?,
    ): DailyBriefReactionReceiptDto
}

/**
 * Hosts the capture that takes the words behind a thumbs-down: [TaskCompletionCapture] says what
 * they are about and where they go, and the close callback runs whether they were sent or not.
 * The app supplies the Tell Omnesis screen; a test without one sends the reaction alone.
 */
typealias DailyBriefNoteCaptureHost = @Composable (capture: TaskCompletionCapture, onClose: () -> Unit) -> Unit

/**
 * The Morning brief conversation's [DailyBriefViewState] as Compose state, with the fetches
 * that fill it. One per conversation on screen.
 */
@Stable
class DailyBriefHolder(
    val conversationId: String,
    private val loader: DailyBriefItemsLoader?,
    preloaded: List<DailyBriefItemsDto> = emptyList(),
    private val reactions: DailyBriefReactionSender? = null,
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

    /**
     * Record the reader's [reaction] to one item on [day], or clear it with null. The item shows
     * the reaction at once; the gateway's answer replaces it, and a refusal puts the previous
     * reaction back and leaves its reason as the day's [DailyBriefViewState.reactionError].
     * Returns null once the gateway took it, or the sentence that says why not.
     */
    suspend fun react(
        day: String,
        observationId: String,
        reaction: DailyBriefReactionKind?,
        note: String? = null,
    ): String? {
        val sender = reactions ?: return null
        val before = view.reaction(day, observationId)
        val optimistic = reaction?.let { DailyBriefReactionDto(kind = it.wire, note = note?.trim()?.takeIf(String::isNotEmpty)) }
        view = view.withReaction(day, observationId, optimistic).copy(reactionError = null)
        return try {
            val receipt = sender.react(conversationId, day, observationId, reaction, note)
            // A later reaction on the same item has already moved on; its own answer settles it.
            if (view.reaction(day, observationId) == optimistic) view = view.withReaction(day, observationId, receipt.asReaction)
            null
        } catch (cancellation: CancellationException) {
            if (view.reaction(day, observationId) == optimistic) view = view.withReaction(day, observationId, before)
            throw cancellation
        } catch (failure: Throwable) {
            val message = "Couldn't save your reaction: ${classifyGatewayError(failure)}"
            if (view.reaction(day, observationId) == optimistic) {
                view = view.withReaction(day, observationId, before).copy(reactionError = DailyBriefReactionError(day, message))
            }
            message
        }
    }

    fun ackReactionError() {
        view = view.copy(reactionError = null)
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
    /** Sends a reaction on one of the day's items; null once it is saved, else why not. */
    onReact: suspend (observationId: String, DailyBriefReactionKind?, note: String?) -> String? = { _, _, _ -> null },
    /** The last reaction the gateway refused on this day, until dismissed. */
    reactionError: String? = null,
    onDismissReactionError: () -> Unit = {},
    noteCapture: DailyBriefNoteCaptureHost? = null,
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
                LoadedFooter(
                    day = day,
                    items = items,
                    open = open,
                    catalog = catalog,
                    onToggle = onToggle,
                    onOpenDocument = onOpenDocument,
                    onOpenTask = onOpenTask,
                    onReact = onReact,
                    reactionError = reactionError,
                    onDismissReactionError = onDismissReactionError,
                    noteCapture = noteCapture,
                )
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
    onReact: suspend (String, DailyBriefReactionKind?, String?) -> String?,
    reactionError: String?,
    onDismissReactionError: () -> Unit,
    noteCapture: DailyBriefNoteCaptureHost?,
) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(OmRadius.large)
    val scope = rememberCoroutineScope()
    // The item whose thumbs-down is being chosen, then the note capture that choice opened.
    var choosing by remember { mutableStateOf<DailyBriefItemDto?>(null) }
    var pendingNote by remember { mutableStateOf<PendingBriefNote?>(null) }

    fun send(item: DailyBriefItemDto, reaction: DailyBriefReactionKind?) {
        scope.launch { onReact(item.observationId, reaction, null) }
    }

    fun thumbsDown(item: DailyBriefItemDto, choice: DailyBriefThumbsDown) {
        val kind = choice.kind
        when (choice) {
            DailyBriefThumbsDown.NOT_INTERESTED -> send(item, kind)
            // The reaction stands on its own; the words, if any come, are added to it.
            DailyBriefThumbsDown.NOT_INTERESTED_WITH_NOTE -> {
                send(item, kind)
                if (noteCapture != null) {
                    pendingNote = PendingBriefNote(item, TaskNoteKind.NOT_INTERESTED, onCancel = {}) { words ->
                        onReact(item.observationId, kind, words)
                    }
                }
            }
            // The reaction is sent once the words are; cancelling still disputes the item,
            // without a correction.
            DailyBriefThumbsDown.FACTUAL_ERROR -> {
                if (noteCapture == null) {
                    send(item, kind)
                } else {
                    pendingNote = PendingBriefNote(item, TaskNoteKind.FACTUAL_ERROR, onCancel = { send(item, kind) }) { words ->
                        onReact(item.observationId, kind, words)
                    }
                }
            }
        }
    }

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
                items.forEach { item ->
                    ItemRow(
                        item = item,
                        catalog = catalog,
                        onOpenDocument = onOpenDocument,
                        onOpenTask = onOpenTask,
                        onThumbsUp = { send(item, if (item.reaction?.kindOrNull == DailyBriefReactionKind.UP) null else DailyBriefReactionKind.UP) },
                        onThumbsDown = { choosing = item },
                    )
                }
            }
        }
        if (reactionError != null) {
            Row(
                Modifier.fillMaxWidth().testTag("dailyBrief.reactionError.$day"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = c.warning, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    reactionError,
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textMuted,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    "Dismiss",
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.SemiBold,
                    color = c.accent,
                    modifier = Modifier
                        .heightIn(min = 32.dp)
                        .clickable(role = Role.Button, onClick = onDismissReactionError)
                        .padding(vertical = 8.dp)
                        .testTag("dailyBrief.reactionError.dismiss.$day"),
                )
            }
        }
    }

    choosing?.let { item ->
        DailyBriefThumbsDownDialog(
            initial = item.reaction?.kindOrNull?.takeIf { it != DailyBriefReactionKind.UP },
            onCancel = { choosing = null },
            onContinue = { choice ->
                choosing = null
                thumbsDown(item, choice)
            },
        )
    }
    pendingNote?.let { pending ->
        noteCapture?.invoke(pending.capture) {
            if (!pending.saved) pending.onCancel()
            pendingNote = null
        }
    }
}

/**
 * A note capture opened by a thumbs-down, with what to do when it closes unsaved. [save] sends
 * the words and answers null once they are taken; [saved] remembers that, so the close that
 * follows a successful save is not read as a cancel.
 */
private class PendingBriefNote(
    item: DailyBriefItemDto,
    kind: TaskNoteKind,
    val onCancel: () -> Unit,
    save: suspend (String) -> String?,
) {
    var saved = false
        private set
    val capture = TaskCompletionCapture(
        subject = item.summary,
        kind = kind,
        save = { words -> save(words).also { refusal -> if (refusal == null) saved = true } },
    )
}

/**
 * What a thumbs-down can say: not worth the reader's time, with or without their words on why,
 * or wrong, with the correction. [tag] names its choice in tests.
 */
enum class DailyBriefThumbsDown(val kind: DailyBriefReactionKind, val title: String, val tag: String) {
    NOT_INTERESTED(DailyBriefReactionKind.NOT_INTERESTED, DailyBriefCopy.NOT_INTERESTED_CHOICE, "not_interested"),
    NOT_INTERESTED_WITH_NOTE(
        DailyBriefReactionKind.NOT_INTERESTED,
        DailyBriefCopy.NOT_INTERESTED_NOTE_CHOICE,
        "not_interested_note",
    ),
    FACTUAL_ERROR(DailyBriefReactionKind.FACTUAL_ERROR, DailyBriefCopy.FACTUAL_ERROR_CHOICE, "factual_error"),
}

/**
 * The choice behind a thumbs-down. Continue hands the choice back; the caller sends it and,
 * when the choice asks for them, the words.
 */
@Composable
fun DailyBriefThumbsDownDialog(
    initial: DailyBriefReactionKind?,
    onCancel: () -> Unit,
    onContinue: (DailyBriefThumbsDown) -> Unit,
) {
    val c = OmTheme.colors
    var choice by remember {
        mutableStateOf(
            when (initial) {
                DailyBriefReactionKind.FACTUAL_ERROR -> DailyBriefThumbsDown.FACTUAL_ERROR
                else -> DailyBriefThumbsDown.NOT_INTERESTED
            },
        )
    }
    AlertDialog(
        onDismissRequest = onCancel,
        containerColor = c.bgSecondary,
        modifier = Modifier.testTag("dailyBrief.thumbsDownDialog"),
        title = { Text(DailyBriefCopy.THUMBS_DOWN_TITLE, color = c.textPrimary) },
        text = {
            Column {
                DailyBriefThumbsDown.entries.forEach { option ->
                    ThumbsDownChoice(option, selected = choice == option, onSelect = { choice = option })
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onContinue(choice) }, modifier = Modifier.testTag("dailyBrief.thumbsDownContinue")) {
                Text("Continue", color = c.accent)
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel, modifier = Modifier.testTag("dailyBrief.thumbsDownCancel")) {
                Text("Cancel", color = c.accent)
            }
        },
    )
}

@Composable
private fun ThumbsDownChoice(option: DailyBriefThumbsDown, selected: Boolean, onSelect: () -> Unit) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .selectable(selected, role = Role.RadioButton, onClick = onSelect)
            .padding(vertical = OmSpacing.xs)
            .testTag("dailyBrief.thumbsDownChoice.${option.tag}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected, onClick = null)
        Spacer(Modifier.width(OmSpacing.sm))
        Text(option.title, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
    }
}

/**
 * One ranked item: its sentence, a chip for each document and task, then a thumbs up and down
 * with the word for a thumbs-down beside them once one is given.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ItemRow(
    item: DailyBriefItemDto,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
    onOpenTask: (String) -> Unit,
    onThumbsUp: () -> Unit,
    onThumbsDown: () -> Unit,
) {
    val c = OmTheme.colors
    val kind = item.reaction?.kindOrNull
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                ReactionButton(
                    selected = kind == DailyBriefReactionKind.UP,
                    outlined = Icons.Outlined.ThumbUp,
                    filled = Icons.Filled.ThumbUp,
                    description = DailyBriefCopy.THUMBS_UP,
                    tag = "dailyBrief.thumbsUp.${item.observationId}",
                    onClick = onThumbsUp,
                )
                Spacer(Modifier.width(2.dp))
                ReactionButton(
                    selected = kind == DailyBriefReactionKind.NOT_INTERESTED || kind == DailyBriefReactionKind.FACTUAL_ERROR,
                    outlined = Icons.Outlined.ThumbDown,
                    filled = Icons.Filled.ThumbDown,
                    description = DailyBriefCopy.THUMBS_DOWN,
                    tag = "dailyBrief.thumbsDown.${item.observationId}",
                    onClick = onThumbsDown,
                )
                DailyBriefCopy.reactionCaption(kind)?.let { caption ->
                    Spacer(Modifier.width(4.dp))
                    Text(
                        caption,
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.testTag("dailyBrief.reactionCaption.${item.observationId}"),
                    )
                }
            }
        }
    }
}

/** A small thumb: outlined until chosen, filled in the accent once it is. */
@Composable
private fun ReactionButton(
    selected: Boolean,
    outlined: ImageVector,
    filled: ImageVector,
    description: String,
    tag: String,
    onClick: () -> Unit,
) {
    val c = OmTheme.colors
    Box(
        Modifier
            .size(32.dp)
            .clip(RoundedCornerShape(50))
            .selectable(selected, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description }
            .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            if (selected) filled else outlined,
            contentDescription = null,
            tint = if (selected) c.accent else c.textMuted,
            modifier = Modifier.size(16.dp),
        )
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
    reactions: DailyBriefReactionSender? = null,
): DailyBriefHolder = remember(conversationId, loader != null, reactions != null) {
    DailyBriefHolder(conversationId, loader, preloaded, reactions)
}

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
    /** Where reactions go; null leaves the thumbs on screen but inert. */
    val reactions: DailyBriefReactionSender? = null,
    /** The capture that takes the words behind a thumbs-down; null sends the reaction alone. */
    val noteCapture: DailyBriefNoteCaptureHost? = null,
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
            LaunchedEffect(holder, day) { holder.load(day) }
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
        is DailyBriefRow.Folded -> {
            val day = row.day.brief.day
            // A folded line can scroll into view ahead of its separator; it reads the count it
            // names itself rather than waiting for the separator to.
            LaunchedEffect(holder, day) { holder.load(day) }
            DailyBriefFoldedRow(
                day = day,
                summary = DailyBriefCopy.foldedSummary(view.itemCount(day), row.day.replyCount),
                onOpen = { onToggleDay(row.day.brief) },
            )
        }
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
            onReact = { observationId, reaction, note -> holder.react(row.brief.day, observationId, reaction, note) },
            reactionError = view.reactionError?.takeIf { it.day == row.brief.day }?.message,
            onDismissReactionError = holder::ackReactionError,
            noteCapture = context.noteCapture,
        )
    }
}
