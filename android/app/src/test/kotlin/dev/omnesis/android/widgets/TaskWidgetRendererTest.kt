// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import android.appwidget.AppWidgetManager
import android.os.Bundle
import android.util.SizeF
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import dev.omnesis.android.R
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TaskWidgetRendererTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val today = LocalDate.of(2026, 6, 15)
    private val tasks = (0 until 15).map {
        WidgetTask("task-$it", "Read chapter $it", scheduledFor = today.toString())
    }

    @Test
    fun compact_pagination_exposes_every_task() {
        val size = TaskWidgetRenderer.Size(170, 170)
        val seen = mutableListOf<String>()
        for (page in 0 until (tasks.size + size.capacity - 1) / size.capacity) {
            val root = render(TaskWidgetState(page = page), 170, 170)
            val rows = root.findViewById<LinearLayout>(R.id.tasks_widget_left)
            for (index in 0 until rows.childCount) seen += rows.getChildAt(index)
                .findViewById<TextView>(R.id.tasks_widget_task_title).text.toString()
        }
        assertEquals(tasks.size, seen.size)
        assertEquals(tasks.map { it.title }.toSet(), seen.toSet())
    }

    @Test
    fun stale_page_is_clamped_and_full_task_title_remains_accessible() {
        val root = render(TaskWidgetState(page = Int.MAX_VALUE), 360, 170)
        assertTrue(root.findViewById<TextView>(R.id.tasks_widget_page).text.toString().contains("/"))
        val rows = root.findViewById<LinearLayout>(R.id.tasks_widget_left)
        assertTrue(rows.childCount > 0)
        val title = rows.getChildAt(0).findViewById<TextView>(R.id.tasks_widget_task_title)
        assertEquals(title.text, title.contentDescription)
    }

    @Test
    fun no_cache_is_not_reported_as_an_empty_task_list() {
        val root = render(TaskWidgetState(), 360, 170, snapshot = null, status = TaskWidgetStatus.OFFLINE)
        assertEquals("Gateway unavailable", root.findViewById<TextView>(R.id.tasks_widget_message_title).text)
        assertEquals(View.GONE, root.findViewById<View>(R.id.tasks_widget_rows).visibility)
        assertEquals(View.GONE, root.findViewById<View>(R.id.tasks_widget_count_block).visibility)
    }

    @Test
    fun week_month_plan_with_deadline_displays_the_due_day() {
        val task = WidgetTask("month-due", "Review the workshop outline", scheduledFor = "2026-06", dueDay = "2026-06-18")
        val root = render(TaskWidgetState(period = TaskWidgetPeriod.WEEK), 360, 360,
            snapshot = TaskWidgetSnapshot(listOf(task), 0))
        val rows = root.findViewById<LinearLayout>(R.id.tasks_widget_left)
        assertEquals(1, rows.childCount)
        assertEquals("Thu 18", rows.getChildAt(0).findViewById<TextView>(R.id.tasks_widget_task_date).text)
    }

    @Test
    fun minimum_empty_layout_keeps_message_clear_of_controls() {
        val root = render(TaskWidgetState(), 150, 150, snapshot = TaskWidgetSnapshot(emptyList(), 0))
        assertEquals(View.GONE, root.findViewById<View>(R.id.tasks_widget_message_icon).visibility)
        assertEquals("Room to breathe", root.findViewById<TextView>(R.id.tasks_widget_message_title).text)
    }

    @Test
    fun responsive_sizes_use_distinct_layouts_and_more_space_shows_more_tasks() {
        assertTrue(TaskWidgetRenderer.Size(720, 360).capacity > TaskWidgetRenderer.Size(170, 170).capacity)
        val options = options(170, 170).apply {
            putParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES, arrayListOf(SizeF(170f, 170f), SizeF(360f, 170f)))
        }
        val views = TaskWidgetRenderer.render(context, 41, TaskWidgetState(), TaskWidgetSnapshot(tasks, 0), TaskWidgetStatus.READY, "test-authority", options, today)
        assertTrue(views.apply(context, FrameLayout(context)) is LinearLayout)
    }

    private fun render(state: TaskWidgetState, width: Int, height: Int,
                       snapshot: TaskWidgetSnapshot? = TaskWidgetSnapshot(tasks, 0),
                       status: TaskWidgetStatus = TaskWidgetStatus.READY): View =
        TaskWidgetRenderer.render(context, 41, state, snapshot, status, "test-authority", options(width, height), today)
            .apply(context, FrameLayout(context))

    private fun options(width: Int, height: Int) = Bundle().apply {
        putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, width)
        putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width)
        putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, height)
        putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, height)
    }
}
