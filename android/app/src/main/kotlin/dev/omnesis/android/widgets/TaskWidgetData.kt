// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import dev.omnesis.android.transport.dto.TaskDto
import java.time.LocalDate
import java.time.YearMonth
import java.time.temporal.TemporalAdjusters
import java.time.temporal.WeekFields
import java.util.Locale
import kotlinx.serialization.Serializable

@Serializable
enum class TaskWidgetPeriod { DAY, WEEK, MONTH }

enum class TaskWidgetStatus { READY, LOADING, UNPAIRED, OFFLINE, COMPLETION_FAILED }

@Serializable
data class TaskWidgetState(
    val period: TaskWidgetPeriod = TaskWidgetPeriod.DAY,
    val offset: Int = 0,
    val page: Int = 0,
)

/** Only fields shown by a widget are persisted; task evidence and history stay in the gateway. */
@Serializable
data class WidgetTask(
    val id: String,
    val title: String,
    val state: String = "open",
    val origin: String = "user",
    val accepted: Boolean = false,
    val ignored: Boolean = false,
    val scheduledFor: String? = null,
    val dueDay: String? = null,
    val createdAt: String? = null,
) {
    val isOpen: Boolean get() = state !in setOf("done", "dismissed") && !ignored && (origin != "brain" || accepted)

    companion object {
        fun from(task: TaskDto) = WidgetTask(
            task.id, task.title, task.state, task.origin, task.accepted, task.ignored,
            task.scheduledFor, task.dueDay, task.createdAt,
        )
    }
}

@Serializable
data class TaskWidgetSnapshot(val tasks: List<WidgetTask>, val updatedAt: Long)

/** Future windows show actual plans; only the current window includes today's backlog. */
object TaskWidgetSchedule {
    fun anchor(state: TaskWidgetState, today: LocalDate = LocalDate.now()): LocalDate = when (state.period) {
        TaskWidgetPeriod.DAY -> today.plusDays(state.offset.toLong())
        TaskWidgetPeriod.WEEK -> today.plusWeeks(state.offset.toLong())
        TaskWidgetPeriod.MONTH -> today.plusMonths(state.offset.toLong())
    }

    fun tasks(
        tasks: List<WidgetTask>,
        state: TaskWidgetState,
        today: LocalDate = LocalDate.now(),
        locale: Locale = Locale.getDefault(),
    ): List<WidgetTask> {
        val date = anchor(state, today)
        val start = when (state.period) {
            TaskWidgetPeriod.DAY -> date
            TaskWidgetPeriod.WEEK -> date.with(TemporalAdjusters.previousOrSame(WeekFields.of(locale).firstDayOfWeek))
            TaskWidgetPeriod.MONTH -> date.withDayOfMonth(1)
        }
        val end = when (state.period) {
            TaskWidgetPeriod.DAY -> start
            TaskWidgetPeriod.WEEK -> start.plusDays(6)
            TaskWidgetPeriod.MONTH -> start.with(TemporalAdjusters.lastDayOfMonth())
        }
        val first = start.toString()
        val last = end.toString()
        val day = today.toString()
        val month = YearMonth.from(date).toString()
        return tasks.filter { task ->
            if (!task.isOpen) return@filter false
            val plan = task.scheduledFor?.takeUnless { it == "someday" }
            val due = task.dueDay
            val dueNow = due != null && due <= day
            val plannedNow = plan != null && (if (plan.length == 10) plan <= day else plan < day.take(7))
            if (day in first..last && (dueNow || plannedNow)) return@filter true
            when {
                plan == null -> due != null && due in first..last
                plan.length == 7 -> when {
                    due != null && due < "$plan-01" -> due in first..last
                    state.period == TaskWidgetPeriod.MONTH -> plan == month
                    else -> due != null && due in first..last
                }
                else -> (due?.let { minOf(plan, it) } ?: plan) in first..last
            }
        }.sortedWith(
            if (state.period == TaskWidgetPeriod.DAY && date == today) {
                compareByDescending<WidgetTask> { it.createdAt.orEmpty() }.thenBy { it.id }
            } else {
                compareBy<WidgetTask> { effectiveDate(it) }.thenBy { it.createdAt.orEmpty() }.thenBy { it.id }
            },
        )
    }

    fun effectiveDate(task: WidgetTask): String {
        val plan = task.scheduledFor?.takeUnless { it == "someday" }
        return if (plan != null && task.dueDay != null) minOf(plan, task.dueDay)
        else plan ?: task.dueDay ?: "9999"
    }
}
