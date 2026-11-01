// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import android.appwidget.AppWidgetManager
import android.content.res.Configuration
import android.os.Bundle
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.widgets.TaskWidgetPeriod
import dev.omnesis.android.widgets.TaskWidgetSchedule
import dev.omnesis.android.widgets.TaskWidgetRenderer
import dev.omnesis.android.widgets.TaskWidgetSnapshot
import dev.omnesis.android.widgets.TaskWidgetState
import dev.omnesis.android.widgets.TaskWidgetStatus
import dev.omnesis.android.widgets.WidgetTask
import java.time.LocalDate
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Renders the production RemoteViews tree, including its real vector mark and XML layouts. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class TaskWidgetScreenshotTest {
    private val today = LocalDate.of(2026, 6, 15)
    private val tasks = listOf(
        "Plan a weekend walk", "Read a chapter", "Water the balcony plants", "Outline the project",
        "Visit the library", "Sketch a new idea", "Organise the desk", "Choose a recipe",
        "Write a postcard", "Practise piano", "Sort the bookshelf", "Print the draft",
        "Back up the photos", "Check the garden", "Finish the reading list", "Choose a workshop topic",
    ).mapIndexed { index, title ->
        WidgetTask(id = "preview-${index.toString().padStart(2, '0')}", title = title, scheduledFor = today.toString())
    } + listOf(
        WidgetTask("tomorrow-a", "Choose a new book", scheduledFor = "2026-06-16"),
        WidgetTask("tomorrow-b", "Refill the sketchbook", scheduledFor = "2026-06-16"),
        WidgetTask("week-a", "Visit the botanical garden", scheduledFor = "2026-06-22"),
        WidgetTask("week-b", "Plan a picnic", scheduledFor = "2026-06-24"),
        WidgetTask("month-a", "Start a new sketchbook", scheduledFor = "2026-07-02"),
        WidgetTask("month-b", "Organise the reading shelf", scheduledFor = "2026-07-20"),
        WidgetTask("month-deadline", "Review the trail map", scheduledFor = "2026-07-20", dueDay = "2026-07-03"),
        WidgetTask("month-only", "Make a summer playlist", scheduledFor = "2026-07"),
    )
    private val snapshot = TaskWidgetSnapshot(tasks, 1781517600000L)

    @Test
    fun responsive_sizes_light_and_dark() {
        for ((name, size) in listOf(
            "compact" to (170 to 170), "medium" to (360 to 170),
            "large" to (360 to 360), "extra_large" to (720 to 360),
        )) {
            for (dark in listOf(false, true)) capture(name, dark, size.first, size.second)
        }
    }

    @Test
    fun states_light_and_dark() {
        for (status in TaskWidgetStatus.entries) {
            for (dark in listOf(false, true)) {
                capture(status.name.lowercase(), dark, 360, 170,
                    status = status, content = if (status == TaskWidgetStatus.UNPAIRED || status == TaskWidgetStatus.LOADING) null else snapshot)
            }
        }
        for (dark in listOf(false, true)) {
            capture("empty", dark, 170, 170, content = TaskWidgetSnapshot(emptyList(), snapshot.updatedAt))
            capture("offline_no_cache", dark, 360, 170, content = null, status = TaskWidgetStatus.OFFLINE)
            capture("minimum_empty", dark, 150, 150, content = TaskWidgetSnapshot(emptyList(), snapshot.updatedAt))
            capture("minimum_unpaired", dark, 150, 150, content = null, status = TaskWidgetStatus.UNPAIRED)
            capture("minimum_offline", dark, 150, 150, content = null, status = TaskWidgetStatus.OFFLINE)
        }
    }

    @Test
    fun future_dates_light_and_dark() {
        for (period in TaskWidgetPeriod.entries) {
            val state = TaskWidgetState(period, offset = 1)
            assertFalse("Future previews must show planned tasks", TaskWidgetSchedule.tasks(tasks, state, today, Locale.UK).isEmpty())
            for (dark in listOf(false, true)) capture("next_${period.name.lowercase()}", dark, 360, 360, state = state)
        }
    }

    @Test
    fun long_titles_and_large_text() {
        val content = TaskWidgetSnapshot(listOf(
            WidgetTask("long", "Prepare a detailed outline for the next community workshop and review the printed draft", scheduledFor = today.toString()),
            WidgetTask("short", "Read", scheduledFor = today.toString()),
        ), snapshot.updatedAt)
        for (dark in listOf(false, true)) {
            capture("long_titles", dark, 170, 170, content = content)
            capture("accessibility", dark, 360, 360, content = content, fontScale = 2f)
            capture("minimum_accessibility", dark, 150, 150, content = content, fontScale = 2f)
        }
    }

    @Test fun today_newest_light() = newestToday(false)
    @Test fun today_newest_dark() = newestToday(true)

    private fun newestToday(dark: Boolean) {
        val content = TaskWidgetSnapshot(listOf(
            WidgetTask("older", "Inspect the storage shelves", scheduledFor = "2026-06-15", createdAt = "2026-06-15T08:00:00Z"),
            WidgetTask("new-carried", "Review the exhibit plan", scheduledFor = "2026-06-14", createdAt = "2026-06-15T11:00:00Z"),
            WidgetTask("current", "Prepare display labels", scheduledFor = "2026-06-15", createdAt = "2026-06-15T10:00:00Z"),
        ), snapshot.updatedAt)
        assertEquals(2, TaskWidgetRenderer.Size(270, 180).capacity)
        capture("today_newest", dark, 270, 180, content = content)
    }

    private fun capture(
        name: String,
        dark: Boolean,
        width: Int,
        height: Int,
        state: TaskWidgetState = TaskWidgetState(),
        content: TaskWidgetSnapshot? = snapshot,
        status: TaskWidgetStatus = TaskWidgetStatus.READY,
        fontScale: Float = 1f,
    ) {
        val application = RuntimeEnvironment.getApplication()
        val configuration = Configuration(application.resources.configuration).apply {
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
            setLocale(Locale.UK)
            this.fontScale = fontScale
        }
        val context = application.createConfigurationContext(configuration)
        val options = Bundle().apply {
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, width)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, height)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, height)
        }
        val views = TaskWidgetRenderer.render(context, 41, state, content, status, "preview-authority", options, today)
        captureRoboImage(filePath = "src/test/roborazzi/task_widget_${name}_${if (dark) "dark" else "light"}.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                Box(Modifier.background(if (dark) Color(0xFF172232) else Color(0xFFCDD8E8)).padding(8.dp)) {
                    AndroidView(
                        factory = { views.apply(context, FrameLayout(context)) },
                        modifier = Modifier.size(width.dp, height.dp),
                    )
                }
            }
        }
    }
}
