// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.History
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.TaskEventDto
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Which date the editor's picker is choosing, while it is open. */
private enum class PickerTarget { PLAN_DAY, DEADLINE }

/**
 * A task's details, opened by tapping its text: its title, description, when it is planned (a
 * day, a month, someday or not at all) and its deadline, then its history a tap away. Saving
 * sends only what changed, so an edit never overwrites a value it did not show differently.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskEditorContent(
    initial: TaskEditorDraft,
    onCancel: () -> Unit,
    onSave: (TaskEditorDraft) -> Unit,
    /** Opens the task's history; null (a preview) offers none. */
    onHistory: (() -> Unit)? = null,
) {
    val c = OmTheme.colors
    var draft by remember(initial) { mutableStateOf(initial) }
    var picker by remember { mutableStateOf<PickerTarget?>(null) }
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.lg)
            .navigationBarsPadding(),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onCancel) { Text("Cancel", color = c.textSecondary) }
            Text(
                "Task",
                style = MaterialTheme.typography.titleMedium,
                color = c.textPrimary,
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.Center,
            )
            TextButton(onClick = { onSave(draft) }, enabled = draft.canSave) {
                Text("Save", fontWeight = FontWeight.SemiBold)
            }
        }
        OutlinedTextField(
            value = draft.title,
            onValueChange = { draft = draft.copy(title = it) },
            label = { Text("Title") },
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(OmRadius.large),
        )
        OutlinedTextField(
            value = draft.description,
            onValueChange = { draft = draft.copy(description = it) },
            label = { Text("Details") },
            modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp),
            shape = RoundedCornerShape(OmRadius.large),
        )

        FieldLabel("When")
        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            listOf(
                TaskPlan.NONE to "Anytime",
                TaskPlan.DAY to "Day",
                TaskPlan.MONTH to "Month",
                TaskPlan.SOMEDAY to "Someday",
            ).forEach { (plan, label) ->
                ChoiceChip(label, selected = draft.plan == plan) { draft = draft.copy(plan = plan) }
            }
        }
        when (draft.plan) {
            TaskPlan.DAY -> ValueRow(
                text = dayLabel(draft.day),
                onClick = { picker = PickerTarget.PLAN_DAY },
            )
            TaskPlan.MONTH -> MonthStepper(
                month = draft.month,
                onChange = { draft = draft.copy(month = it) },
            )
            TaskPlan.NONE, TaskPlan.SOMEDAY -> Unit
        }

        FieldLabel("Deadline")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                ValueRow(
                    text = draft.deadline?.let(::dayLabel) ?: "No deadline",
                    muted = draft.deadline == null,
                    onClick = { picker = PickerTarget.DEADLINE },
                )
            }
            if (draft.deadline != null) {
                IconButton(onClick = { draft = draft.copy(deadline = null) }) {
                    Icon(Icons.Outlined.Close, contentDescription = "Remove deadline", tint = c.textSecondary)
                }
            }
        }
        if (onHistory != null) {
            HorizontalDivider(color = c.borderLight)
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable(role = Role.Button, onClick = onHistory),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.History, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(OmSpacing.sm))
                Text("History", style = MaterialTheme.typography.bodyLarge, color = c.textPrimary, modifier = Modifier.weight(1f))
                Icon(
                    Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                    contentDescription = null,
                    tint = c.textMuted,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }

    picker?.let { target ->
        val current = when (target) {
            PickerTarget.PLAN_DAY -> draft.day
            PickerTarget.DEADLINE -> draft.deadline
        }
        // The picker speaks UTC midnight; the draft speaks local calendar days.
        val pickerState = rememberDatePickerState(
            initialSelectedDateMillis = current?.let {
                LocalDate.parse(it).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
            },
        )
        DatePickerDialog(
            onDismissRequest = { picker = null },
            confirmButton = {
                TextButton(onClick = {
                    val chosen = pickerState.selectedDateMillis?.let {
                        Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString()
                    }
                    if (chosen != null) {
                        draft = when (target) {
                            PickerTarget.PLAN_DAY -> draft.copy(day = chosen)
                            PickerTarget.DEADLINE -> draft.copy(deadline = chosen)
                        }
                    }
                    picker = null
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { picker = null }) { Text("Cancel") } },
        ) {
            DatePicker(state = pickerState)
        }
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(
        text.uppercase(),
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.6.sp,
        color = OmTheme.colors.textMuted,
        modifier = Modifier.padding(top = OmSpacing.xs),
    )
}

@Composable
private fun ChoiceChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(50)
    Text(
        label,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
        color = if (selected) c.accent else c.textSecondary,
        modifier = Modifier
            .clip(shape)
            .background(if (selected) c.accent.copy(alpha = if (c.isDark) 0.18f else 0.12f) else Color.Transparent)
            .border(1.dp, if (selected) c.accent.copy(alpha = 0.5f) else c.border, shape)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 7.dp),
    )
}

@Composable
private fun ValueRow(text: String, onClick: () -> Unit, muted: Boolean = false) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(OmRadius.large)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .border(1.dp, c.border, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = OmSpacing.md, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Event, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(OmSpacing.sm))
        Text(text, style = MaterialTheme.typography.bodyLarge, color = if (muted) c.textMuted else c.textPrimary)
    }
}

@Composable
private fun MonthStepper(month: String?, onChange: (String) -> Unit) {
    val c = OmTheme.colors
    val current = month?.let { runCatching { YearMonth.parse(it) }.getOrNull() } ?: YearMonth.now()
    val shape = RoundedCornerShape(OmRadius.large)
    Row(
        Modifier.fillMaxWidth().clip(shape).border(1.dp, c.border, shape),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = { onChange(current.minusMonths(1).toString()) }) {
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, contentDescription = "Previous month", tint = c.textSecondary)
        }
        Text(
            MONTH_LABEL.format(current),
            style = MaterialTheme.typography.bodyLarge,
            color = c.textPrimary,
            modifier = Modifier.weight(1f),
            textAlign = TextAlign.Center,
        )
        IconButton(onClick = { onChange(current.plusMonths(1).toString()) }) {
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = "Next month", tint = c.textSecondary)
        }
    }
}

private val MONTH_LABEL = DateTimeFormatter.ofPattern("MMMM yyyy", Locale.ENGLISH)
private val LONG_DAY = DateTimeFormatter.ofPattern("EEEE d MMMM yyyy", Locale.ENGLISH)
private val EVENT_TIME = DateTimeFormatter.ofPattern("d MMM, HH:mm", Locale.ENGLISH)

private fun dayLabel(day: String?): String =
    day?.let { runCatching { LONG_DAY.format(LocalDate.parse(it)) }.getOrNull() } ?: "Pick a day"

/**
 * A task's history, newest first: what changed, when, and where it was changed from. A change
 * Omnesis applied on its own offers Undo on its line while it is still the newest change.
 */
@Composable
fun TaskHistoryContent(
    history: TaskHistoryState,
    zone: ZoneId = ZoneId.systemDefault(),
    onUndo: (() -> Unit)? = null,
) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.xl)
            .navigationBarsPadding(),
    ) {
        Text(
            history.task.title,
            style = MaterialTheme.typography.titleMedium,
            color = c.textPrimary,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        history.task.description?.takeIf(String::isNotBlank)?.let {
            Spacer(Modifier.height(OmSpacing.xs))
            Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
        }
        Spacer(Modifier.height(OmSpacing.lg))
        Text(
            "HISTORY",
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.6.sp,
            color = c.textMuted,
        )
        Spacer(Modifier.height(OmSpacing.sm))
        val events = history.detail?.history.orEmpty()
        when {
            history.loading -> Box(Modifier.fillMaxWidth().padding(OmSpacing.xl), contentAlignment = Alignment.Center) {
                OmSpinner(Modifier.size(24.dp), color = c.textMuted, strokeWidth = 2.dp)
            }
            history.error != null -> Text(history.error, style = MaterialTheme.typography.bodyMedium, color = c.danger)
            events.isEmpty() -> Text("No changes recorded yet.", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
            else -> events.forEachIndexed { index, event ->
                HistoryRow(event, zone, onUndo?.takeIf { event.seq == history.autoAppliedUndoSeq })
                if (index < events.lastIndex) HorizontalDivider(color = c.borderLight)
            }
        }
    }
}

@Composable
private fun HistoryRow(event: TaskEventDto, zone: ZoneId, onUndo: (() -> Unit)?) {
    val c = OmTheme.colors
    Row(Modifier.fillMaxWidth().padding(vertical = OmSpacing.sm), verticalAlignment = Alignment.Top) {
        Box(
            Modifier
                .padding(top = 7.dp)
                .size(6.dp)
                .clip(CircleShape)
                .background(if (event.surface == "brain") c.accent else c.textMuted),
        )
        Spacer(Modifier.width(OmSpacing.md))
        Column(Modifier.weight(1f)) {
            Text(taskEventTitle(event), style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
            val time = event.at?.let { runCatching { EVENT_TIME.format(Instant.parse(it).atZone(zone)) }.getOrNull() }
            Text(
                listOfNotNull(time, taskEventAttribution(event)).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
        }
        if (onUndo != null) TextButton(onClick = onUndo) { Text("Undo", color = c.accent) }
    }
}

/** How a change Omnesis applied on its own names itself. */
internal fun autoAppliedLabel(event: TaskEventDto): String =
    if (event.change == "complete") "Marked done by Omnesis" else "Updated by Omnesis"

/**
 * A history line's headline: the gateway's own note when it wrote one, else the kind. A change
 * Omnesis applied on its own leads with who made it, then its reason.
 */
internal fun taskEventTitle(event: TaskEventDto): String {
    if (event.kind == "auto_applied") {
        val label = autoAppliedLabel(event)
        return event.note?.takeIf(String::isNotBlank)?.let { "$label — $it" } ?: label
    }
    return event.note?.takeIf(String::isNotBlank) ?: when (event.kind) {
        "created" -> "Created"
        "accepted" -> "Accepted"
        "ignored" -> "Ignored"
        // Older gateways dismissed a refused suggestion.
        "refused" -> "Dismissed"
        "migrated" -> "Moved"
        "completed" -> "Done"
        "struck" -> "Struck"
        "edited" -> "Edited"
        "reopened" -> "Reopened"
        "proposal_confirmed" -> "Confirmed Omnesis's change"
        "proposal_kept" -> "Kept as is"
        "undone" -> "Undone"
        else -> "Updated"
    }
}

/** Where a history line's change came from; null when its headline already says so. */
internal fun taskEventAttribution(event: TaskEventDto): String? =
    if (event.kind == "auto_applied") null else taskEventSurface(event.surface)

/** Where a change was made, in the reader's terms; null for a surface this build does not know. */
internal fun taskEventSurface(surface: String): String? = when (surface) {
    "tasks" -> "in Tasks"
    "conversation" -> "in a conversation"
    "note" -> "from a note"
    "brain" -> "by Omnesis"
    else -> null
}
