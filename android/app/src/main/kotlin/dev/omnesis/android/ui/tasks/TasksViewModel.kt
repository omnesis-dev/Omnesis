// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.client.TaskAction
import dev.omnesis.android.transport.client.TaskView
import dev.omnesis.android.transport.dto.TaskDetailDto
import dev.omnesis.android.transport.dto.TaskDto
import dev.omnesis.android.transport.dto.TaskMutationDto
import dev.omnesis.android.transport.dto.TaskViewDto
import dev.omnesis.android.ui.common.classifyGatewayError
import java.time.LocalDate
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Narrow transport boundary, so the view model's sequencing is testable without a gateway. */
internal interface TasksGateway {
    suspend fun view(view: TaskView, date: String): TaskViewDto
    suspend fun detail(id: String): TaskDetailDto
    suspend fun act(id: String, action: TaskAction): TaskMutationDto
    suspend fun undo(seq: Long): TaskMutationDto
}

private class SessionTasksGateway(private val session: SessionManager) : TasksGateway {
    private val tasks get() = session.requireSession().tasks
    override suspend fun view(view: TaskView, date: String) = tasks.view(view, date)
    override suspend fun detail(id: String) = tasks.detail(id)
    override suspend fun act(id: String, action: TaskAction) = tasks.act(id, action)
    override suspend fun undo(seq: Long) = tasks.undo(seq)
}

/**
 * The Tasks journal. Every view is read for the phone's own local day, because the gateway
 * places carried and due tasks relative to the day it is given. Each mutation shows the
 * gateway's receipt with Undo and then re-reads the view, so what the screen shows is always
 * the gateway's account rather than a client-side guess at where a task now belongs.
 */
@HiltViewModel
class TasksViewModel internal constructor(
    private val gateway: TasksGateway,
    private val catalog: SourceCatalog? = null,
    private val countsStore: TaskCountsStore? = null,
    private val focusBus: TaskFocusBus? = null,
    private val today: () -> LocalDate,
) : ViewModel() {
    @Inject constructor(
        session: SessionManager,
        catalog: SourceCatalog,
        countsStore: TaskCountsStore,
        focusBus: TaskFocusBus,
    ) : this(SessionTasksGateway(session), catalog, countsStore, focusBus, { LocalDate.now() })

    /** A task document's source icon, resolved generically through the source catalog. */
    fun iconFor(sourceId: String): SourceIconModel = catalog?.iconModel(sourceId) ?: SourceIconModel()

    private val _state = MutableStateFlow(TasksUiState(day = today().toString()))
    val state: StateFlow<TasksUiState> = _state.asStateFlow()
    private var receiptCounter = 0L

    init {
        load()
        focusBus?.let { bus ->
            viewModelScope.launch {
                bus.request.filterNotNull().collect { request ->
                    bus.consume(request)
                    focus(request.taskId)
                }
            }
        }
    }

    /** The device's local day, as the views were last read for. */
    val localDay: LocalDate get() = LocalDate.parse(_state.value.day)

    /**
     * Each read and each command takes the next generation; a read applies only while its
     * generation is still the latest. A read that started before a command was sent can
     * otherwise land after the command's own re-read and paint the task as it was.
     */
    private var generation = 0L

    /**
     * Read the current segment. [quietly] keeps the rows on screen under the pull-to-refresh
     * indicator; otherwise an empty list shows the loading state.
     */
    fun load(quietly: Boolean = false) = read(showRefresh = quietly)

    /** Re-read after a command, keeping the rows on screen with no indicator. */
    private fun reread() = read(showRefresh = false, keepRows = true)

    private fun read(showRefresh: Boolean, keepRows: Boolean = showRefresh) {
        val day = today().toString()
        val readGeneration = ++generation
        _state.update {
            it.copy(
                day = day,
                loading = if (keepRows) it.loading else it.tasks.isEmpty(),
                refreshing = showRefresh && it.tasks.isNotEmpty(),
            )
        }
        val segment = _state.value.segment
        viewModelScope.launch {
            try {
                val view = gateway.view(segment.view, day)
                if (readGeneration != generation) return@launch
                // Every view carries the whole journal's counts, so each read — including the
                // re-read after a command — keeps the menu's count current.
                if (view.day.isEmpty() || view.day == day) countsStore?.publish(view.counts)
                _state.update { TasksReducer.viewLoaded(it, segment, view) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                if (readGeneration != generation) return@launch
                _state.update { TasksReducer.viewFailed(it, segment, error) }
            }
        }
    }

    fun select(segment: TaskSegment) {
        if (_state.value.segment == segment) return
        _state.update { TasksReducer.selectSegment(it, segment) }
        load()
    }

    /** The circle: an open task completes, a resolved one reopens — shown at once, confirmed by the gateway. */
    fun tapBullet(task: TaskDto) {
        if (task.id in _state.value.pending) return
        val action = if (task.isResolved) TaskAction.Reopen else TaskAction.Complete()
        generation++
        _state.update { TasksReducer.toggleOptimistically(it, task.id) }
        run(task, restore = task) { gateway.act(task.id, action) }
    }

    /**
     * What a target of the action fan does to its task. Done goes through the circle's path,
     * which shows the row done at once; Done + note opens the note capture; the moves and
     * Cancel task are ordinary commands, each with a receipt and Undo.
     */
    fun perform(task: TaskDto, action: TaskFanAction) {
        when (action) {
            TaskFanAction.Done -> tapBullet(task)
            TaskFanAction.DoneWithNote -> _state.update { it.copy(noting = task) }
            TaskFanAction.Tomorrow -> mutate(task, TaskAction.Migrate(TaskDates.tomorrow(localDay)))
            TaskFanAction.NextMonth -> mutate(task, TaskAction.Migrate(TaskDates.nextMonth(localDay)))
            is TaskFanAction.Month -> mutate(task, TaskAction.Migrate(action.month))
            TaskFanAction.CancelTask -> mutate(task, TaskAction.Strike())
            TaskFanAction.OtherMonth, TaskFanAction.Back, TaskFanAction.LaterMonths, TaskFanAction.EarlierMonths -> Unit
        }
    }

    /**
     * Complete [task] with the note the capture took. Returns null once the gateway accepted it,
     * or the sentence to show in the capture when it did not, so the note is never lost to a
     * refusal. Runs in the view model's scope: closing the capture does not cancel it.
     */
    suspend fun completeWithNote(task: TaskDto, note: String): String? {
        if (task.id in _state.value.pending) return null
        generation++
        _state.update { TasksReducer.begin(it, task.id) }
        return viewModelScope.async {
            try {
                val result = gateway.act(task.id, TaskAction.Complete(note))
                _state.update { TasksReducer.mutated(it, task.id, result, ++receiptCounter) }
                reread()
                null
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                val message = classifyGatewayError(error)
                _state.update { it.copy(pending = it.pending - task.id) }
                if (isRefusal(error)) reread()
                message
            }
        }.await()
    }

    fun closeNote() = _state.update { it.copy(noting = null) }

    fun confirmProposal(task: TaskDto) = mutate(task, TaskAction.Confirm)
    fun keepAsIs(task: TaskDto) = mutate(task, TaskAction.Keep)
    fun accept(task: TaskDto, scheduledFor: String?) = mutate(task, TaskAction.Accept(scheduledFor))
    fun refuse(task: TaskDto) = mutate(task, TaskAction.Refuse())

    fun saveEdit(task: TaskDto, edit: TaskAction.Edit) = mutate(task, edit)

    fun undo(receipt: TaskReceipt) {
        val seq = receipt.undoSeq ?: return
        _state.update { it.copy(receipt = null) }
        viewModelScope.launch {
            try {
                val result = gateway.undo(seq)
                _state.update { TasksReducer.undone(it, result, ++receiptCounter) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                _state.update { it.copy(actionError = classifyGatewayError(error)) }
            }
            reread()
        }
    }

    fun dismissReceipt(receipt: TaskReceipt) =
        _state.update { if (it.receipt?.id == receipt.id) it.copy(receipt = null) else it }

    fun clearActionError() = _state.update { it.copy(actionError = null) }

    /** Open a task's details: its editor, with its history a tap away. */
    fun openDetails(task: TaskDto) = _state.update { it.copy(editing = task) }
    fun closeEditor() = _state.update { it.copy(editing = null) }

    /**
     * Show one task with its details open, asked for from elsewhere in the app (a brief's task
     * chip). The task is read as it now stands, wherever it sits in the journal; one that no
     * longer exists says so instead.
     */
    fun focus(taskId: String) {
        viewModelScope.launch {
            try {
                val detail = gateway.detail(taskId)
                _state.update { it.copy(editing = detail.task, history = null) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                _state.update { it.copy(actionError = classifyGatewayError(error)) }
            }
        }
    }

    fun openHistory(task: TaskDto) {
        _state.update { it.copy(history = TaskHistoryState(task), editing = null) }
        viewModelScope.launch {
            try {
                val detail = gateway.detail(task.id)
                _state.update { current ->
                    val open = current.history?.takeIf { it.task.id == task.id } ?: return@update current
                    current.copy(history = open.copy(detail = detail, task = detail.task, loading = false))
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                _state.update { current ->
                    val open = current.history?.takeIf { it.task.id == task.id } ?: return@update current
                    current.copy(history = open.copy(loading = false, error = classifyGatewayError(error)))
                }
            }
        }
    }

    fun closeHistory() = _state.update { it.copy(history = null) }

    private fun mutate(task: TaskDto, action: TaskAction) {
        if (task.id in _state.value.pending) return
        generation++
        _state.update { TasksReducer.begin(it, task.id) }
        run(task, restore = null) { gateway.act(task.id, action) }
    }

    /**
     * Send a command, then re-read the view: one command can move a task between sections or
     * segments, and only the gateway knows where it now belongs. A refusal puts back what was
     * shown optimistically; a refusal that says the screen was stale also re-reads it.
     */
    private fun run(task: TaskDto, restore: TaskDto?, call: suspend () -> TaskMutationDto) {
        viewModelScope.launch {
            try {
                val result = call()
                _state.update { TasksReducer.mutated(it, task.id, result, ++receiptCounter) }
                reread()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                _state.update { TasksReducer.failed(it, task.id, restore, classifyGatewayError(error)) }
                if (isRefusal(error)) reread()
            }
        }
    }
}

/**
 * Whether the gateway refused a command on what it holds — the task changed elsewhere (409),
 * was already accepted or is no longer what the command expects (400, 422), or is gone (404).
 * The screen was showing something stale, so it is re-read. Authorization and transport
 * failures say nothing about the task and leave the list as it is.
 */
internal fun isRefusal(error: Throwable): Boolean = when (error) {
    is GatewayException.NotFound -> true
    is GatewayException.ServerError -> error.status in 400..499
    else -> false
}
