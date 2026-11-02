// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import dev.omnesis.android.MainActivity

/** Explicit, immutable capabilities: only the launcher holding one can invoke a widget action. */
object TaskWidgetIntents {
    const val PREVIOUS = "previous"
    const val NEXT = "next"
    const val RESET = "reset"
    const val PERIOD_DAY = "period-day"
    const val PERIOD_WEEK = "period-week"
    const val PERIOD_MONTH = "period-month"
    const val NEXT_PAGE = "page"
    const val REFRESH = "refresh"
    const val COMPLETE = "complete"
    const val ACTION = "dev.omnesis.android.widgets.ACTION"
    const val ID = "widgetId"
    const val OPERATION = "operation"
    const val AUTHORITY = "authority"
    const val TASK = "taskId"
    const val PAGE = "page"

    fun action(
        context: Context,
        id: Int,
        action: String,
        authority: String? = null,
        taskId: String? = null,
        page: Int? = null,
    ): PendingIntent {
        val identity = Uri.Builder().scheme("omnesis-widget").authority(context.packageName)
            .appendPath(id.toString()).appendPath(action)
            .appendQueryParameter("authority", authority.orEmpty())
            .appendQueryParameter("task", taskId.orEmpty())
            .appendQueryParameter("page", page?.toString().orEmpty()).build()
        val intent = Intent(context, TasksWidgetProvider::class.java).setAction(ACTION).setData(identity)
            .putExtra(ID, id).putExtra(OPERATION, action).putExtra(AUTHORITY, authority)
            .putExtra(TASK, taskId)
        page?.let { intent.putExtra(PAGE, it) }
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun open(context: Context, id: Int, state: TaskWidgetState, taskId: String? = null): PendingIntent {
        val uri = Uri.Builder().scheme("omnesis").authority("tasks")
            .appendQueryParameter("view", if (state.period == TaskWidgetPeriod.MONTH) "month" else "today")
            .appendQueryParameter("date", TaskWidgetSchedule.anchor(state).toString())
            .apply { taskId?.let { appendQueryParameter("task", it) } }.build()
        val intent = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(uri)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
