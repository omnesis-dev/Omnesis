// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.FieldChange
import dev.omnesis.android.transport.client.TaskAction
import dev.omnesis.android.transport.client.TaskView
import dev.omnesis.android.transport.dto.TaskCountsDto
import dev.omnesis.android.transport.dto.TaskDetailDto
import dev.omnesis.android.transport.dto.TaskDto
import dev.omnesis.android.transport.dto.TaskMutationDto
import dev.omnesis.android.transport.dto.TaskReceiptDto
import dev.omnesis.android.transport.dto.TaskViewDto

/**
 * A stand-in for the gateway's `/tasks` surface that behaves like it: it keeps its own store,
 * places each task in the journal views by its plan and deadline, applies commands to the
 * store, answers a command that no longer applies with the gateway's 400, and undoes from a
 * ledger. Reads return the store as it now is. The Android port of the iOS `TasksDemoGateway`,
 * so the interaction tests catch a screen that keeps showing a task as it was.
 */
internal class StatefulTasksGateway(tasks: List<TaskDto>, private val resolvedNow: String) : TasksGateway {
    var tasks: List<TaskDto> = tasks
        private set
    private val ledger = mutableListOf<Pair<Long, TaskDto>>()
    private var nextSeq = 100L

    /** Every command the screen sent, in order. */
    val commands = mutableListOf<Pair<String, TaskAction>>()

    /** The notes saved while accepting a suggestion with one: task id to text, by note id. */
    val notes = linkedMapOf<String, Pair<String, String>>()
    var reads = 0
        private set

    /** Change a task behind the screen's back, as another device would. */
    fun changeElsewhere(id: String, change: (TaskDto) -> TaskDto) {
        tasks = tasks.map { if (it.id == id) change(it) else it }
    }

    override suspend fun view(view: TaskView, date: String): TaskViewDto {
        reads++
        val owned = tasks.filter { !it.isResolved && isMine(it) }
        val listed = when (view) {
            TaskView.TODAY -> owned.filter { place(it, date) == TaskView.TODAY }.map { carried(it, date) } +
                tasks.filter { it.isResolved && it.resolvedAt?.take(10) == date && isMine(it) }
            TaskView.MONTH, TaskView.FUTURE, TaskView.ANYTIME -> owned.filter { place(it, date) == view }
            TaskView.WAITING -> owned.filter { it.blockedBy.isNotEmpty() }
            TaskView.SUGGESTED -> tasks.filter { it.isSuggestion && !it.isResolved }
            TaskView.DONE -> tasks.filter { it.isResolved && isMine(it) }.sortedByDescending { it.resolvedAt }
        }
        return TaskViewDto(view = view.wire, day = date, tasks = listed, counts = counts(date))
    }

    override suspend fun detail(id: String): TaskDetailDto =
        TaskDetailDto(task = tasks.firstOrNull { it.id == id } ?: throw GatewayException.NotFound("no task $id"))

    override suspend fun act(id: String, action: TaskAction): TaskMutationDto {
        val task = tasks.firstOrNull { it.id == id } ?: throw GatewayException.NotFound("no task $id")
        commands += id to action
        val (updated, verb) = when (action) {
            is TaskAction.Complete -> {
                require(!task.isResolved, "Task is already resolved")
                // A suggestion marked done is the user's, done.
                task.copy(
                    state = TaskDto.STATE_DONE,
                    accepted = true,
                    completionNote = action.note,
                    resolvedAt = resolvedNow,
                ) to "Done"
            }
            is TaskAction.Strike -> {
                require(!task.isResolved, "Task is already resolved")
                task.copy(state = TaskDto.STATE_DISMISSED, resolvedAt = resolvedNow) to "Struck"
            }
            TaskAction.Reopen -> {
                require(task.isResolved, "Task is already open")
                task.copy(state = TaskDto.STATE_OPEN, completionNote = null, resolvedAt = null) to "Reopened"
            }
            is TaskAction.Migrate -> {
                require(!task.isResolved, "Task is already resolved")
                task.copy(scheduledFor = action.to, carried = false) to "Moved"
            }
            is TaskAction.Accept -> {
                // A retry of an accept whose note was saved replays it.
                val replayed = action.noteId?.let { notes[it] }?.first == id
                if (replayed) return TaskMutationDto(task, TaskReceiptDto("Added to your tasks: ${task.title}", nextSeq))
                require(task.isSuggestion, "Task is already accepted")
                action.note?.let { note -> notes[action.noteId ?: "note-$nextSeq"] = id to note }
                task.copy(accepted = true, scheduledFor = action.scheduledFor ?: task.scheduledFor) to "Added to your tasks"
            }
            is TaskAction.Ignore -> {
                require(task.isSuggestion, "Only a suggestion can be ignored")
                task.copy(ignored = true) to "Ignored"
            }
            is TaskAction.Edit -> {
                val plan = (action.scheduledFor as? FieldChange.Set)?.value ?: task.scheduledFor
                task.copy(title = action.title ?: task.title, scheduledFor = plan) to "Edited"
            }
            TaskAction.Confirm, TaskAction.Keep, TaskAction.Delete -> task to "Updated"
        }
        ledger += ++nextSeq to task
        tasks = tasks.map { if (it.id == id) updated else it }
        return TaskMutationDto(updated, TaskReceiptDto("$verb: ${task.title}", nextSeq))
    }

    override suspend fun undo(seq: Long): TaskMutationDto {
        val entry = ledger.lastOrNull { it.first == seq }
            ?: throw GatewayException.ServerError(400, "Nothing to undo")
        ledger.remove(entry)
        val before = entry.second
        tasks = tasks.map { if (it.id == before.id) before else it }
        return TaskMutationDto(before, TaskReceiptDto("Undone: ${before.title}", null))
    }

    private fun require(condition: Boolean, message: String) {
        if (!condition) throw GatewayException.ServerError(400, message)
    }

    /** The view an open task belongs to on [day]: a deadline that has arrived brings it to today. */
    private fun place(task: TaskDto, day: String): TaskView {
        task.dueDay?.let { if (it <= day) return TaskView.TODAY }
        val plan = task.scheduledFor ?: return TaskView.ANYTIME
        if (plan == "someday") return TaskView.FUTURE
        val month = day.take(7)
        if (plan.length == 10) {
            if (plan <= day) return TaskView.TODAY
            return if (plan.startsWith(month)) TaskView.MONTH else TaskView.FUTURE
        }
        if (plan < month) return TaskView.TODAY
        return if (plan == month) TaskView.MONTH else TaskView.FUTURE
    }

    private fun carried(task: TaskDto, day: String): TaskDto {
        val plan = task.scheduledFor
        return task.copy(carried = plan != null && plan.length == 10 && plan < day)
    }

    private fun isMine(task: TaskDto): Boolean = task.origin != "brain" || task.accepted

    private fun counts(day: String): TaskCountsDto {
        val owned = tasks.filter { !it.isResolved && isMine(it) }
        val placed = owned.map { place(it, day) }
        return TaskCountsDto(
            today = placed.count { it == TaskView.TODAY },
            month = placed.count { it == TaskView.MONTH },
            future = placed.count { it == TaskView.FUTURE },
            anytime = placed.count { it == TaskView.ANYTIME },
            waiting = owned.count { it.blockedBy.isNotEmpty() },
            suggested = tasks.count { it.isSuggestion && !it.isResolved },
        )
    }
}
