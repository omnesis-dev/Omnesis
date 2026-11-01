// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Network work is durable and never runs on the AppWidgetProvider's broadcast time budget. */
class TaskWidgetWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext
        if (TaskWidgetUpdates.ids(context).isEmpty()) {
            TaskWidgetUpdates.disable(context)
            return@withContext Result.success()
        }
        val store = TaskWidgetStore(context)
        val repository = TaskWidgetRepository({ TaskWidgetUpdates.pairing(context) }, TaskWidgetCache(context))
        val authority = repository.currentAuthority()
        val taskId = inputData.getString(TaskWidgetIntents.TASK)
        if (taskId != null) {
            val expected = inputData.getString(TaskWidgetIntents.AUTHORITY).orEmpty()
            val widgetId = inputData.getInt(TaskWidgetIntents.ID, -1)
            if (widgetId !in TaskWidgetUpdates.ids(context)) return@withContext Result.success()
            try {
                repository.complete(taskId, expected)
                if (repository.currentAuthority() == expected) store.status(TaskWidgetStatus.READY)
                TaskWidgetUpdates.renderAll(context)
                // Refresh other task fields without making a confirmed completion
                // depend on a second successful network call.
                TaskWidgetUpdates.refresh(context)
                return@withContext Result.success()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (repository.currentAuthority() == expected) store.status(TaskWidgetStatus.COMPLETION_FAILED)
                TaskWidgetUpdates.renderAll(context)
                return@withContext Result.failure()
            }
        }
        if (authority != null && TaskWidgetCache(context).read(authority) == null) {
            store.status(TaskWidgetStatus.LOADING)
            TaskWidgetUpdates.renderAll(context)
        }
        val read = repository.refresh()
        // Lifecycle reconciliation owns a replacement authority's status.
        if (repository.currentAuthority() == authority) store.status(read.status)
        TaskWidgetUpdates.renderAll(context)
        if (TaskWidgetUpdates.ids(context).isEmpty()) runCatching { TaskWidgetCache(context).clear() }
        Result.success()
    }
}
