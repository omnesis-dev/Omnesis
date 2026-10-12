// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import dev.omnesis.android.transport.client.FieldChange
import dev.omnesis.android.transport.client.TaskAction
import dev.omnesis.android.transport.client.TaskDeadlineInput
import dev.omnesis.android.transport.client.TaskView
import dev.omnesis.android.transport.dto.TaskCountsDto
import dev.omnesis.android.transport.dto.TaskDetailDto
import dev.omnesis.android.transport.dto.TaskDocumentDto
import dev.omnesis.android.transport.dto.TaskDto
import dev.omnesis.android.transport.dto.TaskMutationDto
import dev.omnesis.android.transport.dto.TaskViewDto
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.temporal.TemporalAdjusters
import java.util.Locale

/**
 * The journal's segments, in the order the screen offers them. [experimental] marks a segment
 * that only exists while the gateway runs in experimental mode: Suggested holds the Brain's
 * suggestions, and the Brain only runs there.
 */
enum class TaskSegment(val label: String, val view: TaskView, val experimental: Boolean = false) {
    TODAY("Today", TaskView.TODAY),
    MONTH("Month", TaskView.MONTH),
    FUTURE("Future", TaskView.FUTURE),
    ANYTIME("Anytime", TaskView.ANYTIME),
    WAITING("Waiting", TaskView.WAITING),
    SUGGESTED("Suggested", TaskView.SUGGESTED, experimental = true),
    DONE("Done", TaskView.DONE),
    ;

    /**
     * How many open tasks this segment's tab names, from the gateway's counts. Suggested shows
     * its count as a badge instead, and Done counts nothing: a finished task needs no attention.
     */
    fun count(counts: TaskCountsDto): Int = when (this) {
        TODAY -> counts.today
        MONTH -> counts.month
        FUTURE -> counts.future
        ANYTIME -> counts.anytime
        WAITING -> counts.waiting
        SUGGESTED, DONE -> 0
    }

    /** The tab's label: "Today (4)" while it holds open tasks, plain "Today" otherwise. */
    fun tabLabel(counts: TaskCountsDto): String = count(counts).let { if (it > 0) "$label ($it)" else label }

    companion object {
        /** The segments the strip offers, given whether the gateway is in experimental mode. */
        fun visible(experimental: Boolean): List<TaskSegment> = entries.filter { experimental || !it.experimental }
    }
}

/**
 * The one-tap "move it" targets, computed from the device's local day. Weekends are not
 * special: next week is simply the next Monday.
 */
object TaskDates {
    private val MONTH_LABEL = DateTimeFormatter.ofPattern("MMMM yyyy", Locale.ENGLISH)
    private val DAY_LABEL = DateTimeFormatter.ofPattern("EEE d MMM", Locale.ENGLISH)

    fun tomorrow(today: LocalDate): String = today.plusDays(1).toString()

    /** The Monday after [today], even when today is a Sunday or a Monday. */
    fun nextWeek(today: LocalDate): String =
        today.with(TemporalAdjusters.next(DayOfWeek.MONDAY)).toString()

    /** `YYYY-MM` of the month after [today]'s. */
    fun nextMonth(today: LocalDate): String = YearMonth.from(today).plusMonths(1).toString()

    /**
     * How a schedule or due day reads on a row, relative to [today]: "Today", "Tomorrow",
     * "Tue 13 Oct", "November 2026", "Someday". Null for nothing to say or a value this build
     * cannot read.
     */
    fun describe(schedule: String?, today: LocalDate): String? {
        if (schedule.isNullOrBlank()) return null
        if (schedule == SOMEDAY) return "Someday"
        return try {
            when (schedule.length) {
                10 -> {
                    val day = LocalDate.parse(schedule)
                    when (day) {
                        today -> "Today"
                        today.plusDays(1) -> "Tomorrow"
                        today.minusDays(1) -> "Yesterday"
                        else -> DAY_LABEL.format(day)
                    }
                }
                7 -> {
                    val month = YearMonth.parse(schedule)
                    if (month == YearMonth.from(today)) "This month" else MONTH_LABEL.format(month)
                }
                else -> null
            }
        } catch (_: DateTimeParseException) {
            null
        }
    }

    const val SOMEDAY = "someday"
}

/**
 * One line of a segment's list: a section heading or a task. The screen renders the segment as
 * this one list rather than a list per section, keyed by [key]: a task keeps its key whichever
 * section it is in, so completing a planned task (which moves it to "Done today") is the same
 * line moving and redrawing, never a new line beside a stale one.
 */
sealed interface TaskJournalEntry {
    val key: String

    data class Heading(val section: String, val title: String, val count: Int) : TaskJournalEntry {
        override val key: String get() = "heading:$section"
    }

    data class Task(val task: TaskDto) : TaskJournalEntry {
        override val key: String get() = taskEntryKey(task.id)
    }
}

/** A task line's key in the journal list. */
fun taskEntryKey(taskId: String) = "task:$taskId"

/** A mutation the user can still take back, shown as a toast with Undo. */
data class TaskReceipt(
    /** Distinguishes two receipts with the same text, so each restarts the toast's timer. */
    val id: Long,
    val text: String,
    val undoSeq: Long?,
)

/** A task's history, opened from its details. */
data class TaskHistoryState(
    val task: TaskDto,
    val detail: TaskDetailDto? = null,
    val loading: Boolean = true,
    val error: String? = null,
)

data class TasksUiState(
    val segment: TaskSegment = TaskSegment.TODAY,
    /** The device's local day the views are read for (`YYYY-MM-DD`). */
    val day: String = "",
    val tasks: List<TaskDto> = emptyList(),
    val counts: TaskCountsDto = TaskCountsDto(),
    /** True until the current segment's first answer. */
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val loadError: Throwable? = null,
    /** Tasks with a request in flight, whose actions are disabled until it settles. */
    val pending: Set<String> = emptySet(),
    val receipt: TaskReceipt? = null,
    /** A mutation the gateway refused, said once and then cleared. */
    val actionError: String? = null,
    /** The task whose details (the editor) are open, if any. */
    val editing: TaskDto? = null,
    val history: TaskHistoryState? = null,
    /** The task a "Done + note" capture is open for, if any. */
    val noting: TaskDto? = null,
) {
    val entries: List<TaskJournalEntry> get() = TasksReducer.entries(segment, tasks)
}

/**
 * The pure state transitions behind the Tasks screen, kept free of coroutines and transport so
 * every rule is unit-testable on the JVM. The gateway stays authoritative: each mutation applies
 * its returned task in place for immediate feedback, and the screen then re-reads the view.
 */
object TasksReducer {

    /**
     * Today reads like the day's page of a bullet journal: what was carried over from earlier
     * days first, then what is planned or due today, then what got resolved today. Every other
     * segment is one run in the gateway's order. Empty sections are dropped, and Today's own
     * rows need no heading when nothing else is on the page.
     */
    fun entries(segment: TaskSegment, tasks: List<TaskDto>): List<TaskJournalEntry> {
        if (segment != TaskSegment.TODAY) return tasks.map { TaskJournalEntry.Task(it) }
        val carried = tasks.filter { !it.isResolved && it.carried }
        val planned = tasks.filter { !it.isResolved && !it.carried }
        val resolved = tasks.filter { it.isResolved }
        val sections = listOf(
            Triple("carried", "Carried over", carried),
            Triple("today", if (carried.isEmpty() && resolved.isEmpty()) null else "Today", planned),
            Triple("resolved", "Done today", resolved),
        )
        return sections.filter { it.third.isNotEmpty() }.flatMap { (id, title, rows) ->
            val heading = title?.let { listOf(TaskJournalEntry.Heading(id, it, rows.size)) }.orEmpty()
            heading + rows.map { TaskJournalEntry.Task(it) }
        }
    }

    /** Switch segment: the list empties and loads. */
    fun selectSegment(state: TasksUiState, segment: TaskSegment): TasksUiState =
        if (state.segment == segment) {
            state
        } else {
            state.copy(segment = segment, tasks = emptyList(), loading = true, refreshing = false, loadError = null)
        }

    /**
     * A view arrived. Ignored when it answers a segment or day the screen has since left, so a
     * slow reply never paints one segment's tasks under another's label.
     */
    fun viewLoaded(state: TasksUiState, segment: TaskSegment, view: TaskViewDto): TasksUiState {
        if (segment != state.segment || (view.day.isNotEmpty() && view.day != state.day)) return state
        return state.copy(tasks = view.tasks, counts = view.counts, loading = false, refreshing = false, loadError = null)
    }

    fun viewFailed(state: TasksUiState, segment: TaskSegment, error: Throwable): TasksUiState =
        if (segment != state.segment) state else state.copy(loading = false, refreshing = false, loadError = error)

    /**
     * The circle: an open task shows done and a resolved one shows open at once — the one
     * gesture that has to feel instant. The request confirms it, and a refusal puts the task
     * back with [failed].
     */
    fun toggleOptimistically(state: TasksUiState, taskId: String): TasksUiState = state.copy(
        tasks = state.tasks.map { task ->
            when {
                task.id != taskId -> task
                task.isResolved -> task.copy(state = TaskDto.STATE_OPEN, completionNote = null)
                else -> task.copy(state = TaskDto.STATE_DONE)
            }
        },
        pending = state.pending + taskId,
        actionError = null,
    )

    fun begin(state: TasksUiState, taskId: String): TasksUiState =
        state.copy(pending = state.pending + taskId, actionError = null)

    /**
     * A mutation succeeded: the returned task replaces the row (or the row goes, when the task
     * is gone), and the receipt becomes the undo toast. A suggestion answered from Suggested
     * leaves that list at once — suggestions appear nowhere else, so a row that is no longer
     * one has no place there, and its Accept can never linger.
     */
    fun mutated(
        state: TasksUiState,
        taskId: String,
        mutation: TaskMutationDto,
        receiptId: Long,
    ): TasksUiState {
        val updated = mutation.task
        val tasks = when {
            updated == null -> state.tasks.filterNot { it.id == taskId }
            state.segment == TaskSegment.SUGGESTED && (!updated.isSuggestion || updated.isResolved) ->
                state.tasks.filterNot { it.id == taskId }
            else -> state.tasks.map { if (it.id == taskId) updated else it }
        }
        return state.copy(
            tasks = tasks,
            pending = state.pending - taskId,
            receipt = receiptFor(mutation, receiptId),
            editing = state.editing?.takeUnless { it.id == taskId },
        )
    }

    /** A mutation was refused: the row returns to [restore] and the reason is said once. */
    fun failed(state: TasksUiState, taskId: String, restore: TaskDto?, message: String): TasksUiState =
        state.copy(
            tasks = if (restore == null) {
                state.tasks
            } else {
                state.tasks.map { if (it.id == taskId) restore else it }
            },
            pending = state.pending - taskId,
            actionError = message,
        )

    /** An undo went through: its receipt says so, with nothing further to undo. */
    fun undone(state: TasksUiState, mutation: TaskMutationDto, receiptId: Long): TasksUiState =
        state.copy(receipt = receiptFor(mutation, receiptId)?.copy(undoSeq = null))

    private fun receiptFor(mutation: TaskMutationDto, receiptId: Long): TaskReceipt? =
        mutation.receipt.text.takeIf(String::isNotBlank)?.let {
            TaskReceipt(id = receiptId, text = it, undoSeq = mutation.receipt.undoSeq)
        }
}

/**
 * Today's footer banner, pointing at the Brain's suggestions: shown only where the Suggested
 * segment exists and something waits there.
 */
fun suggestionsBannerText(count: Int, experimental: Boolean): String? = when {
    !experimental || count <= 0 -> null
    count == 1 -> "Omnesis has created 1 task for your review"
    else -> "Omnesis has created $count tasks for your review"
}

/**
 * Whether a segment ends with the reminder that tasks are added through Tell Omnesis. Suggested
 * and Done hold what Omnesis or the past put there, so the reminder answers nothing there.
 */
fun showsCaptureHint(segment: TaskSegment): Boolean =
    segment != TaskSegment.SUGGESTED && segment != TaskSegment.DONE

/** Whether a long press on [task]'s row opens the action fan: the user's own open tasks. */
fun hasActionFan(task: TaskDto): Boolean = !task.isResolved && !task.isSuggestion

/** How the editor plans a task: not at all, on a day, in a month, or someday. */
enum class TaskPlan { NONE, DAY, MONTH, SOMEDAY }

/**
 * The editor's working copy of a task. [toEdit] sends only what changed, so saving an editor
 * the user did not touch is a no-op rather than an edit that rewrites every field.
 */
data class TaskEditorDraft(
    val title: String,
    val description: String,
    val plan: TaskPlan,
    /** `YYYY-MM-DD` when [plan] is [TaskPlan.DAY]. */
    val day: String?,
    /** `YYYY-MM` when [plan] is [TaskPlan.MONTH]. */
    val month: String?,
    /** The deadline day (`YYYY-MM-DD`), or null for none. */
    val deadline: String?,
) {
    /** The `scheduledFor` value this draft stands for. */
    val schedule: String?
        get() = when (plan) {
            TaskPlan.NONE -> null
            TaskPlan.DAY -> day
            TaskPlan.MONTH -> month
            TaskPlan.SOMEDAY -> TaskDates.SOMEDAY
        }

    val canSave: Boolean
        get() = title.isNotBlank() &&
            (plan != TaskPlan.DAY || day != null) &&
            (plan != TaskPlan.MONTH || month != null)

    /** The edit that turns [original] into this draft, or null when nothing changed. */
    fun toEdit(original: TaskDto): TaskAction.Edit? {
        val newTitle = title.trim().takeIf { it != original.title }
        val newDescription = description.takeIf { it != original.description.orEmpty() }
        val planned = schedule
        val scheduleChange = when {
            planned == original.scheduledFor -> FieldChange.Keep
            planned == null -> FieldChange.Clear
            else -> FieldChange.Set(planned)
        }
        val due = deadline
        val deadlineChange = when {
            due == original.dueDay -> FieldChange.Keep
            due == null -> FieldChange.Clear
            else -> FieldChange.Set(TaskDeadlineInput.by(due))
        }
        if (newTitle == null && newDescription == null &&
            scheduleChange == FieldChange.Keep && deadlineChange == FieldChange.Keep
        ) {
            return null
        }
        return TaskAction.Edit(
            title = newTitle,
            description = newDescription,
            scheduledFor = scheduleChange,
            deadline = deadlineChange,
        )
    }

    companion object {
        fun from(task: TaskDto, today: LocalDate): TaskEditorDraft {
            val schedule = task.scheduledFor
            val plan = when {
                schedule == null -> TaskPlan.NONE
                schedule == TaskDates.SOMEDAY -> TaskPlan.SOMEDAY
                schedule.length == 7 -> TaskPlan.MONTH
                else -> TaskPlan.DAY
            }
            return TaskEditorDraft(
                title = task.title,
                description = task.description.orEmpty(),
                plan = plan,
                day = schedule?.takeIf { plan == TaskPlan.DAY } ?: today.toString(),
                month = schedule?.takeIf { plan == TaskPlan.MONTH } ?: YearMonth.from(today).toString(),
                deadline = task.dueDay,
            )
        }
    }
}

/** The documents a task's row lists, and how many it holds back behind "+N more". */
data class TaskDocumentsShown(val shown: List<TaskDocumentDto>, val hidden: Int)

/** How many of a task's documents its row lists before "+N more". */
const val TASK_DOCUMENTS_SHOWN = 3

/**
 * All of a task's documents once the user asked for more, otherwise the first few. Holding
 * back a single document would take as much room as listing it, so a list one longer than the
 * limit is shown whole.
 */
fun taskDocumentsShown(documents: List<TaskDocumentDto>, showAll: Boolean): TaskDocumentsShown =
    if (showAll || documents.size <= TASK_DOCUMENTS_SHOWN + 1) {
        TaskDocumentsShown(documents, 0)
    } else {
        TaskDocumentsShown(documents.take(TASK_DOCUMENTS_SHOWN), documents.size - TASK_DOCUMENTS_SHOWN)
    }
