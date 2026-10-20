// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.client.TaskAction
import dev.omnesis.android.transport.dto.TaskDto
import java.time.LocalDate
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Tasks screen driven the way a person drives it — taps on the circle, a long press that
 * slides over the action fan and lifts, Undo on the receipt — against a stateful gateway, with
 * what the screen shows checked after every change. All fixture data is invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class TasksInteractionTest {

    @get:Rule val compose = createComposeRule()

    private val today = LocalDate.of(2026, 10, 14)

    private val deposit = TaskDto(
        id = "t_deposit",
        title = "Pay the venue deposit",
        description = "The quote holds the date until Friday.",
        accepted = true,
        scheduledFor = "2026-10-14",
    )
    private val tuner = TaskDto(id = "t_tuner", title = "Book the piano tuner", accepted = true, scheduledFor = "2026-10-14")
    private val permit = TaskDto(
        id = "s_permit",
        title = "Renew the parking permit",
        description = "The reminder says it lapses at the end of the month.",
        origin = "brain",
        accepted = false,
    )

    private lateinit var gateway: StatefulTasksGateway
    private lateinit var vm: TasksViewModel

    /** How many times the bar's Tell Omnesis button asked for the capture. */
    private var tellOmnesisTaps = 0

    private fun start(tasks: List<TaskDto> = listOf(deposit, tuner, permit), experimental: Boolean = false) {
        gateway = StatefulTasksGateway(tasks, resolvedNow = "2026-10-14T09:30:00.000Z")
        vm = TasksViewModel(gateway) { today }
        compose.setContent { Harness(vm, experimental) }
        compose.waitForIdle()
    }

    @Composable
    private fun Harness(vm: TasksViewModel, experimental: Boolean) {
        val state by vm.state.collectAsState()
        // Inspection mode freezes the receipt's timer, so Undo stays on screen to be tapped.
        CompositionLocalProvider(LocalInspectionMode provides true) {
            OmnesisTheme(darkTheme = false) {
                TasksFrame(onOpenMenu = {}, onTellOmnesis = { tellOmnesisTaps += 1 }) {
                    TasksContent(
                        state = state,
                        today = LocalDate.parse(state.day),
                        experimental = experimental,
                        actions = taskRowActions(vm) {},
                        onSelect = vm::select,
                        onUndo = vm::undo,
                        onReceiptExpired = vm::dismissReceipt,
                    )
                }
            }
        }
    }

    private fun node(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true)

    private fun assertOpen(id: String) = node("tasks.open.$id").assertExists()
    private fun assertDone(id: String) = node("tasks.done.$id").assertIsDisplayed()

    private fun undo() {
        compose.onNodeWithText("Undo").performClick()
        compose.waitForIdle()
    }

    /**
     * Long-press [taskId]'s row, wait for the fan, then slide onto [target] (a fan target's tag
     * suffix) and lift there; a null [target] lifts at the press point. [restMillis] holds the
     * finger still on the target before lifting.
     */
    private fun fan(taskId: String, target: String?, restMillis: Long = 0, then: String? = null) {
        val row = node("tasks.row.$taskId")
        val rowBounds = row.fetchSemanticsNode().boundsInRoot
        val press = Offset(rowBounds.width * 0.75f, 40f)
        row.performTouchInput {
            down(press)
            advanceEventTime(viewConfiguration.longPressTimeoutMillis + 100)
            moveBy(Offset(0f, 1f))
        }
        compose.waitForIdle()
        node("tasks.fan").assertExists()
        fun local(tag: String) = node("tasks.fan.$tag").fetchSemanticsNode().boundsInRoot.center - rowBounds.topLeft
        val first = target?.let(::local) ?: press
        row.performTouchInput {
            moveTo(first)
            if (restMillis > 0) {
                advanceEventTime(restMillis)
                moveBy(Offset(0f, 0.5f))
            }
        }
        compose.waitForIdle()
        val last = then?.let(::local)
        row.performTouchInput {
            if (last != null) moveTo(last)
            up()
        }
        compose.waitForIdle()
        node("tasks.fan").assertDoesNotExist()
    }

    /**
     * Long-press [taskId]'s row, then rest on each navigation target in [stops] long enough to
     * follow it, and lift on the last stop.
     */
    private fun fanThrough(taskId: String, vararg stops: String) {
        val row = node("tasks.row.$taskId")
        val rowBounds = row.fetchSemanticsNode().boundsInRoot
        val press = Offset(rowBounds.width * 0.75f, 40f)
        row.performTouchInput {
            down(press)
            advanceEventTime(viewConfiguration.longPressTimeoutMillis + 100)
            moveBy(Offset(0f, 1f))
        }
        compose.waitForIdle()
        fun local(tag: String) = node("tasks.fan.$tag").fetchSemanticsNode().boundsInRoot.center - rowBounds.topLeft
        stops.dropLast(1).forEach { stop ->
            row.performTouchInput {
                moveTo(local(stop))
                advanceEventTime(600)
                moveBy(Offset(0f, 0.5f))
            }
            compose.waitForIdle()
        }
        val last = local(stops.last())
        row.performTouchInput {
            moveTo(last)
            up()
        }
        compose.waitForIdle()
        node("tasks.fan").assertDoesNotExist()
    }

    private fun openSuggested() {
        vm.select(TaskSegment.SUGGESTED)
        compose.waitForIdle()
        node("tasks.row.${permit.id}").assertExists()
    }

    // --- Tell Omnesis ---------------------------------------------------------------------------

    /** The bar's microphone-and-plus button asks for Tell Omnesis once per tap and changes no task. */
    @Test
    fun the_bars_tell_omnesis_button_asks_for_capture() {
        start()
        assertOpen(deposit.id)

        val button = compose.onNodeWithTag("tasks.tellOmnesis")
        button.assertIsDisplayed()
        button.assertContentDescriptionEquals("Tell Omnesis")

        button.performClick()
        compose.waitForIdle()
        assertEquals(1, tellOmnesisTaps)
        assertTrue(gateway.commands.isEmpty())
    }

    // --- The circle ----------------------------------------------------------------------------

    @Test
    fun tapping_the_circle_completes_then_reopens() {
        start()
        assertOpen(deposit.id)

        node("tasks.circle.${deposit.id}").performClick()
        compose.waitForIdle()
        assertDone(deposit.id)
        compose.onNodeWithText("Done: Pay the venue deposit").assertExists()
        // The row moved into "Done today" and is drawn there as done.
        compose.onNodeWithText("DONE TODAY").assertExists()

        node("tasks.circle.${deposit.id}").performClick()
        compose.waitForIdle()
        assertOpen(deposit.id)
        assertEquals(listOf(TaskAction.Complete(), TaskAction.Reopen), gateway.commands.map { it.second })
    }

    @Test
    fun undo_after_the_circle_puts_the_task_back() {
        start()
        node("tasks.circle.${tuner.id}").performClick()
        compose.waitForIdle()
        assertDone(tuner.id)

        undo()

        assertOpen(tuner.id)
        compose.onNodeWithText("Undone: Book the piano tuner").assertExists()
    }

    // --- The fan ---------------------------------------------------------------------------------

    @Test
    fun fan_done_completes_the_row_and_undo_reopens_it() {
        start()
        fan(deposit.id, "done")
        assertDone(deposit.id)
        assertEquals(TaskAction.Complete(), gateway.commands.single().second)

        undo()
        assertOpen(deposit.id)
    }

    @Test
    fun fan_done_with_note_opens_the_capture_and_completes_with_its_words() {
        start()
        fan(deposit.id, "doneWithNote")
        assertEquals(deposit.id, vm.state.value.noting?.id)
        assertTrue(gateway.commands.isEmpty())

        // What the capture's Done hands over.
        var error: String? = "pending"
        MainScope().launch { error = vm.saveNote(vm.state.value.noting!!, "Paid by card") }
        compose.waitForIdle()
        vm.closeNote()
        compose.waitForIdle()

        assertNull(error)
        assertDone(deposit.id)
        compose.onNodeWithText("Paid by card").assertExists()
        assertEquals(TaskAction.Complete("Paid by card"), gateway.commands.single().second)

        undo()
        assertOpen(deposit.id)
        compose.onNodeWithText("Paid by card").assertDoesNotExist()
    }

    @Test
    fun fan_tomorrow_moves_the_task_off_today_and_undo_brings_it_back() {
        start()
        fan(tuner.id, "tomorrow")
        node("tasks.row.${tuner.id}").assertDoesNotExist()
        assertEquals(TaskAction.Migrate("2026-10-15"), gateway.commands.single().second)

        undo()
        node("tasks.row.${tuner.id}").assertExists()
    }

    @Test
    fun fan_next_month_moves_the_task_and_undo_brings_it_back() {
        start()
        fan(tuner.id, "nextMonth")
        node("tasks.row.${tuner.id}").assertDoesNotExist()
        assertEquals(TaskAction.Migrate("2026-11"), gateway.commands.single().second)

        undo()
        node("tasks.row.${tuner.id}").assertExists()
    }

    /** Resting on Other month… opens the month fan in place; sliding onto a month and lifting moves it there. */
    @Test
    fun fan_other_month_moves_the_task_to_the_chosen_month_and_undo_brings_it_back() {
        start()
        fan(tuner.id, "otherMonth", restMillis = 600, then = "month.2027-02")
        node("tasks.row.${tuner.id}").assertDoesNotExist()
        assertEquals(TaskAction.Migrate("2027-02"), gateway.commands.single().second)

        undo()
        node("tasks.row.${tuner.id}").assertExists()
    }

    @Test
    fun fan_cancel_strikes_the_task_and_undo_reopens_it() {
        start()
        fan(deposit.id, "cancelTask")
        node("tasks.struck.${deposit.id}").assertIsDisplayed()
        assertEquals(TaskAction.Strike(), gateway.commands.single().second)

        undo()
        assertOpen(deposit.id)
    }

    @Test
    fun lifting_off_every_target_changes_nothing() {
        start()
        fan(deposit.id, target = null)
        assertTrue(gateway.commands.isEmpty())
        assertOpen(deposit.id)
        // Lifting on a navigation target is not an action either.
        fan(deposit.id, target = "otherMonth")
        assertTrue(gateway.commands.isEmpty())
        assertNull(vm.state.value.receipt)
    }

    /** The list scrolls again once the fan has closed. */
    @Test
    fun the_list_scrolls_after_the_fan_closes() {
        val many = (1..18).map { n ->
            TaskDto(id = "t_$n", title = "Invented errand number $n", accepted = true, scheduledFor = "2026-10-14")
        }
        start(many)
        node("tasks.row.t_18").assertDoesNotExist()

        fan("t_1", target = null)

        node("tasks.list").performTouchInput { swipeUp() }
        compose.waitForIdle()
        node("tasks.list").performTouchInput { swipeUp() }
        compose.waitForIdle()
        node("tasks.row.t_18").assertExists()
    }

    // --- Suggestions -------------------------------------------------------------------------------

    @Test
    fun a_suggestion_offers_its_own_fan() {
        start(experimental = true)
        openSuggested()
        val row = node("tasks.row.${permit.id}")
        row.performTouchInput {
            down(Offset(width * 0.75f, 40f))
            advanceEventTime(viewConfiguration.longPressTimeoutMillis + 100)
            moveBy(Offset(0f, 1f))
        }
        compose.waitForIdle()
        listOf("accept", "acceptWithNote", "acceptFor", "done", "ignore").forEach { node("tasks.fan.$it").assertExists() }
        listOf("doneWithNote", "tomorrow", "cancelTask").forEach { node("tasks.fan.$it").assertDoesNotExist() }
        row.performTouchInput { up() }
        compose.waitForIdle()
        assertTrue(gateway.commands.isEmpty())
    }

    @Test
    fun tapping_a_suggestions_circle_marks_it_done_and_undo_brings_it_back() {
        start(experimental = true)
        openSuggested()

        node("tasks.circle.${permit.id}").performClick()
        compose.waitForIdle()

        node("tasks.row.${permit.id}").assertDoesNotExist()
        assertEquals(TaskAction.Complete(), gateway.commands.single().second)
        compose.onNodeWithText("Done: Renew the parking permit").assertExists()
        vm.select(TaskSegment.DONE)
        compose.waitForIdle()
        node("tasks.done.${permit.id}").assertIsDisplayed()

        undo()
        vm.select(TaskSegment.SUGGESTED)
        compose.waitForIdle()
        node("tasks.row.${permit.id}").assertExists()
    }

    @Test
    fun fan_mark_as_done_resolves_the_suggestion() {
        start(experimental = true)
        openSuggested()
        fan(permit.id, "done")
        node("tasks.row.${permit.id}").assertDoesNotExist()
        assertEquals(TaskAction.Complete(), gateway.commands.single().second)
        assertEquals(TaskDto.STATE_DONE, gateway.tasks.first { it.id == permit.id }.state)
    }

    @Test
    fun fan_accept_takes_it_out_of_suggested_and_onto_the_journal_and_undo_brings_it_back() {
        start(experimental = true)
        openSuggested()

        fan(permit.id, "accept")

        node("tasks.row.${permit.id}").assertDoesNotExist()
        assertEquals(TaskAction.Accept(), gateway.commands.single().second)
        vm.select(TaskSegment.ANYTIME)
        compose.waitForIdle()
        node("tasks.row.${permit.id}").assertExists()

        undo()
        node("tasks.row.${permit.id}").assertDoesNotExist()
        vm.select(TaskSegment.SUGGESTED)
        compose.waitForIdle()
        node("tasks.row.${permit.id}").assertExists()
    }

    @Test
    fun fan_accept_with_note_opens_the_capture_and_accepts_with_its_words() {
        start(experimental = true)
        openSuggested()

        fan(permit.id, "acceptWithNote")
        val noting = vm.state.value.noting
        assertEquals(permit.id, noting?.id)
        assertTrue(gateway.commands.isEmpty())

        var error: String? = "pending"
        MainScope().launch { error = vm.saveNote(noting!!, "The renewal form is in the glovebox") }
        compose.waitForIdle()

        assertNull(error)
        val sent = gateway.commands.single().second as TaskAction.Accept
        assertEquals("The renewal form is in the glovebox", sent.note)
        assertTrue(sent.noteId != null)
        assertEquals(permit.id to "The renewal form is in the glovebox", gateway.notes[sent.noteId])
        node("tasks.row.${permit.id}").assertDoesNotExist()

        // Saving again from the same capture replays the same note rather than writing another.
        var again: String? = "pending"
        MainScope().launch { again = vm.saveNote(noting!!, "The renewal form is in the glovebox") }
        compose.waitForIdle()
        assertNull(again)
        assertEquals(1, gateway.notes.size)
        assertEquals(sent.noteId, (gateway.commands.last().second as TaskAction.Accept).noteId)
        vm.closeNote()
        compose.waitForIdle()

        vm.select(TaskSegment.ANYTIME)
        compose.waitForIdle()
        node("tasks.row.${permit.id}").assertExists()
    }

    @Test
    fun fan_accept_for_today_plans_it_for_today() {
        start(experimental = true)
        openSuggested()

        fanThrough(permit.id, "acceptFor", "today")

        assertEquals(TaskAction.Accept("2026-10-14"), gateway.commands.single().second)
        vm.select(TaskSegment.TODAY)
        compose.waitForIdle()
        node("tasks.row.${permit.id}").assertExists()

        undo()
        node("tasks.row.${permit.id}").assertDoesNotExist()
    }

    @Test
    fun fan_accept_for_someday_plans_it_for_someday() {
        start(experimental = true)
        openSuggested()
        fanThrough(permit.id, "acceptFor", "someday")
        assertEquals(TaskAction.Accept("someday"), gateway.commands.single().second)
        vm.select(TaskSegment.FUTURE)
        compose.waitForIdle()
        node("tasks.row.${permit.id}").assertExists()
    }

    @Test
    fun fan_accept_for_another_month_plans_it_for_that_month() {
        start(experimental = true)
        openSuggested()
        fanThrough(permit.id, "acceptFor", "otherMonth", "month.2027-01")
        assertEquals(TaskAction.Accept("2027-01"), gateway.commands.single().second)
        vm.select(TaskSegment.FUTURE)
        compose.waitForIdle()
        node("tasks.row.${permit.id}").assertExists()
    }

    @Test
    fun fan_ignore_takes_it_out_of_tasks_and_undo_restores_the_suggestion() {
        start(experimental = true)
        openSuggested()

        fan(permit.id, "ignore")

        node("tasks.row.${permit.id}").assertDoesNotExist()
        assertTrue(gateway.commands.single().second is TaskAction.Ignore)
        compose.onNodeWithText("Ignored: Renew the parking permit").assertExists()
        assertEquals(0, vm.state.value.counts.suggested)
        // Not resolved: the loop stays open; it is only out of the Tasks views.
        assertEquals(TaskDto.STATE_OPEN, gateway.tasks.first { it.id == permit.id }.state)
        vm.select(TaskSegment.ANYTIME)
        compose.waitForIdle()
        node("tasks.row.${permit.id}").assertDoesNotExist()
        vm.select(TaskSegment.SUGGESTED)
        compose.waitForIdle()
        node("tasks.row.${permit.id}").assertDoesNotExist()

        undo()
        node("tasks.row.${permit.id}").assertExists()
        assertEquals(1, vm.state.value.counts.suggested)
    }

    /** Accepted on another device meanwhile: the gateway's 400 re-reads the list, so no stale row stays. */
    @Test
    fun a_suggestion_accepted_elsewhere_leaves_the_list_on_refusal() {
        start(experimental = true)
        openSuggested()
        gateway.changeElsewhere(permit.id) { it.copy(accepted = true) }

        fan(permit.id, "accept")

        node("tasks.row.${permit.id}").assertDoesNotExist()
        assertTrue(vm.state.value.actionError != null)
    }

    @Test
    fun today_opens_with_the_review_banner_that_opens_suggested() {
        start(experimental = true)
        compose.onNodeWithText("Omnesis has created 1 task for your review").assertExists()
        node("tasks.reviewBanner").performClick()
        compose.waitForIdle()
        assertEquals(TaskSegment.SUGGESTED, vm.state.value.segment)
        node("tasks.row.${permit.id}").assertExists()
    }

    /** A long day never pushes the banner out of sight: it sits above the first task. */
    @Test
    fun the_review_banner_sits_above_a_long_today() {
        val many = (1..18).map { n ->
            TaskDto(id = "t_$n", title = "Invented errand number $n", accepted = true, scheduledFor = "2026-10-14")
        }
        start(many + permit, experimental = true)
        node("tasks.reviewBanner").assertIsDisplayed()
        val banner = node("tasks.reviewBanner").fetchSemanticsNode().boundsInRoot
        val first = node("tasks.row.t_1").fetchSemanticsNode().boundsInRoot
        assertTrue("banner ${banner.top} above first row ${first.top}", banner.bottom <= first.top)
    }
}
