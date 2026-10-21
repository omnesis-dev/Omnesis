// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircleOutline
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Snooze
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.TaskDto
import dev.omnesis.android.transport.dto.TaskOriginSnapshot
import dev.omnesis.android.transport.dto.WatchFiringOriginSnapshot
import dev.omnesis.android.ui.common.TimeFormat
import dev.omnesis.android.ui.tasks.TaskDates
import dev.omnesis.android.ui.tasks.inlinePhrase
import java.time.LocalDate

/**
 * The card pinned above an anchored thread's messages, saying what the thread is about.
 *
 * A watch-firing thread opens with the creating run's folded transcript —
 * the agent's own context, not something the user wrote — which the gateway hides. This card
 * takes its place, so the thread reads as a reply to a specific thing rather than as a chat
 * that mysteriously begins mid-conversation. A task thread ("Chat about this") has no seed: its
 * card says which task the chat is about, from the snapshot taken when it was opened. Draws
 * nothing for an origin this build does not recognise, which is the same condition under which
 * the seeded prefix stays visible.
 *
 * [today] places a task's due day ("Due tomorrow").
 */
@Composable
fun ConversationOriginCard(
    origin: ConversationOrigin?,
    modifier: Modifier = Modifier,
    onOpenWatch: ((String) -> Unit)? = null,
    onOpenTask: ((String) -> Unit)? = null,
    today: LocalDate = LocalDate.now(),
) {
    // Gated on the same predicate that decides whether the seeded prefix may be hidden. The two
    // must never disagree: hiding the prefix while drawing nothing leaves an empty screen.
    if (!hasContextCard(origin)) return
    when (origin?.kind) {
        "watch_firing" -> origin.watch?.let { snapshot ->
            val watchId = origin.watchId?.takeIf(String::isNotBlank)
            WatchFiringContextCard(
                snapshot = snapshot,
                modifier = modifier,
                onOpen = if (watchId != null && onOpenWatch != null) {
                    { onOpenWatch(watchId) }
                } else {
                    null
                },
            )
        }
        ConversationOrigin.TASK_KIND -> origin.task?.let { snapshot ->
            val taskId = origin.taskId?.takeIf(String::isNotBlank)
            TaskContextCard(
                snapshot = snapshot,
                today = today,
                modifier = modifier,
                onOpen = if (taskId != null && onOpenTask != null) {
                    { onOpenTask(taskId) }
                } else {
                    null
                },
            )
        }
    }
}

@Composable
private fun WatchFiringContextCard(
    snapshot: WatchFiringOriginSnapshot,
    modifier: Modifier = Modifier,
    onOpen: (() -> Unit)? = null,
) {
    val c = OmTheme.colors
    val cardModifier = if (onOpen == null) {
        modifier.semantics(mergeDescendants = true) {}
    } else {
        modifier
            .clickable(
                onClickLabel = "Open watch details",
                role = Role.Button,
                onClick = onOpen,
            )
            .semantics(mergeDescendants = true) {}
    }
    OriginCardFrame(cardModifier) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OriginCardKicker(Icons.Outlined.NotificationsActive, "Watch fired")
            if (onOpen != null) OriginCardLink("View watch", Modifier.weight(1f))
        }
        Text(
            snapshot.name,
            fontSize = 20.sp,
            lineHeight = 26.sp,
            fontWeight = FontWeight.Bold,
            color = c.textPrimary,
        )
        // A heading rather than a sentence stem: the condition is quoted verbatim in the
        // operator's own words, often first person, so "you asked to be told when…" would
        // clash on person.
        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            Text(
                "WATCHING FOR",
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.5.sp,
                color = c.textSecondary.copy(alpha = 0.7f),
            )
            Text(
                snapshot.condition,
                fontSize = 14.sp,
                lineHeight = 20.sp,
                color = c.textSecondary,
            )
        }
        OriginCardFact(Icons.Outlined.Schedule, TimeFormat.dateTime(snapshot.firedAt))
    }
}

/**
 * The task a "Chat about this" conversation is about: its title, and what state it was in, when
 * it is due and how many documents it refers to, as they were when the chat was opened. The
 * agent reads the task as it now stands with every reply, which the card's last line says.
 * Tapping it opens the task.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TaskContextCard(
    snapshot: TaskOriginSnapshot,
    today: LocalDate,
    modifier: Modifier = Modifier,
    onOpen: (() -> Unit)? = null,
) {
    val c = OmTheme.colors
    val cardModifier = if (onOpen == null) {
        modifier.semantics(mergeDescendants = true) {}
    } else {
        modifier
            .clickable(
                onClickLabel = "Open the task",
                role = Role.Button,
                onClick = onOpen,
            )
            .semantics(mergeDescendants = true) {}
    }
    OriginCardFrame(cardModifier.testTag("agent.origin.task")) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OriginCardKicker(Icons.Outlined.TaskAlt, "Task")
            if (onOpen != null) OriginCardLink("View task", Modifier.weight(1f))
        }
        Text(
            snapshot.title,
            fontSize = 20.sp,
            lineHeight = 26.sp,
            fontWeight = FontWeight.Bold,
            color = c.textPrimary,
        )
        val facts = taskOriginFacts(snapshot, today)
        if (facts.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.md),
                verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
            ) {
                facts.forEach { fact -> OriginCardFact(fact.icon.vector, fact.text, danger = fact.overdue) }
            }
        }
        Text(
            "Omnesis reads this task's notes, history and sources with each reply.",
            fontSize = 13.sp,
            lineHeight = 18.sp,
            color = c.textMuted,
        )
    }
}

/** One fact on a task card. [overdue] marks a due day that has passed on a task still open. */
internal data class TaskOriginFact(val icon: TaskOriginFactIcon, val text: String, val overdue: Boolean = false)

internal enum class TaskOriginFactIcon(val vector: ImageVector) {
    OPEN(Icons.Outlined.RadioButtonUnchecked),
    SNOOZED(Icons.Outlined.Snooze),
    DONE(Icons.Outlined.CheckCircleOutline),
    STRUCK(Icons.Outlined.Close),
    DUE(Icons.Outlined.Flag),
    SOURCES(Icons.Outlined.Description),
}

/**
 * The facts under a task card's title: the task's state in the words its history uses, when it
 * is due relative to [today] (overdue while the task is unresolved), and how many documents it
 * refers to. A state this build does not know reads as the gateway spelled it; a due day it
 * cannot read and a count of none are left out.
 */
internal fun taskOriginFacts(snapshot: TaskOriginSnapshot, today: LocalDate): List<TaskOriginFact> = buildList {
    val state = snapshot.state.trim()
    when (state) {
        "" -> Unit
        TaskDto.STATE_OPEN -> add(TaskOriginFact(TaskOriginFactIcon.OPEN, "Open"))
        "snoozed" -> add(TaskOriginFact(TaskOriginFactIcon.SNOOZED, "Snoozed"))
        TaskDto.STATE_DONE -> add(TaskOriginFact(TaskOriginFactIcon.DONE, "Done"))
        TaskDto.STATE_DISMISSED -> add(TaskOriginFact(TaskOriginFactIcon.STRUCK, "Struck"))
        else -> add(TaskOriginFact(TaskOriginFactIcon.OPEN, state.replaceFirstChar { it.uppercase() }))
    }
    TaskDates.describe(snapshot.due, today)?.let { phrase ->
        val resolved = state == TaskDto.STATE_DONE || state == TaskDto.STATE_DISMISSED
        val overdue = !resolved && snapshot.due.orEmpty().let { it.length == 10 && it < today.toString() }
        add(TaskOriginFact(TaskOriginFactIcon.DUE, "Due ${inlinePhrase(phrase)}", overdue))
    }
    val count = snapshot.sourceCount
    if (count > 0) add(TaskOriginFact(TaskOriginFactIcon.SOURCES, if (count == 1) "1 source" else "$count sources"))
}

@Composable
private fun OriginCardFact(icon: ImageVector, text: String, danger: Boolean = false) {
    val c = OmTheme.colors
    val tint = if (danger) c.danger else c.textSecondary
    Row(
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(14.dp))
        Text(text, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = tint)
    }
}

/** The trailing "View …" affordance of a card that opens what it is about. */
@Composable
private fun OriginCardLink(label: String, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = c.accent)
        Icon(
            Icons.Outlined.ChevronRight,
            contentDescription = null,
            tint = c.accent,
            modifier = Modifier.size(14.dp),
        )
    }
}

@Composable
private fun OriginCardFrame(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = OmTheme.colors
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(OmRadius.large))
            .border(1.dp, c.border, RoundedCornerShape(OmRadius.large))
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
        content = content,
    )
}

@Composable
private fun OriginCardKicker(icon: ImageVector, label: String) {
    val c = OmTheme.colors
    Row(
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = c.accent, modifier = Modifier.size(13.dp))
        Text(
            label.uppercase(),
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.6.sp,
            color = c.accent,
        )
    }
}
