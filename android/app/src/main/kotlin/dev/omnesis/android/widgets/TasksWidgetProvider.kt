// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Bundle

/** Non-exported receiver; its immutable PendingIntents carry the only mutation entrypoints. */
class TasksWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        TaskWidgetUpdates.renderAll(context)
        TaskWidgetUpdates.refresh(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        TaskWidgetUpdates.renderAll(context)
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        val store = TaskWidgetStore(context)
        ids.forEach(store::delete)
    }

    override fun onRestored(context: Context, oldWidgetIds: IntArray, newWidgetIds: IntArray) {
        val store = TaskWidgetStore(context)
        oldWidgetIds.zip(newWidgetIds).forEach { (old, new) ->
            store.save(new, store.state(old))
            store.delete(old)
        }
    }

    override fun onDisabled(context: Context) { TaskWidgetUpdates.disable(context) }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action in setOf(Intent.ACTION_CONFIGURATION_CHANGED, Intent.ACTION_LOCALE_CHANGED,
                Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_DATE_CHANGED)) {
            TaskWidgetUpdates.renderAll(context)
            if (intent.action != Intent.ACTION_CONFIGURATION_CHANGED) TaskWidgetUpdates.refresh(context)
            return
        }
        if (intent.action != TaskWidgetIntents.ACTION) {
            super.onReceive(context, intent)
            return
        }
        val id = intent.getIntExtra(TaskWidgetIntents.ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        if (id !in TaskWidgetUpdates.ids(context)) return
        val store = TaskWidgetStore(context)
        val state = store.state(id)
        val next = when (intent.getStringExtra(TaskWidgetIntents.OPERATION)) {
            TaskWidgetIntents.PREVIOUS -> state.copy(offset = (state.offset - 1).coerceAtLeast(-120), page = 0)
            TaskWidgetIntents.NEXT -> state.copy(offset = (state.offset + 1).coerceAtMost(120), page = 0)
            TaskWidgetIntents.RESET -> state.copy(offset = 0, page = 0)
            TaskWidgetIntents.PERIOD_DAY -> TaskWidgetState(period = TaskWidgetPeriod.DAY)
            TaskWidgetIntents.PERIOD_WEEK -> TaskWidgetState(period = TaskWidgetPeriod.WEEK)
            TaskWidgetIntents.PERIOD_MONTH -> TaskWidgetState(period = TaskWidgetPeriod.MONTH)
            TaskWidgetIntents.NEXT_PAGE -> state.copy(page = intent.getIntExtra(TaskWidgetIntents.PAGE, 0).coerceIn(0, 10000))
            TaskWidgetIntents.REFRESH -> { TaskWidgetUpdates.refresh(context); return }
            TaskWidgetIntents.COMPLETE -> {
                TaskWidgetUpdates.complete(context, id, intent.getStringExtra(TaskWidgetIntents.TASK).orEmpty(),
                    intent.getStringExtra(TaskWidgetIntents.AUTHORITY).orEmpty())
                return
            }
            else -> return
        }
        store.save(id, next)
        TaskWidgetUpdates.renderAll(context)
    }
}
