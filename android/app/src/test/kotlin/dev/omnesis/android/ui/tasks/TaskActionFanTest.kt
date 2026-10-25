// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import java.time.LocalDate
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The action fan's geometry and touch rules, on unscaled (1 px = 1 dp) metrics. Mirrors the iOS TaskActionFanTests. */
class TaskActionFanTest {

    private val today = LocalDate.of(2026, 10, 14)
    private val bounds = Rect(0f, 0f, 400f, 800f)

    private fun session(
        anchor: Offset = Offset(300f, 600f),
        mode: TaskFanSession.Mode = TaskFanSession.Mode.Main,
        tracking: Boolean = true,
        suggestion: Boolean = false,
        chat: Boolean = false,
    ) = TaskFanSession(
        anchor,
        bounds,
        today,
        mode = mode,
        tracking = tracking,
        locale = Locale.UK,
        suggestion = suggestion,
        chat = chat,
    )

    private fun TaskFanSession.target(action: TaskFanAction) = targets.single { it.action == action }

    // --- Layout ------------------------------------------------------------------------------

    @Test
    fun the_main_fan_lists_its_targets_nearest_first_in_a_fixed_order() {
        assertEquals(
            listOf("Done", "Done + note", "Tomorrow", "Next month", "Other month…", "Cancel task"),
            session().targets.map { it.label },
        )
    }

    @Test
    fun a_suggestions_fan_offers_its_own_actions_nearest_first() {
        assertEquals(
            listOf("Accept", "Accept with note", "Accept for…", "Mark as done", "Ignore"),
            session(suggestion = true).targets.map { it.label },
        )
    }

    /**
     * A gateway that opens conversations about tasks adds Chat about this to a task's main fan,
     * furthest from the thumb, so every other target keeps its place in the order. A
     * suggestion's fan is about deciding on it and stays as it is.
     */
    @Test
    fun chat_about_this_ends_a_tasks_main_fan_only_when_the_gateway_offers_it() {
        assertEquals(
            listOf("Done", "Done + note", "Tomorrow", "Next month", "Other month…", "Cancel task", "Chat about this"),
            session(chat = true).targets.map { it.label },
        )
        assertEquals(
            listOf("Accept", "Accept with note", "Accept for…", "Mark as done", "Ignore"),
            session(suggestion = true, chat = true).targets.map { it.label },
        )
        // Only the main fans: the month and when fans are about moving the task.
        val months = session(chat = true, tracking = false)
        months.tap(TaskFanAction.OtherMonth)
        assertTrue(months.targets.none { it.action == TaskFanAction.ChatAbout })
    }

    @Test
    fun lifting_on_chat_about_this_performs_it() {
        val fan = session(chat = true)
        val target = fan.target(TaskFanAction.ChatAbout)
        fan.move(target.center, nowMillis = 0)
        assertEquals(TaskFanSession.Outcome.Perform(TaskFanAction.ChatAbout), fan.release(target.center, nowMillis = 10))
    }

    /** Accept for… leads to the times to plan it for; Other month… to the months; Back retraces the way. */
    @Test
    fun a_suggestions_accept_for_walks_through_when_and_months_and_back() {
        val fan = session(suggestion = true, tracking = false)
        assertEquals(TaskFanSession.Outcome.StayOpen, fan.tap(TaskFanAction.AcceptFor))
        assertEquals(TaskFanSession.Mode.When, fan.mode)
        assertEquals(
            listOf("Back", "Today", "Tomorrow", "Next week", "Next month", "Other month…", "Someday"),
            fan.targets.map { it.label },
        )
        assertEquals(TaskFanSession.Outcome.StayOpen, fan.tap(TaskFanAction.OtherMonth))
        assertEquals(TaskFanSession.Mode.Months(0), fan.mode)
        fan.tap(TaskFanAction.Back)
        assertEquals(TaskFanSession.Mode.When, fan.mode)
        fan.tap(TaskFanAction.Back)
        assertEquals(TaskFanSession.Mode.Main, fan.mode)
        assertEquals(TaskFanSession.Outcome.Perform(TaskFanAction.Ignore), fan.tap(TaskFanAction.Ignore))
    }

    /** Resting on Accept for… opens the when fan in place, like Other month… does. */
    @Test
    fun resting_on_accept_for_opens_the_when_fan() {
        val fan = session(suggestion = true)
        val target = fan.target(TaskFanAction.AcceptFor)
        fan.move(target.center, nowMillis = 0)
        assertTrue(fan.tick(nowMillis = 500).contains(TaskFanSession.Event.ModeChanged(TaskFanSession.Mode.When)))
    }

    /** For a right thumb: every target sits up and to the left of the press, Done nearest. */
    @Test
    fun the_column_rises_up_and_left_of_the_finger_leaning_further_left_as_it_rises() {
        val fan = session()
        assertTrue(fan.upwards)
        fan.targets.forEach { target ->
            assertTrue(target.frame.right <= 300f - 26f + 0.01f)
            assertTrue(target.frame.bottom <= 600f)
        }
        val ys = fan.targets.map { it.center.y }
        assertEquals(ys.sortedDescending(), ys)
        assertTrue(fan.targets.last().center.x < fan.targets.first().center.x)
        // No two targets overlap.
        fan.targets.zipWithNext().forEach { (a, b) -> assertFalse(a.frame.overlaps(b.frame)) }
    }

    /** Near the top the column hangs below the finger, in the same order by distance. */
    @Test
    fun near_the_top_the_column_flips_downwards() {
        val fan = session(anchor = Offset(300f, 60f))
        assertFalse(fan.upwards)
        val ys = fan.targets.map { it.center.y }
        assertEquals(ys.sorted(), ys)
        assertEquals("Done", fan.targets.first().label)
        fan.targets.forEach { assertTrue(it.frame.top >= bounds.top + 8f - 0.01f) }
    }

    /** Pressed near the left edge, the column slides right to stay on screen, never reordering. */
    @Test
    fun near_the_left_edge_the_column_slides_back_on_screen() {
        val fan = session(anchor = Offset(60f, 600f))
        fan.targets.forEach { assertTrue(it.frame.left >= 8f - 0.01f) }
        assertEquals("Done", fan.targets.first().label)
    }

    // --- Hit-testing ---------------------------------------------------------------------------

    @Test
    fun the_press_point_and_gaps_select_nothing() {
        val fan = session()
        assertNull(fan.targetAt(Offset(300f, 600f)))
        assertNull(fan.targetAt(Offset(390f, 100f)))
        val done = fan.target(TaskFanAction.Done)
        assertEquals(TaskFanAction.Done, fan.targetAt(done.center)?.action)
    }

    // --- Release -------------------------------------------------------------------------------

    @Test
    fun lifting_on_a_target_performs_it() {
        val fan = session()
        val tomorrow = fan.target(TaskFanAction.Tomorrow)
        val events = fan.move(tomorrow.center, 1_000)
        assertEquals(listOf(TaskFanSession.Event.SelectionChanged(TaskFanAction.Tomorrow)), events)
        assertEquals(TaskFanSession.Outcome.Perform(TaskFanAction.Tomorrow), fan.release(tomorrow.center, 1_050))
        assertFalse(fan.tracking)
    }

    /** Lifting anywhere but on an action — the press point, a gap, a navigation target — changes nothing. */
    @Test
    fun lifting_off_a_target_dismisses() {
        assertEquals(TaskFanSession.Outcome.Dismiss, session().release(Offset(300f, 600f), 10))
        assertEquals(TaskFanSession.Outcome.Dismiss, session().release(Offset(390f, 50f), 10))
        val fan = session()
        val other = fan.target(TaskFanAction.OtherMonth)
        assertEquals(TaskFanSession.Outcome.Dismiss, fan.release(other.center, 10))
    }

    @Test
    fun sliding_across_targets_ticks_once_per_change() {
        val fan = session()
        val done = fan.target(TaskFanAction.Done)
        assertEquals(1, fan.move(done.center, 0).size)
        assertTrue(fan.move(done.center + Offset(2f, 1f), 10).isEmpty())
        assertEquals(1, fan.move(fan.target(TaskFanAction.DoneWithNote).center, 20).size)
    }

    // --- Dwell and the month fan ----------------------------------------------------------------

    @Test
    fun resting_on_other_month_opens_the_month_fan_which_waits_for_a_deliberate_move() {
        val fan = session()
        val other = fan.target(TaskFanAction.OtherMonth)
        fan.move(other.center, 1_000)
        assertEquals(1_450L, fan.dwellDeadlineMillis)
        assertTrue(fan.tick(1_200).isEmpty())

        val events = fan.tick(1_450)
        assertEquals(listOf(TaskFanSession.Event.ModeChanged(TaskFanSession.Mode.Months(0))), events)
        assertEquals("Back", fan.targets.first().label)
        // Whatever target now sits under the finger is not chosen without moving first.
        assertTrue(fan.move(other.center + Offset(3f, 3f), 1_500).isEmpty())
        assertNull(fan.highlighted)
        assertEquals(TaskFanSession.Outcome.Dismiss, fan.release(other.center, 1_600))
    }

    @Test
    fun a_month_is_chosen_after_moving_onto_it() {
        val fan = session()
        val other = fan.target(TaskFanAction.OtherMonth)
        fan.move(other.center, 0)
        fan.tick(450)
        val february = fan.target(TaskFanAction.Month("2027-02"))
        fan.move(february.center, 600)
        assertEquals(TaskFanSession.Outcome.Perform(TaskFanAction.Month("2027-02")), fan.release(february.center, 650))
    }

    @Test
    fun month_pages_start_the_month_after_next_and_run_across_years() {
        assertEquals(
            listOf("2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05"),
            TaskFanSession.months(0, today, 6, Locale.UK).map { it.first },
        )
        assertEquals("Dec 2026", TaskFanSession.months(0, today, 6, Locale.UK).first().second)
        assertEquals("2027-06", TaskFanSession.months(1, today, 6, Locale.UK).first().first)
        val first = TaskFanSession.monthActions(0, today, 6, Locale.UK).map { it.second }
        assertEquals("Back", first.first())
        assertFalse("Earlier" in first)
        assertEquals("Later", first.last())
        assertTrue("Earlier" in TaskFanSession.monthActions(1, today, 6, Locale.UK).map { it.second })
    }

    // --- TalkBack ----------------------------------------------------------------------------------

    @Test
    fun a_fan_opened_without_a_finger_is_driven_by_taps() {
        val fan = session(tracking = false)
        assertFalse(fan.touchDriven)
        assertTrue(fan.move(fan.target(TaskFanAction.Done).center, 0).isEmpty())
        assertEquals(TaskFanSession.Outcome.StayOpen, fan.tap(TaskFanAction.OtherMonth))
        assertEquals(TaskFanSession.Mode.Months(0), fan.mode)
        assertEquals(TaskFanSession.Outcome.StayOpen, fan.tap(TaskFanAction.LaterMonths))
        assertEquals(TaskFanSession.Mode.Months(1), fan.mode)
        assertEquals(TaskFanSession.Outcome.StayOpen, fan.tap(TaskFanAction.EarlierMonths))
        assertEquals(TaskFanSession.Outcome.StayOpen, fan.tap(TaskFanAction.Back))
        assertEquals(TaskFanSession.Mode.Main, fan.mode)
        assertEquals(TaskFanSession.Outcome.Perform(TaskFanAction.CancelTask), fan.tap(TaskFanAction.CancelTask))
    }

    @Test
    fun metrics_scale_from_dp_to_pixels() {
        val scaled = TaskFanSession.Metrics().scaled(3f)
        assertEquals(528f, scaled.targetWidth)
        assertEquals(132f, scaled.targetHeight)
        assertEquals(450L, scaled.dwellMillis)
        assertEquals(6, scaled.monthsPerPage)
    }
}
