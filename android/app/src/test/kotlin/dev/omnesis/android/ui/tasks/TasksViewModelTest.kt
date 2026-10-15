// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.TaskAction
import dev.omnesis.android.transport.client.TaskView
import dev.omnesis.android.transport.dto.TaskCountsDto
import dev.omnesis.android.transport.dto.TaskDetailDto
import dev.omnesis.android.transport.dto.TaskDto
import dev.omnesis.android.transport.dto.TaskMutationDto
import dev.omnesis.android.transport.dto.TaskReceiptDto
import dev.omnesis.android.transport.dto.TaskViewDto
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The view model's sequencing against a scripted gateway. All fixture data is invented. */
@OptIn(ExperimentalCoroutinesApi::class)
class TasksViewModelTest {

    private class FakeGateway : TasksGateway {
        val views = mutableListOf<Pair<TaskView, String>>()
        val actions = mutableListOf<Pair<String, TaskAction>>()
        val undone = mutableListOf<Long>()
        var tasks = listOf(TaskDto(id = "a", title = "Water the plants", scheduledFor = "2026-10-12"))
        var failNextAction: Throwable? = null
        var counts = TaskCountsDto(today = 1)

        override suspend fun view(view: TaskView, date: String): TaskViewDto {
            views += view to date
            return TaskViewDto(view = view.wire, day = date, tasks = tasks, counts = counts)
        }

        override suspend fun detail(id: String) = TaskDetailDto(task = tasks.first { it.id == id })

        override suspend fun act(id: String, action: TaskAction): TaskMutationDto {
            failNextAction?.let { failNextAction = null; throw it }
            actions += id to action
            return TaskMutationDto(tasks.first { it.id == id }, TaskReceiptDto("Done", 9))
        }

        override suspend fun undo(seq: Long): TaskMutationDto {
            undone += seq
            return TaskMutationDto(null, TaskReceiptDto("Undone", null))
        }
    }

    private val sunday = LocalDate.of(2026, 10, 18)
    private lateinit var gateway: FakeGateway
    private lateinit var vm: TasksViewModel
    private lateinit var store: TaskCountsStore

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        gateway = FakeGateway()
        store = TaskCountsStore()
        vm = TasksViewModel(gateway, countsStore = store) { sunday }
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun every_view_is_read_for_the_device_local_day() {
        vm.select(TaskSegment.SUGGESTED)

        assertEquals(
            listOf(TaskView.TODAY to "2026-10-18", TaskView.SUGGESTED to "2026-10-18"),
            gateway.views,
        )
        assertEquals(TaskSegment.SUGGESTED, vm.state.value.segment)
    }

    @Test
    fun fan_moves_are_computed_from_the_device_day() {
        val task = gateway.tasks.single()
        vm.perform(task, TaskFanAction.Tomorrow)
        vm.perform(task, TaskFanAction.NextMonth)
        vm.perform(task, TaskFanAction.Month("2027-02"))

        assertEquals(
            listOf("2026-10-19", "2026-11", "2027-02"),
            gateway.actions.map { (it.second as TaskAction.Migrate).to },
        )
    }

    @Test
    fun fan_done_completes_and_cancel_strikes() {
        val task = gateway.tasks.single()
        vm.perform(task, TaskFanAction.Done)
        vm.perform(task, TaskFanAction.CancelTask)
        assertEquals(listOf(TaskAction.Complete(), TaskAction.Strike()), gateway.actions.map { it.second })
    }

    /** Navigation targets only change the fan; they never reach the gateway. */
    @Test
    fun fan_navigation_changes_nothing() {
        val task = gateway.tasks.single()
        listOf(TaskFanAction.OtherMonth, TaskFanAction.Back, TaskFanAction.LaterMonths, TaskFanAction.EarlierMonths)
            .forEach { vm.perform(task, it) }
        assertTrue(gateway.actions.isEmpty())
    }

    @Test
    fun a_suggestions_fan_accepts_plans_marks_done_and_ignores() {
        val suggestion = TaskDto(id = "s", title = "Renew the parking permit", origin = "brain", accepted = false)
        gateway.tasks = listOf(suggestion)
        listOf(
            TaskFanAction.Accept,
            TaskFanAction.Today,
            TaskFanAction.Tomorrow,
            TaskFanAction.NextWeek,
            TaskFanAction.NextMonth,
            TaskFanAction.Month("2027-02"),
            TaskFanAction.Someday,
            TaskFanAction.Done,
            TaskFanAction.Ignore,
        ).forEach { vm.perform(suggestion, it) }

        assertEquals(
            listOf(
                TaskAction.Accept(),
                TaskAction.Accept("2026-10-18"),
                TaskAction.Accept("2026-10-19"),
                TaskAction.Accept("2026-10-19"),
                TaskAction.Accept("2026-11"),
                TaskAction.Accept("2027-02"),
                TaskAction.Accept("someday"),
                TaskAction.Complete(),
                TaskAction.Ignore(),
            ),
            gateway.actions.map { it.second },
        )
    }

    @Test
    fun accept_with_note_opens_the_capture_and_accepts_with_its_words_under_one_note_id() = runTest {
        val suggestion = TaskDto(id = "s", title = "Renew the parking permit", origin = "brain", accepted = false)
        gateway.tasks = listOf(suggestion)
        vm.perform(suggestion, TaskFanAction.AcceptWithNote)
        assertEquals(suggestion, vm.state.value.noting)
        assertTrue(gateway.actions.isEmpty())

        assertNull(vm.saveNote(suggestion, "The form is in the glovebox"))
        assertNull(vm.saveNote(suggestion, "The form is in the glovebox"))

        val sent = gateway.actions.map { it.second as TaskAction.Accept }
        assertEquals(listOf("The form is in the glovebox", "The form is in the glovebox"), sent.map { it.note })
        // A retry from the same capture replays the same note.
        assertEquals(1, sent.map { it.noteId }.toSet().size)
        assertTrue(sent.first().noteId != null)

        // A new capture is a new note.
        vm.perform(suggestion, TaskFanAction.AcceptWithNote)
        vm.saveNote(suggestion, "Another thought")
        assertEquals(2, gateway.actions.map { (it.second as TaskAction.Accept).noteId }.toSet().size)
    }

    @Test
    fun done_with_note_opens_the_capture_and_completes_with_its_words() = runTest {
        val task = gateway.tasks.single()
        vm.perform(task, TaskFanAction.DoneWithNote)
        assertEquals(task, vm.state.value.noting)

        assertNull(vm.saveNote(task, "Paid by card"))

        assertEquals(TaskAction.Complete("Paid by card"), gateway.actions.single().second)
        assertEquals("Done", vm.state.value.receipt?.text)
        vm.closeNote()
        assertNull(vm.state.value.noting)
    }

    @Test
    fun a_refused_note_keeps_the_capture_open_with_the_reason() = runTest {
        gateway.failNextAction = GatewayException.ServerError(409, "That task changed elsewhere.")
        val task = gateway.tasks.single()
        vm.perform(task, TaskFanAction.DoneWithNote)

        val error = vm.saveNote(task, "Paid by card")

        assertTrue(error != null)
        assertEquals(task, vm.state.value.noting)
        assertTrue(vm.state.value.pending.isEmpty())
    }

    /** A 4xx says the screen was stale, so it is re-read; a transport failure is not. */
    @Test
    fun a_refusal_rereads_the_view_and_a_transport_failure_does_not() {
        val reads = gateway.views.size
        gateway.failNextAction = GatewayException.ServerError(400, "Task is already accepted")
        vm.accept(gateway.tasks.single(), null)
        assertEquals(reads + 1, gateway.views.size)

        gateway.failNextAction = IllegalStateException("offline")
        vm.accept(gateway.tasks.single(), null)
        assertEquals(reads + 1, gateway.views.size)
    }

    @Test
    fun a_task_asked_for_elsewhere_opens_with_its_details() {
        val bus = TaskFocusBus()
        val focused = TasksViewModel(gateway, countsStore = store, focusBus = bus) { sunday }
        bus.post("a")
        assertEquals("a", focused.state.value.editing?.id)
        assertNull(bus.request.value)
    }

    @Test
    fun a_mutation_raises_its_receipt_and_rereads_the_view() {
        vm.tapBullet(gateway.tasks.single())

        assertEquals(TaskAction.Complete(), gateway.actions.single().second)
        assertEquals("Done", vm.state.value.receipt?.text)
        assertEquals(2, gateway.views.size)
    }

    @Test
    fun undo_posts_the_receipt_sequence_says_so_and_rereads() {
        vm.tapBullet(gateway.tasks.single())
        val receipt = vm.state.value.receipt!!

        vm.undo(receipt)

        assertEquals(listOf(9L), gateway.undone)
        assertEquals("Undone", vm.state.value.receipt?.text)
        assertNull(vm.state.value.receipt?.undoSeq)
        assertEquals(3, gateway.views.size)
    }

    @Test
    fun a_refused_completion_restores_the_row_and_says_why() {
        gateway.failNextAction = IllegalStateException("refused")
        val original = gateway.tasks.single()

        vm.tapBullet(original)

        assertEquals(original, vm.state.value.tasks.single())
        assertTrue(vm.state.value.pending.isEmpty())
        assertTrue(vm.state.value.actionError != null)
    }

    @Test
    fun every_view_read_shares_its_counts_with_the_menu() {
        assertEquals(1, store.counts.value.today)

        // Completing the only task: the re-read after the mutation carries the new count.
        gateway.counts = TaskCountsDto(today = 0, month = 3)
        vm.tapBullet(gateway.tasks.single())

        assertEquals(0, store.counts.value.today)
        assertEquals(3, vm.state.value.counts.month)
    }

    @Test
    fun history_opens_with_the_gateway_detail() {
        vm.openHistory(gateway.tasks.single())
        val history = vm.state.value.history!!
        assertEquals(false, history.loading)
        assertEquals("a", history.detail?.task?.id)
        vm.closeHistory()
        assertNull(vm.state.value.history)
    }
}
