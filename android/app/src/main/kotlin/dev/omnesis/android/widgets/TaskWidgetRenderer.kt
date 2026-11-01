// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import android.appwidget.AppWidgetManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import dev.omnesis.android.R
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.time.temporal.WeekFields
import java.util.Locale
import kotlin.math.max

/** The launcher renders this exact view tree; no task titles are rasterised into bitmaps. */
object TaskWidgetRenderer {
    data class Size(val width: Int, val height: Int, val fontScale: Float = 1f) {
        val wide: Boolean get() = width >= 280 && height < 240
        val columns: Int get() = if (width >= 580 && height >= 240) 2 else 1
        val compact: Boolean get() = height < 210 || width < 220
        val rowHeight: Int get() = if (fontScale > 1.3f) { if (compact) 32 else 48 } else if (compact) 26 else 34
        val rowsPerColumn: Int get() = ((height - if (wide) 64 else if (width < 220) 118 else 122) / rowHeight).coerceIn(1, 10)
        val capacity: Int get() = rowsPerColumn * columns
    }

    fun size(context: Context, options: Bundle): Size = Size(
        options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 300).coerceAtLeast(120),
        options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 300).coerceAtLeast(120),
        context.resources.configuration.fontScale,
    )

    fun render(
        context: Context,
        widgetId: Int,
        state: TaskWidgetState,
        snapshot: TaskWidgetSnapshot?,
        status: TaskWidgetStatus,
        authority: String?,
        options: Bundle,
        today: LocalDate = LocalDate.now(),
    ): RemoteViews {
        fun layout(width: Int, height: Int): RemoteViews = renderAtSize(
            context, widgetId, state, snapshot, status, authority,
            Size(width.coerceAtLeast(120), height.coerceAtLeast(120), context.resources.configuration.fontScale), today,
        )
        if (Build.VERSION.SDK_INT >= 31) {
            @Suppress("DEPRECATION")
            val sizes = options.getParcelableArrayList<SizeF>(AppWidgetManager.OPTION_APPWIDGET_SIZES)
                .orEmpty().filter { it.width.isFinite() && it.height.isFinite() && it.width > 0 && it.height > 0 }
                .distinct().take(16)
            if (sizes.isNotEmpty()) return RemoteViews(sizes.associateWith { layout(it.width.toInt(), it.height.toInt()) })
        }
        val minimum = size(context, options)
        val portraitHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, minimum.height)
        val landscapeWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, minimum.width)
        val portrait = layout(minimum.width, portraitHeight)
        return if (portraitHeight == minimum.height && landscapeWidth == minimum.width) portrait
        else RemoteViews(layout(landscapeWidth, minimum.height), portrait)
    }

    private fun renderAtSize(
        context: Context,
        widgetId: Int,
        state: TaskWidgetState,
        snapshot: TaskWidgetSnapshot?,
        status: TaskWidgetStatus,
        authority: String?,
        size: Size,
        today: LocalDate,
    ): RemoteViews {
        val locale = context.resources.configuration.locales[0] ?: Locale.getDefault()
        val tasks = TaskWidgetSchedule.tasks(snapshot?.tasks.orEmpty(), state, today, locale)
        val anchor = TaskWidgetSchedule.anchor(state, today)
        val pages = max(1, (tasks.size + size.capacity - 1) / size.capacity)
        val page = state.page.coerceIn(0, pages - 1)
        val visible = tasks.drop(page * size.capacity).take(size.capacity)
        val views = RemoteViews(context.packageName, if (size.wide) R.layout.widget_tasks_wide else R.layout.widget_tasks)
        views.setTextViewText(R.id.tasks_widget_title, title(state.period, anchor, today, locale))
        views.setTextViewTextSize(R.id.tasks_widget_title, TypedValue.COMPLEX_UNIT_DIP, if (size.wide) 21f else 20f)
        views.setTextViewTextSize(R.id.tasks_widget_brand, TypedValue.COMPLEX_UNIT_DIP, 9f)
        views.setTextViewText(R.id.tasks_widget_count, tasks.size.toString())
        views.setTextViewTextSize(R.id.tasks_widget_count, TypedValue.COMPLEX_UNIT_DIP, if (size.wide) 12f else 27f)
        views.setContentDescription(R.id.tasks_widget_count_block, "${tasks.size} tasks to do")
        views.setViewVisibility(R.id.tasks_widget_count_block, if (snapshot == null || size.width < 220 || status == TaskWidgetStatus.UNPAIRED) View.GONE else View.VISIBLE)
        val open = TaskWidgetIntents.open(context, widgetId, state)
        views.setOnClickPendingIntent(R.id.tasks_widget_title, open)
        views.setOnClickPendingIntent(R.id.tasks_widget_logo, open)
        views.setOnClickPendingIntent(R.id.tasks_widget_message, open)
        bindTabs(context, views, widgetId, state)
        bindFooter(context, views, widgetId, state, anchor, status, snapshot, page, pages, locale)
        views.removeAllViews(R.id.tasks_widget_left)
        views.removeAllViews(R.id.tasks_widget_right)
        views.setViewVisibility(R.id.tasks_widget_right, if (size.columns == 2) View.VISIBLE else View.GONE)
        val message = when {
            status == TaskWidgetStatus.UNPAIRED -> "Open Omnesis" to "Pair your gateway to see your tasks."
            status == TaskWidgetStatus.LOADING && snapshot == null -> "Finding your tasks" to "Connecting to your gateway…"
            snapshot == null -> "Gateway unavailable" to "Tap refresh to try again."
            tasks.isEmpty() -> "Room to breathe" to "No tasks planned for this ${state.period.name.lowercase(locale)}."
            else -> null
        }
        views.setViewVisibility(R.id.tasks_widget_message, if (message != null) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.tasks_widget_rows, if (message == null) View.VISIBLE else View.GONE)
        if (message != null) {
            val icon = when {
                status == TaskWidgetStatus.UNPAIRED -> R.drawable.omnesis_logo
                status == TaskWidgetStatus.LOADING && snapshot == null -> R.drawable.widget_tasks_refresh
                snapshot == null -> R.drawable.widget_tasks_unavailable
                else -> R.drawable.widget_tasks_empty
            }
            views.setImageViewResource(R.id.tasks_widget_message_icon, icon)
            views.setViewVisibility(R.id.tasks_widget_message_icon, if (size.height < 170) View.GONE else View.VISIBLE)
            views.setTextViewTextSize(R.id.tasks_widget_message_title, TypedValue.COMPLEX_UNIT_DIP, 13f)
            views.setTextViewTextSize(R.id.tasks_widget_message_detail, TypedValue.COMPLEX_UNIT_DIP, 11f)
            views.setTextViewText(R.id.tasks_widget_message_title, message.first)
            views.setTextViewText(R.id.tasks_widget_message_detail, message.second)
            views.setViewVisibility(R.id.tasks_widget_message_detail, if (size.width < 220) View.GONE else View.VISIBLE)
        } else {
            visible.forEachIndexed { index, task ->
                val container = if (size.columns == 2 && index >= size.rowsPerColumn) R.id.tasks_widget_right else R.id.tasks_widget_left
                views.addView(container, row(context, widgetId, state, task, authority, size, anchor, locale))
            }
        }
        return views
    }

    private fun bindTabs(context: Context, views: RemoteViews, id: Int, state: TaskWidgetState) {
        val tabs = listOf(
            Triple(R.id.tasks_widget_day, TaskWidgetPeriod.DAY, TaskWidgetIntents.PERIOD_DAY),
            Triple(R.id.tasks_widget_week, TaskWidgetPeriod.WEEK, TaskWidgetIntents.PERIOD_WEEK),
            Triple(R.id.tasks_widget_month, TaskWidgetPeriod.MONTH, TaskWidgetIntents.PERIOD_MONTH),
        )
        tabs.forEach { (view, period, action) ->
            val selected = state.period == period
            views.setInt(view, "setBackgroundResource", if (selected) R.drawable.widget_tasks_selected else R.drawable.widget_tasks_transparent)
            views.setTextColor(view, context.getColor(if (selected) R.color.tasks_widget_accent else R.color.tasks_widget_secondary))
            views.setTextViewTextSize(view, TypedValue.COMPLEX_UNIT_DIP, 10f)
            views.setContentDescription(view, "${period.name.lowercase().replaceFirstChar(Char::uppercaseChar)} view${if (selected) ", selected" else ""}")
            views.setOnClickPendingIntent(view, TaskWidgetIntents.action(context, id, action))
        }
    }

    private fun bindFooter(
        context: Context,
        views: RemoteViews,
        id: Int,
        state: TaskWidgetState,
        anchor: LocalDate,
        status: TaskWidgetStatus,
        snapshot: TaskWidgetSnapshot?,
        page: Int,
        pages: Int,
        locale: Locale,
    ) {
        val label = when (status) {
            TaskWidgetStatus.OFFLINE -> if (snapshot == null) "Offline" else "Offline · saved"
            TaskWidgetStatus.COMPLETION_FAILED -> "Couldn't complete"
            TaskWidgetStatus.UNPAIRED -> "Your tasks, close by"
            TaskWidgetStatus.LOADING -> "Refreshing…"
            TaskWidgetStatus.READY -> when (state.period) {
                TaskWidgetPeriod.DAY -> anchor.format(DateTimeFormatter.ofPattern("d MMM", locale))
                TaskWidgetPeriod.WEEK -> "Week of " + weekStart(anchor, locale).format(DateTimeFormatter.ofPattern("d MMM", locale))
                TaskWidgetPeriod.MONTH -> anchor.format(DateTimeFormatter.ofPattern("MMM yyyy", locale))
            }
        }
        views.setTextViewText(R.id.tasks_widget_reset, label)
        views.setTextViewTextSize(R.id.tasks_widget_reset, TypedValue.COMPLEX_UNIT_DIP, 10f)
        views.setTextColor(R.id.tasks_widget_reset, context.getColor(if (status == TaskWidgetStatus.COMPLETION_FAILED) R.color.tasks_widget_danger else R.color.tasks_widget_secondary))
        views.setContentDescription(R.id.tasks_widget_reset, "${label}. Return to current ${state.period.name.lowercase()}.")
        views.setOnClickPendingIntent(R.id.tasks_widget_reset, TaskWidgetIntents.action(context, id, TaskWidgetIntents.RESET))
        views.setOnClickPendingIntent(R.id.tasks_widget_previous, TaskWidgetIntents.action(context, id, TaskWidgetIntents.PREVIOUS))
        views.setOnClickPendingIntent(R.id.tasks_widget_next, TaskWidgetIntents.action(context, id, TaskWidgetIntents.NEXT))
        views.setOnClickPendingIntent(R.id.tasks_widget_refresh, TaskWidgetIntents.action(context, id, TaskWidgetIntents.REFRESH))
        views.setViewVisibility(R.id.tasks_widget_page, if (pages > 1) View.VISIBLE else View.GONE)
        views.setTextViewText(R.id.tasks_widget_page, "${page + 1}/$pages")
        views.setTextViewTextSize(R.id.tasks_widget_page, TypedValue.COMPLEX_UNIT_DIP, 10f)
        views.setContentDescription(R.id.tasks_widget_page, "More tasks, page ${page + 1} of $pages")
        views.setOnClickPendingIntent(R.id.tasks_widget_page, TaskWidgetIntents.action(context, id, TaskWidgetIntents.NEXT_PAGE, page = (page + 1) % pages))
    }

    private fun row(
        context: Context,
        id: Int,
        state: TaskWidgetState,
        task: WidgetTask,
        authority: String?,
        size: Size,
        anchor: LocalDate,
        locale: Locale,
    ): RemoteViews {
        val layout = when {
            size.fontScale > 1.3f && size.compact -> R.layout.widget_task_row_compact_accessibility
            size.fontScale > 1.3f -> R.layout.widget_task_row_accessibility
            size.compact -> R.layout.widget_task_row_compact
            else -> R.layout.widget_task_row
        }
        return RemoteViews(context.packageName, layout).apply {
            setTextViewText(R.id.tasks_widget_task_title, task.title)
            if (size.fontScale > 1.3f) {
                // A widget has fixed bounds; preserve enlarged task text while
                // keeping one line inside even the minimum-size tile.
                setTextViewTextSize(R.id.tasks_widget_task_title, TypedValue.COMPLEX_UNIT_DIP,
                    (13f * size.fontScale).coerceAtMost(if (size.compact) 26f else 34f))
                setTextViewTextSize(R.id.tasks_widget_task_date, TypedValue.COMPLEX_UNIT_DIP,
                    (10f * size.fontScale).coerceAtMost(20f))
            }
            setContentDescription(R.id.tasks_widget_task_title, task.title)
            setContentDescription(R.id.tasks_widget_complete, "Complete ${task.title}")
            setOnClickPendingIntent(R.id.tasks_widget_complete, TaskWidgetIntents.action(context, id, TaskWidgetIntents.COMPLETE, authority, task.id))
            setOnClickPendingIntent(R.id.tasks_widget_task_title, TaskWidgetIntents.open(context, id, state, task.id))
            if (state.period != TaskWidgetPeriod.DAY) {
                scheduleLabel(task, state.period, anchor, locale)?.let { label ->
                    setTextViewText(R.id.tasks_widget_task_date, label)
                    setViewVisibility(R.id.tasks_widget_task_date, View.VISIBLE)
                }
            }
        }
    }

    private fun title(period: TaskWidgetPeriod, anchor: LocalDate, today: LocalDate, locale: Locale): String = when (period) {
        TaskWidgetPeriod.DAY -> when (anchor) {
            today -> "Today"
            today.plusDays(1) -> "Tomorrow"
            today.minusDays(1) -> "Yesterday"
            else -> anchor.format(DateTimeFormatter.ofPattern("EEE d MMM", locale))
        }
        TaskWidgetPeriod.WEEK -> if (weekStart(anchor, locale) == weekStart(today, locale)) "This week"
        else "Week of " + weekStart(anchor, locale).format(DateTimeFormatter.ofPattern("d MMM", locale))
        TaskWidgetPeriod.MONTH -> anchor.format(DateTimeFormatter.ofPattern(if (anchor.year == today.year) "MMMM" else "MMM yyyy", locale))
    }

    private fun weekStart(day: LocalDate, locale: Locale): LocalDate =
        day.with(TemporalAdjusters.previousOrSame(WeekFields.of(locale).firstDayOfWeek))

    private fun scheduleLabel(task: WidgetTask, period: TaskWidgetPeriod, anchor: LocalDate, locale: Locale): String? {
        val plan = task.scheduledFor?.takeUnless { it == "someday" }
        if (period == TaskWidgetPeriod.MONTH && plan?.length == 7 && (task.dueDay == null || task.dueDay >= "$plan-01")) {
            return if (plan == YearMonth.from(anchor).toString()) "This month" else "Carried"
        }
        val day = if (plan?.length == 7) task.dueDay else TaskWidgetSchedule.effectiveDate(task)
        return runCatching { day?.let(LocalDate::parse) }
            .getOrNull()?.format(DateTimeFormatter.ofPattern("EEE d", locale))
    }
}
